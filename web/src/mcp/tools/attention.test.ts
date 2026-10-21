/**
 * get_attention on SQLite with the full ledger schema, through runTool: each
 * condition lands at the severity SEVERITY_MEANING promises, keys hold still
 * while a condition does and change when its severity rises, seen_keys marks
 * what is new and what resolved (and never "resolves" what it did not look
 * at), proposals and alert deliveries appear only under their scopes, no
 * signed limit is offered as a fix, another owner's agents never leak, and
 * the read changes nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runStart } from "@/lib/services/attention";
import { proposalRow } from "@/lib/services/proposals";
import type { AgentDirectory, OwnedAgent } from "../agents";
import type { Principal } from "../oauth/server";
import { resetMetricsForTest } from "../observe";
import { ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, agentFixture, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";
import { toolInProfile } from "../server";
import { runTool, type ToolDef } from "../tool";
import { ATTENTION_TOOLS } from "./attention";
import { PROPOSAL_TOOLS } from "./proposals";

// Links are fixed pages on the configured app address.
process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); });

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86_400;
const BREAKER = "on-chain drawdown breaker TRIPPED: equity is below the signed floor";

const attention = ATTENTION_TOOLS.find((t) => t.name === "get_attention") as unknown as ToolDef;
const draftPost = PROPOSAL_TOOLS.find((t) => t.name === "draft_post") as unknown as ToolDef;

interface Item { key: string; severity: string; kind: string; agent: string | null; title: string; detail: string; owner_can_fix: boolean; what_to_do: string | null; link: string | null; started_at: string | null; ends_at: string | null; new: boolean }
interface Answer { items: Item[]; counts: Record<string, number>; new_counts: Record<string, number>; resolved_keys: string[]; agents_checked: string[]; not_checked: Array<{ part: string; why: string }> }

async function setup(o: { agentA?: Partial<OwnedAgent>; scopes?: string[] } = {}) {
  const d = await makeTestDb();
  const directory: AgentDirectory = {
    async agentsFor(t) {
      const map: Record<string, OwnedAgent[]> = {
        [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, o.agentA)],
        [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B, { expiresAt: NOW - HOUR })],
      };
      return map[t.toLowerCase()] ?? [];
    },
  };
  const deps = makeDeps(d, { agents: directory });
  restore = installFixtures(d, { directory, settings: { [OWNER_A]: { tickSeconds: 240 }, [OWNER_B]: { tickSeconds: 240 } } });
  const a = await connectAs(deps, OWNER_A, o.scopes ? { scopes: o.scopes } : {});
  const b = await connectAs(deps, OWNER_B);
  const directory_ = () => connectAs(deps, OWNER_A, { profile: "directory", scopes: ["agents:read", "notifications:manage"] });
  const ask = async (args: Record<string, unknown> = {}, p: Principal = a.principal, at = NOW) => {
    const r = await runTool(attention, args, p, "trace-test", { now: () => at });
    assert.equal(r.isError, undefined, r.content[0]?.text);
    return r.structuredContent as unknown as Answer;
  };
  return { d, pa: a.principal, pb: b.principal, ask, directory: directory_ };
}

function agentRow(d: TestDb, account: string, o: { status?: string; mode?: string; beat?: number; blocker?: string | null } = {}) {
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, live_blocker, sponsor_gas, epoch)
    VALUES (?, 'Alan', ?, '0x1', 4663, '{}', 1700000000, 4102444800, ?, ?, ?, ?, 0, 1)`)
    .run(account, account === ACCOUNT_A ? OWNER_A : OWNER_B, o.status ?? "armed", o.mode ?? "live", o.beat ?? NOW - 30, o.blocker ?? null);
}

function event(d: TestDb, account: string, message: string, at: number, level = "warn") {
  d.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(account, level, message, at);
}

function refused(d: TestDb, account: string, rule: string, at: number) {
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, reject_rule, created_at) VALUES (?, 'swap', 'router', 10, 'rejected', ?, ?)`).run(account, rule, at);
}

const only = (r: Answer, kind: string) => {
  const hits = r.items.filter((i) => i.kind === kind);
  assert.equal(hits.length, 1, `one ${kind} item in ${JSON.stringify(r.items.map((i) => i.key))}`);
  return hits[0]!;
};

test("a healthy agent needs nothing, and the parts this connection cannot see are named rather than passed as fine", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  const r = await ask();
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.counts, { act_now: 0, today: 0, fyi: 0 });
  assert.deepEqual(r.agents_checked, [SLUG_A]);
  assert.deepEqual(r.not_checked.map((n) => n.part), ["proposals", "alert deliveries"]);
});

test("permission expiry rises through fyi, today and act_now, each a new key, and an old expiry quietens to fyi", async () => {
  const cases: Array<[number, string | null, string]> = [
    [30 * DAY, null, ""],
    [5 * DAY, "fyi", "-7d"],
    [2 * DAY, "today", "-72h"],
    [9 * HOUR, "act_now", "-24h"],
  ];
  for (const [left, severity, tag] of cases) {
    const { d, ask } = await setup({ agentA: { expiresAt: NOW + left } });
    agentRow(d, ACCOUNT_A);
    const r = await ask();
    const items = r.items.filter((i) => i.kind === "permission-expiring");
    if (severity === null) { assert.deepEqual(items, []); restore?.(); restore = null; continue; }
    assert.equal(items.length, 1);
    assert.equal(items[0]!.severity, severity, `${left}s left`);
    assert.equal(items[0]!.key, `permission-expiring:${SLUG_A}:${NOW + left}${tag}`);
    assert.equal(items[0]!.link, "https://app.test/grant");
    assert.equal(items[0]!.ends_at, new Date((NOW + left) * 1000).toISOString());
    restore?.(); restore = null;
  }
  {
    const { d, ask } = await setup({ agentA: { expiresAt: NOW - HOUR } });
    agentRow(d, ACCOUNT_A, { status: "expired" });
    const item = only(await ask(), "permission-expired");
    assert.equal(item.severity, "act_now");
    assert.equal(item.started_at, new Date((NOW - HOUR) * 1000).toISOString());
    restore?.(); restore = null;
  }
  const { d, ask } = await setup({ agentA: { expiresAt: NOW - 10 * DAY } });
  agentRow(d, ACCOUNT_A, { status: "expired" });
  const old = only(await ask(), "permission-expired");
  assert.equal(old.severity, "fyi", "an agent stopped for ten days is not act-now news");
  assert.match(old.key, /-old$/);
});

test("live blockers: funding and re-signing are act_now with the page that fixes them; a deliberate state is nothing; Merrymen's own fault is today with no chore", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A, { blocker: "no-gas" });
  let item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.link, "https://app.test/deposit");
  assert.equal(item.owner_can_fix, true);
  assert.match(item.what_to_do ?? "", /ETH/);

  d.raw.prepare("UPDATE agents SET live_blocker = 'dead-policy'").run();
  item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.link, "https://app.test/grant");

  d.raw.prepare("UPDATE agents SET live_blocker = 'live-not-enabled'").run();
  assert.deepEqual((await ask()).items, [], "live trading switched off is the owner's choice, not a fault");

  d.raw.prepare("UPDATE agents SET live_blocker = 'no-executor'").run();
  item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "today");
  assert.equal(item.owner_can_fix, false);
  assert.equal(item.what_to_do, null);
});

test("a breaker the worker restates every tick is one act_now item from the start of the run, with no limit offered as a fix", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  event(d, ACCOUNT_A, BREAKER, NOW - 20 * HOUR); // an earlier, separate trip
  for (let at = NOW - 2 * HOUR; at <= NOW - 60; at += 240) event(d, ACCOUNT_A, BREAKER, at);
  const item = only(await ask(), "breaker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.started_at, new Date((NOW - 2 * HOUR) * 1000).toISOString());
  assert.equal(item.key, `breaker:${SLUG_A}:${NOW - 2 * HOUR}`);
  assert.equal(item.what_to_do, null);
  assert.equal(item.owner_can_fix, false);
  assert.doesNotMatch(item.detail, /raise|lower|increase|re-sign/i);
  // An hour after the last sighting it has recovered.
  assert.deepEqual((await ask({}, undefined, NOW + HOUR)).items.filter((i) => i.kind === "breaker"), []);
});

test("kill switch, a stale worker, a provider failure and reached caps are named at their severities", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A, { status: "killed" });
  event(d, ACCOUNT_A, "KILL SWITCH — grant discarded, session key destroyed; trading halted", NOW - 3 * HOUR, "err");
  let item = only(await ask(), "killed");
  assert.equal(item.severity, "fyi");
  assert.equal(item.started_at, new Date((NOW - 3 * HOUR) * 1000).toISOString());

  d.raw.prepare("UPDATE agents SET status = 'armed', beat_at = ?").run(NOW - HOUR);
  item = only(await ask(), "worker-stale");
  assert.equal(item.severity, "today");
  assert.equal(item.owner_can_fix, false);
  assert.equal(item.started_at, new Date((NOW - HOUR + 570) * 1000).toISOString(), "stale from the moment the heartbeat aged past 2 x tick + 90 s");

  d.raw.prepare("UPDATE agents SET beat_at = ?").run(NOW - 30);
  for (let at = NOW - 40 * 60; at <= NOW - 120; at += 240) event(d, ACCOUNT_A, "strategist driver failed: 400 json_validate_failed", at);
  item = only(await ask(), "provider-failure");
  assert.equal(item.severity, "fyi");
  assert.equal(item.title, "The AI model provider is failing");
  assert.doesNotMatch(item.detail, /json_validate_failed/, "the provider's own text is never forwarded");

  refused(d, ACCOUNT_A, "daily-cap", NOW - 3 * HOUR);
  refused(d, ACCOUNT_A, "daily-cap", NOW - 600);
  refused(d, ACCOUNT_A, "ops-cap", NOW - 5 * HOUR); // no longer holding anything
  item = only(await ask(), "daily-cap");
  assert.equal(item.severity, "fyi");
  assert.equal(item.started_at, new Date((NOW - 3 * HOUR) * 1000).toISOString());
  assert.equal(item.what_to_do, null, "a reached cap is the signed permission working; raising it is not offered");
  assert.match(item.detail, /trailing 24-hour window/);
  assert.equal((await ask()).items.filter((i) => i.kind === "ops-cap").length, 0);
});

test("seen_keys: what was reported is not new, a fixed condition resolves, a risen severity is news, and an unchecked key never resolves", async () => {
  const { d, ask } = await setup({ agentA: { expiresAt: NOW + 2 * DAY } });
  agentRow(d, ACCOUNT_A, { blocker: "no-cash" });
  const first = await ask();
  assert.deepEqual(first.items.map((i) => [i.kind, i.new]), [["live-blocker", true], ["permission-expiring", true]]);
  const elsewhere = `breaker:${SLUG_B}:${NOW}`;
  const seen = [...first.items.map((i) => i.key), elsewhere];

  const again = await ask({ seen_keys: seen });
  assert.ok(again.items.every((i) => !i.new));
  assert.deepEqual(again.new_counts, { act_now: 0, today: 0, fyi: 0 });
  assert.deepEqual(again.resolved_keys, []);

  d.raw.prepare("UPDATE agents SET live_blocker = NULL").run();
  const later = await ask({ seen_keys: seen }, undefined, NOW + 2 * DAY - 9 * HOUR);
  assert.deepEqual(later.resolved_keys.sort(), [first.items.find((i) => i.kind === "live-blocker")!.key, first.items.find((i) => i.kind === "permission-expiring")!.key].sort());
  const risen = only(later, "permission-expiring");
  assert.equal(risen.severity, "act_now");
  assert.equal(risen.new, true, "nine hours from expiry is news even though two days was reported");
  assert.ok(!later.resolved_keys.includes(elsewhere), "a key about an agent this read did not check stays unknown");

  const bad = await runTool(attention, { seen_keys: ["not a key"] }, (await setup()).pa, "trace-test", { now: () => NOW });
  assert.equal(errorOf(bad).code, "invalid_input");
});

test("proposals waiting for approval appear only under a proposal scope, link to their approval page, and the read expires nothing", async () => {
  const { d, ask, pa } = await setup({ scopes: ["agents:read", "social:write", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  const made = await runTool(draftPost, { text: "gm merrymen", idempotency_key: "post-00001" }, pa, "trace-test", { now: () => NOW });
  assert.equal(made.isError, undefined, made.content[0]?.text);
  const id = (made.structuredContent as { proposal_id: string }).proposal_id;

  const r = await ask();
  const item = only(r, "proposal-waiting");
  assert.equal(item.severity, "today");
  assert.equal(item.link, `https://app.test/connect/approve/${id}`);
  assert.equal(item.agent, SLUG_A);
  assert.ok(!r.not_checked.some((n) => n.part === "proposals"));

  const past = await ask({}, pa, NOW + 30 * DAY);
  assert.deepEqual(past.items.filter((i) => i.kind === "proposal-waiting"), [], "a lapsed proposal is not waiting");
  assert.equal((await proposalRow(d.db, OWNER_A, id))?.status, "awaiting_approval", "and reading did not expire it: get_attention changes nothing");
});

test("undelivered Telegram alerts are an fyi item under notifications:manage", async () => {
  const { d, ask } = await setup({ scopes: ["agents:read", "notifications:manage", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  d.raw.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
    VALUES ('sub_1', ?, ?, 'telegram', 'risk_halt', '{}', 'active', 'c', NULL, ?, ?, NULL)`).run(OWNER_A, SLUG_A, NOW - DAY, NOW - DAY);
  for (const [id, at] of [["dl_1", NOW - 5 * HOUR], ["dl_2", NOW - HOUR], ["dl_old", NOW - 3 * DAY]] as const) {
    d.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, last_error_code, payload_json, created_at, sent_at)
      VALUES (?, 'sub_1', ?, ?, 'risk_halt', 'telegram', 'dead', 5, 0, NULL, '{}', ?, NULL)`).run(id, OWNER_A, `k:${id}`, at);
  }
  const item = only(await ask(), "alerts-failing");
  assert.equal(item.severity, "fyi");
  assert.match(item.detail, /^2 alert message/);
  assert.equal(item.started_at, new Date((NOW - 5 * HOUR) * 1000).toISOString());
  assert.equal(item.link, "https://app.test/settings");
});

test("another owner's agent never appears, and asking for it by id is not found", async () => {
  const { d, ask, pb } = await setup();
  agentRow(d, ACCOUNT_A);
  agentRow(d, ACCOUNT_B, { blocker: "no-gas" });
  event(d, ACCOUNT_B, BREAKER, NOW - 60);
  assert.deepEqual((await ask()).items, []);
  const forB = await ask({}, pb);
  assert.ok(forB.items.length >= 2 && forB.items.every((i) => i.agent === SLUG_B));
  const r = await runTool(attention, { agent: SLUG_B }, (await setup()).pa, "trace-test", { now: () => NOW });
  assert.equal(errorOf(r).code, "not_found");
});

test("the connector-directory listing has the tool too, and says it cannot see proposals rather than asking for a scope it can never hold", async () => {
  assert.ok(toolInProfile(attention, "directory"));
  const { d, ask, directory } = await setup();
  agentRow(d, ACCOUNT_A, { blocker: "no-gas" });
  const r = await ask({}, (await directory()).principal);
  assert.equal(only(r, "live-blocker").severity, "act_now");
  assert.deepEqual(r.not_checked, [{ part: "proposals", why: "The connector-directory listing never sees proposals; they are listed in Merrymen." }]);
});

test("runStart walks back while sightings stay within the gap, and says unknown when the read could have cut the run off", () => {
  assert.equal(runStart([1000, 900, 800, 100], 150, 0, false), 800);
  assert.equal(runStart([1000, 900], 150, 0, false), 900);
  assert.equal(runStart([1000, 900], 150, 800, false), null, "the floor is within the gap of the oldest sighting");
  assert.equal(runStart([1000, 900], 150, 0, true), null, "the read was cut");
  assert.equal(runStart([], 150, 0, false), null);
});
