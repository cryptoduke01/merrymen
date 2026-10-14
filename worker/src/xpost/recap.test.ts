/**
 * AN ACTIVE AGENT'S TRADE POSTS (the owner's ask, 2026-10-14): through the
 * night, while six hours fresh, and one recap for a burst the gap could not
 * post one by one; and every finding of the branch's review, pinned. Pure:
 * the planner, the send decision, the figures line, the recap's words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVE_CADENCE,
  ACTIVE_TRADE_FRESH_MS,
  ACTIVE_TRADE_SEND_STALE_MS,
  BUY_STALE_MS,
  RECAP_GAP_MS,
  RECAP_HORIZON_MS,
  STANDARD_CADENCE,
  buyKey,
  introKey,
  maybeOut,
  planPosts,
  recapCoverOf,
  recapCoverText,
  recapKey,
  sellKey,
  sendDecision,
  type PlanCall,
  type PlanClock,
  type PlanInput,
  type PlanIntent,
  type PlanSell,
} from "./planner";
import { admitFiguresLine, renderFiguresLine, withFigures, withoutFiguresLine } from "./figures";
import { RECAP_SLOTS, recapFigures, recapLines, recapStillHolds } from "./recap";
import type { XPost } from "./store";
import { REPEAT_LIMIT, similarity } from "../social-post";

const MIN = 60_000, HOUR = 60 * MIN;
const DAY0 = Date.UTC(2026, 9, 13);
const TENANT = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
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
const recapOf = (out: PlanIntent[]) => out.find((i): i is Extract<PlanIntent, { kind: "recap" }> => i.kind === "recap");
/** A recap row as writeIntent writes it: its covered keys in `coin`. */
const recapRow = (r: Extract<PlanIntent, { kind: "recap" }>, over: Partial<XPost> = {}) =>
  post({ kind: "recap", dedupeKey: r.dedupeKey, coin: recapCoverText(r.covers), status: "posted", sentAtMs: r.dueAtMs, dueAtMs: r.dueAtMs, ...over });

describe("an active agent's trade posts through the night", () => {
  it("plans a fresh buy at three in the morning, and no casual post or hello", () => {
    const at3 = DAY0 + 3 * HOUR;
    assert.equal(clock.isAsleep("UTC", TENANT, at3), true);
    assert.deepEqual(kinds(planPosts(input({ nowMs: at3, calls: [buy(2.9)] }))), ["buy"]);
    assert.deepEqual(planPosts(input({ nowMs: at3, calls: [buy(2.9)], cadence: STANDARD_CADENCE, perDay: 3 })), [], "a standard owner's night holds everything");
    assert.deepEqual(planPosts(input({ nowMs: at3, calls: [buy(2.9)], intros: [] })), [], "a hello still waits for morning");
  });

  it("goes stale four hours after its draft on the active cadence, so never more than ten after its fill", () => {
    const account = { xUserId: "111", posting: true };
    const p = post({ kind: "buy", createdAtMs: DAY0, dueAtMs: DAY0 + MIN, status: "scheduled", sentAtMs: null });
    assert.equal(ACTIVE_CADENCE.sendStaleMs, ACTIVE_TRADE_SEND_STALE_MS);
    assert.equal(ACTIVE_TRADE_FRESH_MS + ACTIVE_TRADE_SEND_STALE_MS, 10 * HOUR);
    assert.deepEqual(sendDecision(p, account, DAY0 + 2 * MIN, false), { action: "send" });
    assert.deepEqual(sendDecision(p, account, DAY0 + BUY_STALE_MS + MIN, false), { action: "skip", reason: "stale" });
    assert.deepEqual(sendDecision(p, account, DAY0 + ACTIVE_TRADE_SEND_STALE_MS + MIN, false, undefined, { tradeStaleMs: ACTIVE_CADENCE.sendStaleMs }), { action: "skip", reason: "stale" });
    assert.deepEqual(sendDecision({ ...p, kind: "recap" }, account, DAY0 + ACTIVE_TRADE_SEND_STALE_MS + MIN, false, undefined, { tradeStaleMs: ACTIVE_CADENCE.sendStaleMs }), { action: "skip", reason: "stale" });
    assert.deepEqual(sendDecision({ ...p, kind: "recap" }, { ...account, prefs: { buys: false, casual: true } }, DAY0 + 2 * MIN, false), { action: "cancel", reason: "kind-off" });
  });
});

describe("a wider window", () => {
  it("posts an active agent's buy while six hours fresh; a standard owner's while two", () => {
    const now = DAY0 + 15 * HOUR;
    const buys = (o: Partial<PlanInput>) => kinds(planPosts(input({ nowMs: now, ...o }))).filter((k) => k === "buy");
    assert.deepEqual(buys({ calls: [buy(10)] }), ["buy"]);
    assert.deepEqual(buys({ calls: [buy(10)], cadence: STANDARD_CADENCE, perDay: 3 }), []);
    assert.deepEqual(buys({ calls: [buy(8.5)] }), [], "past six hours, no single post");
  });
});

describe("one recap for a burst", () => {
  // Eight buys in an hour and a half, the burst over by 07:12; it is 08:00.
  const burst = () => [5.5, 5.7, 5.9, 6.1, 6.3, 6.6, 6.9, 7.2].map((h) => buy(h));
  const now = DAY0 + 8 * HOUR;

  it("posts the first soon and says the rest in one recap that records every trade it covers", () => {
    const calls = burst();
    const out = planPosts(input({ nowMs: now, calls }));
    const singles = out.filter((i) => i.kind === "buy");
    const recap = recapOf(out);
    assert.ok(singles.length >= 1 && singles.length <= 2, `${singles.length} single posts`);
    for (const s of singles) assert.ok(s.dueAtMs <= now + RECAP_HORIZON_MS, "a single post goes out soon or not at all");
    assert.ok(recap);
    assert.equal(recap!.buys.length, 8);
    assert.deepEqual(recap!.covers.sort(), calls.map((c) => buyKey(c.decisionId)).sort());
    assert.equal(recap!.dedupeKey, recapKey(TENANT, calls[7]!.atSec));
    assert.deepEqual(recapCoverOf(recapCoverText(recap!.covers)).sort(), recap!.covers.sort());
  });

  it("never posts one by one, nor recaps again, what a recap covered; no second recap for three hours", () => {
    const calls = burst();
    const recap = recapOf(planPosts(input({ nowMs: now, calls })))!;
    const row = recapRow(recap);
    assert.deepEqual(planPosts(input({ nowMs: now + 30 * MIN, calls, posts: [row] })), [], "the burst is said");
    const more = [...calls, ...[8.6, 8.7, 8.8, 8.9, 9, 9.1].map((h) => buy(h))];
    assert.ok(!planPosts(input({ nowMs: now + 2 * HOUR, calls: more, posts: [row] })).some((i) => i.kind === "recap"), "no recap inside the gap");
    // The gap runs from when the recap went out.
    const next = recapOf(planPosts(input({ nowMs: row.sentAtMs! + RECAP_GAP_MS + MIN, calls: more, posts: [row] })));
    assert.ok(next);
    assert.equal(next!.buys.length, 6, "only the trades no recap covered");
  });

  it("a recap that may be on X (uncertain, interrupted, fault) still covers its trades and holds the gap; a refused one does not", () => {
    const calls = burst();
    const recap = recapOf(planPosts(input({ nowMs: now, calls })))!;
    for (const reason of ["uncertain", "interrupted", "fault"]) {
      const row = recapRow(recap, { status: "failed", reason });
      assert.equal(maybeOut(row), true);
      assert.deepEqual(planPosts(input({ nowMs: now + 30 * MIN, calls, posts: [row] })), [], reason);
      const more = [...calls, ...[8.6, 8.7, 8.8, 8.9].map((h) => buy(h))];
      assert.ok(!planPosts(input({ nowMs: now + 2 * HOUR, calls: more, posts: [row] })).some((i) => i.kind === "recap"), `${reason}: the gap holds`);
    }
    // X refused it outright: its key is spent, as a refused buy post's is, and
    // its trades are still unsaid, so the next recap (new trades, new key) says them too, at once.
    const refused = recapRow(recap, { status: "failed", reason: "forbidden" });
    assert.equal(maybeOut(refused), false);
    const more = [...calls, ...[8.2, 8.3, 8.4].map((h) => buy(h))];
    const next = recapOf(planPosts(input({ nowMs: now + 2 * HOUR, calls: more, posts: [refused] })));
    assert.equal(next?.buys.length, 11, "the refused recap's trades and the new ones");
  });

  it("a trade that lands after the recap but was decided before its newest is still said (covered by key, never by time)", () => {
    const calls = burst();
    const recap = recapOf(planPosts(input({ nowMs: now, calls })))!;
    const late = buy(7.1); // decided before the recap's newest trade, seen only now
    const later = planPosts(input({ nowMs: now + 15 * MIN, calls: [...calls, late], posts: [recapRow(recap)] }));
    assert.deepEqual(later.filter((i) => i.kind === "buy").map((i) => i.dedupeKey), [buyKey(late.decisionId)]);
  });

  it("another owner's recap on a shared X account never hides this owner's trades", () => {
    const calls = burst();
    const recap = recapOf(planPosts(input({ nowMs: now, calls })))!;
    const theirs = recapRow(recap, { tenant: OTHER, dedupeKey: recapKey(OTHER, calls[7]!.atSec) });
    assert.ok(recapOf(planPosts(input({ nowMs: now, calls, posts: [theirs] }))), "this owner's burst is still recapped");
  });

  it("reads its recaps apart from the capped history: one pushed out of `posts` still covers", () => {
    const calls = burst();
    const recap = recapOf(planPosts(input({ nowMs: now, calls })))!;
    assert.deepEqual(planPosts(input({ nowMs: now + 30 * MIN, calls, posts: [], recaps: [recapRow(recap)] })), []);
  });

  it("is planned with no model left, when no single post or casual post can be", () => {
    const out = planPosts(input({ nowMs: now, calls: burst(), model: false }));
    assert.deepEqual(kinds(out), ["recap"]);
    assert.equal(recapOf(out)!.buys.length, 8);
  });

  it("no recap for a couple of trades, mid-burst, of the other money, with buy posts off, or idle", () => {
    assert.ok(!planPosts(input({ nowMs: now, calls: [buy(7), buy(7.1)] })).some((i) => i.kind === "recap"));
    assert.ok(!planPosts(input({ nowMs: now, calls: [7.8, 7.85, 7.9, 7.95].map((h) => buy(h)) })).some((i) => i.kind === "recap"), "the burst is still going");
    assert.ok(!planPosts(input({ nowMs: now, calls: burst().map((c) => ({ ...c, paper: true })) })).some((i) => i.kind === "recap"));
    assert.deepEqual(planPosts(input({ nowMs: now, calls: burst(), kinds: { buys: false } })).filter((i) => i.kind === "recap" || i.kind === "buy"), []);
    assert.ok(!planPosts(input({ nowMs: now, calls: burst(), money: null })).some((i) => i.kind === "recap"));
  });

  it("counts sales only from the receipt-backed results, and only with the owner's opt-in to sale posts", () => {
    const sells = [sale(6, "profit", 12.4), sale(6.5, "loss", null), sale(7, "profit", 3.1)];
    const recap = recapOf(planPosts(input({ nowMs: now, calls: burst(), tradeResults: true, sells })))!;
    assert.equal(recap.sells.length, 3);
    assert.ok(recap.covers.includes(sellKey(TENANT, sells[0]!.operationKey)));
    assert.equal(renderFiguresLine(recapFigures(recap))?.startsWith("recap: 8 buys, 3 sells (2 green, 1 red), best +12.4%; traded "), true);
    const noOptIn = recapOf(planPosts(input({ nowMs: now, calls: [...burst(), { ...buy(6), side: "sell" }], tradeResults: false, sells })))!;
    assert.equal(noOptIn.sells.length, 0, "no sale said without the opt-in, from results or from calls");
  });
});

describe("a recap's figures", () => {
  it("renders counts, outcomes, the best gain and the coins in the line's own grammar", () => {
    const spec = recapFigures({ buys: [buy(1, { symbol: "CAPITOL" }), buy(2, { symbol: "WISP" })], sells: [sale(3, "profit", 22.04)], results: [sale(3, "profit", 22.04)] });
    const line = renderFiguresLine(spec);
    assert.equal(line, "recap: 2 buys, 1 sell (1 green, 0 red), best +22%; traded WISP, CAPITOL.");
    assert.ok(admitFiguresLine(line));
    assert.equal(renderFiguresLine(recapFigures({ buys: [], sells: [sale(1, "loss")], results: [sale(1, "loss")] })), "recap: 1 sell (0 green, 1 red); traded WISP.");
    assert.equal(renderFiguresLine(recapFigures({ buys: [], sells: [], results: [] })), null);
  });

  it("says green and red only when every sale counted was measured", () => {
    const sells = [sale(1, "profit", 9), sale(2, "unknown"), sale(3, "flat")];
    assert.equal(renderFiguresLine(recapFigures({ buys: [buy(0.5)], sells, results: sells }))?.startsWith("recap: 1 buy, 3 sells; traded "), true);
  });

  it("admits only what the renderer writes: no gain beside buys alone or a red-only run, no 'traded' alone", () => {
    for (const bad of ["recap: 2 buys, best +12%.", "recap: 1 sell, best +12%.", "recap: 1 sell (0 green, 1 red), best +3%.", "recap: 0 buys.", "traded ETH.", "recap: 2 buys; traded WISP; traded INDEX."]) {
      assert.equal(admitFiguresLine(bad), false, bad);
    }
    assert.equal(withoutFiguresLine("i just traded ETH."), "i just traded ETH.", "an ordinary sentence is never read as a line");
  });

  it("drops the coins, then the best gain, before the post runs long, and keeps the counts", () => {
    const spec = recapFigures({ buys: [buy(1, { symbol: "CAPITOL" }), buy(2, { symbol: "WISP" }), buy(3, { symbol: "INDEX" })], sells: [sale(4, "profit", 9)], results: [sale(4, "profit", 9)] });
    const long = withFigures("x".repeat(200), spec);
    assert.ok(long.line === null || /^recap: 3 buys, 1 sell/.test(long.line));
    const short = withFigures("busy stretch on the desk. quick recap, for the record", spec);
    assert.equal(short.dropped, 0);
    assert.equal(withoutFiguresLine(short.text), "busy stretch on the desk. quick recap, for the record.");
  });
});

describe("a recap at send time", () => {
  const sells = [sale(1, "profit", 12.4), sale(2, "loss")];
  const intent = { buys: [buy(0.5), buy(0.7)], sells, results: sells };
  const covers = [...intent.buys.map((c) => buyKey(c.decisionId)), ...sells.map((s) => sellKey(TENANT, s.operationKey))];
  const body = withFigures("the tally, no spin", recapFigures(intent)).text;
  const row = { tenant: TENANT, body, coin: recapCoverText(covers) };

  it("holds while its receipts say what it says, the best gain dropped to fit included", () => {
    assert.equal(recapStillHolds(row, sells), true);
    const trimmed = { ...row, body: "the tally, no spin. recap: 2 buys, 2 sells (1 green, 1 red)." };
    assert.equal(recapStillHolds(trimmed, sells), true);
  });

  it("is withheld when a sale it counted is gone, an outcome changed, or it covers nothing", () => {
    assert.equal(recapStillHolds(row, [sells[0]!]), false, "a sale no longer receipt-backed");
    assert.equal(recapStillHolds(row, [{ ...sells[0]!, gainPct: 3 }, sells[1]!]), false, "the best gain changed");
    assert.equal(recapStillHolds(row, [sells[0]!, { ...sells[1]!, outcome: "profit", gainPct: 1 }]), false, "an outcome changed");
    assert.equal(recapStillHolds({ ...row, coin: null }, sells), false);
  });
});

describe("a recap's words", () => {
  it("sixty-four lines, this recap's own first, no word in two parts, so recaps never run out to the repeat limit", () => {
    const a = recapLines(recapKey(TENANT, 1)), b = recapLines(recapKey(TENANT, 2));
    assert.equal(a.length, 64);
    assert.equal(new Set(a).size, 64);
    assert.deepEqual([...a].sort(), [...b].sort());
    const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 2 && similarity(w, w) > 0));
    const seen = new Map<string, string>();
    for (const part of RECAP_SLOTS.flat()) for (const w of words(part)) {
      assert.ok(!seen.has(w), `"${w}" is in "${part}" and "${seen.get(w)}"`);
      seen.set(w, part);
    }
    // After any one went out, nearly all the rest are still no repeat of it.
    for (const said of a) assert.ok(a.filter((l) => l !== said && similarity(l, said) < REPEAT_LIMIT).length >= 56, said);
  });

  it("no digit, no result word, no time of day; a paper clause on paper", () => {
    for (const l of [...recapLines("x"), ...recapLines("x", { paper: true })]) {
      assert.doesNotMatch(l, /\p{N}|\$|@|#|https?:|green|\bred\b|profit|loss|gain|\bwin|morning|night|tonight|today|on.?chain/iu, l);
    }
    assert.ok(recapLines("x", { paper: true }).every((l) => /paper|practice/.test(l)));
  });
});
