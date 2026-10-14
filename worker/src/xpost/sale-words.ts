/**
 * A WIN IS SAID EVEN WHEN THE MODEL PASSES (the owner's ask, 2026-10-14:
 * "where are the trade pnls" — every profitable sale gets its own post with
 * the P&L card). A sale post's words are the model's one neutral sentence and
 * its result line is code's (sale-outcome.ts); when the model passes, is
 * refused by the gate, is down or its allowance is spent, an active owner's
 * win takes one of these lines instead, through the same gate, and code's
 * result line, card and token link follow as ever.
 *
 * WHAT THE SALE PATH ASKS (writer.ts sellPrompt, gate.ts kind "sell"): the
 * coin named, "sold" said, under ninety characters, no result, emotion or
 * timing word (the measured outcome is code's), and nothing that says the
 * whole position went (a partial sale is possible: never closed, exited or
 * out).
 *
 * A HUNDRED AND FORTY-FOUR LINES, NONE A TICKER-SWAPPED TEMPLATE. The gate
 * refuses a post that shares six tenths of its content words with a recent
 * one, which is what a template with only the coin changed does. Three slots
 * of twelve joined by a Latin square (casual.ts latinLines), so any two lines
 * share at most one part: the opening says "sold" and the coin and no other
 * word the gate counts, and every other part has exactly three counted words
 * and shares none with another part. Two wins of different coins that share
 * a part are half alike, under the limit; a line identical to a recent win
 * but for its coin is refused and the next one tried (sale-words.test.ts).
 *
 * Pure: no I/O, no model, no clock.
 */
import { latinLines } from "./casual";

export const SALE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["sold {c}", "just sold {c}", "{c} sold", "sold {c} now", "i sold {c}", "sold {c} just now", "ok, sold {c}", "so i sold {c}",
    "and {c} is sold", "{c}: sold", "{c} is sold", "sold {c} just then"]),
  Object.freeze(["the swap settled fine", "the order cleared smoothly", "the record got updated", "the confirmation arrived quickly",
    "the tally is squared away", "the fill came through", "receipt filed safely", "logged it in the book neatly", "noted in the ledger promptly",
    "jotted in the journal properly", "the block confirmed it fast", "the history shows it plainly"]),
  Object.freeze(["watching charts with coffee", "eyes on the screens again", "moving on to the next idea", "scanning the candidate list",
    "the desk keeps going", "the terminal stays open", "hunting for fresh names", "onward, patiently and calmly", "the search carries forward",
    "attention shifts elsewhere", "looking around quietly", "back to scouting carefully"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Every sale line for this coin, this post's own first (by its key). The caller tries each through the gate. */
export function saleLines(coin: string, seed: string): string[] {
  const name = String(coin ?? "").trim();
  if (!name) return [];
  return latinLines(SALE_SLOTS, seed, (a, b, c) => `${a.replace("{c}", name)}. ${b}, ${c}.`);
}
