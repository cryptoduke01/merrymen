/** Authenticated Solana application boundary. Owner keys never enter this module. */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction,
  getTransactionDecoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Decode } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, requireSolanaLiveSellLimits, validateSolanaPaperLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaSwapIntent } from "../../packages/core/src/solana";
import {
  buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, buildRevokeSolanaSessionsInstruction,
  buildWithdrawSolanaVaultInstruction, buildSetSolanaBreakerInstruction, decodeSolanaVaultAccount, deriveSolanaAta, deriveSolanaVaultAddress,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_WRAPPED_SOL_MINT,
} from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { createSolanaExecutor, parseSolanaLiveIntent, readSolanaVaultBalances, readSolanaVaultState,
  reconcileSolanaSubmission, SolanaExecutionError, verifySolanaVaultDeployment, type SolanaLiveRecord } from "./solana-executor";
import { createSolanaLiveMarket } from "./solana-live-market";
import { createSolanaLiveRpc, type SolanaLiveRpc } from "./solana-live-rpc";
import { createSolanaMarket } from "./solana-market";
import { createSolanaPaperService, type SolanaPaperMarket } from "./solana-paper-service";
import { readSolanaReferencePrice, solanaReferenceBound, solanaReferenceNotional, solanaReferenceToleranceBps,
  SolanaReferencePriceError } from "./solana-reference-price";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { isSolanaTransactionError } from "./solana-settlement";
import { ensureSolanaTradingSchema, SolanaTradingStore, type SolanaAccountScope, type SolanaPreparedSetup } from "./solana-trading-store";

export class SolanaAppRuntimeError extends Error {
  constructor(readonly code: "configuration" | "permission" | "invalid" | "pending", message: string) {
    super(message); this.name = "SolanaAppRuntimeError";
  }
}
function fail(message: string, code: SolanaAppRuntimeError["code"] = "invalid"): never { throw new SolanaAppRuntimeError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("Invalid Solana confirmation data."); return value;
}
function encoded(value: string, max = 1232): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value) fail("Invalid encoded Solana transaction.");
  return bytes;
}
function seed(value: string | undefined, message: string): Buffer {
  if (!value) return fail(message, "configuration");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) return fail(message, "configuration");
  return bytes;
}
function publicTrade(record: SolanaLiveRecord) {
  const { intent, signature, preparedAtMs, minOutAmount, quotedOutAmount } = record.submission;
  return { mode: "live" as const, requestId: intent.requestId, intent, signature, status: record.status,
    preparedAtMs, minOutAmount, quotedOutAmount, settlement: record.settlement ?? null };
}
function tokenProgram(mint: string): string {
  if (mint === SOLANA_USDG_MINT) return TOKEN_2022_PROGRAM;
  if (mint === SOLANA_WRAPPED_SOL_MINT) return SOLANA_CLASSIC_TOKEN_PROGRAM;
  return fail("Live Solana trading currently supports USDG and wrapped SOL.");
}
async function createAta(owner: string, authority: string, mint: string): Promise<Instruction> {
  const program = tokenProgram(mint);
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(1), accounts: [
    { address: address(owner), role: 3 }, { address: address(await deriveSolanaAta(authority, mint, program)), role: 1 },
    { address: address(authority), role: 0 }, { address: address(mint), role: 0 },
    { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(program), role: 0 },
  ] };
}
export interface SolanaAppRuntimeOptions {
  db?: Db; env?: Readonly<Record<string, string | undefined>>; now?: () => number;
  rpc?: SolanaLiveRpc; market?: SolanaPaperMarket;
}
export function createSolanaAppRuntime(options: SolanaAppRuntimeOptions = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const rpc = () => options.rpc ?? createSolanaLiveRpc({ env });
  const market = () => options.market ?? createSolanaMarket({ env, now });
  async function store(scope: SolanaAccountScope, autonomousRevision?: number, signal?: AbortSignal) {
    const db = options.db ?? await getSolanaRuntimeDb();
    await ensureSolanaTradingSchema(db, !!env.DATABASE_URL);
    const result = new SolanaTradingStore(db, scope, now, autonomousRevision === undefined ? undefined : { autonomousRevision, signal }); await result.binding(); return result;
  }
  function config() {
    const programId = env.MERRYMEN_SOLANA_VAULT_PROGRAM, hash = env.MERRYMEN_SOLANA_VAULT_SHA256;
    if (!programId || !hash || !/^[a-f0-9]{64}$/.test(hash)) fail("An audited immutable Solana vault deployment and its binary hash must be configured.", "configuration");
    try { address(programId); } catch { fail("The configured Solana vault program is invalid.", "configuration"); }
    return { programId, hash };
  }
  function dek() { return seed(env.MERRYMEN_STORE_DEK, "Configure a 32-byte encryption key before registering live trading."); }
  async function payer() {
    return createKeyPairFromPrivateKeyBytes(seed(env.MERRYMEN_SOLANA_FEE_PAYER_SEED, "Configure the separate Solana network fee payer before live trading."));
  }
  function paperService(s: SolanaTradingStore) { return createSolanaPaperService(s.paper(), market(), now, { owner: s.scope.owner }); }
  function intent(raw: unknown, mode: "paper" | "live"): SolanaSwapIntent {
    if (!object(raw) || raw.mode !== mode || Object.hasOwn(raw, "owner") || Object.hasOwn(raw, "vault")) fail("Invalid Solana trade request.");
    return parseSolanaSwapIntent({ ...raw, mode: "paper" });
  }
  async function reconcile(s: SolanaTradingStore) {
    for (const pending of await s.pending()) {
      await reconcileSolanaSubmission(rpc(), s, s.scope.owner, pending.submission.intent.requestId, now);
    }
  }
  async function ownerStatus(s: SolanaTradingStore, setup: SolanaPreparedSetup) {
    if (!setup.signature || !setup.signedTransactionBase64) fail("The owner transaction has not been submitted.");
    const signature = setup.signature;
    if (setup.status === "finalized" || setup.status === "failed") return { signature, status: setup.status };
    let confirmedSlot: number | undefined;
    let expiryProof: { reason: "blockhash-expired"; blockHeight: string; vaultSequence: string | null; sessionEpoch: string | null; slot: number } | undefined;
    const result = await rpc().read(async read => {
      const statuses = await read("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (!object(statuses) || !Array.isArray(statuses.value) || statuses.value.length !== 1) fail("Invalid owner transaction confirmation.");
      const state = statuses.value[0];
      if (!object(state) || state.confirmationStatus !== "finalized") {
        if (setup.priorVaultExisted === undefined || setup.priorSequence === undefined || setup.priorSessionEpoch === undefined) return "pending" as const;
        if (await read("getTransaction", [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]) !== null) return "pending" as const;
        const blockHeight = integer(await read("getBlockHeight", [{ commitment: "finalized" }]));
        if (BigInt(blockHeight) <= BigInt(setup.lastValidBlockHeight)) return "pending" as const;
        // Read the finalized slot AFTER the expiry height. The account proof
        // must be from at least this slot, never an older pre-expiry snapshot.
        const slot = integer(await read("getSlot", [{ commitment: "finalized" }]));
        if (slot < 1) fail("Invalid owner expiry evidence.");
        const snapshot = await read("getAccountInfo", [setup.vault, { encoding: "base64", commitment: "finalized", minContextSlot: slot }]);
        if (!object(snapshot) || !object(snapshot.context) || integer(snapshot.context.slot) < slot || !Object.hasOwn(snapshot, "value")) fail("Invalid owner expiry evidence.");
        let sequence: string | null = null, epoch: string | null = null;
        if (setup.priorVaultExisted) {
          if (!object(snapshot.value) || snapshot.value.owner !== setup.programId || snapshot.value.executable !== false || !Array.isArray(snapshot.value.data)
            || snapshot.value.data[1] !== "base64" || typeof snapshot.value.data[0] !== "string") return "pending" as const;
          const current = decodeSolanaVaultAccount(encoded(snapshot.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE));
          sequence = current.seq.toString(); epoch = current.sessionEpoch.toString();
          if (current.owner !== s.scope.owner || sequence !== setup.priorSequence || epoch !== setup.priorSessionEpoch) return "pending" as const;
        } else if (snapshot.value !== null) return "pending" as const;
        confirmedSlot = integer(snapshot.context.slot);
        expiryProof = { reason: "blockhash-expired", blockHeight: String(blockHeight), vaultSequence: sequence, sessionEpoch: epoch, slot: confirmedSlot };
        return "failed" as const;
      }
      const tx = await read("getTransaction", [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
      if (tx === null) return "pending" as const;
      if (!object(tx) || tx.version !== 0 || !object(tx.meta) || !Object.hasOwn(tx.meta, "err") || !Object.hasOwn(state, "err")
        || !isSolanaTransactionError(tx.meta.err) || !isSolanaTransactionError(state.err)
        || JSON.stringify(tx.meta.err) !== JSON.stringify(state.err)
        || !Array.isArray(tx.transaction) || tx.transaction[1] !== "base64" || typeof tx.transaction[0] !== "string"
        || tx.transaction[0] !== setup.signedTransactionBase64 || integer(tx.slot) !== integer(state.slot)) fail("Owner confirmation does not match the saved transaction.");
      // A failed receipt is terminal too; neither path may mint a new signature.
      if ((tx.meta.err === null) !== (state.err === null)) fail("Owner transaction confirmations disagree.");
      confirmedSlot = integer(tx.slot);
      return tx.meta.err === null ? "finalized" as const : "failed" as const;
    });
    if (result !== "pending") await s.finishSetup(signature, result, confirmedSlot, expiryProof);
    return { signature, status: result };
  }
  async function prepareOwner(s: SolanaTradingStore, instructions: Instruction[], details: Omit<SolanaPreparedSetup,
    "transactionBase64" | "messageBase64" | "blockhash" | "lastValidBlockHeight" | "preparedAtMs" | "expiresAtMs">) {
    const previous = await s.setup();
    if (previous?.signature && previous.status !== "failed" && previous.status !== "finalized") fail("Refresh the pending owner transaction before preparing another.", "pending");
    const block = await rpc().read(async read => {
      const result = await read("getLatestBlockhash", [{ commitment: "confirmed" }]);
      if (!object(result) || !object(result.value) || typeof result.value.blockhash !== "string") fail("Invalid Solana blockhash response.");
      return { blockhash: address(result.value.blockhash) as unknown as Blockhash, lastValidBlockHeight: BigInt(integer(result.value.lastValidBlockHeight)) };
    });
    const tx = compileTransaction(setTransactionMessageLifetimeUsingBlockhash(block,
      setTransactionMessageFeePayer(address(s.scope.owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))));
    const transactionBase64 = getBase64EncodedWireTransaction(tx); encoded(transactionBase64);
    const preparedAtMs = now();
    const setup: SolanaPreparedSetup = { ...details, transactionBase64, messageBase64: Buffer.from(tx.messageBytes).toString("base64"),
      blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight.toString(), preparedAtMs, expiresAtMs: preparedAtMs + 60_000 };
    await s.saveSetup(setup);
    return { transactionBase64, blockhash: setup.blockhash, lastValidBlockHeight: setup.lastValidBlockHeight,
      programId: setup.programId, vault: setup.vault, session: setup.session, expiresAtMs: setup.expiresAtMs };
  }
  async function submitOwner(scope: SolanaAccountScope, input: { signedTransactionBase64: string }, kind: "session" | "owner") {
    const s = await store(scope), setup = await s.setup();
    if (!setup || (kind === "session" ? (setup.kind ?? "session") !== "session" : setup.kind === "session" || !setup.kind)) fail("Prepare this owner transaction before signing it.");
    const transaction = getTransactionDecoder().decode(encoded(input.signedTransactionBase64));
    const signatureBytes = transaction.signatures[address(scope.owner)];
    if (Object.keys(transaction.signatures).length !== 1 || !signatureBytes ||
      Buffer.from(transaction.messageBytes).toString("base64") !== setup.messageBase64 ||
      !ed25519.verify(new Uint8Array(signatureBytes), new Uint8Array(transaction.messageBytes), base58Decode(scope.owner)!, { zip215: false })) fail("The owner signature or reviewed transaction does not match.");
    const signature = getBase58Decoder().decode(signatureBytes);
    if (setup.signature) {
      if (setup.signature !== signature || setup.signedTransactionBase64 !== input.signedTransactionBase64) fail("Another owner transaction is already saved.");
      return ownerStatus(s, setup);
    }
    const signed: SolanaPreparedSetup = { ...setup, signature, signedTransactionBase64: input.signedTransactionBase64, status: "pending" };
    const first = await s.saveSetup(signed);
    if (first) { try { await rpc().send(input.signedTransactionBase64, 1); } catch { /* Durable pending; retry only reconciles. */ } }
    return { signature, status: "pending" as const };
  }
  return {
    async status(scope: SolanaAccountScope) {
      const s = await store(scope), binding = await s.binding(), blockers: string[] = [];
      try { await reconcile(s); } catch { blockers.push("Pending trade confirmation is unavailable; its reservation remains held."); }
      const setup = await s.setup();
      if (setup?.signature && setup.status !== "finalized" && setup.status !== "failed") {
        try { await ownerStatus(s, setup); } catch { blockers.push("Owner transaction confirmation is unavailable."); }
      }
      const session = await s.session();
      let programId: string | null = null, vault: string | null = null, cashTokenAccount: string | null = null;
      let balances: { slot: number; cashUsdg: string; wsolRaw: string } | null = null;
      try {
        const cfg = config(); programId = cfg.programId; vault = await deriveSolanaVaultAddress(programId, scope.owner);
        dek(); const feePayer = await getAddressFromPublicKey((await payer()).publicKey);
        if ([scope.owner, vault, session?.session].includes(feePayer)) fail("The network fee payer must be separate from the owner, vault and session.", "configuration");
        await verifySolanaVaultDeployment(rpc(), cfg.programId, cfg.hash);
        const feeBudget = parseSolanaRawAmount(env.MERRYMEN_SOLANA_MAX_FEE_LAMPORTS ?? "5000000");
        await rpc().read(async read => {
          const account = await read("getAccountInfo", [feePayer, { encoding: "base64", commitment: "confirmed" }]);
          if (!object(account) || !object(account.value) || account.value.owner !== SOLANA_SYSTEM_PROGRAM || BigInt(integer(account.value.lamports)) < feeBudget)
            fail("The separate network fee payer needs SOL for transaction fees and temporary account rent.", "configuration");
        });
        const live = await readSolanaVaultState(rpc(), programId, scope.owner);
        balances = await readSolanaVaultBalances(rpc(), vault, live.slot);
        cashTokenAccount = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
        const book = await s.liveBook();
        if (book && balances.cashUsdg !== book.cashRaw && balances.wsolRaw === book.wsolRaw && BigInt(balances.cashUsdg) >= BigInt(book.cashRaw)) {
          const observedAtMs = now();
          const finalized = await readSolanaVaultBalances(rpc(), vault, book.slot, "finalized");
          await s.reconcileCashDeposit({ ...finalized, observedAtMs, commitment: "finalized" });
        }
        if (!session || session.programId !== programId || session.vault !== vault || live.state.session !== session.session || live.state.sessionEpoch.toString() !== session.sessionEpoch) blockers.push("Register an owner-approved live trading permission.");
        else {
          const storedSeed = await s.sessionSeed(dek());
          if (!storedSeed || await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(seed(storedSeed, "The session cannot be opened."))).publicKey) !== session.session)
            fail("The saved trading permission cannot be opened.", "configuration");
        }
        const currentBook = await s.liveBook();
        if (currentBook?.buyPaused) blockers.push("The buying drawdown breaker is paused; exits remain available.");
        if (currentBook && (currentBook.cashRaw !== balances.cashUsdg || currentBook.wsolRaw !== balances.wsolRaw)) blockers.push("Vault balances changed outside recorded trades; reconcile capital transfers before trading.");
        if (!currentBook && balances.wsolRaw !== "0") blockers.push("Start the live book with USDG; the cost basis of existing SOL is unknown.");
        if (live.state.expiresAt * 1000n <= BigInt(now())) blockers.push("The on-chain trading permission has expired.");
        if (live.state.paused) blockers.push("The on-chain buying breaker is paused; exits remain available.");
      } catch (error) { blockers.push(error instanceof SolanaAppRuntimeError ? error.message : "The configured vault, balances or live permissions could not be verified."); }
      if (!env.MERRYMEN_JUPITER_API_KEY) blockers.push("Configure Jupiter quote access.");
      if (binding.requestedMode !== "live") blockers.push("Live mode is not selected.");
      if (!binding.limits || binding.limits.expiresAtMs <= now()) blockers.push("Save current Solana trading limits.");
      const pending = (await s.pending()).map(publicTrade);
      if (pending.length) blockers.push("A live trade is awaiting final confirmation.");
      const ownerTransaction = await s.setup();
      if (ownerTransaction?.signature && ownerTransaction.status === "pending") blockers.push("An owner transaction is awaiting final confirmation.");
      const heartbeat = await s.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number | string } | undefined;
      const lastSeenAtMs = heartbeat ? Number(heartbeat.last_seen_at_ms) : null;
      return { chain: CHAINS.solana, owner: scope.owner, requestedMode: binding.requestedMode,
        automation: { workerOnline: lastSeenAtMs !== null && lastSeenAtMs <= now() && now() - lastSeenAtMs < 90_000, lastSeenAtMs },
        paper: await s.paper().get(scope.owner), limits: binding.limits,
        live: { ready: blockers.length === 0, canExit: blockers.every(item => ["The on-chain buying breaker is paused; exits remain available.", "The buying drawdown breaker is paused; exits remain available."].includes(item)), blockers, programId, vault, cashTokenAccount, session: session?.session ?? null,
          balances, book: await s.liveBook(), pending, history: (await s.history()).map(publicTrade),
          ownerTransaction: ownerTransaction?.signature ? { signature: ownerTransaction.signature, status: ownerTransaction.status, kind: ownerTransaction.kind } : null } };
    },
    async setupPaper(scope: SolanaAccountScope, input: { initialCashRaw: string; limits: SolanaPaperLimits }) {
      const s = await store(scope), binding = await s.binding();
      if (binding.requestedMode !== "paper" || !binding.limits || JSON.stringify(binding.limits) !== JSON.stringify(input.limits)) fail("Save paper mode and its limits before creating the book.", "permission");
      return s.createPaper(input.initialCashRaw, input.limits);
    },
    async preview(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown }) {
      const s = await store(scope), parsed = intent(input.intent, input.mode);
      if (input.mode === "paper") return paperService(s).preview(scope.owner, parsed);
      const cfg = config(); parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: await deriveSolanaVaultAddress(cfg.programId, scope.owner) });
      const quote = await market().quote(parsed); validateSolanaQuote(quote, parsed, now());
      return { intent: { ...parsed, mode: "live" }, quote };
    },
    async trade(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown; autonomousRevision?: number; signal?: AbortSignal }) {
      const s = await store(scope, input.autonomousRevision, input.signal), parsed = intent(input.intent, input.mode);
      if (input.mode === "paper") return paperService(s).trade(scope.owner, parsed);
      const prior = await s.get(scope.owner, parsed.requestId);
      if (prior) {
        const expected = parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: prior.submission.intent.vault });
        if (JSON.stringify(expected) !== JSON.stringify(prior.submission.intent)) fail("The request ID already belongs to a different live trade.");
        return publicTrade(await reconcileSolanaSubmission(rpc(), s, scope.owner, parsed.requestId, now) ?? prior);
      }
      const cfg = config(), secret = await s.sessionSeed(dek());
      if (!secret) fail("Register an owner-approved live trading permission first.", "permission");
      let toleranceBps: number;
      try { toleranceBps = solanaReferenceToleranceBps(env); } catch { return fail("The independent SOL price tolerance is misconfigured.", "configuration"); }
      const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(seed(secret, "The stored trading permission cannot be opened."));
      const vault = await deriveSolanaVaultAddress(cfg.programId, scope.owner), liveRpc = rpc(), quotes = market();
      const executor = createSolanaExecutor({ programId: cfg.programId, programBinarySha256: cfg.hash,
        sessionKeyPair, feePayerKeyPair: await payer(), rpc: liveRpc, market: createSolanaLiveMarket({ env, rpc: liveRpc, now }),
        journal: s, maxFeeLamports: env.MERRYMEN_SOLANA_MAX_FEE_LAMPORTS ?? "5000000", now, signal: input.signal,
        computeUnitPriceMicroLamports: env.MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS ?? "0",
        assessRisk: async ({ intent: current, quote, slot }) => {
          const observedAtMs = now(), balances = await readSolanaVaultBalances(liveRpc, vault, slot);
          const makeExit = (amountRaw: string, requestId: string) => parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana,
            mode: "paper", requestId, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: current.slippageBps });
          const held = BigInt(balances.wsolRaw), cash = BigInt(balances.cashUsdg);
          const evidence: Array<{ intent: SolanaSwapIntent; quote: typeof quote }> = [];
          let equity = cash;
          if (held > 0n && current.inputMint === SOLANA_USDG_MINT) { const markIntent = makeExit(balances.wsolRaw, "live-portfolio-mark");
            const mark = await quotes.quote(markIntent); validateSolanaQuote(mark, markIntent, now()); evidence.push({ intent: markIntent, quote: mark }); equity += BigInt(mark.minOutAmount); }
          // Independent of Jupiter: the build quote's guaranteed output is checked
          // against Pyth SOL/USD, and a sell is charged at least its reference value.
          let reference: ReturnType<typeof solanaReferenceBound>;
          try { reference = solanaReferenceBound(current, await liveRpc.read(read => readSolanaReferencePrice(read, slot, now())), toleranceBps); }
          catch (error) { if (error instanceof SolanaReferencePriceError) throw new SolanaExecutionError("risk"); throw error; }
          const previous = await s.liveBook(), peak = previous ? BigInt(previous.hwmRaw) : equity;
          for (const item of evidence) validateSolanaQuote(item.quote, item.intent, now());
          return { observedAtMs, slot: balances.slot, notionalUsdg: solanaReferenceNotional(current, quote.outAmount, reference).toString(),
            equityUsdg: equity.toString(), peakEquityUsdg: (peak > equity ? peak : equity).toString(), cashUsdg: balances.cashUsdg, wsolRaw: balances.wsolRaw, reference };
        },
      });
      return publicTrade(await executor.execute({ ...parsed, mode: "live", owner: scope.owner, vault }));
    },
    async prepareLive(scope: SolanaAccountScope, input: { limits: SolanaPaperLimits; sessionPublicKey: string }) {
      const s = await store(scope), binding = await s.binding(), limits = validateSolanaPaperLimits(input.limits, now()), cfg = config();
      dek(); const feePayer = await getAddressFromPublicKey((await payer()).publicKey), session = address(input.sessionPublicKey);
      const vault = await deriveSolanaVaultAddress(cfg.programId, scope.owner);
      if (binding.requestedMode !== "live" || JSON.stringify(binding.limits) !== JSON.stringify(limits)) fail("Save the reviewed live trading limits first.", "permission");
      let sell: ReturnType<typeof requireSolanaLiveSellLimits>;
      try { sell = requireSolanaLiveSellLimits(limits); } catch { return fail("Save per-trade and daily SOL sell limits before registering live trading.", "permission"); }
      if (new Set([scope.owner, session, vault, feePayer]).size !== 4) fail("Owner, session, vault and fee payer must be separate accounts.");
      const deployment = await verifySolanaVaultDeployment(rpc(), cfg.programId, cfg.hash);
      const prior = await rpc().read(async read => {
        const found = await read("getAccountInfo", [vault, { encoding: "base64", commitment: "confirmed", minContextSlot: deployment.slot }]);
        if (!object(found) || !object(found.context) || integer(found.context.slot) < deployment.slot || !Object.hasOwn(found, "value")) fail("The vault account could not be read.");
        if (found.value === null) return null;
        if (!object(found.value) || found.value.owner !== cfg.programId || !Array.isArray(found.value.data) || typeof found.value.data[0] !== "string" || found.value.data[1] !== "base64"
          || decodeSolanaVaultAccount(encoded(found.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE)).owner !== scope.owner) fail("The vault account does not match this owner.");
        return decodeSolanaVaultAccount(encoded(found.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE));
      });
      const instructions: Instruction[] = [];
      if (!prior) instructions.push(buildInitializeSolanaVaultInstruction({ programAddress: cfg.programId, vault, owner: scope.owner }));
      instructions.push(await createAta(scope.owner, vault, SOLANA_USDG_MINT), await createAta(scope.owner, vault, SOLANA_WRAPPED_SOL_MINT),
        await createAta(scope.owner, scope.owner, SOLANA_USDG_MINT), await createAta(scope.owner, scope.owner, SOLANA_WRAPPED_SOL_MINT),
        buildCreateSolanaSessionInstruction({ programAddress: cfg.programId, vault, owner: scope.owner, session,
          perTrade: BigInt(limits.perTradeUsdg), daily: BigInt(limits.dailyUsdg), perTradeWsol: sell.perTradeWsol, dailyWsol: sell.dailyWsol,
          maxOps: limits.maxOpsPerDay, expiresAt: BigInt(Math.floor(limits.expiresAtMs / 1000)) }));
      return prepareOwner(s, instructions, { kind: "session", programId: cfg.programId, vault, session, limits,
        priorVaultExisted: prior !== null, priorSequence: prior?.seq.toString() ?? "0", priorSessionEpoch: prior?.sessionEpoch.toString() ?? "0" });
    },
    submitSetup: (scope: SolanaAccountScope, input: { signedTransactionBase64: string }) => submitOwner(scope, input, "session"),
    async activateLive(scope: SolanaAccountScope, input: { signature: string; sessionSecretKey: string }) {
      const s = await store(scope), cfg = config(), keyPair = await createKeyPairFromPrivateKeyBytes(seed(input.sessionSecretKey, "Invalid session seed."));
      const session = await getAddressFromPublicKey(keyPair.publicKey), previous = await s.session();
      if (previous?.registrationSignature === input.signature && previous.session === session) return { registered: true, session, vault: previous.vault };
      const setup = await s.setup();
      if (!setup || (setup.kind ?? "session") !== "session" || setup.signature !== input.signature || setup.session !== session || setup.programId !== cfg.programId) fail("The signed permission does not match this session key.");
      const status = await ownerStatus(s, setup);
      if (status.status !== "finalized") fail(status.status === "failed" ? "The permission transaction failed. Prepare a new permission." : "The permission is awaiting final confirmation.", "pending");
      await verifySolanaVaultDeployment(rpc(), cfg.programId, cfg.hash);
      const live = await readSolanaVaultState(rpc(), cfg.programId, scope.owner);
      if (live.vault !== setup.vault || live.state.session !== session || live.state.perTrade !== BigInt(setup.limits.perTradeUsdg)
        || live.state.daily !== BigInt(setup.limits.dailyUsdg) || live.state.maxOps !== setup.limits.maxOpsPerDay
        || live.state.perTradeWsol !== BigInt(setup.limits.perTradeWsol ?? "0") || live.state.dailyWsol !== BigInt(setup.limits.dailyWsol ?? "0")
        || live.state.expiresAt !== BigInt(Math.floor(setup.limits.expiresAtMs / 1000)) || live.state.expiresAt * 1000n <= BigInt(now())) fail("The current vault permission does not match the signed limits.");
      await s.registerSession({ programId: cfg.programId, vault: setup.vault, session, sessionEpoch: live.state.sessionEpoch.toString(),
        registrationSignature: input.signature, registeredAtMs: now() }, input.sessionSecretKey, dek());
      return { registered: true, session, vault: setup.vault };
    },
    async prepareOwnerAction(scope: SolanaAccountScope, input: { action: "revoke" | "withdraw" | "resume-buys"; mint?: string; amountRaw?: string }) {
      const s = await store(scope), cfg = config();
      if (input.action !== "revoke") await reconcile(s);
      await verifySolanaVaultDeployment(rpc(), cfg.programId, cfg.hash);
      const { vault, state } = await readSolanaVaultState(rpc(), cfg.programId, scope.owner), instructions: Instruction[] = [];
      if (input.action === "revoke") instructions.push(buildRevokeSolanaSessionsInstruction({ programAddress: cfg.programId, vault, owner: scope.owner }));
      else if (input.action === "resume-buys") instructions.push(buildSetSolanaBreakerInstruction({ programAddress: cfg.programId, vault, authority: scope.owner, paused: false }));
      else if (input.action === "withdraw" && input.mint && input.amountRaw) {
        const program = tokenProgram(input.mint), amount = parseSolanaRawAmount(input.amountRaw);
        let book = await s.liveBook();
        if (book) {
          const observedAtMs = now();
          const finalized = await readSolanaVaultBalances(rpc(), vault, book.slot, "finalized");
          await s.reconcileCashDeposit({ ...finalized, observedAtMs, commitment: "finalized" });
          book = await s.liveBook();
          if (amount > BigInt(input.mint === SOLANA_USDG_MINT ? book!.cashRaw : book!.wsolRaw)) fail("The withdrawal exceeds the reconciled vault balance.");
        }
        instructions.push(await createAta(scope.owner, scope.owner, input.mint), buildWithdrawSolanaVaultInstruction({ programAddress: cfg.programId, vault, owner: scope.owner,
          mint: input.mint, tokenProgram: program, vaultToken: await deriveSolanaAta(vault, input.mint, program), ownerToken: await deriveSolanaAta(scope.owner, input.mint, program), amount }));
      } else fail("Choose a supported owner action and a positive withdrawal amount.");
      // Owner recovery remains available with expired/revoked worker permission.
      const limits = { perTradeUsdg: state.perTrade.toString(), dailyUsdg: state.daily.toString(), maxOpsPerDay: state.maxOps,
        maxDrawdownBps: 1, expiresAtMs: Number(state.expiresAt * 1000n) };
      return prepareOwner(s, instructions, { kind: input.action, programId: cfg.programId, vault, session: state.session, limits,
        priorVaultExisted: true, priorSequence: state.seq.toString(), priorSessionEpoch: state.sessionEpoch.toString(),
        ...(input.action === "withdraw" ? { mint: input.mint, amountRaw: input.amountRaw } : {}) });
    },
    submitOwnerAction: (scope: SolanaAccountScope, input: { signedTransactionBase64: string }) => submitOwner(scope, input, "owner"),
  };
}
let runtime: ReturnType<typeof createSolanaAppRuntime> | undefined;
export function getSolanaAppRuntime() { return runtime ??= createSolanaAppRuntime(); }
