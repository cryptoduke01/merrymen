/**
 * EVERY TRADE SAID, MINUTE BY MINUTE (third review of the recap branch,
 * 2026-10-14). The planner's rules are each pinned in recap.test.ts; this
 * runs them together, a pass a minute with a send loop that keeps the gap,
 * the caps and the send-time staleness, over the bursts the review found
 * lost trades in and over seeded random ones, casual posts on and off. Every
 * trade is said by its own post or a recap, unless the day's posts ran out;
 * no recap says a trade another recap said; nothing planned goes stale.
 * Pure: the planner and the send decision, no store, no model.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVE_CADENCE,
  RECAP_WINDOW_MS,
  buyKey,
  introKey,
  planPosts,
  recapCoverOf,
  recapCoverText,
  sendDecision,
  type PlanCall,
  type PlanClock,
} from "./planner";
import type { XPost } from "./store";

const MIN = 60_000, HOUR = 60 * MIN;
const DAY0 = Date.UTC(2026, 9, 13);
const TENANT = `0x${"ab".repeat(20)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A plain 23:00–07:00 night in UTC. */
const clock: PlanClock = {
  localDay: (_tz, ms) => day(ms),
  localMinutes: (_tz, ms) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); },
  isAsleep: (_tz, _k, ms) => { const m = new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(); return m >= 23 * 60 || m < 7 * 60; },
};

interface Run { unsaid: string[]; twice: string[]; stale: string[]; capped: Set<string>; singles: Map<string, number> }

/**
 * One owner's day, a pass a minute: due posts go out (a gap's deferral, the
 * day's caps, staleness by the active cadence), then the plan pass sees the
 * calls the orchestrator reads (`readMs` back) and writes what it plans.
 */
function simulate(o: { trades: number[]; fromH: number; toH: number; casual: boolean; readMs?: number }): Run {
  const calls: PlanCall[] = o.trades.map((h, i) => ({ decisionId: `d-${i}`, side: "buy", symbol: ["CAPITOL", "WISP", "INDEX", "PEPE"][i % 4]!,
    name: null, paper: false, atSec: Math.floor((DAY0 + h * HOUR) / 1000) }));
  const posts: XPost[] = [];
  const stale: string[] = [];
  const capped = new Set<string>();
  const account = { xUserId: "111", posting: true, prefs: { buys: true, casual: o.casual } };
  for (let now = DAY0 + o.fromH * HOUR; now <= DAY0 + o.toH * HOUR; now += MIN) {
    for (const p of posts.filter((q) => q.status === "scheduled" && q.dueAtMs <= now).sort((a, b) => a.dueAtMs - b.dueAtMs)) {
      const d = sendDecision(p, account, now, false, day, { tradeStaleMs: ACTIVE_CADENCE.sendStaleMs });
      if (d.action === "skip") { Object.assign(p, { status: "skipped", reason: "stale", updatedAtMs: now }); stale.push(p.dedupeKey); continue; }
      if (d.action !== "send") continue;
      const out = posts.filter((q) => q.status === "posted");
      const last = Math.max(-Infinity, ...out.map((q) => q.sentAtMs!));
      if (now - last < ACTIVE_CADENCE.gapMs) { Object.assign(p, { dueAtMs: last + ACTIVE_CADENCE.gapMs, updatedAtMs: now }); continue; }
      const today = out.filter((q) => day(q.sentAtMs!) === day(now));
      const trades = today.filter((q) => q.kind === "buy" || q.kind === "sell" || q.kind === "recap");
      if (today.length >= ACTIVE_CADENCE.perDay || (p.kind !== "casual" && trades.length >= ACTIVE_CADENCE.tradePerDay)) { capped.add(day(now)); continue; }
      Object.assign(p, { status: "posted", sentAtMs: now, updatedAtMs: now });
    }
    const seen = calls.filter((c) => c.atSec * 1000 <= now && now - c.atSec * 1000 < (o.readMs ?? RECAP_WINDOW_MS));
    const intents = planPosts({ tenant: TENANT, account: { xUserId: "111", consentAtMs: DAY0 - 2 * 24 * HOUR }, tz: "UTC", nowMs: now, clock,
      intros: [{ dedupeKey: introKey(TENANT, "111"), status: "posted", reason: null, createdAtMs: DAY0 - 2 * 24 * HOUR, updatedAtMs: DAY0 - 2 * 24 * HOUR }],
      posts, calls: seen, perDay: ACTIVE_CADENCE.perDay, cadence: ACTIVE_CADENCE, money: "live",
      kinds: { buys: true, casual: o.casual }, recaps: posts.filter((p) => p.kind === "recap") });
    for (const i of intents) {
      assert.ok(!posts.some((p) => p.dedupeKey === i.dedupeKey), `planned twice: ${i.dedupeKey}`);
      posts.push({ id: posts.length + 1, tenant: TENANT, xUserId: "111", kind: i.kind, dedupeKey: i.dedupeKey, body: "x",
        coin: i.kind === "recap" ? recapCoverText(i.covers) : null, decisionId: i.kind === "buy" ? i.call.decisionId : null,
        status: "scheduled", reason: null, createdAtMs: now, dueAtMs: i.dueAtMs, sentAtMs: null, tweetId: null, updatedAtMs: now } as XPost);
    }
  }
  const singles = new Map<string, number>(), recapped = new Map<string, number>();
  for (const p of posts.filter((q) => q.status === "posted")) {
    if (p.kind === "buy") singles.set(buyKey(p.decisionId!), p.sentAtMs!);
    if (p.kind === "recap") for (const k of recapCoverOf(p.coin)) recapped.set(k, (recapped.get(k) ?? 0) + 1);
  }
  const unsaid = calls.map((c) => buyKey(c.decisionId)).filter((k) => !singles.has(k) && !recapped.has(k));
  return { unsaid, twice: [...recapped].filter(([, n]) => n > 1).map(([k]) => k), stale, capped, singles };
}

/** Every trade said, unless a day's posts ran out; none in two recaps; nothing gone stale. */
function assertSaid(r: Run, what: string) {
  assert.deepEqual(r.twice, [], `${what}: a trade in two recaps`);
  assert.deepEqual(r.stale, [], `${what}: planned to go stale`);
  if (r.capped.size === 0) assert.deepEqual(r.unsaid, [], `${what}: never said`);
}

describe("every trade of an active agent is said", () => {
  it("a trade the casual posts' far reservations kept out of reach (review: casual took every slot until it went stale)", () => {
    const r = simulate({ trades: [11.426, 12.019, 12.219], fromH: 10.5, toH: 24, casual: true });
    assertSaid(r, "three buys around noon");
    assert.equal(r.capped.size, 0);
    // Each by its own post, a gap apart, ahead of the afternoon's casual posts: never left for a recap that need not come.
    assert.deepEqual([...r.singles.values()].map((ms) => new Date(ms).toISOString().slice(11, 16)), ["12:18", "13:33", "14:48"]);
  });

  it("a burst's tail of one or two, after a recap said the rest (review: below the minimum, no recap came)", () => {
    const trades = Array.from({ length: 16 }, (_, i) => 1 + i * 0.15);
    const r = simulate({ trades, fromH: 0.9, toH: 14, casual: false });
    assertSaid(r, "sixteen night buys");
    assert.equal(r.capped.size, 0);
  });

  it("trades six to eight hours old, which only a recap can say, with the plan pass reading a recap's window of calls", () => {
    const trades = Array.from({ length: 18 }, (_, i) => 1 + i * (4 / 60));
    assertSaid(simulate({ trades, fromH: 0.9, toH: 16, casual: false }), "eighteen buys four minutes apart");
    // The six-hour read the plan pass had without a mention batch lost them: the reason it reads eight.
    assert.notDeepEqual(simulate({ trades, fromH: 0.9, toH: 16, casual: false, readMs: 6 * HOUR }).unsaid, []);
  });

  for (const casual of [false, true]) {
    it(`seeded random bursts, casual posts ${casual ? "on" : "off"}`, () => {
      let seed = casual ? 7 : 13;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let n = 0; n < 40; n++) {
        const count = 2 + Math.floor(rnd() * 20), base = rnd() * 24, spread = rnd() * 10;
        const trades = Array.from({ length: count }, () => +(base + rnd() * spread).toFixed(3)).sort((a, b) => a - b);
        assertSaid(simulate({ trades, fromH: Math.max(0, base - 0.5), toH: base + spread + 16, casual }), `burst ${n} ${JSON.stringify(trades)}`);
      }
    });
  }
});
