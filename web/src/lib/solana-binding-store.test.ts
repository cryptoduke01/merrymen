import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { base58Encode } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits } from "../../../packages/core/src/solana";
import { wrapSqlite, translateSchema, type Db } from "../../../worker/src/db";
import { SqlSolanaBindingStore, SolanaBindingError, validateSolanaStrategy } from "./solana-binding-store";

const TENANT = `0x${"11".repeat(20)}` as const, OTHER = `0x${"22".repeat(20)}` as const;
const OWNER = base58Encode(new Uint8Array(32).fill(20)), SECOND = base58Encode(new Uint8Array(32).fill(21));
const NOW = 1_000_000;
const limits: SolanaPaperLimits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3600000 };
function fixture(t: TestContext) {
  const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
  return new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite", () => NOW);
}
test("bindings start in paper mode and cannot replace another wallet or identity", async (t) => {
  const store = fixture(t);
  const first = await store.bind(TENANT, "did:privy:alice", OWNER);
  assert.equal(first.requestedMode, "paper"); assert.equal(first.limits, null); assert.equal(first.revision, 0);
  assert.deepEqual(await store.bind(TENANT, "did:privy:alice", OWNER), first);
  for (const [tenant, did, owner] of [[TENANT, "did:privy:alice", SECOND], [TENANT, "did:privy:bob", OWNER], [OTHER, "did:privy:bob", OWNER]] as const) {
    await assert.rejects(store.bind(tenant, did, owner), (error: unknown) => error instanceof SolanaBindingError && error.code === "conflict");
  }
  assert.deepEqual(await store.get(TENANT), first); assert.equal(await store.get(OTHER), null);
});
test("concurrent first claims cannot bind one Solana wallet to two tenants", async (t) => {
  const store = fixture(t);
  const claims = await Promise.allSettled([store.bind(TENANT, "did:privy:alice", OWNER), store.bind(OTHER, "did:privy:bob", OWNER)]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
});
test("Solana owners remain case-sensitive while tenant IDs remain canonical EVM IDs", async (t) => {
  const store = fixture(t);
  const caseOwner = OWNER.replace(/[A-Z]/, (letter) => letter.toLowerCase());
  assert.notEqual(caseOwner, OWNER);
  await store.bind(TENANT, "did:privy:alice", OWNER);
  await store.bind(OTHER, "did:privy:bob", caseOwner);
  assert.equal((await store.get(OTHER))!.owner, caseOwner);
  await assert.rejects(store.bind("0xABC" as `0x${string}`, "did:privy:test", SECOND));
  await assert.rejects(store.bind(OTHER, "did:privy:bob", " " + SECOND));
});
test("settings save explicit mode and exact raw limits without granting live authority", async (t) => {
  const store = fixture(t);
  await store.bind(TENANT, "did:privy:alice", OWNER);
  const saved = await store.settings(TENANT, OWNER, 0, "live", limits);
  assert.equal(saved.requestedMode, "live"); assert.equal(saved.revision, 1); assert.deepEqual(saved.limits, limits);
  assert.equal("sessionKey" in saved, false); assert.equal("liveReady" in saved, false);
  const paused = await store.settings(TENANT, OWNER, 1, "paper", limits);
  assert.equal(paused.requestedMode, "paper"); assert.equal(paused.revision, 2);
});
test("stale settings and cross-owner writes cannot override current consent", async (t) => {
  const store = fixture(t);
  await store.bind(TENANT, "did:privy:alice", OWNER);
  const results = await Promise.allSettled([
    store.settings(TENANT, OWNER, 0, "live", limits), store.settings(TENANT, OWNER, 0, "paper", limits),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await store.get(TENANT))!.revision, 1);
  for (const [tenant, owner] of [[OTHER, OWNER], [TENANT, SECOND]] as const) {
    await assert.rejects(store.settings(tenant, owner, 1, "live", limits), (e: unknown) => e instanceof SolanaBindingError && e.code === "stale");
  }
});
test("invalid or expired limits cannot change the saved mode", async (t) => {
  const store = fixture(t);
  await store.bind(TENANT, "did:privy:alice", OWNER);
  for (const invalid of [{ ...limits, perTradeUsdg: "50000001" }, { ...limits, expiresAtMs: NOW }, { ...limits, maxDrawdownBps: 0 }]) {
    await assert.rejects(store.settings(TENANT, OWNER, 0, "live", invalid));
  }
  assert.equal((await store.get(TENANT))!.requestedMode, "paper");
  assert.equal((await store.get(TENANT))!.revision, 0);
});

const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };
test("strategy changes share the consent revision fence and switching mode disables autonomy", async (t) => {
  const store = fixture(t);
  await store.bind(TENANT, "did:privy:alice", OWNER);
  assert.equal((await store.get(TENANT))!.strategy, null);
  const saved = await store.strategy(TENANT, OWNER, 0, strategy);
  assert.deepEqual(saved.strategy, strategy); assert.equal(saved.revision, 1);
  await assert.rejects(store.strategy(TENANT, OWNER, 0, { ...strategy, enabled: false }));
  await assert.rejects(store.strategy(OTHER, OWNER, 1, strategy));
  await assert.rejects(store.strategy(TENANT, SECOND, 1, strategy));
  const live = await store.settings(TENANT, OWNER, 1, "live", limits);
  assert.equal(live.strategy, null); assert.equal(live.revision, 2);
  await assert.rejects(store.strategy(TENANT, OWNER, 1, strategy));
});
test("strategy validation rejects unbounded, fractional and extra authority fields", () => {
  for (const item of [{ ...strategy, enabled: "true" }, { ...strategy, targetSolBps: 10001 }, { ...strategy, targetSolBps: -1 },
    { ...strategy, rebalanceBps: 99 }, { ...strategy, rebalanceBps: 5001 }, { ...strategy, intervalSeconds: 29 },
    { ...strategy, intervalSeconds: 86401 }, { ...strategy, intervalSeconds: 60.1 }, { ...strategy, tradeUsdgRaw: "01" },
    { ...strategy, tradeUsdgRaw: "0" }, { ...strategy, tradeUsdgRaw: "18446744073709551616" }, { ...strategy, owner: OWNER }]) {
    assert.throws(() => validateSolanaStrategy(item));
  }
  assert.deepEqual(validateSolanaStrategy({ ...strategy, targetSolBps: 0 }), { ...strategy, targetSolBps: 0 });
});
test("existing binding databases migrate strategy consent without replacing owners", async (t) => {
  const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
  raw.exec(`CREATE TABLE solana_wallet_bindings (tenant TEXT PRIMARY KEY,did TEXT NOT NULL,chain TEXT NOT NULL,owner TEXT NOT NULL UNIQUE,
    requested_mode TEXT NOT NULL,limits_json TEXT,revision BIGINT NOT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL)`);
  const store = new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite", () => NOW);
  const first = await store.bind(TENANT, "did:privy:alice", OWNER);
  assert.equal(first.strategy, null);
  assert.equal((await store.strategy(TENANT, OWNER, 0, strategy)).owner, OWNER);
});
test("Postgres binding initialization applies the driver migration translation once", async () => {
  const statements: string[] = [];
  const db: Db = {
    prepare: () => ({ run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => undefined, all: async () => [] }),
    exec: async (sql) => { statements.push(translateSchema(sql)); }, tx: async (fn) => fn(db),
  };
  const store = new SqlSolanaBindingStore(async () => db, "postgres", () => NOW);
  assert.equal(await store.get(TENANT), null);
  assert.ok(statements.includes("ALTER TABLE solana_wallet_bindings ADD COLUMN IF NOT EXISTS strategy_json TEXT"));
  assert.ok(statements.every((sql) => !sql.includes("IF NOT EXISTS IF NOT EXISTS")));
});
