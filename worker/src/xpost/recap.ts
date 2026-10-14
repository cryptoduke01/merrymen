/**
 * ONE POST FOR A BURST OF TRADES (the owner's ask, 2026-10-14: "post one recap
 * for a burst, like 'closed 6 trades this morning'").
 *
 * Alan made twenty trades in four hours on 2026-10-13 and four were posted:
 * the night held the plan, the two-hour freshness dropped the oldest, and
 * the seventy-five-minute gap queued the rest until they went stale. The
 * planner now leaves a trade it cannot post soon for a recap (planner.ts
 * planRecap), and this file says it.
 *
 * CODE'S WORDS AND CODE'S FIGURES, NO MODEL. A recap is a count of its own
 * receipt-backed trades: the words only say it is one ("busy stretch on the
 * desk, here's the rundown"), naming no coin, no result and no time of day,
 * and the figures line after the gate says the rest (xpost/figures.ts
 * "recap:" and "traded"). Nothing for a model to embellish, and nothing a
 * model outage can silence: a recap goes out whenever the gate admits one of
 * the lines, which xpost/recap.test.ts pins live and paper.
 *
 * Pure: no I/O, no model, no clock.
 */
import { CASUAL_PAPER } from "./casual";
import { cleanTicker, TRADED_MAX, type FiguresSpec } from "./figures";
import type { PlanCall, PlanIntent, PlanSell } from "./planner";

/**
 * EIGHT WAYS TO SAY "A RECAP FOLLOWS", none of them sharing much with another,
 * so two recaps in a day are never each other's repeat to the gate. No coin,
 * no result word (green, profit, loss), no time of day, no pointing word the
 * gate reads as a call.
 */
export const RECAP_LINES: readonly string[] = Object.freeze([
  "busy stretch on the desk, here's the rundown",
  "lot of trading in the last few hours, quick recap",
  "been an active session, the tape from it",
  "quick recap of the latest run of trades",
  "recap time, how the session shaped up",
  "a flurry of trades lately, the summary",
  "the desk kept moving, recap of the run",
  "wrapping up a busy session, the numbers",
]);

/** The hash a recap's lines start from: its key. */
function seedOf(seed: string): number {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * EVERY RECAP LINE, this recap's own first (by its key), each with a paper
 * clause when the agent trades on paper (the gate's rule for a paper reply
 * is no rule for a recap, but a paper recap that never said paper would read
 * as real money all the same).
 */
export function recapLines(seed: string, o: { paper?: boolean } = {}): string[] {
  const h = seedOf(seed);
  return RECAP_LINES.map((_, i) => {
    const k = (h + i) % RECAP_LINES.length;
    return `${RECAP_LINES[k]!}${o.paper === true ? `. ${CASUAL_PAPER[k % CASUAL_PAPER.length]!}` : ""}.`;
  });
}

/** A trade's ticker as the figures line may show it: its symbol, else its name, when either is one. */
function tickerOf(c: Pick<PlanCall, "symbol" | "name">): string | null {
  return cleanTicker(c.symbol) ?? cleanTicker(c.name);
}

/**
 * A RECAP'S FIGURES: how many buys and sales; of the sales whose outcome a
 * receipt measured, how many closed in profit and at a loss, and the best
 * measured gain among the profits; and the coins, newest first. Every number
 * is a count of its own trades or a gain the sale's receipts measured.
 */
export function recapFigures(r: Pick<Extract<PlanIntent, { kind: "recap" }>, "buys" | "sells" | "results">): FiguresSpec {
  const measured: PlanSell[] = Array.isArray(r.results) ? r.results.filter((s) => s.outcome === "profit" || s.outcome === "loss") : [];
  const gains = measured.filter((s) => s.outcome === "profit" && typeof s.gainPct === "number" && Number.isFinite(s.gainPct)).map((s) => s.gainPct as number);
  const coins = [...(r.buys ?? []), ...(r.sells ?? [])].sort((a, b) => b.atSec - a.atSec).map(tickerOf).filter((t): t is string => t !== null);
  return [
    { kind: "recap", buys: (r.buys ?? []).length, sells: (r.sells ?? []).length,
      ...(measured.length ? { wins: measured.filter((s) => s.outcome === "profit").length, losses: measured.filter((s) => s.outcome === "loss").length } : {}),
      ...(gains.length ? { bestPct: Math.max(...gains) } : {}) },
    { kind: "traded", symbols: [...new Set(coins)].slice(0, TRADED_MAX) },
  ];
}
