import type { SolanaQuote } from "../../packages/core/src/solana";
import { createHash } from "node:crypto";
import {
  address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signTransaction, type AddressesByLookupTableAddress, type Blockhash, type Instruction,
} from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, validateSolanaQuote, type SolanaMint } from "../../packages/core/src/solana";
import {
  buildExecuteSolanaSwapInstruction, decodeSolanaVaultAccount, deriveSolanaAta,
  deriveSolanaSwapAuthority, deriveSolanaVaultAddress, SOLANA_CLASSIC_TOKEN_PROGRAM,
  SOLANA_WRAPPED_SOL_MINT, type SolanaVaultState,
} from "../../packages/core/src/solana-live";
import { validateJupiterCpi, type JupiterCpiRoute, type SolanaCpiBuildRequest } from "./solana-live-market";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { solanaReferenceNotional, verifySolanaReferenceBound, type SolanaReferenceBound } from "./solana-reference-price";
import { isSolanaTransactionError, settleSolanaReceipt } from "./solana-settlement";

export interface SolanaLiveIntent {
  kind: "spl-swap"; chain: typeof CHAINS.solana; mode: "live";
  requestId: string; owner: string; vault: string;
  inputMint: string; outputMint: string; amountRaw: string; slippageBps: number;
}
/** Supplied only by the trusted portfolio reader, never directly from caller JSON. */
export interface SolanaLiveRiskEvidence {
  observedAtMs: number;
  slot: number;
  notionalUsdg: string;
  equityUsdg: string;
  peakEquityUsdg: string;
  cashUsdg: string;
  wsolRaw: string;
  /** Independent SOL price bound; the signed minimum output may not be below its floor. */
  reference: SolanaReferenceBound;
}
export interface SolanaSignedSubmission {
  version: 1;
  intent: SolanaLiveIntent;
  programId: string;
  session: string;
  feePayer: string;
  sessionEpoch: string;
  vaultSequence: string;
  signature: string;
  signedTransactionBase64: string;
  messageBase64: string;
  /** Resolved from RPC-verified tables before signing, in wire account order. */
  loadedAddresses: { writable: readonly string[]; readonly: readonly string[] };
  recentBlockhash: string;
  lastValidBlockHeight: string;
  minContextSlot: number;
  minOutAmount: string;
  quotedOutAmount: string;
  inputTokenAccount: string;
  outputTokenAccount: string;
  inputTokenProgram: string;
  outputTokenProgram: string;
  inputBalanceBefore: string;
  outputBalanceBefore: string;
  maxFeeLamports: string;
  feeLamports: string;
  rentLamports: string;
  preparedAtMs: number;
  safetyObservedAtMs: number;
  quote: SolanaQuote;
  risk: SolanaLiveRiskEvidence;
}
interface SolanaSettlementFields {
  signature: string;
  slot: number;
  amountIn: string;
  amountOut: string;
  finalizedAtMs: number;
}
export type SolanaLiveSettlement = SolanaSettlementFields & (
  { status: "finalized" | "failed"; feeLamports: string } |
  { status: "expired"; feeLamports: null; expiryProof: {
    vaultSequence: string; sessionEpoch: string; blockHeight: string; reason: "blockhash-expired" | "session-revoked";
  } }
);
export interface SolanaLiveRecord {
  submission: SolanaSignedSubmission;
  status: "pending" | "finalized" | "failed" | "expired";
  settlement?: SolanaLiveSettlement;
}
export interface SolanaLiveJournal {
  get(owner: string, requestId: string): Promise<SolanaLiveRecord | null>;
  /** Atomic durable commit + risk admission. False means conflict; caller MUST NOT send. */
  recordSigned(submission: SolanaSignedSubmission): Promise<boolean>;
  /** CAS on owner/requestId/signature; only canonical finalized network evidence. */
  settle(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement): Promise<void>;
}

export class SolanaExecutionError extends Error {
  constructor(readonly code: "invalid-intent" | "invalid-state" | "unsafe-program" | "unsafe-route" | "simulation" | "fee-cap" | "risk" | "conflict" | "cancelled") {
    super(`Solana live execution refused: ${code}.`); this.name = "SolanaExecutionError";
  }
}
function fail(code: SolanaExecutionError["code"] = "invalid-state"): never { throw new SolanaExecutionError(code); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(); return value;
}
function context(raw: unknown, minimum = 1): { slot: number; value: unknown } {
  if (!object(raw) || !object(raw.context) || integer(raw.context.slot) < minimum || !Object.hasOwn(raw, "value")) return fail();
  return { slot: integer(raw.context.slot), value: raw.value };
}
type Account = { owner: string; executable: boolean; lamports: bigint; data: Buffer };
function account(raw: unknown): Account {
  if (!object(raw) || typeof raw.owner !== "string" || typeof raw.executable !== "boolean" ||
      !Array.isArray(raw.data) || raw.data[1] !== "base64" || typeof raw.data[0] !== "string") return fail();
  try { address(raw.owner); } catch { return fail(); }
  const data = Buffer.from(raw.data[0], "base64");
  if (data.toString("base64") !== raw.data[0]) return fail();
  return { owner: raw.owner, executable: raw.executable, lamports: BigInt(integer(raw.lamports)), data };
}
function tokenBalance(raw: Account, mint: string, authority: string, program: string): bigint {
  const data = raw.data;
  if (raw.owner !== program || raw.executable || data.length < 165 ||
      getBase58Decoder().decode(data.subarray(0, 32)) !== mint ||
      getBase58Decoder().decode(data.subarray(32, 64)) !== authority ||
      data[108] !== 1 || data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n || data.readUInt32LE(129) !== 0) return fail();
  return data.readBigUInt64LE(64);
}
function paperIntent(intent: SolanaLiveIntent) {
  return parseSolanaSwapIntent({ kind: intent.kind, chain: intent.chain, mode: "paper", requestId: intent.requestId,
    inputMint: intent.inputMint, outputMint: intent.outputMint, amountRaw: intent.amountRaw, slippageBps: intent.slippageBps });
}
export function parseSolanaLiveIntent(raw: unknown): SolanaLiveIntent {
  const keys = ["kind", "chain", "mode", "requestId", "owner", "vault", "inputMint", "outputMint", "amountRaw", "slippageBps"];
  if (!object(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key)) ||
      raw.mode !== "live" || typeof raw.owner !== "string" || typeof raw.vault !== "string") return fail("invalid-intent");
  try {
    address(raw.owner); address(raw.vault);
    const intent = raw as unknown as SolanaLiveIntent;
    paperIntent(intent);
    if (![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(intent.inputMint) ||
        ![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(intent.outputMint)) return fail("invalid-intent");
    return { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: intent.requestId,
      owner: intent.owner, vault: intent.vault, inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, slippageBps: intent.slippageBps };
  } catch { return fail("invalid-intent"); }
}
export interface SolanaExecutorOptions {
  programId: string;
  /** SHA256 of immutable ProgramData's entire executable region (bytes after metadata offset 45). */
  programBinarySha256: string;
  sessionKeyPair: CryptoKeyPair;
  feePayerKeyPair: CryptoKeyPair;
  rpc: SolanaLiveRpc;
  market: { build(request: SolanaCpiBuildRequest): Promise<JupiterCpiRoute>; readMint(address: string): Promise<SolanaMint> };
  journal: SolanaLiveJournal;
  maxFeeLamports: string;
  computeUnitPriceMicroLamports?: string;
  assessRisk(input: { intent: SolanaLiveIntent; quote: SolanaQuote; vaultState: SolanaVaultState;
    slot: number; observedAtMs: number }): Promise<SolanaLiveRiskEvidence>;
  now?: () => number;
  signal?: AbortSignal;
}
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOOKUP_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const COMPUTE_PROGRAM = "ComputeBudget111111111111111111111111111111";
const U64_MAX = (1n << 64n) - 1n;
async function readRawAccount(rpc: SolanaLiveRead, key: string, slot: number) {
  return account(context(await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed", minContextSlot: slot }]), slot).value);
}
async function verifyDeployment(rpc: SolanaLiveRead, programId: string, hash: string, slot: number): Promise<void> {
  address(programId);
  if (!/^[a-f0-9]{64}$/.test(hash)) return fail("unsafe-program");
  const program = await readRawAccount(rpc, programId, slot);
  if (program.owner !== UPGRADEABLE_LOADER || !program.executable || program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) return fail("unsafe-program");
  const dataAddress = getBase58Decoder().decode(program.data.subarray(4));
  const readSlice = async (offset: number, length: number) => {
    const raw = context(await rpc("getAccountInfo", [dataAddress, { encoding: "base64", commitment: "confirmed", minContextSlot: slot,
      dataSlice: { offset, length } }]), slot).value;
    if (!object(raw)) return fail("unsafe-program");
    const parsed = account(raw);
    if (parsed.owner !== UPGRADEABLE_LOADER || parsed.executable) return fail("unsafe-program");
    return { ...parsed, space: integer(raw.space) };
  };
  const header = await readSlice(0, 45);
  if (header.data.length !== 45 || header.data.readUInt32LE(0) !== 3 || header.data[12] !== 0 || header.space <= 45 || header.space > 2_097_152) return fail("unsafe-program");
  const digest = createHash("sha256");
  for (let offset = 45; offset < header.space; offset += 98_304) {
    const length = Math.min(98_304, header.space - offset);
    const chunk = await readSlice(offset, length);
    if (chunk.space !== header.space || chunk.data.length !== length) return fail("unsafe-program");
    digest.update(chunk.data);
  }
  if (digest.digest("hex") !== hash) return fail("unsafe-program");
}
export async function verifySolanaVaultDeployment(rpc: SolanaLiveRpc, programId: string, binarySha256: string): Promise<{ slot: number }> {
  return rpc.read(async read => {
    const slot = integer(await read("getSlot", [{ commitment: "confirmed" }]));
    if (slot < 1) return fail();
    await verifyDeployment(read, programId, binarySha256, slot);
    return { slot };
  });
}
export async function readSolanaVaultState(rpc: SolanaLiveRpc, programId: string, owner: string): Promise<{ vault: string; slot: number; state: SolanaVaultState }> {
  const vault = await deriveSolanaVaultAddress(programId, owner);
  return rpc.read(async read => {
    const raw = context(await read("getAccountInfo", [vault, { encoding: "base64", commitment: "confirmed" }]));
    const data = account(raw.value);
    if (data.owner !== programId || data.executable) return fail();
    const state = decodeSolanaVaultAccount(data.data);
    if (state.owner !== owner) return fail();
    return { vault, slot: raw.slot, state };
  });
}
export async function readSolanaVaultBalances(rpc: SolanaLiveRpc, vault: string, minContextSlot = 1, commitment: "confirmed" | "finalized" = "confirmed"): Promise<{ slot: number; cashUsdg: string; wsolRaw: string }> {
  const [cash, wsol] = await Promise.all([deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
    deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM)]);
  return rpc.read(async read => {
    const result = context(await read("getMultipleAccounts", [[cash, wsol], { encoding: "base64", commitment, minContextSlot }]), minContextSlot);
    if (!Array.isArray(result.value) || result.value.length !== 2) return fail();
    return { slot: result.slot, cashUsdg: tokenBalance(account(result.value[0]), SOLANA_USDG_MINT, vault, TOKEN_2022_PROGRAM).toString(),
      wsolRaw: tokenBalance(account(result.value[1]), SOLANA_WRAPPED_SOL_MINT, vault, SOLANA_CLASSIC_TOKEN_PROGRAM).toString() };
  });
}
/** Resolves signed submissions without loading signing keys or requiring live mode. */
export async function reconcileSolanaSubmission(
  rpc: SolanaLiveRpc, journal: SolanaLiveJournal, owner: string, requestId: string, now: () => number = Date.now,
): Promise<SolanaLiveRecord | null> {
  const record = await journal.get(owner, requestId);
  if (!record || record.status !== "pending") return record;
  const submission = record.submission;
  const settlement = await rpc.read(async (read): Promise<SolanaLiveSettlement | null> => {
    const result = context(await read("getSignatureStatuses", [[submission.signature], { searchTransactionHistory: true }]), submission.minContextSlot);
    if (!Array.isArray(result.value) || result.value.length !== 1) return fail();
    const status = result.value[0];
    if (status !== null && (!object(status) || !["processed", "confirmed", "finalized"].includes(String(status.confirmationStatus)) ||
      !Object.hasOwn(status, "err") || !isSolanaTransactionError(status.err))) return fail();
    const receipt = await read("getTransaction", [submission.signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
    if (object(status) && status.confirmationStatus === "finalized") return receipt === null ? null : settleSolanaReceipt(submission, receipt, status, now());
    if (receipt !== null) return null;
    // A missing receipt alone proves nothing. Read finalized height FIRST, then
    // a finalized account at/after a later finalized slot: its monotonic sequence
    // proves no successful swap occurred before the signed lifetime ended.
    const blockHeight = integer(await read("getBlockHeight", [{ commitment: "finalized", minContextSlot: submission.minContextSlot }]));
    const finalizedSlot = integer(await read("getSlot", [{ commitment: "finalized", minContextSlot: submission.minContextSlot }]));
    if (finalizedSlot < submission.minContextSlot || await deriveSolanaVaultAddress(submission.programId, owner) !== submission.intent.vault) return fail();
    const evidence = context(await read("getAccountInfo", [submission.intent.vault, {
      encoding: "base64", commitment: "finalized", minContextSlot: finalizedSlot,
    }]), finalizedSlot);
    const vault = account(evidence.value);
    if (vault.owner !== submission.programId || vault.executable) return fail();
    const state = decodeSolanaVaultAccount(vault.data);
    if (state.owner !== owner || state.sessionEpoch < BigInt(submission.sessionEpoch)) return fail();
    if (state.seq !== BigInt(submission.vaultSequence)) return null;
    const revoked = state.sessionEpoch > BigInt(submission.sessionEpoch);
    if (!revoked && BigInt(blockHeight) <= BigInt(submission.lastValidBlockHeight)) return null;
    const finalizedAtMs = integer(now()); if (finalizedAtMs < submission.preparedAtMs) return fail();
    return { status: "expired", signature: submission.signature, slot: evidence.slot, feeLamports: null,
      amountIn: "0", amountOut: "0", finalizedAtMs, expiryProof: { vaultSequence: state.seq.toString(),
        sessionEpoch: state.sessionEpoch.toString(), blockHeight: blockHeight.toString(), reason: revoked ? "session-revoked" : "blockhash-expired" } };
  });
  if (!settlement) return record;
  await journal.settle(owner, requestId, submission.signature, settlement);
  return { submission, status: settlement.status, settlement };
}
function computeInstructions(units: number, price: bigint): Instruction[] {
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(units, 1);
  const fee = Buffer.alloc(9); fee[0] = 3; fee.writeBigUInt64LE(price, 1);
  return [{ programAddress: address(COMPUTE_PROGRAM), accounts: [], data: limit },
    { programAddress: address(COMPUTE_PROGRAM), accounts: [], data: fee }];
}

export function createSolanaExecutor(options: SolanaExecutorOptions) {
  const now = options.now ?? Date.now;
  const cap = parseSolanaRawAmount(options.maxFeeLamports);
  const price = parseSolanaRawAmount(options.computeUnitPriceMicroLamports ?? "0", true);
  address(options.programId);
  if (!/^[a-f0-9]{64}$/.test(options.programBinarySha256)) fail("unsafe-program");
  const identity = Promise.all([getAddressFromPublicKey(options.sessionKeyPair.publicKey), getAddressFromPublicKey(options.feePayerKeyPair.publicKey)]);
  const timestamp = () => { const value = now(); integer(value); return value; };
  const checkAbort = () => { if (options.signal?.aborted) fail("cancelled"); };
  return {
    async execute(rawIntent: unknown): Promise<SolanaLiveRecord> {
      checkAbort();
      const intent = parseSolanaLiveIntent(rawIntent);
      const prior = await options.journal.get(intent.owner, intent.requestId);
      if (prior) {
        if (JSON.stringify(prior.submission.intent) !== JSON.stringify(intent)) return fail("conflict");
        return prior; // Includes failed requests: never re-sign an old request.
      }
      checkAbort();
      const [session, feePayer] = await identity;
      checkAbort();
      if (session === feePayer || [session, feePayer].some(key => key === intent.owner || key === intent.vault) ||
          await deriveSolanaVaultAddress(options.programId, intent.owner) !== intent.vault) return fail();
      const inputProgram = intent.inputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
      const outputProgram = intent.outputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
      const [inputTokenAccount, outputTokenAccount, ownerRefund, inputMint, outputMint] = await Promise.all([
        deriveSolanaAta(intent.vault, intent.inputMint, inputProgram), deriveSolanaAta(intent.vault, intent.outputMint, outputProgram),
        deriveSolanaAta(intent.owner, intent.inputMint, inputProgram),
        options.market.readMint(intent.inputMint), options.market.readMint(intent.outputMint),
      ]);
      checkAbort();
      const observedAtMs = timestamp();
      for (const [mint, expected, program] of [[inputMint, intent.inputMint, inputProgram], [outputMint, intent.outputMint, outputProgram]] as const) {
        if (mint.address !== expected || mint.program !== program || mint.observedAtMs > observedAtMs || observedAtMs - mint.observedAtMs >= 30_000 ||
            mint.decimals !== (expected === SOLANA_USDG_MINT ? 6 : 9)) return fail();
      }
      if (intent.inputMint === SOLANA_USDG_MINT && (inputMint.buyBlockedReasons.length || outputMint.buyBlockedReasons.length)) return fail("unsafe-route");
      const safetyObservedAtMs = Math.min(inputMint.observedAtMs, outputMint.observedAtMs);
      const snapshot = await options.rpc.read(async rpc => {
        const slot = integer(await rpc("getSlot", [{ commitment: "confirmed" }]));
        if (slot < 1) return fail();
        await verifyDeployment(rpc, options.programId, options.programBinarySha256, slot);
        const result = context(await rpc("getMultipleAccounts", [[intent.vault, inputTokenAccount, outputTokenAccount, feePayer, ownerRefund],
          { encoding: "base64", commitment: "confirmed", minContextSlot: slot }]), slot);
        if (!Array.isArray(result.value) || result.value.length !== 5) return fail();
        const [vault, input, output, payer, refund] = result.value.map(account) as [Account, Account, Account, Account, Account];
        if (vault.owner !== options.programId || vault.executable || payer.owner !== "11111111111111111111111111111111" || payer.executable || payer.data.length) return fail();
        const state = decodeSolanaVaultAccount(vault.data);
        if (state.owner !== intent.owner || state.session !== session || (state.paused && intent.inputMint === SOLANA_USDG_MINT) || state.expiresAt * 1000n <= BigInt(observedAtMs) ||
            state.seq === U64_MAX || state.maxOps < 1 || state.perTrade <= 0n || state.daily < state.perTrade) return fail();
        const inputBalance = tokenBalance(input, intent.inputMint, intent.vault, inputProgram);
        const outputBalance = tokenBalance(output, intent.outputMint, intent.vault, outputProgram);
        tokenBalance(refund, intent.inputMint, intent.owner, inputProgram);
        if (inputBalance < BigInt(intent.amountRaw)) return fail();
        const rent = BigInt(integer(await rpc("getMinimumBalanceForRentExemption", [input.data.length, { commitment: "confirmed" }])));
        return { slot: result.slot, state, inputBalance, outputBalance, payerBalance: payer.lamports, rent };
      });
      checkAbort();
      // Mirror the vault's owner-signed WSOL input caps before asking for a route.
      if (intent.inputMint === SOLANA_WRAPPED_SOL_MINT) {
        const amount = BigInt(intent.amountRaw), cutoff = BigInt(Math.floor(observedAtMs / 1000)) - 86_400n;
        const used = snapshot.state.debits.filter(d => d.timestamp > cutoff).reduce((sum, d) => sum + d.wsol, 0n);
        if (amount > snapshot.state.perTradeWsol || used + amount > snapshot.state.dailyWsol) return fail("risk");
      }
      const swapAuthority = await deriveSolanaSwapAuthority(options.programId, intent.vault, snapshot.state.seq);
      const tempInput = await deriveSolanaAta(swapAuthority, intent.inputMint, inputProgram);
      const buildRequest: SolanaCpiBuildRequest = { ...intent, swapAuthority, sourceTokenAccount: tempInput,
        destinationTokenAccount: outputTokenAccount, inputTokenProgram: inputProgram, outputTokenProgram: outputProgram };
      const route = await options.market.build(buildRequest);
      checkAbort();
      validateSolanaQuote(route.quote, paperIntent(intent), timestamp());
      validateJupiterCpi({ swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", data: route.dataBase64,
        accounts: route.accounts.map(meta => ({ pubkey: meta.address, isSigner: meta.isSigner, isWritable: meta.isWritable })) },
        addressLookupTableAddresses: route.lookupTableAddresses }, buildRequest, route.quote);
      // Provider objects cannot add authority. Inspect all remaining account owners
      // before CPI and reject any path to the vault's other token accounts.
      const prepared = await options.rpc.read(async rpc => {
        const slot = Math.max(snapshot.slot, route.quote.contextSlot);
        if (route.accounts.some(meta => [intent.owner, intent.vault, session, feePayer, inputTokenAccount, ownerRefund].includes(meta.address))) return fail("unsafe-route");
        const keys = [...new Set(route.accounts.map(meta => meta.address))];
        const remaining = context(await rpc("getMultipleAccounts", [keys,
          { encoding: "base64", commitment: "confirmed", minContextSlot: slot, dataSlice: { offset: 0, length: 165 } }]), slot);
        if (!Array.isArray(remaining.value) || remaining.value.length !== keys.length) return fail();
        remaining.value.forEach((raw, index) => {
          if (raw === null) return;
          const item = account(raw);
          if ([SOLANA_CLASSIC_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(item.owner) && item.data.length >= 64 &&
              getBase58Decoder().decode(item.data.subarray(32, 64)) === intent.vault && keys[index] !== outputTokenAccount) fail("unsafe-route");
        });
        const alts: AddressesByLookupTableAddress = {};
        for (const key of route.lookupTableAddresses) {
          const alt = await readRawAccount(rpc, key, slot);
          if (alt.owner !== LOOKUP_PROGRAM || alt.executable || alt.data.length < 56 || (alt.data.length - 56) % 32 ||
              alt.data.length > 8248 || alt.data.readUInt32LE(0) !== 1 || alt.data.readBigUInt64LE(4) !== U64_MAX ||
              alt.data.readBigUInt64LE(12) >= BigInt(slot)) return fail("unsafe-route");
          alts[address(key)] = Array.from({ length: (alt.data.length - 56) / 32 }, (_, index) =>
            address(getBase58Decoder().decode(alt.data.subarray(56 + index * 32, 88 + index * 32))));
        }
        const blockhash = context(await rpc("getLatestBlockhash", [{ commitment: "confirmed", minContextSlot: slot }]), slot);
        if (!object(blockhash.value) || typeof blockhash.value.blockhash !== "string") return fail();
        let recentBlockhash: Blockhash;
        try { recentBlockhash = address(blockhash.value.blockhash) as unknown as Blockhash; } catch { return fail(); }
        const lastValidBlockHeight = BigInt(integer(blockhash.value.lastValidBlockHeight));
        const deadline = BigInt(Math.floor(Math.min(route.quote.expiresAtMs, Number(snapshot.state.expiresAt * 1000n)) / 1000));
        const swap = buildExecuteSolanaSwapInstruction({ programAddress: options.programId, vault: intent.vault,
          sessionSigner: session, feePayer, inputMint: intent.inputMint, outputMint: intent.outputMint,
          vaultInput: inputTokenAccount, vaultOutput: outputTokenAccount, swapAuthority, tempInput, ownerRefund,
          inputTokenProgram: inputProgram, outputTokenProgram: outputProgram, expectedSeq: snapshot.state.seq,
          sessionEpoch: snapshot.state.sessionEpoch, amountIn: BigInt(intent.amountRaw), minOut: BigInt(route.quote.minOutAmount),
          deadline, slippageBps: intent.slippageBps, routeData: Buffer.from(route.dataBase64, "base64"),
          routeAccounts: route.accounts.map(meta => ({ address: meta.address, role: meta.isWritable ? 1 : 0 })) });
        const compile = (units: number) => {
          const msg = setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight },
            setTransactionMessageFeePayer(feePayer, appendTransactionMessageInstructions([...computeInstructions(units, price), swap], createTransactionMessage({ version: 0 }))));
          const transaction = compileTransaction(compressTransactionMessageUsingAddressLookupTables(msg, alts));
          if (Buffer.from(getBase64EncodedWireTransaction(transaction), "base64").length > 1232) return fail("unsafe-route");
          return transaction;
        };
        const simulate = async (transaction: ReturnType<typeof compile>) => {
          const sim = context(await rpc("simulateTransaction", [getBase64EncodedWireTransaction(transaction), {
            encoding: "base64", commitment: "confirmed", minContextSlot: slot, sigVerify: false, replaceRecentBlockhash: false,
            accounts: { encoding: "base64", addresses: [intent.vault, inputTokenAccount, outputTokenAccount, feePayer] },
          }]), slot);
          if (!object(sim.value) || sim.value.err !== null || !Array.isArray(sim.value.accounts) || sim.value.accounts.length !== 4) return fail("simulation");
          const [vault, input, output, payer] = sim.value.accounts.map(account) as [Account, Account, Account, Account];
          const state = decodeSolanaVaultAccount(vault.data);
          const inputAfter = tokenBalance(input, intent.inputMint, intent.vault, inputProgram);
          const outputAfter = tokenBalance(output, intent.outputMint, intent.vault, outputProgram);
          if (vault.owner !== options.programId || state.owner !== intent.owner || state.session !== session ||
              state.seq !== snapshot.state.seq + 1n || state.sessionEpoch !== snapshot.state.sessionEpoch ||
              snapshot.inputBalance - inputAfter <= 0n || snapshot.inputBalance - inputAfter > BigInt(intent.amountRaw) ||
              outputAfter - snapshot.outputBalance < BigInt(route.quote.minOutAmount) ||
              snapshot.payerBalance - payer.lamports > cap) return fail("simulation");
          const units = integer(sim.value.unitsConsumed);
          if (units < 1 || units > 1_400_000) return fail("simulation");
          return units;
        };
        const estimate = await simulate(compile(1_400_000));
        const transaction = compile(Math.min(1_400_000, Math.ceil(estimate * 1.2)));
        const feeResult = context(await rpc("getFeeForMessage", [Buffer.from(transaction.messageBytes).toString("base64"),
          { commitment: "confirmed", minContextSlot: slot }]), slot);
        const fee = BigInt(integer(feeResult.value));
        if (fee < 10_000n || fee + snapshot.rent > cap || snapshot.payerBalance < fee + snapshot.rent) return fail("fee-cap");
        await simulate(transaction); // Recheck the exact message that will be signed.
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        if (compiled.version !== 0) return fail();
        const loadedAddresses: SolanaSignedSubmission["loadedAddresses"] = { writable: [], readonly: [] };
        for (const field of ["writable", "readonly"] as const) {
          loadedAddresses[field] = (compiled.addressTableLookups ?? []).flatMap(lookup => lookup[`${field}Indexes`].map(index => {
            const value = alts[lookup.lookupTableAddress]?.[index]; if (!value) return fail("unsafe-route"); return value;
          }));
        }
        return { transaction, fee, recentBlockhash, lastValidBlockHeight, slot, loadedAddresses };
      });
      checkAbort();
      const risk = await options.assessRisk({ intent, quote: route.quote, vaultState: snapshot.state,
        slot: prepared.slot, observedAtMs });
      checkAbort();
      const preparedAtMs = timestamp();
      validateSolanaQuote(route.quote, paperIntent(intent), preparedAtMs);
      if (preparedAtMs - safetyObservedAtMs >= 30_000) return fail("unsafe-route");
      // The guaranteed output must clear the independent price floor; a bad,
      // buggy or manipulated build quote cannot sign a sale for dust.
      let reference: SolanaReferenceBound;
      try { reference = verifySolanaReferenceBound(risk.reference, intent, preparedAtMs); } catch { return fail("risk"); }
      if (reference.reference.slot < prepared.slot || BigInt(route.quote.minOutAmount) < BigInt(reference.minOutFloor)) return fail("risk");
      if (integer(risk.observedAtMs) > preparedAtMs || preparedAtMs - risk.observedAtMs >= 30_000 ||
          integer(risk.slot) < prepared.slot || risk.cashUsdg !== (intent.inputMint === SOLANA_USDG_MINT ? snapshot.inputBalance : snapshot.outputBalance).toString() ||
          risk.wsolRaw !== (intent.inputMint === SOLANA_WRAPPED_SOL_MINT ? snapshot.inputBalance : snapshot.outputBalance).toString() ||
          parseSolanaRawAmount(risk.notionalUsdg) !== solanaReferenceNotional(intent, route.quote.outAmount, reference) ||
          parseSolanaRawAmount(risk.peakEquityUsdg, true) < parseSolanaRawAmount(risk.equityUsdg, true)) return fail("risk");
      if (BigInt(risk.notionalUsdg) > snapshot.state.perTrade || BigInt(risk.notionalUsdg) > snapshot.state.daily) return fail("risk");
      checkAbort();
      const signed = await signTransaction([options.feePayerKeyPair, options.sessionKeyPair], prepared.transaction);
      checkAbort();
      const signature = getSignatureFromTransaction(signed);
      const submission: SolanaSignedSubmission = { version: 1, intent, programId: options.programId, session, feePayer,
        sessionEpoch: snapshot.state.sessionEpoch.toString(), vaultSequence: snapshot.state.seq.toString(), signature,
        signedTransactionBase64: getBase64EncodedWireTransaction(signed), messageBase64: Buffer.from(signed.messageBytes).toString("base64"),
        loadedAddresses: prepared.loadedAddresses,
        recentBlockhash: prepared.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
        minContextSlot: prepared.slot, minOutAmount: route.quote.minOutAmount, quotedOutAmount: route.quote.outAmount,
        inputTokenAccount, outputTokenAccount, inputTokenProgram: inputProgram, outputTokenProgram: outputProgram,
        inputBalanceBefore: snapshot.inputBalance.toString(), outputBalanceBefore: snapshot.outputBalance.toString(),
        maxFeeLamports: cap.toString(), feeLamports: prepared.fee.toString(), rentLamports: snapshot.rent.toString(),
        preparedAtMs, safetyObservedAtMs, quote: route.quote, risk };
      checkAbort();
      if (!await options.journal.recordSigned(submission)) {
        const existing = await options.journal.get(intent.owner, intent.requestId);
        if (existing && JSON.stringify(existing.submission.intent) === JSON.stringify(intent)) return existing;
        return fail("conflict");
      }
      // Every send result, including a mismatched signature or lost response, is
      // pending until finalized network evidence proves its outcome. No resend.
      if (!options.signal?.aborted) {
        try { await options.rpc.send(submission.signedTransactionBase64, submission.minContextSlot, options.signal); } catch { /* Durable pending. */ }
      }
      return { submission, status: "pending" };
    },
    async reconcile(owner: string, requestId: string): Promise<SolanaLiveRecord | null> {
      return reconcileSolanaSubmission(options.rpc, options.journal, owner, requestId, now);
    },
  };
}
