import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder,
  getBase64EncodedWireTransaction, getTransactionDecoder, signTransaction } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { SolanaTradingStore } from "./solana-trading-store";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false) {
  return { owner, executable, lamports: 100_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}
async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "paper", limits);
  const dataAddress = key(41), binary = Buffer.from("runtime-tested-binary"), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, finalized: false, failed: false, malformed: false, sends: 0, signed: "", signature: "", failSend: true, height: 4900, sequence: 0n };
  const state = () => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [1n, controls.sequence, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
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
  const app = createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now });
  const sign = async (wire: string) => getBase64EncodedWireTransaction(await signTransaction([ownerKeys], getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  const live = async () => { const binding = (await bindings.get(TENANT))!; await bindings.settings(TENANT, owner, binding.revision, "live", limits); };
  const trade = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "runtime-test", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 };
  return { raw, db, clock, scope, owner, session, sessionSeed, controls, bindings, app, sign, live, trade, env, rpc, market };
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
    const app = createSolanaAppRuntime({ db: f.db, rpc: f.rpc, market: f.market, env: {}, now: () => f.clock.now });
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
    const restarted = createSolanaAppRuntime({ db: f.db, rpc: f.rpc, market: f.market, env: f.env, now: () => f.clock.now });
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

test("expiry does not resolve an ambiguous owner transaction when the vault sequence advanced", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.sequence = 1n;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});
