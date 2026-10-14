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
 * receipt-backed trades: the words only say it is one ("an update on the
 * trading desk, the full rundown follows"), naming no coin, no result, no
 * size and no time of day,
 * and the figures line after the gate says the rest (xpost/figures.ts
 * "recap:" and "traded"). Nothing for a model to embellish, and nothing a
 * model outage can silence: a recap goes out whenever the gate admits one of
 * the lines, which xpost/recap.test.ts pins live and paper.
 *
 * Pure: no I/O, no model, no clock.
 */
import { latinLines } from "./casual";
import { cleanTicker, renderFiguresLine, TRADED_MAX, type FiguresSection, type FiguresSpec } from "./figures";
import { recapCoverOf, sellKey, type PlanCall, type PlanIntent, type PlanSell } from "./planner";

/**
 * A HUNDRED WAYS TO SAY "A RECAP FOLLOWS" (two reviews of the recap branch,
 * 2026-10-14: with eight fixed lines the ninth recap was a repeat of one of
 * the last eight to the gate and recaps stopped; with sixty-four of uneven
 * length, a paper agent or a busy fleet still ran out, since the gate weighs
 * shared words against the shorter post and a short part shared was half a
 * line). Three slots of ten, joined by a Latin square (casual.ts latinLines),
 * so any two lines share at most one part; every part three or four content
 * words, no word in two parts, so a shared part is never near the repeat
 * limit (the worst pair is under half, paper clause included: recap.test.ts).
 * No coin, no result word (green, profit, loss), no time of day, no pointing
 * word the gate reads as a call, no source word (on-chain) that marks a post
 * as research. No side of the trade (third review, 2026-10-14: "a flurry of
 * buys and sells" opened a tenth of the recaps that counted buys alone, sales
 * the owner may not have opted to post), and nothing only real money has
 * (receipts, settlement, fills), since a paper agent's recap says these too.
 * No size either way (fourth review, 2026-10-14): a recap may say one trade a
 * single post could not, and "heavy action across the book" above "recap: 1
 * buy" was untrue; the figures line says how many.
 */
export const RECAP_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["an update on the trading desk", "checking in on the order book", "where the strategy currently stands", "a catch up on the engine's work",
    "keeping everyone posted", "for the sake of transparency", "the session under review", "a status report on the portfolio",
    "a peek behind the curtain", "a glimpse into the machine"]),
  Object.freeze(["here is the quick recap", "the full rundown follows", "a tidy summary of it all", "the tape in short form", "the running tally laid out",
    "the whole scorecard at a glance", "a brief look back over it", "the condensed version of events", "the highlights reel in numbers", "the wrap sheet put together"]),
  Object.freeze(["straight from the logbook itself", "logged exactly as landed", "no spin attached whatsoever", "noted plainly for the record", "nothing more to add on it",
    "accounted for without shortcuts", "minus any fluff or filler", "that about covers everything worth saying", "precisely what the ledger shows", "served up fresh and unedited"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/**
 * ONE PAPER CLAUSE, A SINGLE WORD OF ITS OWN (second review, 2026-10-14): the
 * casual posts' paper sentences share "paper", "trades", "desk" and "book"
 * among themselves and with these parts, and each paper recap that went out
 * blocked six to eight others. "on paper" adds one word to every paper line.
 */
const RECAP_PAPER = "on paper";

/** Every recap line, this recap's own first (by its key), a paper agent's with its paper clause. */
export function recapLines(seed: string, o: { paper?: boolean } = {}): string[] {
  return latinLines(RECAP_SLOTS, seed, (a, b, c) => `${a}. ${b}, ${c}${o.paper === true ? `, ${RECAP_PAPER}` : ""}.`);
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
