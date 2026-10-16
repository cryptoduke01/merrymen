import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { readAgentDirectory } from "./agent-directory";
import { readLeaderboard } from "./read-leaderboard";

const NOW = 2_000_000_000;
async function fixture(active = 34, retired = 130) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  // Match the observed public fleet size; ledger history exists but a directory
  // must never read it. Distinct identifiers keep alias/retirement behavior real.
  const ids: { tenant: `0x${string}`; slug: string; accounts: `0x${string}`[]; createdAt: number; updatedAt: number }[] = [];
  const insert = raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, status, created_at, name, mode, beat_at) VALUES (?, 'owner', 'key', 4663, '{}', ?, ?, ?, ?, ?, 'paper', ?)`);
  for (let i = 0; i < active + retired; i++) {
    const account = `0x${i.toString(16).padStart(40, "0")}` as const;
    insert.run(account, NOW - 1000, NOW + 1000, i < active ? "armed" : "killed", NOW - i, `Agent ${i}`, NOW - 60);
    ids.push({ tenant: account, slug: `public-${i}`, accounts: [account], createdAt: NOW - i, updatedAt: NOW });
  }
  return { raw, db, identities: async () => ids };
}

function observed(db: Db) {
  const queries: string[] = [];
  const reader: Db = {
    prepare(sql) { queries.push(sql); return db.prepare(sql); },
    exec: sql => db.exec(sql),
    tx: fn => db.tx(fn),
  };
  return { reader, queries };
}

test("164-account directory has the ranking's lifecycle selection without financial/history reads", async (t) => {
  const f = await fixture();
  try {
    const fast = observed(f.db);
    const start = performance.now();
    const directory = await readAgentDirectory(fn => fn(fast.reader), f.identities, () => NOW);
    const duration = performance.now() - start;
    assert.equal(directory.agents.length, 34);
    assert.equal(directory.retired, 130);
    assert.equal(directory.fetchedAt, NOW * 1000);
    assert.ok(directory.agents.every(r => r.landed === null && r.pnlBps === null && r.unrankedWhy === "not-read"));
    assert.ok(fast.queries.every(sql => !/\b(?:trades|equity|flows|tenant_settings)\b/i.test(sql)), "no financial query can delay identity discovery");
    assert.equal(fast.queries.length, 4, "selection cost stays fixed as the fleet grows");
    assert.doesNotMatch(JSON.stringify(directory), /smart_account|owner_address|session_key|caps|equityUsdg|pnlUsdg|performance/);

    const slow = observed(f.db);
    let settingsReads = 0;
    const fullStart = performance.now();
    const ranking = await readLeaderboard(fn => fn(slow.reader), f.identities, () => NOW, async () => { settingsReads++; return null; });
    const fullDuration = performance.now() - fullStart;
    assert.deepEqual(new Set(directory.agents.map(r => r.slug)), new Set(ranking.agents.map(r => r.slug)));
    assert.equal(directory.retired, ranking.retired);
    assert.ok(slow.queries.length > fast.queries.length);
    assert.equal(settingsReads, 164);
    t.diagnostic(`164-account fixture: directory ${duration.toFixed(2)}ms / ${fast.queries.length} ledger queries; full board ${fullDuration.toFixed(2)}ms / ${slow.queries.length} ledger queries + ${settingsReads} settings reads. Local SQLite timings are not production latency.`);
  } finally { f.raw.close(); }
});

test("unknown identities keep rows visible and never invent a retired count", async () => {
  const f = await fixture(2, 2);
  try {
    const r = await readAgentDirectory(fn => fn(f.db), async () => { throw new Error("unread"); }, () => NOW);
    assert.equal(r.agents.length, 4);
    assert.equal(r.retired, null);
    assert.ok(r.agents.every(a => a.slug === null));
  } finally { f.raw.close(); }
});

test("no database or unread selection is not a successful empty directory", async () => {
  const none = await readAgentDirectory(fn => fn(null), async () => [], () => NOW);
  assert.equal(none.source, "none");
  const raw = new DatabaseSync(":memory:");
  try {
    const result = await readAgentDirectory(fn => fn(wrapSqlite(raw)), async () => [], () => NOW);
    assert.equal(result.source, "none");
  } finally { raw.close(); }
});
