/**
 * AN ACTIVE AGENT'S TRADE POSTS (the owner's ask, 2026-10-14): through the
 * night, while six hours fresh, and one recap for a burst the gap could not
 * post one by one. Pure: the planner, the send decision, the figures line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVE_CADENCE,
  ACTIVE_TRADE_FRESH_MS,
  ACTIVE_TRADE_STALE_MS,
  BUY_STALE_MS,
  RECAP_GAP_MS,
  RECAP_HORIZON_MS,
  STANDARD_CADENCE,
  buyKey,
  introKey,
  planPosts,
  recapCovers,
  recapKey,
  sendDecision,
  type PlanCall,
  type PlanClock,
  type PlanInput,
  type PlanIntent,
  type PlanSell,
} from "./planner";
import { admitFiguresLine, renderFiguresLine, withFigures, withoutFiguresLine } from "./figures";
import { recapFigures, recapLines, RECAP_LINES } from "./recap";
import type { XPost } from "./store";

const MIN = 60_000, HOUR = 60 * MIN;
const DAY0 = Date.UTC(2026, 9, 13);
const TENANT = `0x${"ab".repeat(20)}`;
/** A plain 23:00–07:00 night in UTC. */
const clock: PlanClock = {
  localDay: (_tz, ms) => new Date(ms).toISOString().slice(0, 10),
  localMinutes: (_tz, ms) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); },
  isAsleep: (tz, _k, ms) => { if (tz === null) return false; const m = new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(); return m >= 23 * 60 || m < 7 * 60; },
};
let id = 1;
const buy = (h: number, over: Partial<PlanCall> = {}): PlanCall =>
  ({ decisionId: `d-${id++}`, side: "buy", symbol: ["CAPITOL", "WISP", "INDEX", "PEPE"][id % 4]!, name: null, paper: false, atSec: (DAY0 + h * HOUR) / 1000, ...over });
const sale = (h: number, outcome: PlanSell["outcome"], gainPct: number | null = null): PlanSell =>
  ({ decisionId: `s-${id}`, side: "sell", symbol: "WISP", name: null, paper: false, atSec: (DAY0 + h * HOUR) / 1000,
    operationKey: `0x${String(id++).padStart(64, "a")}`, token: `0x${"c".repeat(40)}`, outcome, gainPct });
function post(over: Partial<XPost>): XPost {
  return { id: id++, tenant: TENANT, xUserId: "111", kind: "buy", dedupeKey: `k${id}`, body: "a post", coin: null, decisionId: null, status: "posted",
    reason: null, createdAtMs: DAY0, dueAtMs: DAY0, sentAtMs: DAY0, tweetId: null, updatedAtMs: DAY0, ...over } as XPost;
}
function input(over: Partial<PlanInput> = {}): PlanInput {
  return { tenant: TENANT, account: { xUserId: "111", consentAtMs: DAY0 - 2 * 24 * HOUR }, tz: "UTC", nowMs: DAY0 + 10 * HOUR, clock,
    intros: [{ dedupeKey: introKey(TENANT, "111"), status: "posted", reason: null, createdAtMs: DAY0 - 2 * 24 * HOUR, updatedAtMs: DAY0 - 2 * 24 * HOUR }],
    posts: [], calls: [], perDay: ACTIVE_CADENCE.perDay, cadence: ACTIVE_CADENCE, money: "live", ...over };
}
const kinds = (out: PlanIntent[]) => out.map((i) => i.kind);

describe("an active agent's trade posts through the night", () => {
  it("plans a fresh buy at three in the morning, and no casual post or hello", () => {
    const at3 = DAY0 + 3 * HOUR;
    assert.equal(clock.isAsleep("UTC", TENANT, at3), true);
    const out = planPosts(input({ nowMs: at3, calls: [buy(2.9)] }));
    assert.deepEqual(kinds(out), ["buy"]);
    // A standard owner's night holds everything, as before.
    assert.deepEqual(planPosts(input({ nowMs: at3, calls: [buy(2.9)], cadence: STANDARD_CADENCE, perDay: 3 })), []);
    // And a hello still waits for morning, alone.
    assert.deepEqual(planPosts(input({ nowMs: at3, calls: [buy(2.9)], intros: [] })), []);
  });

  it("sends a trade post at night only for a cadence that trades at night (the caller's asleep), and stales it on its own window", () => {
    const account = { xUserId: "111", posting: true };
    const p = post({ kind: "buy", createdAtMs: DAY0, dueAtMs: DAY0 + MIN, status: "scheduled", sentAtMs: null });
    assert.deepEqual(sendDecision(p, account, DAY0 + 2 * MIN, false), { action: "send" });
    assert.deepEqual(sendDecision(p, account, DAY0 + BUY_STALE_MS + MIN, false), { action: "skip", reason: "stale" });
    assert.deepEqual(sendDecision(p, account, DAY0 + BUY_STALE_MS + MIN, false, undefined, { tradeStaleMs: ACTIVE_TRADE_STALE_MS }), { action: "send" });
    assert.deepEqual(sendDecision({ ...p, kind: "recap" }, account, DAY0 + ACTIVE_TRADE_STALE_MS + MIN, false, undefined, { tradeStaleMs: ACTIVE_TRADE_STALE_MS }), { action: "skip", reason: "stale" });
    // A recap goes with the buy posts when the owner turns those off.
    assert.deepEqual(sendDecision({ ...p, kind: "recap" }, { ...account, prefs: { buys: false, casual: true } }, DAY0 + 2 * MIN, false), { action: "cancel", reason: "kind-off" });
  });
});

describe("a wider window", () => {
  it("posts an active agent's buy while six hours fresh; a standard owner's while two", () => {
    const now = DAY0 + 15 * HOUR;
    const fiveHoursOld = buy(10);
    assert.equal(ACTIVE_TRADE_FRESH_MS, 6 * HOUR);
    const buys = (o: Partial<PlanInput>) => kinds(planPosts(input({ nowMs: now, ...o }))).filter((k) => k === "buy");
    assert.deepEqual(buys({ calls: [fiveHoursOld] }), ["buy"]);
    assert.deepEqual(buys({ calls: [fiveHoursOld], cadence: STANDARD_CADENCE, perDay: 3 }), []);
    assert.deepEqual(buys({ calls: [buy(8.5)] }), [], "past six hours, no single post");
  });
});

describe("one recap for a burst", () => {
  // Eight buys in an hour and a half, the burst over by 07:30; it is 08:00.
  const burst = () => [5.5, 5.7, 5.9, 6.1, 6.3, 6.6, 6.9, 7.2].map((h) => buy(h));
  const now = DAY0 + 8 * HOUR;

  it("posts the first soon and says the rest in one recap, keyed by the newest trade it covers", () => {
    const calls = burst();
    const out = planPosts(input({ nowMs: now, calls }));
    const singles = out.filter((i) => i.kind === "buy");
    const recap = out.find((i): i is Extract<PlanIntent, { kind: "recap" }> => i.kind === "recap");
    assert.ok(singles.length >= 1 && singles.length <= 2, `${singles.length} single posts`);
    for (const s of singles) assert.ok(s.dueAtMs <= now + RECAP_HORIZON_MS, "a single post goes out soon or not at all");
    assert.ok(recap, "and a recap");
    assert.equal(recap!.buys.length, 8, "the recap counts every trade of the burst");
    assert.equal(recap!.dedupeKey, recapKey(TENANT, calls[7]!.atSec));
    assert.equal(recapCovers(recap!.dedupeKey), calls[7]!.atSec);
  });

  it("never posts one by one what a recap already said, and no second recap for three hours", () => {
    const calls = burst();
    const recapPost = post({ kind: "recap", dedupeKey: recapKey(TENANT, calls[7]!.atSec), status: "posted", sentAtMs: now, dueAtMs: now });
    const later = planPosts(input({ nowMs: now + 30 * MIN, calls, posts: [recapPost] }));
    assert.deepEqual(later, [], "the burst is said");
    // New trades after it: posted one by one, and recapped only after the gap.
    const more = [...calls, buy(8.6), buy(8.7), buy(8.8), buy(8.9), buy(9), buy(9.1)];
    const soon = planPosts(input({ nowMs: now + 2 * HOUR, calls: more, posts: [recapPost] }));
    assert.ok(!soon.some((i) => i.kind === "recap"), "no recap inside the gap");
    const after = planPosts(input({ nowMs: now + RECAP_GAP_MS + MIN, calls: more, posts: [recapPost] }));
    const next = after.find((i): i is Extract<PlanIntent, { kind: "recap" }> => i.kind === "recap");
    assert.ok(next);
    assert.equal(next!.buys.length, 6, "only the trades since the last recap");
  });

  it("no recap for a couple of trades, mid-burst, of the other money, or with buy posts off", () => {
    assert.ok(!planPosts(input({ nowMs: now, calls: [buy(7), buy(7.1)] })).some((i) => i.kind === "recap"), "two trades post one by one");
    const live = [7.8, 7.85, 7.9, 7.95].map((h) => buy(h));
    assert.ok(!planPosts(input({ nowMs: now, calls: live })).some((i) => i.kind === "recap"), "the burst is still going");
    assert.ok(!planPosts(input({ nowMs: now, calls: burst().map((c) => ({ ...c, paper: true })) })).some((i) => i.kind === "recap"), "paper trades, live agent");
    assert.deepEqual(planPosts(input({ nowMs: now, calls: burst(), kinds: { buys: false } })).filter((i) => i.kind === "recap" || i.kind === "buy"), []);
    assert.ok(!planPosts(input({ nowMs: now, calls: burst(), money: null })).some((i) => i.kind === "recap"), "idle");
  });

  it("counts receipt-backed sales with their outcomes when trade results are on", () => {
    const sells = [sale(6, "profit", 12.4), sale(6.5, "loss", null), sale(7, "profit", 3.1)];
    const out = planPosts(input({ nowMs: now, calls: burst(), tradeResults: true, sells }));
    const recap = out.find((i): i is Extract<PlanIntent, { kind: "recap" }> => i.kind === "recap");
    assert.ok(recap);
    assert.equal(recap!.sells.length, 3);
    assert.equal(renderFiguresLine(recapFigures(recap!))?.startsWith("recap: 8 buys, 3 sells (2 green, 1 red), best +12.4%; traded "), true);
  });
});

describe("a recap's words and figures", () => {
  it("renders counts, outcomes, the best gain and the coins in the line's own grammar", () => {
    const spec = recapFigures({ buys: [buy(1, { symbol: "CAPITOL" }), buy(2, { symbol: "WISP" })], sells: [sale(3, "profit", 22.04)], results: [sale(3, "profit", 22.04)] });
    const line = renderFiguresLine(spec);
    assert.equal(line, "recap: 2 buys, 1 sell (1 green, 0 red), best +22%; traded WISP, CAPITOL.");
    assert.ok(admitFiguresLine(line));
    assert.equal(renderFiguresLine(recapFigures({ buys: [], sells: [sale(1, "loss")], results: [sale(1, "loss")] })), "recap: 1 sell (0 green, 1 red); traded WISP.");
    assert.equal(renderFiguresLine(recapFigures({ buys: [], sells: [], results: [] })), null, "nothing to recap, no line");
  });

  it("never claims a gain it did not measure, nor an outcome of a sale it did not count", () => {
    for (const bad of ["recap: 2 buys, best +12%.", "recap: 1 sell, best +12%.", "recap: 0 buys.", "recap: 3 buys, traded PEPE."]) {
      assert.equal(admitFiguresLine(bad), false, bad);
    }
    assert.equal(renderFiguresLine([{ kind: "recap", buys: 1, sells: 1, wins: 3, losses: 0, bestPct: 50 }]), "recap: 1 buy, 1 sell.", "outcomes past the sales counted are dropped, and the best with them");
  });

  it("drops the coins, then the best gain, before the post runs long, and keeps the counts", () => {
    const spec = recapFigures({ buys: [buy(1, { symbol: "CAPITOL" }), buy(2, { symbol: "WISP" }), buy(3, { symbol: "INDEX" })], sells: [sale(4, "profit", 9)], results: [sale(4, "profit", 9)] });
    const long = withFigures("x".repeat(200), spec);
    assert.ok(long.line === null || /^recap: 3 buys, 1 sell/.test(long.line));
    const short = withFigures("busy stretch on the desk, here's the rundown", spec);
    assert.equal(short.dropped, 0);
    assert.equal(withoutFiguresLine(short.text), "busy stretch on the desk, here's the rundown.");
  });

  it("has eight lines, this recap's own first, a paper clause on paper, no digit and no result word", () => {
    const a = recapLines(recapKey(TENANT, 1)), b = recapLines(recapKey(TENANT, 2));
    assert.equal(a.length, RECAP_LINES.length);
    assert.deepEqual([...a].sort(), [...b].sort());
    for (const l of [...a, ...recapLines("x", { paper: true })]) {
      assert.doesNotMatch(l, /\p{N}|\$|@|#|https?:|green|red|profit|loss|gain|win|morning|night|tonight|today/iu, l);
    }
    assert.ok(recapLines("x", { paper: true }).every((l) => /paper|practice/.test(l)));
    assert.equal(buyKey("d-1"), "buy:d-1");
  });
});
