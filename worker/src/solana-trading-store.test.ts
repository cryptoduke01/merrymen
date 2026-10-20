import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT, SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import { ensureSolanaTradingSchema, SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, solanaAutonomousSchedule, solanaExpiredAttemptAllowance, SolanaTradingStore,
  type SolanaPreparedSetup } from "./solana-trading-store";
import type { SolanaLiveSettlement, SolanaSignedSubmission } from "./solana-executor";
import { createSolanaPaperService } from "./solana-paper-service";
import { pythBound } from "./solana-reference-price-fixture";
import { releaseSolanaOperatorHold, setSolanaOperatorHold } from "./solana-operator-hold";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TENANT = `0x${"11".repeat(20)}` as const, OTHER = `0x${"22".repeat(20)}` as const;
const OWNER = key(20), VAULT = key(21), SESSION = key(22), PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const NOW = 1_000_000, CASH = 100_000_000n;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };
const dek = Buffer.alloc(32, 3), sessionSeed = Buffer.alloc(32, 4).toString("base64");
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };
function submission(id = "trade-1", seq = "0"): SolanaSignedSubmission {
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  const intent = { kind: "spl-swap" as const, chain: CHAINS.solana, mode: "live" as const, requestId: id, owner: OWNER, vault: VAULT,
    inputMint: quote.inputMint, outputMint: quote.outputMint, amountRaw: quote.inAmount, slippageBps: 100 };
  return { version: 1, intent, programId: PROGRAM,
    session: SESSION, feePayer: key(23), sessionEpoch: "1", vaultSequence: seq, signature: `test-signature-${id}`,
    signedTransactionBase64: "dGVzdC1zaWduZWQ=", messageBase64: "dGVzdC1tZXNzYWdl", loadedAddresses: { writable: [], readonly: [] },
    recentBlockhash: key(24), lastValidBlockHeight: "1200", minContextSlot: 1000, minOutAmount: quote.minOutAmount,
    quotedOutAmount: quote.outAmount, inputTokenAccount: key(25), outputTokenAccount: key(26), inputTokenProgram: TOKEN_2022_PROGRAM,
    outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, inputBalanceBefore: CASH.toString(), outputBalanceBefore: "0", maxFeeLamports: "3000000",
    feeLamports: "10000", rentLamports: "2039280", preparedAtMs: NOW, safetyObservedAtMs: NOW, quote,
    risk: { observedAtMs: NOW, slot: 1000, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(), cashUsdg: CASH.toString(), wsolRaw: "0",
      reference: pythBound(intent, NOW) } };
}
function settlement(s: SolanaSignedSubmission, status: "finalized" | "failed" = "finalized"): SolanaLiveSettlement {
  return { status, signature: s.signature, slot: 1001, feeLamports: "10000", amountIn: status === "failed" ? "0" : "600000",
    amountOut: status === "failed" ? "0" : "1980000", finalizedAtMs: NOW + 1 };
}
function expired(s: SolanaSignedSubmission): SolanaLiveSettlement {
  return { status: "expired", signature: s.signature, slot: 1001, feeLamports: null, amountIn: "0", amountOut: "0", finalizedAtMs: NOW + 1,
    expiryProof: { vaultSequence: s.vaultSequence, sessionEpoch: s.sessionEpoch, blockHeight: "1201", reason: "blockhash-expired" } };
}
function setup(kind: "session" | "revoke" | "withdraw" | "resume-buys" = "session"): SolanaPreparedSetup {
  return { kind, transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: key(30), lastValidBlockHeight: "1200",
    programId: PROGRAM, vault: VAULT, session: SESSION, limits, preparedAtMs: NOW, expiresAtMs: NOW + 30000 };
}
async function saveSignedSetup(store: SolanaTradingStore, prepared = setup(), signature = "owner-registration") {
  await store.saveSetup(prepared); const signed = { ...prepared, signature, signedTransactionBase64: "c2lnbmVk", status: "pending" as const };
  await store.saveSetup(signed); return signed;
}
async function fixture(t: TestContext, dialect: "sqlite" | "postgres" = "sqlite") {
  const clock = { value: NOW }; let db: Db;
  const root = mkdtempSync(path.join(tmpdir(), "solana-trading-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "ledger.sqlite"); let raw: DatabaseSync | undefined;
  if (dialect === "postgres") {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!); const schema = `solana_test_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  } else { raw = new DatabaseSync(filename); raw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); db = wrapSqlite(raw); t.after(() => raw?.close()); }
  const binding = new SqlSolanaBindingStore(async () => db, dialect, () => clock.value);
  await binding.bind(TENANT, "did:privy:test", OWNER); await binding.settings(TENANT, OWNER, 0, "live", limits);
  await ensureSolanaTradingSchema(db, dialect === "postgres");
  const store = new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  const registered = { programId: PROGRAM, vault: VAULT, session: SESSION, sessionEpoch: "1", registrationSignature: "owner-registration", registeredAtMs: NOW };
  await saveSignedSetup(store); await store.finishSetup("owner-registration", "finalized");
  await store.registerSession(registered, sessionSeed, dek);
  return { db, store, binding, clock, registered, reopen() {
    raw!.close(); raw = new DatabaseSync(filename); db = wrapSqlite(raw);
    return new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  } };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: concurrent admissions reserve one sequence and remain idempotent across lost response`, options, async t => {
    const f = await fixture(t, dialect), first = submission(), second = submission("other");
    const results = await Promise.all([f.store.recordSigned(first), f.store.recordSigned(second)]);
    assert.equal(results.filter(Boolean).length, 1);
    const pending = await f.store.pending(); assert.equal(pending.length, 1);
    assert.equal(await f.store.recordSigned(pending[0]!.submission), false);
    assert.equal(await f.store.recordSigned(submission("fresh-blockhash", "1")), false);
    assert.equal((await f.store.liveBook())!.cashRaw, CASH.toString());
  });
  test(`${dialect}: finalized actual deltas book once; failure releases sequence only for a new request`, options, async t => {
    const f = await fixture(t, dialect), failed = submission("failed");
    await f.store.recordSigned(failed); await f.store.settle(OWNER, failed.intent.requestId, failed.signature, settlement(failed, "failed"));
    assert.equal(await f.store.recordSigned(failed), false);
    const actual = submission("actual"); actual.risk.slot = 1001; assert.equal(await f.store.recordSigned(actual), true);
    const receipt = settlement(actual); await f.store.settle(OWNER, actual.intent.requestId, actual.signature, receipt);
    await f.store.settle(OWNER, actual.intent.requestId, actual.signature, { ...receipt, finalizedAtMs: NOW + 2 });
    const book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, "99400000"); assert.equal(book.wsolRaw, "1980000");
    assert.equal(book.costBasisUsdgRaw, "600000"); assert.equal(book.networkFeesLamports, "20000");
    await assert.rejects(f.store.settle(OWNER, actual.intent.requestId, actual.signature, { ...receipt, amountOut: "1980001" }));
    const duplicate = submission("duplicate-sequence"); duplicate.risk.slot = 1001;
    duplicate.risk.cashUsdg = "99400000"; duplicate.risk.wsolRaw = "1980000";
    assert.equal(await f.store.recordSigned(duplicate), false);
  });
  test(`${dialect}: proven expiry releases notional and sequence but records unknown fees once and never reuses the request`, options, async t => {
    const f = await fixture(t, dialect), original = submission();
    await f.store.recordSigned(original);
    const proof = expired(original);
    assert.equal(proof.status, "expired"); if (proof.status !== "expired") assert.fail();
    await assert.rejects(f.store.settle(OWNER, original.intent.requestId, original.signature,
      { ...proof, expiryProof: { ...proof.expiryProof, vaultSequence: "1" } }), /expiry evidence/);
    await assert.rejects(f.store.settle(OWNER, original.intent.requestId, original.signature,
      { ...proof, expiryProof: { ...proof.expiryProof, blockHeight: "1200" } }), /expiry evidence/);
    await f.store.settle(OWNER, original.intent.requestId, original.signature, proof);
    await f.store.settle(OWNER, original.intent.requestId, original.signature, proof);
    const book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, CASH.toString()); assert.equal(book.wsolRaw, "0");
    assert.equal(book.networkFeesLamports, "0"); assert.equal(book.unresolvedFeeCount, 1); assert.equal(book.reservedUnknownFeeLamports, "10000");
    assert.equal((await f.store.pending()).length, 0); assert.equal(await f.store.recordSigned(original), false);
    // Entire daily token allowance is available again, while the operation remains recorded.
    await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, perTradeUsdg: "1000000", dailyUsdg: "1000000" });
    const next = submission("new-request"); next.risk.slot = 1001;
    assert.equal(await f.store.recordSigned(next), true); assert.equal((await f.store.history()).length, 2);
  });
  test(`${dialect}: current limits and autonomous consent are rechecked under admission lock`, options, async t => {
    const f = await fixture(t, dialect);
    let binding = (await f.binding.get(TENANT))!;
    binding = await f.binding.strategy(TENANT, OWNER, binding.revision, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    await f.binding.strategy(TENANT, OWNER, binding.revision, { ...strategy, enabled: false });
    await assert.rejects(automatic.recordSigned(submission()), /strategy/);
    binding = (await f.binding.get(TENANT))!;
    await f.binding.settings(TENANT, OWNER, binding.revision, "live", { ...limits, perTradeUsdg: "999999" });
    await assert.rejects(f.store.recordSigned(submission()), /per-trade/);
    binding = (await f.binding.get(TENANT))!;
    await f.binding.settings(TENANT, OWNER, binding.revision, "paper", limits);
    await assert.rejects(f.store.recordSigned(submission()), /enabled/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: strategy trade cap remains binding below the account limit after a sell quote moves`, options, async t => {
    const f = await fixture(t, dialect), first = submission();
    await f.store.recordSigned(first); await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
    const binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
    const sell = submission("oversized-exit", "1"); sell.intent.inputMint = SOLANA_WRAPPED_SOL_MINT; sell.intent.outputMint = SOLANA_USDG_MINT;
    sell.quote = { ...sell.quote, inputMint: sell.intent.inputMint, outputMint: sell.intent.outputMint, outAmount: "1005000", minOutAmount: "994950" };
    sell.minOutAmount = sell.quote.minOutAmount; sell.quotedOutAmount = sell.quote.outAmount;
    sell.risk = { ...sell.risk, slot: 1001, cashUsdg: "99400000", wsolRaw: "1980000", notionalUsdg: "1005000", reference: pythBound(sell.intent, NOW) };
    await assert.rejects(automatic.recordSigned(sell), /strategy trade limit/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: stale marks, fee cap, tenant/owner confusion and session replacement cannot admit`, options, async t => {
    const f = await fixture(t, dialect);
    for (const alter of [(s: SolanaSignedSubmission) => { s.safetyObservedAtMs -= 30000; },
      (s: SolanaSignedSubmission) => { s.risk.observedAtMs += 1; },
      (s: SolanaSignedSubmission) => { s.rentLamports = "3000000"; },
      (s: SolanaSignedSubmission) => { s.sessionEpoch = "2"; },
      (s: SolanaSignedSubmission) => { s.intent.owner = key(90); }]) {
      const s = submission(); alter(s); await assert.rejects(f.store.recordSigned(s));
    }
    const crossTenant = new SolanaTradingStore(f.db, { tenant: OTHER, owner: OWNER }, () => NOW);
    await assert.rejects(crossTenant.recordSigned(submission())); await assert.rejects(crossTenant.sessionSeed(dek));
    await assert.rejects(f.store.get(key(90), "trade-1"));
    assert.equal(await f.store.sessionSeed(dek), sessionSeed);
    const stored = await f.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions").get() as { sealed_seed: string };
    assert.ok(!stored.sealed_seed.includes(sessionSeed));
  });
}

test("SQLite durable signed bytes and reservation survive close/reopen without a replacement transaction", async t => {
  const f = await fixture(t); const s = submission(); await f.store.recordSigned(s);
  const reopened = f.reopen(); const persisted = await reopened.get(OWNER, s.intent.requestId);
  assert.equal(persisted!.status, "pending"); assert.deepEqual(persisted!.submission, s);
  assert.equal(await reopened.recordSigned(submission("replacement", "1")), false);
});
test("owner revocation stays available during an ambiguous trade; terminal status and session activation cannot be forged", async t => {
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await assert.rejects(f.store.saveSetup(setup("withdraw")), /pending/);
  const revoke = await saveSignedSetup(f.store, setup("revoke"), "revoke");
  await f.store.finishSetup(revoke.signature, "finalized"); await f.store.finishSetup(revoke.signature, "finalized");
  await assert.rejects(f.store.finishSetup(revoke.signature, "failed"), /cannot be changed/);
  await assert.rejects(f.store.registerSession(f.registered, sessionSeed, dek), /exact finalized/);
  assert.equal((await f.store.pending()).length, 1);
});
test("owner expiry records exact finalized proof atomically and cannot be rebound", async t => {
  const f = await fixture(t);
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1" }, "expired-owner");
  const proof = { reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence: "0", sessionEpoch: "1", slot: 1002 };
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, blockHeight: "1200" }), /expiry evidence/);
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, vaultSequence: "1" }), /expiry evidence/);
  await f.store.finishSetup("expired-owner", "failed", 1002, proof);
  assert.deepEqual((await f.store.setup())!.expiryProof, proof);
  await f.store.finishSetup("expired-owner", "failed", 1002, proof);
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, blockHeight: "1202" }), /cannot be changed/);
  assert.equal(await f.store.liveBook(), null);
});
test("paper admission also checks the locked strategy cap against a moved sell quote", async t => {
  const f = await fixture(t); await f.binding.settings(TENANT, OWNER, 1, "paper", limits);
  await f.store.createPaper(CASH.toString(), limits);
  const binding = await f.binding.strategy(TENANT, OWNER, 2, strategy);
  const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
  const market: Parameters<typeof createSolanaPaperService>[1] = {
    async readMint(mint) { return { address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: NOW, buyBlockedReasons: [] }; },
    async quote(intent) { return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
      outAmount: intent.inputMint === SOLANA_USDG_MINT ? "2000000" : "1005000", minOutAmount: intent.inputMint === SOLANA_USDG_MINT ? "1980000" : "994950",
      slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 }; },
  };
  const service = createSolanaPaperService(automatic.paper(), market, () => NOW, { owner: OWNER });
  const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "initial-buy", inputMint: SOLANA_USDG_MINT,
    outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 100 };
  // The owner's own buy; the strategy's first attempt is the exit.
  const buy = await createSolanaPaperService(f.store.paper(), market, () => NOW, { owner: OWNER }).trade(OWNER, intent);
  await assert.rejects(service.trade(OWNER, { ...intent, requestId: "oversized-exit", inputMint: SOLANA_WRAPPED_SOL_MINT,
    outputMint: SOLANA_USDG_MINT, amountRaw: buy.outputAmountRaw }), /strategy trade limit/);
  const snapshot = (await automatic.paper().get(OWNER))!;
  assert.equal(snapshot.version, 1); assert.equal(snapshot.trades.length, 1); assert.equal(snapshot.positions[0]!.amountRaw, buy.outputAmountRaw);
});
test("shutdown while waiting for the database lock prevents new paper and live admission", async t => {
  for (const mode of ["paper", "live"] as const) {
    const f = await fixture(t);
    let revision = 1;
    if (mode === "paper") {
      await f.binding.settings(TENANT, OWNER, revision++, "paper", limits);
      await f.store.createPaper(CASH.toString(), limits);
    }
    const binding = await f.binding.strategy(TENANT, OWNER, revision, strategy);
    const controller = new AbortController();
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision, signal: controller.signal });
    let unlock!: () => void, entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unlock = resolve; });
    const held = f.db.tx(async () => { entered(); await blocked; }); await acquired;
    const s = submission();
    const { owner: _owner, vault: _vault, ...liveIntent } = s.intent;
    const attempt = mode === "live" ? automatic.recordSigned(s) : automatic.paper().commit({ owner: OWNER,
      intent: { ...liveIntent, mode: "paper" }, quote: s.quote, safetyObservedAtMs: NOW, tokenDecimals: 9, marks: [],
      buyExitQuote: { ...s.quote, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT,
        inAmount: s.quote.minOutAmount, outAmount: "1000000", minOutAmount: "990000" }, expectedVersion: 0, nowMs: NOW });
    controller.abort(); unlock(); await held;
    await assert.rejects(Promise.resolve(attempt), /shutdown/);
    assert.equal((await f.store.pending()).length, 0);
    if (mode === "paper") assert.equal((await automatic.paper().get(OWNER))!.version, 0);
    else assert.equal(await f.store.liveBook(), null);
  }
});
test("finalized deposits adjust cashflow/HWM once; owner withdrawals remove actual holdings and basis without inventing P&L", async t => {
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await assert.rejects(f.store.reconcileExternalInflows({ cashUsdg: "110000000", wsolRaw: "0", slot: 1001, observedAtMs: NOW, commitment: "finalized" }), /pending/);
  await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
  const deposit = { cashUsdg: "109400000", wsolRaw: "1980000", slot: 1002, observedAtMs: NOW, commitment: "finalized" as const };
  await f.store.reconcileExternalInflows(deposit); await f.store.reconcileExternalInflows(deposit);
  assert.equal((await f.store.liveBook())!.hwmRaw, "110000000");
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, cashUsdg: "109400001", slot: 1000 }), /finalized inflows/);
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, cashUsdg: "109399999" }), /below the recorded book/);
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, wsolRaw: "1979999" }), /below the recorded book/);
  // The settled trade ran at sequence 0, so the vault was at 1 when this was prepared.
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-cash");
  await assert.rejects(f.store.finishSetup("withdraw-cash", "finalized"), /slot/);
  await f.store.finishSetup("withdraw-cash", "finalized", 1003); await f.store.finishSetup("withdraw-cash", "finalized", 1003);
  let book = (await f.store.liveBook())!; assert.equal(book.cashRaw, "108400000"); assert.equal(book.hwmRaw, "109000000");
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "2", priorSessionEpoch: "1", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "990000" }, "withdraw-sol");
  await f.store.finishSetup("withdraw-sol", "finalized", 1004);
  book = (await f.store.liveBook())!; assert.equal(book.wsolRaw, "990000"); assert.equal(book.costBasisUsdgRaw, "300000");
  assert.equal(book.realizedPnlUsdgRaw, "0"); assert.equal(book.hwmRaw, "109000000");
  const rows = await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(); assert.equal(rows.length, 3);
});
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a finalized withdrawal is booked even when the book already moved past its slot, once, and the book's slot never moves back`, options, async t => {
    const f = await fixture(t, dialect), s = submission(); await f.store.recordSigned(s);
    await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    // The withdrawal landed at slot 1003 before its signed bytes were saved; meanwhile a
    // 5 USDG deposit landed and a finalized read at slot 2000 booked the net of both.
    const before = (await f.store.liveBook())!;
    await f.store.reconcileExternalInflows({ cashUsdg: (BigInt(before.cashRaw) + 4_000_000n).toString(), wsolRaw: before.wsolRaw, slot: 2000, observedAtMs: NOW, commitment: "finalized" });
    assert.equal((await f.store.liveBook())!.slot, 2000);
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-late");
    // Nothing can move the book while it is pending.
    await assert.rejects(f.store.reconcileExternalInflows({ cashUsdg: "200000000", wsolRaw: before.wsolRaw, slot: 2001, observedAtMs: NOW, commitment: "finalized" }), /pending owner transaction/);
    await assert.rejects(f.store.recordSigned(submission("trade-2", "2")), /pending owner transaction/);
    await f.store.finishSetup("withdraw-late", "finalized", 1003);
    let book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, (BigInt(before.cashRaw) + 3_000_000n).toString(), "the withdrawal is booked");
    assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 3_000_000n).toString());
    assert.equal(book.slot, 2000, "the book's slot never moves back");
    assert.equal((await f.store.setup())!.status, "finalized");
    // Booked once: a retry is a no-op, and its evidence row is unique.
    await f.store.finishSetup("withdraw-late", "finalized", 1003);
    assert.deepEqual(await f.store.liveBook(), book);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM solana_runtime_cashflows WHERE evidence_id='withdraw-late'").get() as { n: number | string }).n.toString(), "1");
    // The read at 2000 had already seen the withdrawal: the chain holds the book plus 1 USDG,
    // which the next finalized read books back, so the book meets the chain again.
    await f.store.reconcileExternalInflows({ cashUsdg: (BigInt(before.cashRaw) + 4_000_000n).toString(), wsolRaw: before.wsolRaw, slot: 2001, observedAtMs: NOW, commitment: "finalized" });
    book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, (BigInt(before.cashRaw) + 4_000_000n).toString());
    assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 4_000_000n).toString(), "deposit 5, withdraw 1: the peak rose by 4");
    // A finalized withdrawal still needs a real slot.
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-no-slot");
    await assert.rejects(f.store.finishSetup("withdraw-no-slot", "finalized"), /slot/);
    await assert.rejects(f.store.finishSetup("withdraw-no-slot", "finalized", 0), /slot/);
  });
}
/** An executable WSOL→USDG exit quote and the $500 Pyth bound for a withdrawal of `amountRaw`, read at `at`. */
function withdrawValuation(amountRaw: string, at = NOW, outAmount = (BigInt(amountRaw) / 2n).toString(), usdPerSol?: bigint) {
  const intent = { inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: 50 };
  return { quote: { source: "jupiter" as const, inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: amountRaw, outAmount,
    minOutAmount: (BigInt(outAmount) * 9_950n / 10_000n).toString(), slippageBps: 50, contextSlot: 1000, quotedAtMs: at, expiresAtMs: at + 30_000 },
    reference: pythBound(intent, at, usdPerSol) };
}
/** The audit's book: 8 USDG cash plus 0.022 WSOL (11 USDG at $500), peak 20 USDG. */
async function auditBook(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, string> = {}) {
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ hwmRaw: "20000000",
    cashRaw: "8000000", wsolRaw: "22000000", costBasisUsdgRaw: "12000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 1001, updatedAtMs: NOW, ...extra }));
}
const wsolWithdraw = (amountRaw: string, valuation?: object) => ({ ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1",
  mint: SOLANA_WRAPPED_SOL_MINT, amountRaw, ...(valuation ? { withdrawValuation: valuation } : {}) }) as SolanaPreparedSetup;

test("a WSOL withdrawal lowers the high-water mark by what it was worth, so withdrawn capital is not booked as a drawdown (audit accounting F3)", async t => {
  const f = await fixture(t); await auditBook(f);
  // Jupiter's executable minimum (10.945 USDG) is below the reference (11 USDG): the lower one is taken.
  await saveSignedSetup(f.store, wsolWithdraw("22000000", withdrawValuation("22000000")), "withdraw-all-sol");
  await f.store.finishSetup("withdraw-all-sol", "finalized", 1002);
  const book = (await f.store.liveBook())!;
  assert.equal(book.wsolRaw, "0"); assert.equal(book.costBasisUsdgRaw, "0");
  assert.equal(book.cashRaw, "8000000", "no invented sale proceeds"); assert.equal(book.realizedPnlUsdgRaw, "0", "no invented P&L");
  assert.equal(book.hwmRaw, (20_000_000n - 10_945_000n).toString());
  // The next buy sees 8 USDG against a 9.055 USDG peak (11.6%), inside the 20% breaker; before this it saw 8 against 20 (60%).
  const buy = submission("after-withdraw", "1"); buy.risk = { ...buy.risk, slot: 1002, cashUsdg: "8000000", wsolRaw: "0", equityUsdg: "8000000", peakEquityUsdg: book.hwmRaw };
  assert.equal(await f.store.recordSigned(buy), true);
  assert.notEqual((await f.store.liveBook())!.buyPaused, true);
});

test("a WSOL withdrawal valuation that is missing, stale, altered or one-sided never lowers the peak by more than the WSOL was worth", async t => {
  const amount = "22000000";
  const stale = withdrawValuation(amount, NOW - 121_000);
  for (const [label, valuation] of [
    ["no valuation", undefined],
    ["quote for another amount", { ...withdrawValuation(amount), quote: withdrawValuation("21000000").quote }],
    ["reference for another amount", { ...withdrawValuation(amount), reference: withdrawValuation("21000000").reference }],
    ["stale evidence", stale],
    ["edited reference", { ...withdrawValuation(amount), reference: { ...withdrawValuation(amount).reference, referenceOut: "99000000" } }],
    ["no reference", { quote: withdrawValuation(amount).quote }],
  ] as const) {
    const f = await fixture(t); await auditBook(f);
    await saveSignedSetup(f.store, wsolWithdraw(amount, valuation), "withdraw");
    await f.store.finishSetup("withdraw", "finalized", 1002);
    assert.equal((await f.store.liveBook())!.hwmRaw, "20000000", label);
  }
  // A Jupiter quote five times the reference lowers the peak by the reference value only.
  const high = await fixture(t); await auditBook(high);
  await saveSignedSetup(high.store, wsolWithdraw(amount, withdrawValuation(amount, NOW, "55000000")), "withdraw");
  await high.store.finishSetup("withdraw", "finalized", 1002);
  assert.equal((await high.store.liveBook())!.hwmRaw, "9000000");
  // The signed save keeps the valuation checked at prepare time, whatever it is handed.
  const swapped = await fixture(t); await auditBook(swapped);
  const prepared = wsolWithdraw(amount, withdrawValuation(amount));
  await swapped.store.saveSetup(prepared);
  await swapped.store.saveSetup({ ...prepared, withdrawValuation: withdrawValuation(amount, NOW, "55000000", 250_000_000_000n),
    signature: "withdraw", signedTransactionBase64: "c2lnbmVk", status: "pending" });
  assert.deepEqual((await swapped.store.setup())!.withdrawValuation, prepared.withdrawValuation);
  // A stored valuation that cannot be read never blocks booking the withdrawal; the peak stays.
  const corrupt = await fixture(t); await auditBook(corrupt);
  const signed = await saveSignedSetup(corrupt.store, wsolWithdraw(amount, withdrawValuation(amount)), "withdraw");
  await corrupt.db.prepare("UPDATE solana_runtime_setups SET setup_json=? WHERE tenant=?").run(JSON.stringify({ ...signed,
    withdrawValuation: { quote: { minOutAmount: "-1" }, reference: {} } }), TENANT);
  await corrupt.store.finishSetup("withdraw", "finalized", 1002);
  assert.equal((await corrupt.store.liveBook())!.wsolRaw, "0"); assert.equal((await corrupt.store.liveBook())!.hwmRaw, "20000000");
  // Quarantined WSOL leaves first and never counted toward the peak: only the position's share of the value comes off.
  const mixed = await fixture(t); await auditBook(mixed, { quarantinedWsolRaw: "2000000" });
  await saveSignedSetup(mixed.store, wsolWithdraw("13000000", withdrawValuation("13000000")), "withdraw");
  await mixed.store.finishSetup("withdraw", "finalized", 1002);
  const book = (await mixed.store.liveBook())!;
  assert.equal(book.quarantinedWsolRaw, "0"); assert.equal(book.wsolRaw, "11000000");
  assert.equal(book.hwmRaw, (20_000_000n - 6_467_500n * 11n / 13n).toString());
});

test("drawdown refusal commits a sticky buy pause, survives reopening and still permits reducing the position", async t => {
  const f = await fixture(t), first = submission(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  // A previous portfolio valuation established this historical peak.
  const history = (await f.store.liveBook())!; history.hwmRaw = "200000000";
  await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(history), TENANT, OWNER);
  const next = submission("drawdown-buy", "1"); next.risk.slot = 1001; next.risk.cashUsdg = "99400000"; next.risk.wsolRaw = "1980000";
  next.risk.peakEquityUsdg = "200000000";
  await assert.rejects(f.store.recordSigned(next), /persisted.*drawdown/);
  assert.equal((await f.store.liveBook())!.buyPaused, true); assert.equal((await f.store.pending()).length, 0);
  const reopened = f.reopen(); next.risk.equityUsdg = "200000000";
  await assert.rejects(reopened.recordSigned(next), /persisted.*drawdown/);
  const sell = structuredClone(next); sell.intent.requestId = "exit"; sell.signature = "exit-signature";
  sell.intent.inputMint = SOLANA_WRAPPED_SOL_MINT; sell.intent.outputMint = SOLANA_USDG_MINT; sell.intent.amountRaw = "990000";
  sell.quote = { ...sell.quote, inputMint: sell.intent.inputMint, outputMint: sell.intent.outputMint, inAmount: "990000", outAmount: "1000000", minOutAmount: "990000" };
  sell.minOutAmount = sell.quote.minOutAmount; sell.quotedOutAmount = sell.quote.outAmount; sell.risk.reference = pythBound(sell.intent, NOW);
  assert.equal(await reopened.recordSigned(sell), true);
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await reopened.settle(OWNER, sell.intent.requestId, sell.signature, { ...settlement(sell), amountIn: "990000", amountOut: "1000000" });
  await saveSignedSetup(reopened, setup("resume-buys"), "resume-failed");
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await reopened.finishSetup("resume-failed", "failed");
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await saveSignedSetup(reopened, setup("resume-buys"), "resume-owner-approved");
  await reopened.finishSetup("resume-owner-approved", "finalized");
  assert.equal((await reopened.liveBook())!.buyPaused, false);
  assert.equal((await reopened.liveBook())!.hwmRaw, "200000000");
});
test("finalized and failed attempts consume the daily operation cap and successful notional remains conservatively reserved", async t => {
  for (const status of ["pending", "finalized", "failed"] as const) {
    const f = await fixture(t); await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, dailyUsdg: "10000000", maxOpsPerDay: 1 });
    const first = submission(); await f.store.recordSigned(first);
    if (status !== "pending") await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first, status));
    else await f.db.prepare("UPDATE solana_runtime_submissions SET vault=? WHERE request_id=?").run(key(77), first.intent.requestId);
    const next = submission("too-many", status === "finalized" ? "1" : "0"); next.risk.slot = 1001;
    if (status === "finalized") { next.risk.cashUsdg = "99400000"; next.risk.wsolRaw = "1980000"; }
    await assert.rejects(f.store.recordSigned(next), /daily limit/, status);
  }
});

test("by default a proven-expired attempt counts toward maxOpsPerDay like any signed transaction (owner decision, audit G2-3)", async t => {
  const f = await fixture(t), first = submission(); await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  await f.store.recordSigned(first); await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  const book = { slot: 1001, cash: "99400000", wsol: "1980000" };
  // One executed operation of two; the first exit is dropped and proven expired: the session key signed two.
  const dropped = sale("exit-1", "1", "1000000", book); assert.equal(await f.store.recordSigned(dropped), true);
  await f.store.settle(OWNER, dropped.intent.requestId, dropped.signature, expired(dropped));
  await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "1000000", book)), /expired without landing in the last 24 hours: they count toward the daily operation limit/);
  assert.equal((await f.store.pending()).length, 0);
  // An explicit allowance of 0 is the same; a malformed one admits nothing.
  await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "1000000", book), { expiredAttemptAllowance: 0 }), /expired without landing/);
  for (const bad of [-1, 97, 1.5, Number.NaN]) {
    await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "1000000", book), { expiredAttemptAllowance: bad }), /allowance setting is misconfigured/, String(bad));
  }
  // Later, the dropped attempt leaves the window and trading resumes.
  f.clock.value = NOW + 86_400_001;
  const later = sale("later", "1", "1000000", book); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
  later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value);
  await f.binding.settings(TENANT, OWNER, 2, "live", { ...limits, maxOpsPerDay: 2, expiresAtMs: f.clock.value + 3_600_000 });
  assert.equal(await f.store.recordSigned(later), true);
});

test("an expired-attempt allowance lets that many dropped attempts a day leave the operation count, never more (owner decision, audit G2-3)", async t => {
  const f = await fixture(t), first = submission(), allow = (n: number) => ({ expiredAttemptAllowance: n });
  await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  await f.store.recordSigned(first, allow(1)); await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  const book = { slot: 1001, cash: "99400000", wsol: "1980000" };
  const dropped = sale("exit-1", "1", "1000000", book); await f.store.recordSigned(dropped, allow(1));
  await f.store.settle(OWNER, dropped.intent.requestId, dropped.signature, expired(dropped));
  // With an allowance of one the retry is admitted: the program never counted the dropped one.
  const retry = sale("exit-2", "1", "1000000", book); assert.equal(await f.store.recordSigned(retry, allow(1)), true);
  await f.store.settle(OWNER, retry.intent.requestId, retry.signature, { ...settlement(retry), slot: 1002, amountIn: "1000000", amountOut: "500000" });
  // Two executed operations now: the owner's limit is spent, whatever the allowance.
  await assert.rejects(f.store.recordSigned(sale("exit-3", "2", "500000", { slot: 1002, cash: "99900000", wsol: "980000" }), allow(96)), /daily limit/);
  // At most maxOpsPerDay + allowance are signed: two operations and an allowance of two admit four dropped attempts, not five.
  const g = await fixture(t); await g.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  for (const id of ["drop-1", "drop-2", "drop-3", "drop-4"]) {
    const s = submission(id); s.risk.slot = 1001; assert.equal(await g.store.recordSigned(s, allow(2)), true, id); await g.store.settle(OWNER, id, s.signature, expired(s));
  }
  const fifth = submission("drop-5"); fifth.risk.slot = 1001;
  await assert.rejects(g.store.recordSigned(fifth, allow(2)), /expired without landing/);
  assert.equal((await g.store.pending()).length, 0);
});

test("the expired-attempt allowance setting defaults to 0 and accepts only a whole number from 0 to 96", () => {
  assert.equal(solanaExpiredAttemptAllowance({}), SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE);
  assert.equal(SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, 0);
  for (const [value, expected] of [["0", 0], ["1", 1], ["20", 20], ["96", 96]] as const) {
    assert.equal(solanaExpiredAttemptAllowance({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value }), expected);
  }
  for (const value of ["", " 1", "01", "-1", "1.5", "97", "100", "1e1", "many"]) {
    assert.throws(() => solanaExpiredAttemptAllowance({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value }), /allowance setting is misconfigured/, JSON.stringify(value));
  }
});

/** A WSOL→USDG sell at $500/SOL against the current book, bounded by a fresh reference. */
function sale(id: string, seq: string, amountRaw: string, book: { slot: number; cash: string; wsol: string }, outAmount?: string) {
  const s = submission(id, seq), out = outAmount ?? (BigInt(amountRaw) / 2n).toString();
  s.intent = { ...s.intent, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw };
  s.quote = { ...s.quote, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, inAmount: amountRaw, outAmount: out,
    minOutAmount: (BigInt(out) * 9_900n / 10_000n).toString() };
  s.minOutAmount = s.quote.minOutAmount; s.quotedOutAmount = out;
  s.risk = { ...s.risk, slot: book.slot, cashUsdg: book.cash, wsolRaw: book.wsol, reference: pythBound(s.intent, NOW) };
  s.risk.notionalUsdg = (BigInt(out) > BigInt(s.risk.reference.valueUsdg) ? out : s.risk.reference.valueUsdg);
  return s;
}

test("admission re-checks the independent price floor and charges a cheap sell at its reference value", async t => {
  const f = await fixture(t), first = submission(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  const book = { slot: 1001, cash: "99400000", wsol: "1980000" };
  // An edited floor, a floor from another trade or a stale price is refused before anything is reserved.
  for (const forge of [(s: SolanaSignedSubmission) => { s.risk.reference = { ...s.risk.reference, minOutFloor: "1" }; },
    (s: SolanaSignedSubmission) => { s.risk.reference = pythBound(first.intent, NOW); },
    (s: SolanaSignedSubmission) => { s.risk.reference = pythBound(s.intent, NOW - 121_000); },
    (s: SolanaSignedSubmission) => { delete (s.risk as Partial<typeof s.risk>).reference; }]) {
    const forged = sale("forged", "1", "1000000", book); forge(forged);
    await assert.rejects(f.store.recordSigned(forged), /independent SOL price evidence/);
  }
  // A dust quote cannot sign: its guaranteed output is far below the $500 floor.
  await assert.rejects(f.store.recordSigned(sale("dust", "1", "1000000", book, "100")), /below the independent SOL price floor/);
  // 2% under the reference passes the 3% floor, but is charged at the full reference value.
  const cheap = sale("cheap", "1", "1000000", book, "490000");
  assert.equal(cheap.risk.notionalUsdg, "500000");
  assert.equal(await f.store.recordSigned(cheap), true);
  const row = await f.db.prepare("SELECT notional_raw FROM solana_runtime_submissions WHERE request_id='cheap'").get() as { notional_raw: string };
  assert.equal(row.notional_raw, "500000");
  assert.equal((await f.store.pending()).length, 1);
});

test("live sells are bounded by the signed per-trade and rolling daily SOL sell limits", async t => {
  const f = await fixture(t), first = submission(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  const revision = (await f.binding.get(TENANT))!.revision;
  await f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, perTradeWsol: "1000000", dailyWsol: "1500000" });
  await assert.rejects(f.store.recordSigned(sale("too-big", "1", "1000001", { slot: 1001, cash: "99400000", wsol: "1980000" })), /per-trade SOL sell limit/);
  const one = sale("sell-1", "1", "1000000", { slot: 1001, cash: "99400000", wsol: "1980000" });
  assert.equal(await f.store.recordSigned(one), true);
  await f.store.settle(OWNER, one.intent.requestId, one.signature, { status: "finalized", signature: one.signature, slot: 1002, feeLamports: "10000",
    amountIn: "1000000", amountOut: "500000", finalizedAtMs: NOW + 1 });
  const after = { slot: 1002, cash: "99900000", wsol: "980000" };
  await assert.rejects(f.store.recordSigned(sale("sell-2", "2", "600000", after)), /daily SOL sell limit/);
  assert.equal(await f.store.recordSigned(sale("sell-3", "2", "500000", after)), true);
});

test("limits beyond the vault's 96 daily operations or a 168-hour permission are refused at save and never admitted (audit core-abi-3, web-auth F4)", async t => {
  const f = await fixture(t), revision = (await f.binding.get(TENANT))!.revision;
  const century = NOW + 100 * 365 * 86_400_000;
  // The settings route and binding store refuse live-shaped limits with a validation error (400).
  await assert.rejects(f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, maxOpsPerDay: 1000 }), /Invalid Solana account settings/);
  await assert.rejects(f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, expiresAtMs: century }), /Invalid Solana account settings/);
  // Stored limits that got past save anyway admit nothing and register no session.
  for (const stored of [{ ...limits, maxOpsPerDay: 1000 }, { ...limits, expiresAtMs: century }]) {
    await f.db.prepare("UPDATE solana_wallet_bindings SET limits_json=? WHERE tenant=?").run(JSON.stringify(stored), TENANT);
    await assert.rejects(f.store.recordSigned(submission()), /between 1 and 96|168 hours/);
    await assert.rejects(f.store.saveSetup({ ...setup("session"), limits: stored }), /between 1 and 96|168 hours/);
  }
  assert.equal((await f.store.pending()).length, 0);
  // A paper account without SOL sell caps is bounded too: at save, and at book creation and every trade for limits stored before that.
  const g = await fixture(t), paperLimits = { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: limits.dailyUsdg, maxOpsPerDay: 1000, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000 };
  await assert.rejects(g.binding.settings(TENANT, OWNER, 1, "paper", paperLimits), /Invalid Solana account settings/);
  await g.db.prepare("UPDATE solana_wallet_bindings SET requested_mode='paper', limits_json=? WHERE tenant=?").run(JSON.stringify(paperLimits), TENANT);
  await assert.rejects(g.store.createPaper(CASH.toString(), paperLimits), /between 1 and 96/);
});

test("autonomous admission is spaced by the strategy interval under the lock, except after a proven expiry (audit agent-deploy F2, G2-2)", async t => {
  for (const outcome of ["expired", "finalized", "failed"] as const) {
    const f = await fixture(t), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 3_600 });
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    const first = submission("rebalance-2-0");
    assert.equal(await automatic.recordSigned(first), true);
    await f.store.settle(OWNER, first.intent.requestId, first.signature, outcome === "expired" ? expired(first) : settlement(first, outcome));
    const retry = submission("rebalance-2-1", outcome === "finalized" ? "1" : "0"); retry.risk.slot = 1001;
    if (outcome === "finalized") { retry.risk.cashUsdg = "99400000"; retry.risk.wsolRaw = "1980000"; }
    if (outcome === "expired") {
      assert.equal(await automatic.recordSigned(retry), true, "a dropped packet is retried at once");
      assert.equal(await automatic.recordSigned(first), false, "the expired request is never re-admitted");
    } else await assert.rejects(automatic.recordSigned(retry), /not due/, outcome);
  }
  // The interval passes: due again.
  const f = await fixture(t), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 60 });
  const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
  const first = submission("rebalance-2-0"); await automatic.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first, "failed"));
  f.clock.value = NOW + 60_000;
  const later = submission("rebalance-2-1"); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
  later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value); later.risk.slot = 1001;
  assert.equal(await automatic.recordSigned(later), true);
  // A manual live trade may not take a strategy request ID.
  await assert.rejects(f.store.recordSigned(submission("rebalance-9-9")), /belong to the autonomous strategy/);
});

test("a live binding saved without SOL sell limits admits no trade", async t => {
  const f = await fixture(t), revision = (await f.binding.get(TENANT))!.revision;
  const { perTradeWsol: _p, dailyWsol: _d, ...unbounded } = limits;
  await f.binding.settings(TENANT, OWNER, revision, "live", unbounded);
  await assert.rejects(f.store.recordSigned(submission()), /SOL sell limits/);
  assert.equal((await f.store.pending()).length, 0);
});



test("each owner transaction kind is proven expired only by state it must change", async t => {
  const proof = (vaultSequence: string | null, sessionEpoch: string | null) => ({ reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence, sessionEpoch, slot: 1002 });
  const prior = { priorVaultExisted: true, priorSequence: "5", priorSessionEpoch: "1" };
  for (const [kind, accepted, refused] of [
    // A trade landing advanced the sequence: a revoke is still proven by its epoch.
    ["revoke", proof("6", "1"), proof("5", "2")],
    ["session", proof("6", "1"), proof("5", "2")],
    // A withdrawal moves the sequence; the epoch is irrelevant.
    ["withdraw", proof("5", "2"), proof("6", "1")],
  ] as const) {
    const f = await fixture(t);
    await saveSignedSetup(f.store, { ...setup(kind), ...prior, ...(kind === "withdraw" ? { mint: SOLANA_USDG_MINT, amountRaw: "1" } : {}) }, `${kind}-dropped`);
    await assert.rejects(f.store.finishSetup(`${kind}-dropped`, "failed", 1002, refused), /expiry evidence/, kind);
    await f.store.finishSetup(`${kind}-dropped`, "failed", 1002, accepted);
    assert.equal((await f.store.setup())!.status, "failed");
  }
  // A session that would have created the vault: absent, or created with epoch 0 by something else.
  const f = await fixture(t);
  await saveSignedSetup(f.store, { ...setup("session"), priorVaultExisted: false, priorSequence: "0", priorSessionEpoch: "0" }, "first-session");
  await assert.rejects(f.store.finishSetup("first-session", "failed", 1002, proof("0", "1")), /expiry evidence/);
  await f.store.finishSetup("first-session", "failed", 1002, proof(null, null));
});



test("an unbooked excess never blocks admission, a shortfall does, and no sale reaches quarantined SOL", async t => {
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
  // Dust that finality has not booked yet: the sale sizes against the book alone.
  assert.equal(await f.store.recordSigned(sale("with-dust", "1", "1000000", { slot: 1001, cash: "99400001", wsol: "1980001" })), true);
  const g = await fixture(t), first = submission(); await g.store.recordSigned(first);
  await g.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  await assert.rejects(g.store.recordSigned(sale("whole-chain", "1", "1980001", { slot: 1001, cash: "99400000", wsol: "1980001" })), /quarantined SOL is not traded/);
  await assert.rejects(g.store.recordSigned(sale("short", "1", "1000000", { slot: 1001, cash: "99400000", wsol: "1979999" })), /below the recorded book/);
  await assert.rejects(g.store.recordSigned(sale("short-cash", "1", "1000000", { slot: 1001, cash: "99399999", wsol: "1980000" })), /below the recorded book/);
});

test("a first live book on a vault that already holds WSOL starts with it quarantined instead of refusing forever", async t => {
  const f = await fixture(t), s = submission(); s.risk.wsolRaw = "7";
  assert.equal(await f.store.recordSigned(s), true);
  const book = (await f.store.liveBook())!;
  assert.equal(book.wsolRaw, "0"); assert.equal(book.quarantinedWsolRaw, "7"); assert.equal(book.costBasisUsdgRaw, "0");
});

// The new admission and accounting SQL runs on both dialects; CI runs these against PostgreSQL.
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: an operator hold refuses live admission, manual or automatic, while owner actions continue`, options, async t => {
    const f = await fixture(t, dialect);
    await setSolanaOperatorHold(f.db, TENANT, "incident", NOW);
    await assert.rejects(f.store.recordSigned(submission()), /operator hold/);
    const binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    await assert.rejects(new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision }).recordSigned(submission("auto")), /operator hold/);
    assert.equal((await f.store.pending()).length, 0);
    // Revocation (and any owner transaction) is still prepared and saved.
    assert.equal(await f.store.saveSetup(setup("revoke")), true);
    await releaseSolanaOperatorHold(f.db, TENANT);
    await setSolanaOperatorHold(f.db, "*", "fleet-wide", NOW);
    await assert.rejects(f.store.recordSigned(submission("everyone")), /operator hold/);
  });
  test(`${dialect}: a kill fences a live autonomous admission that captured the strategy before it`, options, async t => {
    const f = await fixture(t, dialect), binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
    assert.equal(await f.binding.disableForKill(TENANT), true);
    await assert.rejects(automatic.recordSigned(submission()), /strategy changed/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: no trade is admitted while a withdrawal is prepared, and a stale withdrawal cannot be prepared`, options, async t => {
    const f = await fixture(t, dialect);
    const withdraw = { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1" };
    await f.store.saveSetup(withdraw);
    await assert.rejects(f.store.recordSigned(submission()), /prepared owner withdrawal/);
    // Once its signing window lapses it can no longer be submitted, so trading resumes.
    f.clock.value = withdraw.expiresAtMs;
    const later = submission("later"); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
    later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value);
    assert.equal(await f.store.recordSigned(later), true);
    await f.store.settle(OWNER, later.intent.requestId, later.signature, { ...settlement(later), finalizedAtMs: f.clock.value + 1 });
    // The trade ran at sequence 0: a withdrawal still claiming sequence 0 read stale state.
    await assert.rejects(f.store.saveSetup({ ...withdraw, preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 60_000 }), /vault changed/);
    assert.equal(await f.store.saveSetup({ ...withdraw, priorSequence: "1", preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 60_000 }), true);
  });
  test(`${dialect}: the durable autonomous schedule counts every attempt and spaces all but proven expiries`, options, async t => {
    const f = await fixture(t, dialect), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 3_600 });
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 0, dueAtMs: 0 });
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    const first = submission("rebalance-2-0"); assert.equal(await automatic.recordSigned(first), true);
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 1, dueAtMs: NOW + 3_600_000 });
    await f.store.settle(OWNER, first.intent.requestId, first.signature, expired(first));
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 1, dueAtMs: 0 });
    const retry = submission("rebalance-2-1"); retry.risk.slot = 1001; assert.equal(await automatic.recordSigned(retry), true);
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 2, dueAtMs: NOW + 3_600_000 });
    // Expired attempts are counted on this dialect too: with the default allowance they use the operation budget (G2-3).
    await f.store.settle(OWNER, retry.intent.requestId, retry.signature, expired(retry));
    const third = submission("rebalance-2-2"); third.risk.slot = 1001; assert.equal(await automatic.recordSigned(third), true);
  });
  test(`${dialect}: one raw WSOL sent to the vault is quarantined at zero basis, outside equity, the HWM and the position (audit dust)`, options, async t => {
    const f = await fixture(t, dialect), s = submission(); await f.store.recordSigned(s);
    await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    const before = (await f.store.liveBook())!;
    const dusted = { cashUsdg: "99400000", wsolRaw: "1980001", slot: 1002, observedAtMs: NOW, commitment: "finalized" as const };
    await f.store.reconcileExternalInflows(dusted); await f.store.reconcileExternalInflows(dusted);
    let book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "1"); assert.equal(book.wsolRaw, before.wsolRaw);
    assert.equal(book.hwmRaw, before.hwmRaw); assert.equal(book.costBasisUsdgRaw, before.costBasisUsdgRaw); assert.equal(book.realizedPnlUsdgRaw, "0");
    const flows = await f.db.prepare("SELECT kind,mint,amount_raw FROM solana_runtime_cashflows ORDER BY kind").all() as Array<{ kind: string; mint: string; amount_raw: string }>;
    assert.deepEqual(flows.map(r => ({ kind: r.kind, mint: r.mint, amount_raw: r.amount_raw })), [{ kind: "quarantine", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "1" }]);
    // A USDG deposit and more dust in one finalized read: capital-in and quarantine, booked once each.
    await f.store.reconcileExternalInflows({ ...dusted, cashUsdg: "109400000", wsolRaw: "1980003", slot: 1003 });
    book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "3"); assert.equal(book.cashRaw, "109400000"); assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 10_000_000n).toString());
    // The owner can take it out: a WSOL withdrawal spends quarantine first, at zero basis.
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5" }, "sweep");
    await f.store.finishSetup("sweep", "finalized", 1004);
    book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "0"); assert.equal(book.wsolRaw, "1979998");
    assert.equal(book.costBasisUsdgRaw, (600000n - 600000n * 2n / 1980000n).toString()); assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 10_000_000n).toString());
  });
}
