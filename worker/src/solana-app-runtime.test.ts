import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder,
  getBase64EncodedWireTransaction, getTransactionDecoder, signTransaction } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { sealSecret } from "./store-crypto";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "./solana-trading-store";

const TENANT = "0x1111111111111111111111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
// A production-style program id: the runtimes below run every live deployment check.
const PROGRAM = key(77), LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false) {
  return { owner, executable, lamports: 100_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}
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
    cash: 0n, wsol: 0n };
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const tokenAccount = (mint: string, amount: bigint) => {
    const b = Buffer.alloc(165); keyBytes(mint).copy(b, 0); keyBytes(vault).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; return b;
  };
  const state = () => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [controls.epoch, controls.sequence, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  const read: SolanaLiveRead = async (method, params = []) => {
    if (method === "getSlot") return 1000;
    if (method === "getBlockHeight") return controls.height;
    if (method === "getAccountInfo") {
      if (params[0] === PROGRAM) return response(account(program, LOADER, true));
      if (params[0] === dataAddress) {
        const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
        return response({ ...account(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
      }
      if (params[0] === vault) return response(controls.initialized ? account(state()) : null);
      return response(account(Buffer.alloc(0), "11111111111111111111111111111111"));
    }
    if (method === "getMultipleAccounts") {
      assert.deepEqual(params[0], [cashAta, wsolAta]);
      return response([account(tokenAccount(SOLANA_USDG_MINT, controls.cash), TOKEN_2022_PROGRAM), account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, controls.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM)]);
    }
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([controls.finalized ? { confirmationStatus: "finalized", slot: 1000, ...(controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null }) } : null]);
    if (method === "getTransaction") return controls.finalized ? { version: 0, slot: 1000, transaction: [controls.signed, "base64"], meta: controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null } } : null;
    throw new Error(`Unexpected test RPC ${method}`);
  };
  const rpc: SolanaLiveRpc = { read: fn => fn(read), send: async wire => {
    controls.sends++;
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
  return { raw, db, clock, scope, owner, session, sessionSeed, controls, bindings, app, runtime, sign, live, trade, env, rpc, market, registered, programData, dataAddress };
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

test("owner setup persists exact signed bytes before send and survives a lost response without rebroadcast", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    assert.equal(first.status, "pending"); assert.equal(f.controls.sends, 1);
    const restarted = f.runtime();
    assert.deepEqual(await restarted.submitSetup(f.scope, { signedTransactionBase64 }), first); assert.equal(f.controls.sends, 1);
    f.controls.initialized = true; f.controls.finalized = true;
    await assert.rejects(restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: Buffer.alloc(32, 99).toString("base64") }), /does not match/);
    await restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    const stored = await f.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions").get() as { sealed_seed: string };
    assert.ok(!stored.sealed_seed.includes(f.sessionSeed.toString("base64")));
    assert.equal((await new SolanaTradingStore(f.db, f.scope).session())!.session, f.session);
    assert.equal(f.controls.sends, 1);
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
    f.controls.height = 5001;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "failed");
    const saved = await new SolanaTradingStore(f.db, f.scope).setup();
    assert.equal(saved!.expiryProof!.blockHeight, "5001"); assert.equal(saved!.expiryProof!.vaultSequence, null);
    assert.equal(f.controls.sends, 1);
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
      assert.equal(f.controls.sends, 1, "resolved without a replacement transaction");
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
