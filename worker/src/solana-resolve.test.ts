import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import type { SolanaLiveSettlement, SolanaObservation, SolanaSignedSubmission } from "./solana-executor";
import { pythBound } from "./solana-reference-price-fixture";
import { ensureSolanaResolutionSchema, listSolanaResolutions, resolveSolanaPendingTrade, runSolanaResolveCommand, solanaResolveDecision, SolanaResolveError,
  type SolanaResolveProvider, type SolanaResolveView } from "./solana-resolve";
import { SolanaRpcError, SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { SolanaSettlementError } from "./solana-settlement";
import { ensureSolanaTradingSchema, SolanaTradingStore, type SolanaPreparedSetup } from "./solana-trading-store";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TENANT = `0x${"11".repeat(20)}` as const;
const OWNER = key(20), VAULT = key(21), SESSION = key(22), PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const NOW = 1_000_000, CASH = 100_000_000n;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };

/** A pending live buy as the store admits it (the store never parses the signed bytes). */
function submission(id = "stuck-1"): SolanaSignedSubmission {
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  const intent = { kind: "spl-swap" as const, chain: CHAINS.solana, mode: "live" as const, requestId: id, owner: OWNER, vault: VAULT,
    inputMint: quote.inputMint, outputMint: quote.outputMint, amountRaw: quote.inAmount, slippageBps: 100 };
  return { version: 1, intent, programId: PROGRAM, session: SESSION, feePayer: key(23), sessionEpoch: "1", vaultSequence: "0", signature: `signature-${id}`,
    signedTransactionBase64: "dGVzdC1zaWduZWQ=", messageBase64: "dGVzdC1tZXNzYWdl", loadedAddresses: { writable: [], readonly: [] },
    recentBlockhash: key(24), lastValidBlockHeight: "1200", minContextSlot: 1000, minOutAmount: quote.minOutAmount,
    quotedOutAmount: quote.outAmount, inputTokenAccount: key(25), outputTokenAccount: key(26), inputTokenProgram: TOKEN_2022_PROGRAM,
    outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, inputBalanceBefore: CASH.toString(), outputBalanceBefore: "0", maxFeeLamports: "3000000",
    feeLamports: "10000", rentLamports: "2039280", preparedAtMs: NOW, safetyObservedAtMs: NOW, quote,
    risk: { observedAtMs: NOW, slot: 1000, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(), cashUsdg: CASH.toString(), wsolRaw: "0",
      reference: pythBound(intent, NOW) } };
}
const fill = (s: SolanaSignedSubmission, change: Partial<SolanaLiveSettlement> = {}): SolanaLiveSettlement =>
  ({ status: "finalized", signature: s.signature, slot: 1001, feeLamports: "10000", amountIn: "1000000", amountOut: "1990000", finalizedAtMs: NOW + 5, ...change } as SolanaLiveSettlement);
const expiry = (s: SolanaSignedSubmission, blockHeight = "1201"): SolanaLiveSettlement => ({ status: "expired", signature: s.signature, slot: 1001, feeLamports: null,
  amountIn: "0", amountOut: "0", finalizedAtMs: NOW + 5, expiryProof: { vaultSequence: "0", sessionEpoch: "1", blockHeight, reason: "blockhash-expired" } });

async function fixture(t: TestContext, dialect: "sqlite" | "postgres" = "sqlite") {
  const clock = { value: NOW }; let db: Db;
  if (dialect === "postgres") {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!), schema = `solana_test_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  } else { const raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw); t.after(() => raw.close()); }
  const bindings = new SqlSolanaBindingStore(async () => db, dialect, () => clock.value);
  await bindings.bind(TENANT, "did:privy:test", OWNER); await bindings.settings(TENANT, OWNER, 0, "live", limits);
  await ensureSolanaTradingSchema(db, dialect === "postgres");
  const store = new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  const setup: SolanaPreparedSetup = { kind: "session", transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: key(30), lastValidBlockHeight: "1200",
    programId: PROGRAM, vault: VAULT, session: SESSION, limits, preparedAtMs: NOW, expiresAtMs: NOW + 30000 };
  await store.saveSetup(setup); await store.saveSetup({ ...setup, signature: "owner-registration", signedTransactionBase64: "c2lnbmVk", status: "pending" });
  await store.finishSetup("owner-registration", "finalized");
  await store.registerSession({ programId: PROGRAM, vault: VAULT, session: SESSION, sessionEpoch: "1", registrationSignature: "owner-registration", registeredAtMs: NOW },
    Buffer.alloc(32, 4).toString("base64"), Buffer.alloc(32, 3));
  const pending = submission(); assert.equal(await store.recordSigned(pending), true);
  return { db, store, clock, pending, postgres: dialect === "postgres" };
}
/** Providers whose observation the test sets per label. A function answer runs; an Error is thrown. */
function providers(views: Record<string, SolanaObservation | Error>, hosts: Record<string, string> = {}) {
  const calls: string[] = [];
  const list: SolanaResolveProvider[] = Object.keys(views).map(label => ({ label, host: hosts[label] ?? `${label.replace(/\W/g, "")}.example`,
    read: async <T>(operation: (read: never) => Promise<T>) => { calls.push(label); return operation(label as never); } }));
  const observe = async (read: unknown): Promise<SolanaObservation> => {
    const view = views[read as string]!; if (view instanceof Error) throw view; return view;
  };
  return { list, observe: observe as never, calls };
}
const seen: SolanaObservation = { settlement: null, seen: true };
const resolutions = (db: Db) => db.prepare("SELECT * FROM solana_operator_resolutions ORDER BY approved_at_ms").all() as Promise<Array<Record<string, unknown>>>;

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a fill two independent providers agree on is recorded with the operator and every view, then booked once through the store`, options, async t => {
    const f = await fixture(t, dialect), agreed = fill(f.pending);
    // The configured pair disagrees: the fallback lags (seen, not finalized). Automatic settlement keeps it pending.
    const pair = providers({ primary: { settlement: agreed, seen: true }, fallback: seen });
    const shown = await resolveSolanaPendingTrade({ db: f.db, postgres: f.postgres, tenant: TENANT, requestId: "stuck-1", providers: pair.list, observe: pair.observe, now: () => f.clock.value });
    assert.equal(shown.booked, false); assert.match(shown.lines.join("\n"), /Only one provider reports this final outcome/);
    assert.match(shown.lines.join("\n"), /primary: finalized fill at slot 1001: 1000000 in, 1990000 out, fee 10000 lamports\n {2}fallback: pending: seen, not finalized/);
    // A third provider the operator supplies agrees with the primary: shown, but nothing written without book.
    const three = providers({ primary: { settlement: agreed, seen: true }, fallback: seen, "operator's provider": { settlement: { ...agreed }, seen: true } });
    const preview = await resolveSolanaPendingTrade({ db: f.db, postgres: f.postgres, tenant: TENANT, requestId: "stuck-1", providers: three.list, observe: three.observe, now: () => f.clock.value });
    assert.equal(preview.decision?.book, true); assert.equal(preview.booked, false);
    assert.match(preview.lines.join("\n"), /primary and operator's provider agree on a finalized fill\.\nNothing was written/);
    assert.deepEqual(await resolutions(f.db), []); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
    // Booked: the decision is recorded first, then settled by the store.
    f.clock.value = NOW + 60_000;
    const booked = await resolveSolanaPendingTrade({ db: f.db, postgres: f.postgres, tenant: TENANT, requestId: "stuck-1", providers: three.list, observe: three.observe,
      now: () => f.clock.value, book: { operator: "milla", reason: "fallback stuck behind; checked on the explorer" } });
    assert.equal(booked.booked, true); assert.match(booked.lines.at(-1)!, /^Booked a finalized fill, recorded as decided by milla\.$/);
    const record = (await f.store.get(OWNER, "stuck-1"))!;
    assert.equal(record.status, "finalized"); assert.deepEqual({ ...record.settlement, finalizedAtMs: 0 }, { ...agreed, finalizedAtMs: 0 });
    const book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, (CASH - 1_000_000n).toString()); assert.equal(book.wsolRaw, "1990000");
    const [row] = await resolutions(f.db);
    assert.equal(row!.operator, "milla"); assert.equal(row!.reason, "fallback stuck behind; checked on the explorer"); assert.equal(row!.outcome, "finalized");
    assert.equal(Number(row!.approved_at_ms), NOW + 60_000); assert.equal(Number(row!.booked_at_ms), NOW + 60_000); assert.equal(row!.refusal, null);
    const evidence = JSON.parse(row!.evidence_json as string);
    assert.deepEqual(evidence.agreed, ["primary", "operator's provider"]);
    assert.deepEqual(evidence.providers.map((p: { label: string; seen?: boolean }) => [p.label, p.seen]), [["primary", true], ["fallback", true], ["operator's provider", true]]);
    assert.ok(evidence.providers.every((p: { hostId: string }) => /^[0-9a-f]{16}$/.test(p.hostId)));
    assert.ok(!JSON.stringify(row).includes(".example"), "hostnames are recorded only as a hash");
    // Run again: already booked, nothing more.
    const again = await resolveSolanaPendingTrade({ db: f.db, postgres: f.postgres, tenant: TENANT, requestId: "stuck-1", providers: three.list, observe: three.observe,
      now: () => f.clock.value, book: { operator: "milla", reason: "again" } });
    assert.equal(again.booked, false); assert.match(again.lines.join("\n"), /already finalized; nothing is booked/);
    assert.equal((await resolutions(f.db)).length, 1);
    assert.deepEqual((await listSolanaResolutions(f.db, TENANT, undefined, f.postgres)).map(r => [r.requestId, r.outcome, r.operator, r.bookedAtMs]), [["stuck-1", "finalized", "milla", NOW + 60_000]]);
  });
}

test("providers that report different final outcomes book nothing, even when two of them agree", async t => {
  const f = await fixture(t), agreed = fill(f.pending);
  for (const views of [
    { primary: { settlement: agreed, seen: true }, fallback: { settlement: expiry(f.pending), seen: false }, "operator's provider": { settlement: agreed, seen: true } },
    { primary: { settlement: agreed, seen: true }, fallback: { settlement: fill(f.pending, { amountOut: "1985000" }), seen: true }, "operator's provider": { settlement: agreed, seen: true } },
  ]) {
    const p = providers(views);
    const result = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
      book: { operator: "milla", reason: "test" } });
    assert.equal(result.booked, false); assert.match(result.lines.at(-1)!, /different final outcomes/);
  }
  assert.deepEqual(await resolutions(f.db), []); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
});

test("an expiry two providers prove is booked only while no provider has seen the signature, and releases the reservation", async t => {
  const f = await fixture(t);
  // Each provider's own finalized height may differ; the outcome is the same.
  const expired = { primary: { settlement: expiry(f.pending, "1201"), seen: false }, "operator's provider": { settlement: expiry(f.pending, "1250"), seen: false } };
  const withSeen = providers({ ...expired, fallback: seen });
  const refused = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: withSeen.list, observe: withSeen.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "dropped" } });
  assert.equal(refused.booked, false); assert.match(refused.lines.at(-1)!, /has seen this signature/);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
  // The fallback cannot answer at all: an expiry waits until the operator sets it aside.
  const unreadable = providers({ ...expired, fallback: new SolanaRpcError("timeout") });
  const waiting = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: unreadable.list, observe: unreadable.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "dropped" } });
  assert.equal(waiting.booked, false); assert.match(waiting.lines.at(-1)!, /A provider could not be read, so this expiry is not booked.*--exclude/);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending"); assert.deepEqual(await resolutions(f.db), []);
  const booked = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: unreadable.list, observe: unreadable.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "dropped; fallback is down" }, exclude: "fallback" });
  assert.equal(booked.booked, true); assert.match(booked.lines.join("\n"), /fallback: could not be used: Solana read timed out\. \(excluded by the operator/);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "expired");
  // The sequence is free again for a new trade.
  const next = submission("after-expiry"); next.risk.slot = 1001; assert.equal(await f.store.recordSigned(next), true);
});

test("an expiry is not booked while a provider has a finalized status whose receipt cannot be read, until the operator sets that provider aside", async t => {
  // The primary has a finalized status but a receipt that cannot be used (observeSolanaSubmission throws):
  // the transaction landed, maybe failed with the vault sequence unchanged. The other two prove an expiry.
  const f = await fixture(t);
  const views = { primary: new SolanaSettlementError() as Error, fallback: { settlement: expiry(f.pending), seen: false }, "operator's provider": { settlement: expiry(f.pending, "1250"), seen: false } };
  const p = providers(views);
  const refused = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "primary broken" } });
  assert.equal(refused.booked, false); assert.equal(refused.decision?.book, false);
  assert.match(refused.lines.join("\n"), /primary: could not be used: Finalized Solana evidence disagrees with the recorded submission\.\n.*\nA provider could not be read, so this expiry is not booked/s);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending"); assert.deepEqual(await resolutions(f.db), []);
  // The decision alone says the same, for an unreadable fallback too; an excluded unreadable view does not block.
  const unread: SolanaResolveView = { label: "fallback", hostId: "b", error: "Its answer could not be read." };
  const proven: SolanaResolveView[] = [{ label: "primary", hostId: "a", observation: { settlement: expiry(f.pending), seen: false } },
    { label: "operator's provider", hostId: "c", observation: { settlement: expiry(f.pending), seen: false } }];
  assert.equal(solanaResolveDecision([...proven, unread]).book, false);
  assert.equal(solanaResolveDecision([...proven, { ...unread, excluded: true }]).book, true);
  // A fill two providers agree on is not held back by an unreadable one: a fill moved the vault's sequence.
  assert.equal(solanaResolveDecision([{ ...proven[0]!, observation: { settlement: fill(f.pending), seen: true } }, { ...proven[1]!, observation: { settlement: fill(f.pending), seen: true } }, unread]).book, true);
  // The operator sets the unreadable primary aside: the two proofs book the expiry, with the dissent recorded.
  const booked = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "primary returns a corrupt receipt for everything" }, exclude: "primary" });
  assert.equal(booked.booked, true); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "expired");
  const evidence = JSON.parse((await resolutions(f.db))[0]!.evidence_json as string);
  assert.equal(evidence.excluded, "primary"); assert.deepEqual(evidence.providers[0], { label: "primary", hostId: evidence.providers[0].hostId, excluded: true,
    error: "Finalized Solana evidence disagrees with the recorded submission." });
});

test("a malformed receipt from one provider does not count; two readable agreeing providers still book, and none books nothing", async t => {
  const f = await fixture(t), agreed = fill(f.pending);
  const none = providers({ primary: new SolanaSettlementError(), fallback: new SolanaSettlementError(), "operator's provider": new Error("https://rpc.example/?api-key=secret") });
  const stuck = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: none.list, observe: none.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "test" } });
  assert.equal(stuck.booked, false); assert.match(stuck.lines.at(-1)!, /No provider reports a final outcome yet/);
  assert.match(stuck.lines.join("\n"), /primary: could not be used: Finalized Solana evidence disagrees with the recorded submission\./);
  assert.ok(!stuck.lines.join("\n").includes("api-key"), "provider text is never shown");
  const two = providers({ primary: { settlement: agreed, seen: true }, fallback: new SolanaSettlementError(), "operator's provider": { settlement: agreed, seen: true } });
  assert.equal((await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: two.list, observe: two.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "fallback returns a truncated receipt" } })).booked, true);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "finalized");
});

test("an outcome the store refuses is recorded as refused and books nothing", async t => {
  const f = await fixture(t);
  // Both agree, but the fee is above what the trade reserved: the store's own check refuses it.
  const greedy = fill(f.pending, { feeLamports: "20000" });
  const p = providers({ primary: { settlement: greedy, seen: true }, fallback: { settlement: greedy, seen: true } });
  await assert.rejects(resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "test" } }), (error: unknown) => error instanceof SolanaResolveError && /^Nothing was booked: Finalized Solana fees exceed the reserved budget\./.test(error.message));
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
  const [row] = await resolutions(f.db);
  assert.equal(row!.booked_at_ms, null); assert.equal(row!.refusal, "Finalized Solana fees exceed the reserved budget.");
});

test("a booking whose reply is lost is still marked booked, and one stopped before its mark is marked on the next run", async t => {
  const f = await fixture(t), agreed = fill(f.pending);
  const p = providers({ primary: { settlement: agreed, seen: true }, "operator's provider": { settlement: agreed, seen: true } });
  // The store commits, then the reply is lost: the decision is not recorded as a refusal.
  const settle = SolanaTradingStore.prototype.settle;
  t.mock.method(SolanaTradingStore.prototype, "settle", async function (this: SolanaTradingStore, ...args: Parameters<SolanaTradingStore["settle"]>) {
    await settle.apply(this, args); throw new Error("connection reset after commit");
  });
  const lost = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "reply lost" } });
  t.mock.restoreAll();
  assert.equal(lost.booked, true); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "finalized");
  const [row] = await resolutions(f.db); assert.equal(row!.refusal, null); assert.notEqual(row!.booked_at_ms, null);
  // A run that stopped between the store's commit and its own mark leaves an open record; the next run marks it.
  const g = await fixture(t);
  await ensureSolanaResolutionSchema(g.db, false);
  await g.db.prepare(`INSERT INTO solana_operator_resolutions(id,tenant,owner,request_id,signature,outcome,operator,reason,settlement_json,evidence_json,approved_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("stopped", TENANT, OWNER, "stuck-1", g.pending.signature, "finalized", "milla", "stopped", JSON.stringify(fill(g.pending)), "{}", NOW);
  await g.store.settle(OWNER, "stuck-1", g.pending.signature, { ...fill(g.pending), finalizedAtMs: NOW + 9 });
  const shown = await resolveSolanaPendingTrade({ db: g.db, tenant: TENANT, requestId: "stuck-1", providers: [], now: () => g.clock.value });
  assert.equal(shown.booked, false, "show writes nothing");
  const next = await resolveSolanaPendingTrade({ db: g.db, tenant: TENANT, requestId: "stuck-1", providers: [], now: () => g.clock.value, book: { operator: "milla", reason: "finish" } });
  assert.equal(next.booked, true); assert.match(next.lines.join("\n"), /already finalized; nothing is booked\. The operator resolution that booked it is now marked booked\./);
  assert.equal(Number((await resolutions(g.db))[0]!.booked_at_ms), NOW);
});

test("the decision needs two hostnames, not two labels, and validates every input before reading anything", async t => {
  const f = await fixture(t), agreed = fill(f.pending);
  const views: SolanaResolveView[] = [{ label: "primary", hostId: "a", observation: { settlement: agreed, seen: true } }, { label: "copy", hostId: "a", observation: { settlement: agreed, seen: true } }];
  assert.equal(solanaResolveDecision(views).book, false);
  const same = providers({ primary: { settlement: agreed, seen: true }, fallback: { settlement: agreed, seen: true } }, { primary: "rpc.example", fallback: "rpc.example" });
  const run = (input: Partial<Parameters<typeof resolveSolanaPendingTrade>[0]>) => resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1",
    providers: same.list, observe: same.observe, now: () => f.clock.value, ...input });
  await assert.rejects(run({}), /its own hostname/);
  const ok = providers({ primary: { settlement: agreed, seen: true }, fallback: { settlement: agreed, seen: true } });
  for (const [input, message] of [
    [{ tenant: `0x${"AB".repeat(20)}` }, /lowercase 0x address/], [{ tenant: `0x${"22".repeat(20)}` }, /No Solana wallet binding/],
    [{ requestId: "missing" }, /No live trade with that request id/], [{ requestId: "-bad" }, /request id/],
    [{ book: { operator: "", reason: "x" } }, /operator's name/], [{ book: { operator: "milla\nroot", reason: "x" } }, /operator's name/],
    [{ book: { operator: "milla", reason: "x".repeat(201) } }, /a reason/],
  ] as const) {
    await assert.rejects(run({ providers: ok.list, observe: ok.observe, ...input }), message, JSON.stringify(input));
  }
  assert.deepEqual(ok.calls, [], "every refusal comes before any provider is asked");
  assert.deepEqual(await resolutions(f.db), []); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
});

// The command itself, over real single-endpoint transports and the executor's own observation, with a fake network.
function network(answers: Record<string, { status: unknown; receipt: unknown }>) {
  const asked: string[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const host = new URL(String(input)).hostname, body = JSON.parse(String(init!.body)) as { id: number; method: string };
    asked.push(`${host} ${body.method}`);
    const answer = answers[host]!;
    const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH
      : body.method === "getSignatureStatuses" ? { context: { slot: 1002 }, value: [answer.status] }
      : body.method === "getTransaction" ? answer.receipt : undefined;
    if (result === undefined) throw new Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}
const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/?api-key=one", MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/key-two" };

test("the command shows each provider's own view through the executor's observation, never an endpoint, and a book without agreement fails", async t => {
  const f = await fixture(t);
  const confirmed = { status: { confirmationStatus: "confirmed", slot: 1001, err: null }, receipt: null };
  // The primary says finalized but its receipt cannot be read; the others have only seen it.
  const net = network({ "primary.example": { status: { confirmationStatus: "finalized", slot: 1001, err: null }, receipt: {} }, "fallback.example": confirmed, "third.example": confirmed });
  const deps = { db: f.db, env: { ...env, MERRYMEN_SOLANA_RESOLVE_THIRD_RPC: "https://third.example/secret-path" }, fetch: net.fetch, now: () => f.clock.value };
  const shown = await runSolanaResolveCommand(["show", TENANT, "stuck-1", "--third-rpc"], deps);
  assert.match(shown, /primary: could not be used: Finalized Solana evidence disagrees with the recorded submission\./);
  assert.match(shown, /fallback: pending: seen, not finalized\n {2}operator's provider: pending: seen, not finalized\nNo provider reports a final outcome yet/);
  for (const secret of ["api-key", "key-two", "secret-path", "https:", ".example"]) assert.ok(!shown.includes(secret), secret);
  assert.ok(net.asked.every(line => /^(primary|fallback|third)\.example (getGenesisHash|getSignatureStatuses|getTransaction)$/.test(line)), net.asked.join(","));
  assert.ok(!net.asked.some(line => /send/i.test(line)), "nothing is ever sent");
  await assert.rejects(runSolanaResolveCommand(["book", TENANT, "stuck-1", "--operator", "milla", "--reason", "try"], deps),
    (error: unknown) => error instanceof SolanaResolveError && /No provider reports a final outcome yet/.test(error.message));
  assert.deepEqual(await resolutions(f.db), []);
  // The operator's provider must be its own host, and an HTTPS URL.
  const third = (url: string) => ({ ...deps, env: { ...env, MERRYMEN_SOLANA_RESOLVE_THIRD_RPC: url } });
  await assert.rejects(runSolanaResolveCommand(["show", TENANT, "stuck-1", "--third-rpc"], third("https://PRIMARY.example./other")), /different hostname/);
  await assert.rejects(runSolanaResolveCommand(["show", TENANT, "stuck-1", "--third-rpc"], third("http://third.example/")), (error: unknown) => error instanceof SolanaRpcError && error.code === "invalid-config");
  for (const argv of [[], ["show", TENANT], ["book", TENANT, "stuck-1", "--operator", "milla"], ["show", TENANT, "stuck-1", "--operator", "milla"],
    ["show", TENANT, "stuck-1", "--force", "yes"], ["resolve", TENANT, "stuck-1"], ["show", TENANT, "stuck-1", "--third-rpc", "--third-rpc"],
    ["show", TENANT, "stuck-1", "--exclude"], ["show", TENANT, "stuck-1", "--exclude", "operator's provider"], ["show", TENANT, "stuck-1", "--exclude", "primary", "--exclude", "fallback"]]) {
    await assert.rejects(runSolanaResolveCommand(argv, deps), (error: unknown) => error instanceof SolanaResolveError && /^Usage: npm run solana:resolve/.test(error.message), argv.join(" "));
  }
  assert.equal(await runSolanaResolveCommand(["history", TENANT], deps), "No operator resolutions are recorded for that tenant.");
});

test("the third provider's URL comes from the environment, never the command line, which is refused without echoing it", async t => {
  const f = await fixture(t);
  const confirmed = { status: { confirmationStatus: "confirmed", slot: 1001, err: null }, receipt: null };
  const net = network({ "primary.example": confirmed, "fallback.example": confirmed, "third.example": confirmed });
  const deps = { db: f.db, env, fetch: net.fetch, now: () => f.clock.value };
  for (const argv of [["show", TENANT, "stuck-1", "--third-rpc", "https://third.example/?api-key=secret"], ["show", TENANT, "stuck-1", "https://third.example/secret"]]) {
    await assert.rejects(runSolanaResolveCommand(argv, deps), (error: unknown) => error instanceof SolanaResolveError
      && /^Do not pass provider URLs on the command line\. Put the third provider's HTTPS URL in MERRYMEN_SOLANA_RESOLVE_THIRD_RPC/.test(error.message) && !/secret|third\.example/.test(error.message), argv.join(" "));
  }
  // The switch without the variable names the variable to set.
  await assert.rejects(runSolanaResolveCommand(["show", TENANT, "stuck-1", "--third-rpc"], deps), /reads the third provider's HTTPS URL from MERRYMEN_SOLANA_RESOLVE_THIRD_RPC/);
  assert.deepEqual(net.asked, [], "refused before any provider is asked");
  // The usage names the variable and the --exclude names.
  await assert.rejects(runSolanaResolveCommand([], deps), (error: unknown) => error instanceof Error
    && /\[--third-rpc\] \[--exclude primary\|fallback\|third\]/.test(error.message) && /MERRYMEN_SOLANA_RESOLVE_THIRD_RPC/.test(error.message));
});

test("an excluded provider's conflicting outcome is shown and recorded, never counted; two others must still agree", async t => {
  const f = await fixture(t), agreed = fill(f.pending);
  // The fallback keeps reporting an expiry the primary and a third provider contradict.
  const views = { primary: { settlement: agreed, seen: true }, fallback: { settlement: expiry(f.pending), seen: false }, "operator's provider": { settlement: agreed, seen: true } };
  const run = (p: ReturnType<typeof providers>, exclude?: string) => resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe,
    now: () => f.clock.value, book: { operator: "milla", reason: "fallback serves a stale fork" }, ...(exclude ? { exclude } : {}) });
  const refused = await run(providers(views));
  assert.equal(refused.booked, false); assert.match(refused.lines.at(-1)!, /different final outcomes.*--exclude/s);
  // Excluding it leaves only one provider when no third one is consulted: nothing is booked.
  const pair = await run(providers({ primary: views.primary, fallback: views.fallback }), "fallback");
  assert.equal(pair.booked, false); assert.match(pair.lines.at(-1)!, /Only one provider reports this final outcome/);
  // A provider that was not consulted cannot be excluded.
  await assert.rejects(run(providers({ primary: views.primary, fallback: views.fallback }), "operator's provider"), /not one of the providers consulted/);
  assert.deepEqual(await resolutions(f.db), []); assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending");
  // With a third provider: booked, and the excluded dissent is in the record.
  const booked = await run(providers(views), "fallback");
  assert.equal(booked.booked, true);
  assert.match(booked.lines.join("\n"), /fallback: never ran: blockhash expired .* \(excluded by the operator: shown and recorded, not counted\)/);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "finalized");
  const evidence = JSON.parse((await resolutions(f.db))[0]!.evidence_json as string);
  assert.equal(evidence.excluded, "fallback"); assert.deepEqual(evidence.agreed, ["primary", "operator's provider"]);
  const dissent = evidence.providers.find((p: { label: string }) => p.label === "fallback");
  assert.equal(dissent.excluded, true); assert.equal(dissent.settlement.status, "expired");
  assert.ok(evidence.providers.filter((p: { excluded?: boolean }) => p.excluded).length === 1);
});

test("an expiry is still refused while an excluded provider has seen the signature", async t => {
  const f = await fixture(t);
  const p = providers({ primary: { settlement: expiry(f.pending, "1201"), seen: false }, fallback: { settlement: fill(f.pending), seen: true },
    "operator's provider": { settlement: expiry(f.pending, "1250"), seen: false } });
  const result = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "dropped" }, exclude: "fallback" });
  assert.equal(result.booked, false); assert.match(result.lines.at(-1)!, /has seen this signature/);
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "pending"); assert.deepEqual(await resolutions(f.db), []);
});

test("the command maps --exclude names to providers, the third one included", async t => {
  const f = await fixture(t);
  const confirmed = { status: { confirmationStatus: "confirmed", slot: 1001, err: null }, receipt: null };
  const net = network({ "primary.example": confirmed, "fallback.example": confirmed, "third.example": confirmed });
  const deps = { db: f.db, env: { ...env, MERRYMEN_SOLANA_RESOLVE_THIRD_RPC: "https://third.example/" }, fetch: net.fetch, now: () => f.clock.value };
  for (const [name, label] of [["primary", "primary"], ["fallback", "fallback"], ["third", "operator's provider"]]) {
    const shown = await runSolanaResolveCommand(["show", TENANT, "stuck-1", "--third-rpc", "--exclude", name!], deps);
    const marked = shown.split("\n").filter(line => line.includes("(excluded by the operator"));
    assert.deepEqual(marked, [`  ${label}: pending: seen, not finalized (excluded by the operator: shown and recorded, not counted)`], name);
  }
});

test("a booking that cannot be marked, or whose reply and re-read are both lost, never claims nothing was booked", async t => {
  // The store books; marking the decision's record fails (the connection drops).
  const f = await fixture(t), agreed = fill(f.pending);
  const p = providers({ primary: { settlement: agreed, seen: true }, "operator's provider": { settlement: agreed, seen: true } });
  const db: Db = { prepare: sql => {
    const statement = f.db.prepare(sql);
    return /^UPDATE solana_operator_resolutions SET booked_at_ms/.test(sql) ? { ...statement, get: statement.get.bind(statement), all: statement.all.bind(statement),
      run: async () => { throw new Error("connection dropped"); } } : statement;
  }, exec: sql => f.db.exec(sql), tx: fn => f.db.tx(fn) };
  await assert.rejects(resolveSolanaPendingTrade({ db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "mark lost" } }), (error: unknown) => error instanceof SolanaResolveError
    && /^Booked a finalized fill, but this decision could not be marked booked in its record\. Run the same book command again/.test(error.message));
  assert.equal((await f.store.get(OWNER, "stuck-1"))!.status, "finalized");
  let [row] = await resolutions(f.db); assert.equal(row!.booked_at_ms, null); assert.equal(row!.refusal, null);
  // The same command again marks it.
  const again = await resolveSolanaPendingTrade({ db: f.db, tenant: TENANT, requestId: "stuck-1", providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "mark lost" } });
  assert.equal(again.booked, true); [row] = await resolutions(f.db); assert.notEqual(row!.booked_at_ms, null);
  // The store commits, its reply is lost, and the trade cannot be read again: unknown, and no refusal is recorded.
  const g = await fixture(t);
  const q = providers({ primary: { settlement: fill(g.pending), seen: true }, "operator's provider": { settlement: fill(g.pending), seen: true } });
  const settle = SolanaTradingStore.prototype.settle, get = SolanaTradingStore.prototype.get;
  let settled = false;
  t.mock.method(SolanaTradingStore.prototype, "settle", async function (this: SolanaTradingStore, ...args: Parameters<SolanaTradingStore["settle"]>) {
    await settle.apply(this, args); settled = true; throw new Error("connection reset after commit");
  });
  t.mock.method(SolanaTradingStore.prototype, "get", async function (this: SolanaTradingStore, ...args: Parameters<SolanaTradingStore["get"]>) {
    if (settled) throw new Error("connection reset"); return get.apply(this, args);
  });
  await assert.rejects(resolveSolanaPendingTrade({ db: g.db, tenant: TENANT, requestId: "stuck-1", providers: q.list, observe: q.observe, now: () => g.clock.value,
    book: { operator: "milla", reason: "reply lost" } }), (error: unknown) => error instanceof SolanaResolveError && /may or may not be booked/.test(error.message) && !/Nothing was booked/.test(error.message));
  t.mock.restoreAll();
  assert.equal((await g.store.get(OWNER, "stuck-1"))!.status, "finalized");
  [row] = await resolutions(g.db); assert.equal(row!.refusal, null, "never recorded as refused"); assert.equal(row!.booked_at_ms, null);
  assert.equal((await resolveSolanaPendingTrade({ db: g.db, tenant: TENANT, requestId: "stuck-1", providers: q.list, observe: q.observe, now: () => g.clock.value,
    book: { operator: "milla", reason: "reply lost" } })).booked, true, "the next run marks it");
  // The CLI's catch-all never says nothing was booked either.
  const cli = readFileSync(new URL("./solana-resolve-cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /nothing was booked/i); assert.match(cli, /may or may not be booked: run show again/);
});

test("the npm script runs the resolve CLI with the Solana env file, like the hold CLI", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  assert.equal(scripts["solana:resolve"], "node --env-file-if-exists=.env.solana.local --import tsx worker/src/solana-resolve-cli.ts");
  const cli = readFileSync(new URL("./solana-resolve-cli.ts", import.meta.url), "utf8");
  assert.match(cli, /runSolanaResolveCommand\(process\.argv\.slice\(2\)/);
});
