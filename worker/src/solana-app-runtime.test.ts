import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, signTransaction } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SolanaPaperValidationError } from "../../packages/core/src/solana";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaSwapAuthority, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { sealSecret } from "./store-crypto";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAgent } from "./solana-agent";
import { createSolanaAppRuntime, SOLANA_DEPLOYMENT_RECHECK_MS, SolanaAppRuntimeError, solanaOwnerComputeUnitLimit, SOLANA_STATUS_NO_FALLBACK } from "./solana-app-runtime";
import { SolanaRpcError, withSolanaReadDeadline } from "./solana-rpc";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "./solana-trading-store";
import { PYTH_SOL_USD_ACCOUNT } from "./solana-reference-price";
import { pythAccount } from "./solana-reference-price-fixture";

const TENANT = "0x1111111111111111111111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
// A production-style program id: the runtimes below run every live deployment check.
const PROGRAM = key(77), LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
/** Mainnet's rent-exempt minimum: (128 + size) bytes at 3,480 lamports per byte-year, for two years. */
const rentExempt = (size: number) => (128 + size) * 6960;
const SYSTEM = "11111111111111111111111111111111";
async function fixture(options: { declared?: string } = {}) {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "paper", limits);
  // The binary declares PROGRAM: declare_id! embeds its 32 bytes.
  const dataAddress = key(41), binary = Buffer.concat([Buffer.from("runtime-tested-binary"), keyBytes(options.declared ?? PROGRAM)]), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, finalized: false, failed: false, malformed: false, sends: 0, signed: "", signature: "", failSend: true, height: 4900, sequence: 0n, epoch: 1n,
    cash: 0n, wsol: 0n, feePayerLamports: 100_000_000, ownerLamports: 100_000_000, ownerAtas: false, vaultNativeLamports: 0, unsyncedWsolLamports: 0,
    // Owner-transaction simulation and recent priority fees; null: the provider cannot answer.
    simulatedUnits: null as number | null, simulationFails: false, priorityFees: null as number[] | null };
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const ownerCashAta = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsolAta = await deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const feePayer = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
  // USDG accounts are Token-2022 with the ATA program's ImmutableOwner extension (170 bytes); WSOL accounts are native (165).
  const tokenAccount = (mint: string, amount: bigint, holder = vault) => {
    const usdg = mint === SOLANA_USDG_MINT, b = Buffer.alloc(usdg ? 170 : 165); keyBytes(mint).copy(b, 0); keyBytes(holder).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1;
    if (usdg) { b[165] = 2; b.writeUInt16LE(7, 166); } else { b.writeUInt32LE(1, 109); b.writeBigUInt64LE(BigInt(rentExempt(165)), 113); }
    return b;
  };
  const state = (epoch = controls.epoch, sequence = controls.sequence) => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [epoch, sequence, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  // Every RPC read, in order: what a status or owner action costs.
  const calls: Array<{ method: string; key: unknown }> = [];
  // Accounts a test places at other addresses (a swap's temporary input account, say).
  const extra = new Map<string, unknown>();
  const accountFor = (k: unknown) => typeof k === "string" && extra.has(k) ? extra.get(k) : k === vault ? (controls.initialized ? account(state(), PROGRAM, false, rentExempt(SOLANA_VAULT_ACCOUNT_SIZE) + controls.vaultNativeLamports) : null)
    : k === cashAta ? account(tokenAccount(SOLANA_USDG_MINT, controls.cash), TOKEN_2022_PROGRAM, false, rentExempt(170))
    : k === wsolAta ? account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, controls.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM, false, rentExempt(165) + Number(controls.wsol) + controls.unsyncedWsolLamports)
    : k === feePayer ? (controls.feePayerLamports ? account(Buffer.alloc(0), SYSTEM, false, controls.feePayerLamports) : null)
    : k === owner ? (controls.ownerLamports ? account(Buffer.alloc(0), SYSTEM, false, controls.ownerLamports) : null)
    : k === ownerCashAta ? (controls.ownerAtas ? account(tokenAccount(SOLANA_USDG_MINT, 0n, owner), TOKEN_2022_PROGRAM, false, rentExempt(170)) : null)
    : k === ownerWsolAta ? (controls.ownerAtas ? account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, 0n, owner), SOLANA_CLASSIC_TOKEN_PROGRAM, false, rentExempt(165)) : null)
    : null;
  const read: SolanaLiveRead = async (method, params = []) => {
    calls.push({ method, key: params[0] });
    if (method === "getSlot") return 1000;
    if (method === "getBlockHeight") return controls.height;
    if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: controls.height, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
    if (method === "getMinimumBalanceForRentExemption") return rentExempt(params[0] as number);
    if (method === "getAccountInfo") {
      if (params[0] === PROGRAM) return response(account(program, LOADER, true));
      if (params[0] === dataAddress) {
        const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
        return response({ ...account(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
      }
      if (params[0] === vault) return response(accountFor(vault));
      return response(accountFor(params[0]) ?? account(Buffer.alloc(0), SYSTEM));
    }
    if (method === "getMultipleAccounts") return response((params[0] as string[]).map(accountFor));
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([controls.finalized ? { confirmationStatus: "finalized", slot: 1000, ...(controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null }) } : null]);
    if (method === "getTransaction") return controls.finalized ? { version: 0, slot: 1000, transaction: [controls.signed, "base64"], meta: controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null } } : null;
    if (method === "simulateTransaction" && controls.simulatedUnits !== null) {
      assert.deepEqual(params[1], { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
      return response({ err: controls.simulationFails ? { InstructionError: [0, { Custom: 6000 }] } : null, unitsConsumed: controls.simulatedUnits, logs: [], accounts: null });
    }
    if (method === "getRecentPrioritizationFees" && controls.priorityFees) return controls.priorityFees.map((prioritizationFee, index) => ({ slot: 1000 - index, prioritizationFee }));
    throw new Error(`Unexpected test RPC ${method}`);
  };
  // Two independent providers. Both answer honestly unless a test replaces one.
  const providers: { primary: SolanaLiveRead | null; fallback: SolanaLiveRead | null } = { primary: null, fallback: null };
  const sent: string[] = [];
  const rpc: SolanaLiveRpc = { read: fn => fn(providers.primary ?? read), readEach: async fn => [await fn(providers.primary ?? read), await fn(providers.fallback ?? read)], send: async wire => {
    controls.sends++; sent.push(wire);
    const saved = await new SolanaTradingStore(db, scope, () => clock.now).setup();
    assert.equal(saved?.signedTransactionBase64, wire, "exact bytes committed before RPC send");
    controls.signed = wire; controls.signature = saved!.signature!;
    if (controls.failSend) throw new Error("lost send response");
    return controls.signature;
  } };
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: clock.now, buyBlockedReasons: [] }),
    quote: async intent => ({ source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
      outAmount: intent.amountRaw, minOutAmount: (BigInt(intent.amountRaw) * 995n / 1000n).toString(), slippageBps: intent.slippageBps,
      contextSlot: 1000, quotedAtMs: clock.now, expiresAtMs: clock.now + 30_000 }),
  };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"), MERRYMEN_JUPITER_API_KEY: "fixture" };
  const runtime = (overrides: Partial<Parameters<typeof createSolanaAppRuntime>[0]> = {}) =>
    createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now, localTestDeployment: false, ...overrides });
  const app = runtime();
  const sign = async (wire: string) => getBase64EncodedWireTransaction(await signTransaction([ownerKeys], getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  const live = async () => { const binding = (await bindings.get(TENANT))!; await bindings.settings(TENANT, owner, binding.revision, "live", limits); };
  const trade = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "runtime-test", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 };
  /** A registered session for the initialized vault, as activateLive leaves it. */
  const registered = async () => {
    await ensureSolanaTradingSchema(db);
    const record = { programId: PROGRAM, vault, session, sessionEpoch: controls.epoch.toString(), registrationSignature: key(43), registeredAtMs: clock.now };
    await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, owner, JSON.stringify(record),
      sealSecret(`solana-session/v1 ${TENANT} ${owner} ${PROGRAM} ${vault} ${session} ${record.sessionEpoch}\n` + sessionSeed.toString("base64"), Buffer.alloc(32, 30)));
  };
  return { raw, db, clock, scope, owner, session, sessionSeed, controls, bindings, app, runtime, sign, live, trade, env, rpc, market, registered, programData, dataAddress, calls, feePayer, vault, cashAta, wsolAta, ownerCashAta, ownerWsolAta,
    read, providers, sent, state, response, extra, tokenAccount };
}

test("authenticated paper execution is durable and never calls transaction submission", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const first = await f.app.trade(f.scope, { mode: "paper", intent: f.trade });
    f.clock.now = limits.expiresAtMs + 1;
    assert.deepEqual(await f.app.trade(f.scope, { mode: "paper", intent: f.trade }), first);
    assert.equal(f.controls.sends, 0);
    await assert.rejects(f.app.trade({ ...f.scope, tenant: "0x2222222222222222222222222222222222222222" }, { mode: "paper", intent: f.trade }), /binding/);
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, owner: f.owner } }), /Invalid/);
  } finally { f.raw.close(); }
});

test("live configuration failure never falls back to a paper fill", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    await f.live();
    const app = f.runtime({ env: {} });
    await assert.rejects(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), /immutable Solana vault/);
    const book = await new SolanaTradingStore(f.db, f.scope).paper().get(f.owner);
    assert.equal(book!.cashRaw, "100000000"); assert.equal(book!.trades.length, 0); assert.equal(f.controls.sends, 0);
    const status = await app.status(f.scope); assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /immutable/);
  } finally { f.raw.close(); }
});

test("owner setup persists exact signed bytes before send and survives a lost response with no replacement transaction", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    assert.equal(first.status, "pending"); assert.equal(f.controls.sends, 1);
    const restarted = f.runtime();
    // Unseen by both providers with its blockhash still valid: the same bytes go out again.
    assert.deepEqual(await restarted.submitSetup(f.scope, { signedTransactionBase64 }), first); assert.equal(f.controls.sends, 2);
    assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]), "only the owner's saved bytes are ever sent");
    f.controls.initialized = true; f.controls.finalized = true;
    await assert.rejects(restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: Buffer.alloc(32, 99).toString("base64") }), /does not match/);
    await restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    const stored = await f.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions").get() as { sealed_seed: string };
    assert.ok(!stored.sealed_seed.includes(f.sessionSeed.toString("base64")));
    assert.equal((await new SolanaTradingStore(f.db, f.scope).session())!.session, f.session);
    assert.equal(f.controls.sends, 2, "a finalized transaction is not sent again");
  } finally { f.raw.close(); }
});

test("changed consent fences a prepared owner permission before any send", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const current = (await f.bindings.get(TENANT))!;
    await f.bindings.settings(TENANT, f.owner, current.revision, "paper", limits);
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /settings changed/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("owner setup refuses unsigned, substituted and expired messages", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64: setup.transactionBase64 }), /signature/);
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    f.clock.now += 60_001;
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /expired/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("malformed owner confirmations remain unresolved and cannot release a pending permission", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.finalized = true; f.controls.malformed = true;
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /confirmation/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});

test("never-landed owner setup resolves only after finalized expiry and an unchanged vault proof", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.height = 5000;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 2, "rebroadcast while its blockhash can still land");
    f.controls.height = 5001;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "failed");
    const saved = await new SolanaTradingStore(f.db, f.scope).setup();
    assert.equal(saved!.expiryProof!.blockHeight, "5001"); assert.equal(saved!.expiryProof!.vaultSequence, null);
    assert.equal(f.controls.sends, 2, "never after it expired"); assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]));
    await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
  } finally { f.raw.close(); }
});

/** A live trade at `sequence`, pending as when the owner acts during it. */
async function pendingTrade(f: Awaited<ReturnType<typeof fixture>>, sequence: string) {
  await ensureSolanaTradingSchema(f.db);
  await f.db.prepare("INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(f.scope.tenant, f.scope.owner, `trade-${sequence}`, await deriveSolanaVaultAddress(PROGRAM, f.owner), sequence, `tradesig${sequence}`, "pending", f.clock.now, "1000000",
      JSON.stringify({ intent: { requestId: `trade-${sequence}` } }));
}
const landTrade = (f: Awaited<ReturnType<typeof fixture>>, sequence: string) =>
  f.db.prepare("UPDATE solana_runtime_submissions SET status='finalized' WHERE request_id=?").run(`trade-${sequence}`);

test("a revoke dropped while a trade lands resolves on its unchanged epoch and frees the owner controls (audit wedge)", async () => {
  for (const tradeLands of [false, true]) {
    const f = await fixture();
    try {
      await f.live(); f.controls.initialized = true; f.controls.sequence = 5n;
      await pendingTrade(f, "5");
      const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
      const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
      // The revoke's only send is lost. The trade lands: the sequence advances, the epoch does not.
      if (tradeLands) { f.controls.sequence = 6n; await landTrade(f, "5"); }
      f.controls.height = 5000;
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending", "not expired yet");
      f.controls.height = 5001;
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed", `tradeLands=${tradeLands}`);
      const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
      assert.equal(saved.expiryProof!.sessionEpoch, "1"); assert.equal(saved.expiryProof!.vaultSequence, tradeLands ? "6" : "5");
      assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]), "resolved without a replacement transaction");
      // The owner can act again.
      await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    } finally { f.raw.close(); }
  }
});

test("a revoke that did run is never booked failed, even with no receipt", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.epoch = 2n; // the epoch moved: it may have landed
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
  } finally { f.raw.close(); }
});

test("a session registration dropped while a trade advanced the vault resolves on the epoch alone", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.sequence = 1n;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal(f.controls.sends, 1);
    const again = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const resigned = await f.sign(again.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64: resigned });
    f.controls.height = 5002; f.controls.epoch = 2n; // a registration that ran always moves the epoch
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64: resigned })).status, "pending");
  } finally { f.raw.close(); }
});

test("a dropped withdrawal resolves on an unchanged sequence, and no trade can move it in between", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; f.controls.sequence = 3n;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.priorSequence, "3");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.epoch = 2n; // the epoch is irrelevant to a withdrawal
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.expiryProof!.vaultSequence, "3");
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    await g.live(); g.controls.initialized = true; g.controls.sequence = 3n;
    const prepared = await g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signedTransactionBase64 = await g.sign(prepared.transactionBase64);
    await g.app.submitOwnerAction(g.scope, { signedTransactionBase64 });
    g.controls.height = 5001; g.controls.sequence = 4n; // a moved sequence may be this withdrawal
    assert.equal((await g.app.submitOwnerAction(g.scope, { signedTransactionBase64 })).status, "pending");
  } finally { g.raw.close(); }
});

test("a dropped resume-buys resolves after expiry and leaves the off-chain breaker paused", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; f.controls.sequence = 2n;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.sequence = 3n;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
  } finally { f.raw.close(); }
});

test("one raw WSOL sent to the vault no longer freezes exits or owner withdrawals (audit dust)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0",
      networkFeesLamports: "10000", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // Anyone can transfer one base unit of WSOL (or SOL then SyncNative) to the vault's token account.
    f.controls.cash = 90_000_000n; f.controls.wsol = 50_000_001n;
    const status = await f.app.status(f.scope);
    assert.equal(status.live.canExit, true, status.live.blockers.join(" | "));
    assert.ok(!status.live.blockers.some(b => /balances/.test(b)));
    assert.deepEqual(status.live.tradable, { cashUsdg: "90000000", wsolRaw: "50000000", quarantinedWsolRaw: "1" });
    const booked = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(booked.quarantinedWsolRaw, "1"); assert.equal(booked.wsolRaw, "50000000"); assert.equal(booked.hwmRaw, "100000000");
    // Both in-app withdrawals prepare, and the WSOL one can take the stranger's unit too.
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000001" });
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000002" }), /exceeds/);
    // A balance below the book still blocks: that is never a stranger's gift.
    f.controls.wsol = 49_999_999n;
    const short = await f.app.status(f.scope);
    assert.equal(short.live.canExit, false); assert.match(short.live.blockers.join(" "), /below recorded trades/);
  } finally { f.raw.close(); }
});

test("a live binding saved before SOL sell limits existed is shown as not ready, not silently refused", async () => {
  const f = await fixture();
  try {
    const { perTradeWsol: _p, dailyWsol: _d, ...unbounded } = limits;
    const binding = (await f.bindings.get(TENANT))!; await f.bindings.settings(TENANT, f.owner, binding.revision, "live", unbounded);
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /SOL sell limits/);
    await assert.rejects(f.app.prepareLive(f.scope, { limits: unbounded, sessionPublicKey: f.session }), /SOL sell limits/);
  } finally { f.raw.close(); }
});

test("the local test program id is never accepted for live trading (audit GAP4-3)", async () => {
  const f = await fixture();
  try {
    await f.live();
    const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_VAULT_PROGRAM: SOLANA_VAULT_LOCAL_TEST_PROGRAM } });
    const status = await app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /local test id/);
    await assert.rejects(app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), /local test id/);
    await assert.rejects(app.prepareOwnerAction(f.scope, { action: "revoke" }), /local test id/);
    // Only a harness that asks for the local build accepts its id.
    const harness = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_VAULT_PROGRAM: SOLANA_VAULT_LOCAL_TEST_PROGRAM }, localTestDeployment: true });
    assert.doesNotMatch((await harness.status(f.scope)).live.blockers.join(" "), /local test id/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("an audited binary built for another program id is refused before any owner transaction (audit GAP4-3)", async () => {
  // Immutable and hash-matching, but its declare_id is the local test id.
  const f = await fixture({ declared: SOLANA_VAULT_LOCAL_TEST_PROGRAM });
  try {
    await f.live(); f.controls.initialized = true;
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /different program id/);
    await assert.rejects(f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), /different program id/);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }), /different program id/);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing was prepared for the owner to sign");
  } finally { f.raw.close(); }
  // The same deployment check passes for the build that declares the configured id.
  const g = await fixture();
  try {
    await g.live();
    assert.doesNotMatch((await g.app.status(g.scope)).live.blockers.join(" "), /program id/);
    await g.app.prepareLive(g.scope, { limits, sessionPublicKey: g.session });
  } finally { g.raw.close(); }
});

/** Reads of the vault program's ProgramData: the expensive part of a deployment check. */
const programDataReads = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.method === "getAccountInfo" && c.key === f.dataAddress).length;

test("a live status verifies the vault binary once per recheck window, not on every call (audit web-auth F1, agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    await f.app.status(f.scope);
    const first = programDataReads(f);
    assert.ok(first > 0, "the first status checks the deployment");
    for (let i = 0; i < 5; i++) await f.app.status(f.scope);
    assert.equal(programDataReads(f), first, "later status calls reuse the successful check");
    f.clock.now += SOLANA_DEPLOYMENT_RECHECK_MS;
    await f.app.status(f.scope);
    assert.ok(programDataReads(f) > first, "the check runs again once the window passes");
  } finally { f.raw.close(); }
});

test("a deployment check is redone when its configuration changes, and a failure is never reused (audit web-auth F1)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    const env: Record<string, string | undefined> = { ...f.env };
    const app = f.runtime({ env });
    assert.doesNotMatch((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/);
    const verifiedReads = programDataReads(f);
    env.MERRYMEN_SOLANA_VAULT_SHA256 = "00".repeat(32);
    for (let i = 0; i < 2; i++) assert.match((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/, "a changed hash is checked, and refused");
    const refusedReads = programDataReads(f);
    assert.ok(refusedReads > verifiedReads);
    env.MERRYMEN_SOLANA_VAULT_SHA256 = f.env.MERRYMEN_SOLANA_VAULT_SHA256;
    assert.doesNotMatch((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/);
    assert.ok(programDataReads(f) > refusedReads, "restoring the hash checks again rather than trusting an old result");
  } finally { f.raw.close(); }
});

test("a paper-only status, and the worker's paper strategy, make no RPC reads at all (audit web-auth F1, agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const status = await f.app.status(f.scope);
    assert.ok(status.paper); assert.equal(status.live.programId, PROGRAM, "the configured program is still shown");
    assert.deepEqual(f.calls, []);
    // A paper strategy on an account that also has a live book: the worker reads only the paper book.
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify({ hwmRaw: "0", cashRaw: "0", wsolRaw: "0",
      costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 }));
    const binding = (await f.bindings.get(TENANT))!;
    await f.bindings.strategy(TENANT, f.owner, binding.revision, { enabled: true, targetSolBps: 5000, rebalanceBps: 100, tradeUsdgRaw: "1000000", intervalSeconds: 60 } as never);
    const agent = createSolanaAgent({ db: f.db, runtime: f.app, market: f.market, now: () => f.clock.now });
    assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
    assert.deepEqual(f.calls, [], "no vault verification or chain read for a paper strategy");
    assert.ok((await f.app.status(f.scope)).live.blockers.length > 0);
  } finally { f.raw.close(); }
});

test("a long worker tick keeps its heartbeat fresh (audit agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const binding = (await f.bindings.get(TENANT))!;
    await f.bindings.strategy(TENANT, f.owner, binding.revision, { enabled: true, targetSolBps: 5000, rebalanceBps: 100, tradeUsdgRaw: "1000000", intervalSeconds: 60 } as never);
    const started = f.clock.now;
    // Each status takes 100 s of wall time, as a slow provider would.
    const slow = { status: async (...args: Parameters<typeof f.app.status>) => { f.clock.now += 100_000; return f.app.status(...args); }, trade: f.app.trade };
    await createSolanaAgent({ db: f.db, runtime: slow, market: f.market, now: () => f.clock.now }).tick();
    const beat = await f.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number };
    assert.ok(f.clock.now - started >= 100_000);
    assert.ok(f.clock.now - Number(beat.last_seen_at_ms) < 90_000, "the UI would otherwise show the worker offline");
  } finally { f.raw.close(); }
});

/** A live account the worker could trade: registered session, live binding, initialized vault. */
async function readyLive(f: Awaited<ReturnType<typeof fixture>>) { await f.live(); f.controls.initialized = true; await f.registered(); }

test("a shared fee payer below the per-transaction fee cap still lets every tenant trade and exit; operators get one alert (audit G2-4)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f);
    const app = f.runtime({ log: line => lines.push(line) });
    assert.equal((await app.status(f.scope)).live.ready, true);
    assert.equal(lines.length, 0, "nothing to say while the payer is funded");
    // Ordinary fee burn: under the 5,000,000-lamport cap, far above what one swap needs.
    f.controls.feePayerLamports = 3_000_000;
    const status = await app.status(f.scope);
    assert.equal(status.live.ready, true, status.live.blockers.join(" | ")); assert.equal(status.live.canExit, true);
    assert.equal(status.live.feePayer?.level, "low"); assert.equal(status.live.feePayer?.lamports, "3000000");
    assert.equal(status.live.feePayer?.lowLamports, "20000000", "default warning: four times the fee cap");
    assert.match(status.live.warnings.join(" "), /fee payer is low \(0\.003 SOL/);
    assert.equal(lines.length, 1); assert.match(lines[0]!, /^\[alert\] Solana fee payer is low: /);
    const event = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
    assert.deepEqual({ solana: event.solana, kind: event.kind, feePayer: event.feePayer, lamports: event.lamports }, { solana: "alert", kind: "fee-payer-low", feePayer: f.feePayer, lamports: "3000000" });
    assert.ok(!lines[0]!.includes(f.owner) && !lines[0]!.includes(TENANT), "no tenant identity in operator logs");
    await app.status(f.scope); await app.status(f.scope);
    assert.equal(lines.length, 1, "repeated reads do not repeat the alert");
    f.clock.now += 10 * 60_000;
    await app.status(f.scope);
    assert.equal(lines.length, 2, "an unresolved alert is repeated every ten minutes");
  } finally { f.raw.close(); }
});

test("the fee payer gates buys and exits only on what one swap actually needs (audit G2-4)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f);
    const app = f.runtime({ log: line => lines.push(line) });
    const exitNeeds = rentExempt(165) + 10_000, buyNeeds = rentExempt(170) + 10_000;
    f.controls.feePayerLamports = buyNeeds;
    assert.equal((await app.status(f.scope)).live.ready, true, "exactly a buy's worth still trades");
    f.controls.feePayerLamports = buyNeeds - 1;
    let status = await app.status(f.scope);
    assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true, "exits stay open");
    assert.match(status.live.blockers.join(" "), /enough for exits, not for buys/); assert.equal(status.live.feePayer?.level, "buys-blocked");
    assert.equal(status.live.feePayer?.exitMinimumLamports, String(exitNeeds)); assert.equal(status.live.feePayer?.buyMinimumLamports, String(buyNeeds));
    f.controls.feePayerLamports = exitNeeds - 1;
    status = await app.status(f.scope);
    assert.equal(status.live.canExit, false); assert.match(status.live.blockers.join(" "), /below the 0\.00204928 SOL one exit needs/);
    f.controls.feePayerLamports = 0; // a drained payer account no longer exists
    assert.equal((await app.status(f.scope)).live.feePayer?.level, "exits-blocked");
    f.controls.feePayerLamports = 100_000_000;
    assert.equal((await app.status(f.scope)).live.ready, true);
    assert.deepEqual(lines.map(line => JSON.parse(line.slice(line.indexOf("{"))).kind ?? JSON.parse(line.slice(line.indexOf("{"))).solana),
      ["fee-payer-low", "fee-payer-buys-blocked", "fee-payer-exits-blocked", "fee-payer-ok"], "one line per change of level");
    assert.ok(lines.slice(0, 3).every(line => line.startsWith("[alert] ")) && !lines[3]!.startsWith("[alert]"));
  } finally { f.raw.close(); }
});

test("the fee payer warning threshold is explicit configuration (audit G2-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.feePayerLamports = 3_000_000;
    const quiet = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "2500000" }, log: () => {} });
    const status = await quiet.status(f.scope);
    assert.equal(status.live.feePayer?.level, "ok"); assert.deepEqual(status.live.warnings, []); assert.equal(status.live.feePayer?.lowLamports, "2500000");
    const broken = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "lots" }, log: () => {} });
    assert.match((await broken.status(f.scope)).live.blockers.join(" "), /warning threshold is misconfigured/);
  } finally { f.raw.close(); }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A provider that kept the owner's signed bytes and reports them finalized, with a vault forged to match. */
const withholding = (f: Fixture): SolanaLiveRead => async (method, params = []) => {
  if (method === "getSignatureStatuses") return f.response([{ confirmationStatus: "finalized", slot: 1000, err: null }]);
  if (method === "getTransaction") return { version: 0, slot: 1000, transaction: [f.controls.signed, "base64"], meta: { err: null } };
  if (method === "getAccountInfo" && params[0] === f.vault) return f.response(account(f.state(f.controls.epoch + 1n, f.controls.sequence + 1n)));
  return f.read(method, params);
};

test("a provider that withholds a revoke and reports it finalized cannot finish it (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.providers.primary = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ownerTransaction?.status, "pending"); assert.match(status.live.blockers.join(" "), /owner transaction is awaiting/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending", "the owner is not told the session was revoked");
    // It never landed: once both providers' finalized banks pass its blockhash, the owner can act again.
    f.providers.primary = null; f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
  } finally { f.raw.close(); }
});

test("a withheld withdrawal reported finalized by one provider books no capital out (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 3n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.providers.primary = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    await f.app.status(f.scope);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.cashRaw, "90000000", "the book still holds the cash");
    assert.deepEqual(await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(), []);
    // An honest fallback that sees the same landed withdrawal finishes it.
    f.providers.fallback = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.cashRaw, "89000000");
  } finally { f.raw.close(); }
});

test("a finalized owner receipt whose vault effect is missing is not believed (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.finalized = true; // both providers show the receipt, but the epoch never moved
    await assert.rejects(f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }), /vault state/);
    assert.match((await f.app.status(f.scope)).live.blockers.join(" "), /Owner transaction confirmation is unavailable/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
    f.controls.epoch = 2n;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
  } finally { f.raw.close(); }
});

test("an owner expiry proof takes its slot and height from one bank, so a stale slot cannot hide a landed revoke (audit execution F1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    // Behind each URL: a current node answers heights, a lagging one slots and signatures.
    // The revoke landed at slot 950, so vault snapshots older than that still show epoch 1.
    const loadBalanced: SolanaLiveRead = async (method, params = []) => {
      if (method === "getBlockHeight") return 5001;
      if (method === "getSlot") return 900;
      if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: 5001, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
      if (method === "getAccountInfo" && params[0] === f.vault) {
        const min = (params[1] as { minContextSlot?: number }).minContextSlot ?? 0;
        return min <= 950 ? { context: { slot: Math.max(900, min) }, value: account(f.state(1n)) } : { context: { slot: 1000 }, value: account(f.state(2n)) };
      }
      return f.read(method, params);
    };
    f.providers.primary = loadBalanced; f.providers.fallback = loadBalanced;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending", "a revoke that ran is never recorded as failed");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
  } finally { f.raw.close(); }
});

test("an unseen owner transaction is sent again, as the same bytes, only while its blockhash can land (audit G2-1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    assert.equal(f.controls.sends, 1);
    await f.app.status(f.scope);
    assert.equal(f.controls.sends, 2, "neither provider has it: rebroadcast");
    f.providers.fallback = async (method, params = []) => method === "getSignatureStatuses" ? f.response([{ confirmationStatus: "processed", slot: 1000, err: null }]) : f.read(method, params);
    await f.app.status(f.scope);
    assert.equal(f.controls.sends, 2, "a provider has seen it: nothing to resend");
    f.providers.fallback = null; f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal(f.controls.sends, 2, "an expired blockhash is never resent");
    assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]));
  } finally { f.raw.close(); }
});

// An owner transaction's floor: one signature fee plus the wallet's own rent-exempt minimum.
const OWNER_BASE = 5_000 + rentExempt(0);

test("an owner without SOL for the fee is told before signing, and nothing is prepared (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    f.controls.ownerLamports = 0; // spent on setup rent
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }), /owner wallet holds 0 SOL\. This transaction needs at least 0\.00089588 SOL/);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null);
    f.controls.ownerLamports = OWNER_BASE - 1;
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "resume-buys" }), /needs at least/);
    f.controls.ownerLamports = OWNER_BASE;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(prepared.requiredLamports, String(OWNER_BASE)); assert.equal(prepared.ownerLamports, String(OWNER_BASE));
  } finally { f.raw.close(); }
});

test("a withdrawal that opens the owner's token account counts its rent, and setup counts every account it opens (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const usdgNeeds = OWNER_BASE + rentExempt(170);
    f.controls.ownerLamports = usdgNeeds - 1;
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" }), /rent for the token accounts it opens/);
    f.controls.ownerLamports = usdgNeeds;
    assert.equal((await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" })).requiredLamports, String(usdgNeeds));
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    await g.live(); g.controls.ownerAtas = true; g.controls.ownerLamports = OWNER_BASE;
    g.controls.initialized = true;
    // With its token accounts open, a withdrawal costs only the fee.
    assert.equal((await g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1" })).requiredLamports, String(OWNER_BASE));
  } finally { g.raw.close(); }
  const h = await fixture();
  try {
    await h.live();
    // A first setup opens the vault and the owner's two token accounts (the fixture's vault token accounts already exist).
    const setupNeeds = OWNER_BASE + rentExempt(SOLANA_VAULT_ACCOUNT_SIZE) + rentExempt(170) + rentExempt(165);
    h.controls.ownerLamports = setupNeeds - 1;
    await assert.rejects(h.app.prepareLive(h.scope, { limits, sessionPublicKey: h.session }), /needs at least/);
    h.controls.ownerLamports = setupNeeds;
    assert.equal((await h.app.prepareLive(h.scope, { limits, sessionPublicKey: h.session })).requiredLamports, String(setupNeeds));
  } finally { h.raw.close(); }
});

test("status shows what the owner wallet needs to revoke and withdraw, and warns when it is short (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    let status = await f.app.status(f.scope);
    assert.deepEqual(status.live.ownerWallet, { lamports: "100000000", revokeLamports: String(OWNER_BASE), withdrawLamports: String(OWNER_BASE + rentExempt(170)) });
    assert.deepEqual(status.live.warnings, []);
    f.controls.ownerLamports = OWNER_BASE;
    status = await f.app.status(f.scope);
    assert.match(status.live.warnings.join(" "), /enough to revoke, but a withdrawal may need up to 0\.00296996 SOL/);
    assert.equal(status.live.ready, true, "an owner warning never blocks the worker");
    f.controls.ownerLamports = 0;
    assert.match((await f.app.status(f.scope)).live.warnings.join(" "), /too little to revoke or withdraw/);
  } finally { f.raw.close(); }
});

/** The prepared transaction's instructions: program, accounts and data. */
function instructionsOf(transactionBase64: string) {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  return message.instructions.map(ix => ({ program: message.staticAccounts[ix.programAddressIndex] as string,
    accounts: (ix.accountIndices ?? []).map(i => message.staticAccounts[i] as string), data: Buffer.from(ix.data ?? []) }));
}
const WITHDRAW_SOL = Buffer.from([145, 131, 74, 136, 65, 137, 42, 38]);
/** SQLite rows as plain objects. */
const rows = async (f: Fixture, sql: string) => (await f.db.prepare(sql).all() as object[]).map(row => ({ ...row }));
/** Both providers see the owner transaction finalized and the vault's sequence moved. */
const landOwner = (f: Fixture) => { f.controls.finalized = true; f.controls.sequence += 1n; };

test("the owner can withdraw native SOL held by the vault account itself (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 4n;
    f.controls.vaultNativeLamports = 100; // sent straight to the vault PDA
    const status = await f.app.status(f.scope);
    assert.deepEqual(status.live.recoverable, { nativeLamports: "100", unsyncedWsolLamports: "0" });
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "101" }), /native SOL above its rent reserve \(0\.0000001 SOL\)/);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "0" }));
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100" }), /supported owner action/);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" });
    const [withdraw, ...rest] = instructionsOf(prepared.transactionBase64);
    assert.deepEqual(rest, []); assert.equal(withdraw!.program, PROGRAM);
    assert.deepEqual(withdraw!.data, Buffer.concat([WITHDRAW_SOL, Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])])); assert.deepEqual(withdraw!.accounts, [f.vault, f.owner]);
    const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    assert.equal(saved.kind, "withdraw-sol"); assert.equal(saved.amountRaw, "100"); assert.equal(saved.priorSequence, "4");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.deepEqual(await rows(f, "SELECT kind,mint,amount_raw FROM solana_runtime_cashflows"), [{ kind: "withdraw-sol", mint: SYSTEM, amount_raw: "100" }]);
  } finally { f.raw.close(); }
});

test("a dropped native SOL withdrawal resolves on an unchanged sequence, and no trade can move it in between (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 4n; f.controls.vaultNativeLamports = 100;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" });
    // A prepared withdrawal's expiry is proven by its sequence, so admission holds trades meanwhile.
    const store = new SolanaTradingStore(f.db, f.scope, () => f.clock.now);
    await assert.rejects(store.recordSigned({ intent: { owner: f.owner, requestId: "trade-during-withdraw-sol" } } as never), /prepared owner withdrawal/);
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal((await store.setup())!.expiryProof!.vaultSequence, "4");
    assert.deepEqual(await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(), []);
    // A trade at or after the read sequence makes a prepared withdrawal stale.
    await pendingTrade(f, "4"); await landTrade(f, "4");
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" }), /vault changed/);
  } finally { f.raw.close(); }
});

test("a WSOL withdrawal syncs native SOL sent straight to the vault's WSOL account and can take it (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // Without SyncNative these 13 lamports are not WSOL: the old app could never withdraw them.
    f.controls.unsyncedWsolLamports = 13;
    assert.equal((await f.app.status(f.scope)).live.recoverable?.unsyncedWsolLamports, "13");
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "14" }), /exceeds/);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "13" });
    const [sync, create, withdraw] = instructionsOf(prepared.transactionBase64);
    assert.deepEqual(sync, { program: SOLANA_CLASSIC_TOKEN_PROGRAM, accounts: [f.wsolAta], data: Buffer.from([17]) }, "SyncNative runs before the withdrawal");
    assert.equal(create!.program, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"); assert.equal(withdraw!.program, PROGRAM);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.syncedWsolRaw, "13");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.unsyncedWsolLamports = 0; landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.wsolRaw, "0"); assert.equal(after.quarantinedWsolRaw, "0"); assert.equal(after.cashRaw, "90000000"); assert.equal(after.hwmRaw, "90000000");
    const flows = await rows(f, "SELECT kind,mint,amount_raw FROM solana_runtime_cashflows ORDER BY kind");
    assert.deepEqual(flows, [{ kind: "quarantine", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "13" }, { kind: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "13" }]);
    // Nothing unsynced: no SyncNative instruction.
    f.controls.finalized = false;
    const plain = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" });
    assert.ok(!instructionsOf(plain.transactionBase64).some(ix => ix.program === SOLANA_CLASSIC_TOKEN_PROGRAM));
  } finally { f.raw.close(); }
});

test("lamports someone else syncs and the app books before the owner signs are not booked twice (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    f.controls.unsyncedWsolLamports = 13;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "13" });
    // Anyone may call SyncNative. A status read then books the 13 as quarantined WSOL.
    f.controls.unsyncedWsolLamports = 0; f.controls.wsol = 13n;
    await f.app.status(f.scope);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.quarantinedWsolRaw, "13");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.wsol = 0n; landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.quarantinedWsolRaw, "0", "the book matches the chain: nothing left over, nothing double counted");
    const flows = await rows(f, "SELECT kind,amount_raw FROM solana_runtime_cashflows ORDER BY kind");
    assert.deepEqual(flows, [{ kind: "quarantine", amount_raw: "13" }, { kind: "withdraw", amount_raw: "13" }]);
    f.controls.finalized = false;
    assert.ok(!(await f.app.status(f.scope)).live.blockers.some(b => /below recorded/.test(b)));
  } finally { f.raw.close(); }
});

/** SOL at $120: a WSOL→USDG quote pays 0.12 micro-USDG per lamport, and Pyth reads the same price. */
const USD_PER_SOL = 12_000_000_000n;
function pricedMarket(f: Fixture, failQuotes = false): SolanaPaperMarket {
  return { ...f.market, quote: async intent => {
    if (failQuotes) throw new Error("quote service unavailable");
    const amount = BigInt(intent.amountRaw), out = intent.inputMint === SOLANA_WRAPPED_SOL_MINT ? amount * 12n / 100n : amount * 100n / 12n;
    return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: out.toString(),
      minOutAmount: (out * BigInt(10_000 - intent.slippageBps) / 10_000n).toString(), slippageBps: intent.slippageBps,
      contextSlot: 1000, quotedAtMs: f.clock.now, expiresAtMs: f.clock.now + 30_000 };
  } };
}
/** The primary provider also serves Pyth's SOL/USD account. */
function servePyth(f: Fixture) {
  f.providers.primary = async (method, params = []) => method === "getAccountInfo" && params[0] === PYTH_SOL_USD_ACCOUNT
    ? f.response(pythAccount({ price: USD_PER_SOL, publishTimeMs: f.clock.now, postedSlot: 999n })) : f.read(method, params);
}
/** The audit's account: 8 USDG cash and 0.1 SOL (12 USDG at $120), high-water mark 20 USDG. */
async function wsolCapital(f: Fixture) {
  await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 8_000_000n; f.controls.wsol = 100_000_000n; f.controls.ownerAtas = true;
  const book = { hwmRaw: "20000000", cashRaw: "8000000", wsolRaw: "100000000", costBasisUsdgRaw: "12000000", realizedPnlUsdgRaw: "0",
    networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
}
/** The persisted breaker's own test (SolanaTradingStore.recordSigned): would the next buy trip it? */
const breakerTrips = (hwm: bigint, equity: bigint) => hwm === 0n || (hwm - equity) * 10_000n >= hwm * BigInt(limits.maxDrawdownBps);

test("withdrawing WSOL capital in the app lowers the high-water mark by its value, so the drawdown breaker stays armed, not tripped (accounting F3)", async () => {
  const f = await fixture();
  try {
    await wsolCapital(f); servePyth(f);
    const app = f.runtime({ market: pricedMarket(f) });
    const prepared = await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
    const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    // An executable exit quote (50 bps, as the agent exits) and the Pyth bound for the same amount.
    assert.ok(saved.withdrawValuation, "the prepared WSOL withdrawal carries its valuation");
    assert.equal(saved.withdrawValuation.quote.inAmount, "100000000"); assert.equal(saved.withdrawValuation.quote.slippageBps, 50);
    assert.equal(saved.withdrawValuation.quote.minOutAmount, "11940000");
    assert.equal(saved.withdrawValuation.reference.referenceOut, "12000000"); assert.equal(saved.withdrawValuation.reference.reference.slot, 1000);
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.wsol = 0n; landOwner(f);
    assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.wsolRaw, "0"); assert.equal(after.cashRaw, "8000000"); assert.equal(after.costBasisUsdgRaw, "0");
    // It drops by the lower of the quote's guaranteed output and the reference: never more than the SOL was worth.
    assert.equal(after.hwmRaw, String(20_000_000 - 11_940_000));
    assert.equal(breakerTrips(BigInt(after.hwmRaw), BigInt(after.cashRaw)), false, "withdrawing capital is not a drawdown");
    assert.notEqual(after.buyPaused, true);
    assert.equal(breakerTrips(20_000_000n, 8_000_000n), true, "without the valuation the same withdrawal pauses buying");
  } finally { f.raw.close(); }
});

test("a WSOL withdrawal whose value cannot be read still prepares and lands, and leaves the high-water mark where it was", async () => {
  for (const unreadable of ["no quote", "no reference price", "a misconfigured reference tolerance"] as const) {
    const f = await fixture();
    try {
      await wsolCapital(f);
      if (unreadable !== "no reference price") servePyth(f);
      const app = f.runtime({ market: pricedMarket(f, unreadable === "no quote"),
        ...(unreadable === "a misconfigured reference tolerance" ? { env: { ...f.env, MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "nonsense" } } : {}) });
      const prepared = await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "40000000" });
      assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation, undefined, unreadable);
      const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
      await app.submitOwnerAction(f.scope, { signedTransactionBase64 });
      f.controls.wsol = 60_000_000n; landOwner(f);
      assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized", unreadable);
      const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
      assert.equal(after.wsolRaw, "60000000"); assert.equal(after.hwmRaw, "20000000", unreadable);
    } finally { f.raw.close(); }
  }
});

test("a WSOL withdrawal of quarantine alone asks no one for a price", async () => {
  // No position at all, and a position the withdrawal never reaches: quarantined WSOL leaves first.
  for (const position of ["0", "100000000"]) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 8_000_000n; f.controls.wsol = BigInt(position) + 5_000_000n;
      const book = { hwmRaw: "8000000", cashRaw: "8000000", wsolRaw: position, quarantinedWsolRaw: "5000000", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0",
        networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
      await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
      let quotes = 0;
      servePyth(f);
      const app = f.runtime({ market: { ...pricedMarket(f), quote: async intent => { quotes++; return pricedMarket(f).quote(intent); } } });
      await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000000" });
      assert.equal(quotes, 0, position); assert.ok(!f.calls.some(call => call.key === PYTH_SOL_USD_ACCOUNT), position);
      assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation, undefined);
      // One unit more reaches the position: then it is valued.
      if (position !== "0") {
        f.controls.finalized = false;
        await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000001" });
        assert.equal(quotes, 1); assert.ok((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation);
      }
    } finally { f.raw.close(); }
  }
});

/** The ComputeBudget limit and price an owner transaction carries, or null without them. */
function ownerBudget(transactionBase64: string): { units: number; price: bigint } | null {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  const budget = message.instructions.filter(ix => message.staticAccounts[ix.programAddressIndex] === "ComputeBudget111111111111111111111111111111").map(ix => Buffer.from(ix.data!));
  if (!budget.length) return null;
  assert.deepEqual(budget.map(d => d[0]), [2, 3], "one unit limit, then one price");
  return { units: budget[0]!.readUInt32LE(1), price: budget[1]!.readBigUInt64LE(1) };
}

test("owner transactions carry a bounded priority fee the owner can afford, and still prepare without one (audit G2-1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    // Simulated at 20,000 units; recent fees on the accounts it writes put the 75th percentile at 50,000 micro-lamports.
    f.controls.simulatedUnits = 20_000; f.controls.priorityFees = [1_000, 2_000, 50_000, 100_000];
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    // 20,000 × 1.2 + 40,000 is below the 200,000 units a one-instruction revoke gets with no limit: it keeps those.
    assert.deepEqual(ownerBudget(revoke.transactionBase64), { units: 200_000, price: 50_000n });
    assert.equal(revoke.priorityFeeLamports, "10000"); assert.equal(revoke.computeUnitLimit, 200_000);
    assert.equal(revoke.requiredLamports, String(OWNER_BASE + 10_000), "the fee is part of what the owner must hold");
    // The signed bytes are exactly the reviewed message, priority fee included.
    const signedTransactionBase64 = await f.sign(revoke.transactionBase64);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 1); assert.equal(f.sent[0], signedTransactionBase64);
  } finally { f.raw.close(); }
  for (const [ownerLamports, fees, expected] of [
    // Never more than 0.001 SOL in priority fees, however high recent fees are.
    [100_000_000, [1_000_000_000], 1_000_000n],
    // Never more than the owner holds beyond the transaction's own needs: a smaller fee, never a refusal.
    [OWNER_BASE + 640, [1_000_000_000], 640n],
    // Nothing to spare, no estimate, or a failing simulation: no priority fee, exactly as before.
    [OWNER_BASE, [50_000], 0n],
    [100_000_000, null, 0n],
    [100_000_000, "simulation", 0n],
  ] as const) {
    const g = await fixture();
    try {
      await readyLive(g);
      g.controls.ownerLamports = ownerLamports; g.controls.simulatedUnits = 20_000;
      g.controls.priorityFees = Array.isArray(fees) ? [...fees] : null; g.controls.simulationFails = fees === "simulation";
      const prepared = await g.app.prepareOwnerAction(g.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, expected.toString(), `${ownerLamports} ${String(fees)}`);
      assert.equal(prepared.requiredLamports, String(OWNER_BASE + Number(expected)));
      const budget = ownerBudget(prepared.transactionBase64);
      if (expected === 0n) assert.equal(budget, null);
      else assert.equal((budget!.price * BigInt(budget!.units) + 999_999n) / 1_000_000n, expected);
    } finally { g.raw.close(); }
  }
  // A withdrawal's fee estimate covers the accounts it writes: the vault, its token account and the owner's.
  const h = await fixture();
  try {
    await readyLive(h); h.controls.cash = 5_000_000n; h.controls.simulatedUnits = 30_000; h.controls.priorityFees = [10_000];
    const prepared = await h.app.prepareOwnerAction(h.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal(ownerBudget(prepared.transactionBase64)!.price, 10_000n);
    const estimate = h.calls.filter(call => call.method === "getRecentPrioritizationFees").at(-1)!.key as string[];
    for (const account of [h.owner, h.vault, h.cashAta, h.ownerCashAta]) assert.ok(estimate.includes(account), account);
  } finally { h.raw.close(); }
});

test("one provider's under-reported simulation never signs an owner compute limit below the runtime default", async () => {
  // Unit: the simulation plus headroom, floored at 200,000 per instruction, capped at 1,400,000.
  assert.equal(solanaOwnerComputeUnitLimit(1, 1), 200_000);
  assert.equal(solanaOwnerComputeUnitLimit(1, 2), 400_000);
  assert.equal(solanaOwnerComputeUnitLimit(500_000, 1), 640_000);
  assert.equal(solanaOwnerComputeUnitLimit(1_300_000, 1), 1_400_000);
  assert.equal(solanaOwnerComputeUnitLimit(1, 9), 1_400_000);
  const f = await fixture();
  try {
    await readyLive(f); f.controls.cash = 5_000_000n;
    // A provider answers that the transaction used 1 compute unit.
    f.controls.simulatedUnits = 1; f.controls.priorityFees = [1_000_000_000];
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(revoke.computeUnitLimit, 200_000, "one instruction: what a revoke gets with no limit at all");
    assert.equal(ownerBudget(revoke.transactionBase64)!.units, 200_000);
    // The total fee still never exceeds the owner's cap: the price shrinks as the units grow.
    assert.equal(revoke.priorityFeeLamports, "1000000");
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal(withdraw.computeUnitLimit, 400_000, "open the owner's token account, then withdraw: two instructions");
    const budget = ownerBudget(withdraw.transactionBase64)!;
    assert.equal(budget.units, 400_000);
    assert.ok((budget.price * 400_000n + 999_999n) / 1_000_000n <= 1_000_000n);
    assert.equal(withdraw.priorityFeeLamports, "1000000");
  } finally { f.raw.close(); }
});

test("a slow priority-fee read leaves the owner transaction without a fee instead of failing it (audit G2-1, owner half)", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    f.controls.simulatedUnits = 20_000; f.controls.priorityFees = [50_000];
    // Every read session has a hard deadline, as the live transport does. The
    // simulation never answers: inside the blockhash and cost session it would
    // fail the whole revoke at that deadline.
    let simulations = 0;
    const slow: SolanaLiveRead = (method, params) => {
      if (method === "simulateTransaction") { simulations++; return new Promise(() => undefined); }
      return f.read(method, params);
    };
    const rpc: SolanaLiveRpc = { ...f.rpc, read: fn => withSolanaReadDeadline(() => fn(slow), 2_000),
      readEach: async fn => [await withSolanaReadDeadline(() => fn(slow), 2_000), await withSolanaReadDeadline(() => fn(slow), 2_000)] };
    const app = f.runtime({ rpc, ownerFeeReadMs: 20 });
    const revoke = await app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(simulations, 1, "the fee was attempted");
    assert.equal(revoke.priorityFeeLamports, "0"); assert.equal(revoke.computeUnitLimit, null);
    assert.equal(ownerBudget(revoke.transactionBase64), null, "no priority fee, exactly as before");
    assert.equal(revoke.requiredLamports, String(OWNER_BASE));
    // The prepared revoke is saved and signs normally.
    const signedTransactionBase64 = await f.sign(revoke.transactionBase64);
    assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    // A provider session that never ends: only the fee reads' own short deadline lets the revoke prepare.
    const e = await fixture();
    try {
      await readyLive(e); e.controls.simulatedUnits = 20_000; e.controls.priorityFees = [50_000];
      const hang: SolanaLiveRead = (method, params) => method === "simulateTransaction" ? new Promise(() => undefined) : e.read(method, params);
      const prepared = await e.runtime({ rpc: { ...e.rpc, read: fn => fn(hang) }, ownerFeeReadMs: 20 }).prepareOwnerAction(e.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, "0");
    } finally { e.raw.close(); }
    // A fee read that throws (the provider refuses simulation) is no fee either.
    const g = await fixture();
    try {
      await readyLive(g); g.controls.priorityFees = [50_000];
      const refusing: SolanaLiveRead = (method, params) => method === "simulateTransaction" ? Promise.reject(new Error("refused")) : g.read(method, params);
      const prepared = await g.runtime({ rpc: { ...g.rpc, read: fn => fn(refusing) } }).prepareOwnerAction(g.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, "0");
    } finally { g.raw.close(); }
  } finally { f.raw.close(); }
});

test("status names the RPC configuration an operator must fix: no independent fallback, or no second provider", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    // The live transport is built from the environment, and it refuses one provider before any request.
    const unpaired = f.runtime({ rpc: undefined, env: { ...f.env, MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example" } });
    const missing = await unpaired.status(f.scope);
    assert.equal(missing.live.ready, false); assert.equal(missing.live.canExit, false);
    assert.ok(missing.live.blockers.includes(SOLANA_STATUS_NO_FALLBACK), missing.live.blockers.join(" | "));
    assert.equal(SOLANA_STATUS_NO_FALLBACK, "Live trading needs a second, independent RPC provider; an operator must configure one.");
    // The owner is never shown a deployment variable's name (the RPC error's own text names one).
    assert.match(new SolanaRpcError("invalid-fallback").message, /MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK/);
    assert.doesNotMatch(missing.live.blockers.join(" "), /MERRYMEN_|could not be verified/);
    // A transport that cannot ask two providers cannot verify the deployment.
    const { readEach: _readEach, ...single } = f.rpc;
    const lone = await f.runtime({ rpc: single }).status(f.scope);
    assert.ok(lone.live.blockers.includes(new SolanaRpcError("no-quorum").message), lone.live.blockers.join(" | "));
    assert.doesNotMatch(lone.live.blockers.join(" "), /MERRYMEN_/);
    // Any other provider failure stays generic: its text is never shown.
    const failing = await f.runtime({ rpc: { ...f.rpc, read: async () => { throw new SolanaRpcError("timeout"); } } }).status(f.scope);
    assert.match(failing.live.blockers.join(" "), /could not be verified/);
    assert.ok(!failing.live.blockers.includes(new SolanaRpcError("timeout").message));
  } finally { f.raw.close(); }
});

test("status tells the owner to reopen a token account a waiting donation needs, and only then (executor owner-refund)", async () => {
  const cases = [
    // [donated mint, owner token accounts, owner account state, blocked, exits open]
    { mint: SOLANA_USDG_MINT, ownerAtas: false, blocked: true, canExit: true },
    { mint: SOLANA_WRAPPED_SOL_MINT, ownerAtas: false, blocked: true, canExit: false },
    { mint: SOLANA_WRAPPED_SOL_MINT, ownerAtas: true, delegate: true, blocked: true, canExit: false },
    { mint: SOLANA_USDG_MINT, ownerAtas: true, blocked: false, canExit: true },
    { mint: null, ownerAtas: false, blocked: false, canExit: true },
  ] as const;
  for (const item of cases) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.sequence = 4n; f.controls.ownerAtas = item.ownerAtas;
      if (item.mint) {
        const program = item.mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
        const authority = await deriveSolanaSwapAuthority(PROGRAM, f.vault, 4n);
        f.extra.set(await deriveSolanaAta(authority, item.mint, program), account(f.tokenAccount(item.mint, 7n, authority), program));
        // A temporary account at an earlier sequence is stranded, never a blocker.
        const stale = await deriveSolanaSwapAuthority(PROGRAM, f.vault, 3n);
        f.extra.set(await deriveSolanaAta(stale, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), account(f.tokenAccount(SOLANA_USDG_MINT, 9n, stale), TOKEN_2022_PROGRAM));
      }
      if ("delegate" in item) {
        const data = f.tokenAccount(SOLANA_WRAPPED_SOL_MINT, 0n, f.owner); data.writeUInt32LE(1, 72);
        f.extra.set(f.ownerWsolAta, account(data, SOLANA_CLASSIC_TOKEN_PROGRAM));
      }
      const status = await f.app.status(f.scope), text = status.live.blockers.join(" | ");
      const label = JSON.stringify(item);
      assert.equal(/next swap account/.test(text), item.blocked, `${label}: ${text}`);
      assert.equal(status.live.ready, !item.blocked, label); assert.equal(status.live.canExit, item.canExit, label);
      if (item.blocked) assert.match(text, new RegExp(`Reopen your ${item.mint === SOLANA_USDG_MINT ? "USDG" : "wrapped SOL"} token account`), label);
      assert.notEqual(status.live.balances, null, "the vault is still shown");
    } finally { f.raw.close(); }
  }
});

test("misconfigured swap prices block trading and exits but still show the vault, fee payer, owner wallet and recoverable SOL", async () => {
  for (const env of [{ MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "2000", MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "1000" },
    { MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "lots" }]) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.cash = 5_000_000n; f.controls.vaultNativeLamports = 1234;
      const status = await f.runtime({ env: { ...f.env, ...env } }).status(f.scope);
      const text = status.live.blockers.join(" | ");
      assert.match(text, /compute-unit price settings are misconfigured/, JSON.stringify(env));
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false, "exits are refused too");
      assert.doesNotMatch(text, /could not be verified/);
      assert.equal(status.live.vault, f.vault); assert.equal(status.live.balances?.cashUsdg, "5000000");
      assert.equal(status.live.feePayer?.level, "ok"); assert.notEqual(status.live.ownerWallet, null);
      assert.equal(status.live.recoverable?.nativeLamports, "1234");
    } finally { f.raw.close(); }
  }
});

/** Rejects with a SolanaAppRuntimeError of `code` whose message matches `message`. */
async function rejectsWith(promise: Promise<unknown>, code: SolanaAppRuntimeError["code"], message: RegExp, label = "") {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SolanaAppRuntimeError, `${label}: ${String(error)}`);
    assert.equal(error.code, code, `${label}: ${error.message}`); assert.match(error.message, message, label);
    return true;
  });
}

test("an activation reads the vault no earlier than the slot its permission finalized at, so a lagging RPC cannot refuse a valid permission", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    // It finalizes at slot 1000 (both providers agree), and the server records that slot.
    f.controls.initialized = true; f.controls.finalized = true;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.finalizedSlot, 1000);
    // The provider that answers single reads lags at slot 999, where the vault still holds an
    // older permission (another session key). Asked for slot 1000 or later it errors, as a
    // real RPC does ("minimum context slot has not been reached").
    const stale = f.state(); keyBytes(key(5)).copy(stale, 42);
    const floors: unknown[] = [];
    f.providers.primary = async (method, params = []) => {
      if (method === "getAccountInfo" && params[0] === f.vault && (params[1] as { commitment?: string }).commitment === "confirmed") {
        const floor = (params[1] as { minContextSlot?: number }).minContextSlot; floors.push(floor);
        if ((floor ?? 0) > 999) throw new SolanaRpcError("rpc");
        return { context: { slot: 999 }, value: account(stale) };
      }
      return f.read(method, params);
    };
    const activate = () => f.app.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    await assert.rejects(activate(), (error: unknown) => error instanceof SolanaRpcError, "a retry, never a refusal of the signed limits");
    assert.deepEqual(floors, [1000]);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).session(), null, "nothing registered from a stale read");
    // Caught up: the same activation succeeds.
    f.providers.primary = null;
    assert.deepEqual(await activate(), { registered: true, session: f.session, vault: f.vault });
  } finally { f.raw.close(); }
});

test("owner bytes refused before anything is saved are 'not-saved'; trouble with saved bytes is 'outcome-unknown', never 'invalid'", async () => {
  const f = await fixture();
  try {
    await f.live();
    const store = () => new SolanaTradingStore(f.db, f.scope);
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: "AQ==" }), "not-saved", /Prepare this owner transaction/, "nothing prepared");
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    for (const [label, bytes, message] of [
      ["not base64", "%%%", /Invalid encoded Solana transaction/],
      ["not a transaction", Buffer.from([1, 2, 3]).toString("base64"), /Invalid encoded Solana transaction/],
      ["unsigned", setup.transactionBase64, /owner signature or reviewed transaction does not match/],
    ] as const) {
      await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: bytes }), "not-saved", message, label);
    }
    // A store refusal (the prepared transaction expired) also saves nothing.
    f.clock.now += 61_000;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "not-saved", /expired before submission/, "expired");
    assert.equal((await store().setup())!.signature, undefined); assert.equal(f.controls.sends, 0);
    f.clock.now -= 61_000;
    // Saved and broadcast; then other bytes are refused, not saved.
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending"); assert.equal(f.controls.sends, 1);
    const altered = Buffer.from(signedTransactionBase64, "base64"); altered[1] = altered[1]! ^ 1;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: altered.toString("base64") }), "not-saved", /does not match/, "a forged signature");
    // The saved bytes' confirmation is malformed: their outcome is unknown.
    f.controls.finalized = true; f.controls.malformed = true;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "outcome-unknown", /^Invalid owner transaction confirmation\.$|^Owner confirmation does not match the saved transaction\.$/, "malformed");
    assert.equal((await store().setup())!.status, "pending");
    // A receipt whose vault effect is missing is not believed: also an unknown outcome.
    f.controls.malformed = false;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "outcome-unknown", /^Owner confirmation does not match the vault state\.$/, "no vault effect");
    // And an activation of such a permission is a retry, not a refusal.
    await rejectsWith(f.app.activateLive(f.scope, { signature: getBase58Decoder().decode(Buffer.from(signedTransactionBase64, "base64").subarray(1, 65)), sessionSecretKey: f.sessionSeed.toString("base64") }),
      "outcome-unknown", /does not match the vault state/, "activation");
    assert.equal(f.controls.sends, 1, "nothing is sent again for a finalized-looking receipt");
  } finally { f.raw.close(); }
});

test("not-saved speaks only for this request: bytes an earlier request saved, sent and finalized are refused that way once replaced", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.vaultNativeLamports = 100;
    const first = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "50" });
    const signedTransactionBase64 = await f.sign(first.transactionBase64);
    const { signature } = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    assert.equal(f.controls.sends, 1);
    landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    // A new prepare replaces the setup; the old bytes no longer match it.
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "10" });
    await rejectsWith(f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }), "not-saved", /does not match/, "landed earlier");
    // This request saved and sent nothing, but the bytes did land: the server's record still shows it.
    assert.equal(f.controls.sends, 1);
    assert.deepEqual(await rows(f, `SELECT evidence_id,kind FROM solana_runtime_cashflows WHERE kind='withdraw-sol'`), [{ evidence_id: signature, kind: "withdraw-sol" }]);
  } finally { f.raw.close(); }
});

test("a permission whose saved limits expire inside the prepare window is refused as not-saved, and nothing is saved or sent", async () => {
  const f = await fixture();
  try {
    // The limits expire 30 seconds after the permission is prepared; the prepare window is 60 seconds.
    f.clock.now = limits.expiresAtMs - 30_000;
    await f.live();
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    f.clock.now = limits.expiresAtMs + 1_000;
    assert.ok(f.clock.now < setup.expiresAtMs, "still inside the prepare window");
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "not-saved", /^The saved trading limits are no longer valid/, "expired limits");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.signature, undefined, "nothing saved");
    assert.equal(f.controls.sends, 0, "nothing sent");
  } finally { f.raw.close(); }
});

test("a permission is prepared only from limits within the account bounds, paper-shaped ones included, before any chain read", async () => {
  const f = await fixture();
  try {
    await f.live();
    const { perTradeWsol: _perTrade, dailyWsol: _daily, ...paperShaped } = limits;
    for (const wide of [{ ...paperShaped, maxOpsPerDay: 500 }, { ...limits, maxOpsPerDay: 97 }, { ...paperShaped, expiresAtMs: f.clock.now + 169 * 3_600_000 }]) {
      f.calls.length = 0;
      await assert.rejects(f.app.prepareLive(f.scope, { limits: wide, sessionPublicKey: f.session }),
        (error: unknown) => error instanceof SolanaPaperValidationError && /between 1 and 96|168 hours/.test(error.message), JSON.stringify(wide));
      assert.deepEqual(f.calls, [], "refused before any RPC read");
    }
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
  } finally { f.raw.close(); }
});

test("a trade carries the owner's previewed minimum beside its intent: paper is held to it, a retry is not, and a preview takes none", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const paper = () => new SolanaTradingStore(f.db, f.scope).paper().get(f.owner);
    // The fixture market guarantees 995,000 for this 1,000,000 buy.
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "995001" } }), /below the previewed minimum/);
    assert.equal((await paper())!.trades.length, 0);
    const placed = await f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "995000" } });
    for (const retry of [{ ...f.trade, minOutAmount: "999999999" }, f.trade]) assert.deepEqual(await f.app.trade(f.scope, { mode: "paper", intent: retry }), placed);
    assert.equal((await paper())!.trades.length, 1);
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, requestId: "next", minOutAmount: "0" } }), SolanaPaperValidationError);
    // A preview is not a trade: it takes no floor.
    await assert.rejects(f.app.preview(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "1" } }), /unsupported fields/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a retry of a recorded live trade is returned whatever previewed minimum it carries; another trade under its id still conflicts", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await ensureSolanaTradingSchema(f.db);
    const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "owner-retry", owner: f.owner, vault: f.vault,
      inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 };
    const submission = { intent, programId: PROGRAM, signature: "owner-retry-signature", minContextSlot: 1000, preparedAtMs: f.clock.now,
      minOutAmount: "995000", quotedOutAmount: "1000000", vaultSequence: "0", sessionEpoch: "1" };
    await f.db.prepare("INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(f.scope.tenant, f.owner, intent.requestId, f.vault, "0", submission.signature, "pending", f.clock.now, "1000000", JSON.stringify(submission));
    // Both providers have seen the signature (processed), so the record stays pending and nothing is sent again.
    const seen: SolanaLiveRead = async (method, params = []) => method === "getSignatureStatuses" ? f.response([{ confirmationStatus: "processed", slot: 1000, err: null }])
      : method === "getTransaction" ? null : f.read(method, params);
    f.providers.primary = seen; f.providers.fallback = seen;
    const { owner: _owner, vault: _vault, ...asked } = intent;
    const answers = [];
    for (const minOutAmount of ["999999999", "1", undefined]) {
      answers.push(await f.app.trade(f.scope, { mode: "live", intent: minOutAmount === undefined ? asked : { ...asked, minOutAmount } }));
    }
    for (const answer of answers) assert.deepEqual(answer, { mode: "live", requestId: "owner-retry", intent, signature: "owner-retry-signature", status: "pending",
      preparedAtMs: f.clock.now, minOutAmount: "995000", quotedOutAmount: "1000000", settlement: null });
    await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: { ...asked, amountRaw: "2000000", minOutAmount: "1" } }), /different live trade/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a malformed expired-attempt allowance is a status blocker and refuses a live trade as configuration, before anything is signed", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    assert.equal((await f.app.status(f.scope)).live.ready, true, "unset: the default applies");
    for (const value of ["97", "-1", "many"]) {
      const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value } });
      const status = await app.status(f.scope);
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false);
      assert.ok(status.live.blockers.some(item => /expired-attempt allowance setting is misconfigured/.test(item)), status.live.blockers.join(" | "));
      await rejectsWith(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: `allowance-${value}` } }), "configuration", /expired-attempt allowance setting is misconfigured/, value);
    }
    assert.equal((await new SolanaTradingStore(f.db, f.scope).pending()).length, 0); assert.equal(f.controls.sends, 0);
    assert.equal((await f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "96" } }).status(f.scope)).live.ready, true);
  } finally { f.raw.close(); }
});
