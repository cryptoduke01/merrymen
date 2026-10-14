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
import { CASUAL_PAPER, latinLines } from "./casual";
import { cleanTicker, renderFiguresLine, TRADED_MAX, type FiguresSection, type FiguresSpec } from "./figures";
import { recapCoverOf, sellKey, type PlanCall, type PlanIntent, type PlanSell } from "./planner";

/**
 * SIXTY-FOUR WAYS TO SAY "A RECAP FOLLOWS" (review of the recap branch,
 * 2026-10-14: with eight fixed lines, the ninth recap found every line a
 * repeat of one of the last eight to the gate, and recaps stopped). Three
 * slots of eight, joined by a Latin square (casual.ts latinLines), so any two
 * lines share at most one part, and no word is in two parts. No coin, no
 * result word (green, profit, loss), no time of day, no pointing word the
 * gate reads as a call, no source word (on-chain) that marks a post as
 * research.
 */
export const RECAP_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["busy stretch on the desk", "lots of trading lately", "been an active session", "the book kept moving",
    "a flurry of trades", "plenty happening on my side", "quite the run of activity", "the pace picked up"]),
  Object.freeze(["quick recap", "the rundown", "the summary", "here's the tape", "the tally", "the scorecard", "a look back", "the short version"]),
  Object.freeze(["for the record", "nothing more to it", "that's the lot", "straight from the fills", "logged and done", "as it landed", "no spin", "numbers attached"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/**
 * EVERY RECAP LINE, this recap's own first (by its key), each with a paper
 * clause when the agent trades on paper (a paper recap that never said paper
 * would read as real money), picked by its first part.
 */
export function recapLines(seed: string, o: { paper?: boolean } = {}): string[] {
  const paperOf = new Map(RECAP_SLOTS[0].map((part, i) => [part, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines(RECAP_SLOTS, seed, (a, b, c) => `${a}. ${b}, ${c}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}.`);
}

/** A trade's ticker as the figures line may show it: its symbol, else its name, when either is one. */
function tickerOf(c: Pick<PlanCall, "symbol" | "name">): string | null {
  return cleanTicker(c.symbol) ?? cleanTicker(c.name);
}

/** A recap's counts, as the figures line's recap section: buys, sales, and their measured outcomes. */
function recapSection(buys: number, sells: number, results: readonly PlanSell[]): Extract<FiguresSection, { kind: "recap" }> {
  const measured = results.filter((s) => s.outcome === "profit" || s.outcome === "loss");
  const gains = measured.filter((s) => s.outcome === "profit" && typeof s.gainPct === "number" && Number.isFinite(s.gainPct)).map((s) => s.gainPct as number);
  return { kind: "recap", buys, sells,
    ...(measured.length ? { wins: measured.filter((s) => s.outcome === "profit").length, losses: measured.filter((s) => s.outcome === "loss").length } : {}),
    ...(gains.length ? { bestPct: Math.max(...gains) } : {}) };
}

/**
 * A RECAP'S FIGURES: how many buys and sales; of the sales whose outcome a
 * receipt measured, how many closed in profit and at a loss, and the best
 * measured gain among the profits; and the coins, newest first. Every number
 * is a count of its own trades or a gain the sale's receipts measured.
 */
export function recapFigures(r: Pick<Extract<PlanIntent, { kind: "recap" }>, "buys" | "sells" | "results">): FiguresSpec {
  const coins = [...(r.buys ?? []), ...(r.sells ?? [])].sort((a, b) => b.atSec - a.atSec).map(tickerOf).filter((t): t is string => t !== null);
  return [recapSection((r.buys ?? []).length, (r.sells ?? []).length, Array.isArray(r.results) ? r.results : []),
    { kind: "traded", symbols: [...new Set(coins)].slice(0, TRADED_MAX) }];
}

/**
 * DOES A RECAP STILL SAY WHAT ITS RECEIPTS SAY, AT SEND TIME? (review of the
 * recap branch, 2026-10-14: a sale post's evidence is replayed before it
 * goes out, and a recap's was not.) Its covered keys (its row's `coin`) are
 * read again: every sale it counted must still be one of the receipt-backed
 * sales (`sales`, read fresh), and the counts, outcomes and best gain those
 * give now must be the ones on the post, whole or with the best gain the
 * line may have dropped to fit. Any doubt: false, and the recap is withheld.
 */
export function recapStillHolds(post: { tenant: string; body: string; coin: string | null }, sales: readonly PlanSell[]): boolean {
  const keys = recapCoverOf(post.coin);
  if (!keys.length || typeof post.body !== "string") return false;
  const buys = keys.filter((k) => k.startsWith("buy:")).length;
  const sellKeys = new Set(keys.filter((k) => k.startsWith("sell:")));
  const matched = sales.filter((s) => sellKeys.has(sellKey(post.tenant, s.operationKey)));
  if (matched.length !== sellKeys.size) return false;
  const full = recapSection(buys, matched.length, matched);
  const variants = [full, { ...full, bestPct: null }].map((s) => renderFiguresLine([s])).filter((l): l is string => l !== null).map((l) => l.slice(0, -1));
  return variants.some((v) => post.body.includes(` ${v};`) || post.body.endsWith(` ${v}.`));
}
