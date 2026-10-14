/**
 * A WIN IS SAID EVEN WHEN THE MODEL PASSES (the owner's ask, 2026-10-14:
 * "where are the trade pnls" — every profitable sale gets its own post with
 * the P&L card). A sale post's words are the model's one neutral sentence and
 * its result line is code's (sale-outcome.ts); when the model passes, is
 * refused by the gate, is down, its allowance is spent, or its sentence
 * leaves no room for the result line and the token link, an active owner's
 * win takes one of these lines instead, through the same gate, and code's
 * result line, card and token link follow as ever.
 *
 * WHAT THE SALE PATH ASKS (writer.ts sellPrompt, gate.ts kind "sell"): the
 * coin named, "sold" said, no result, emotion or timing word (the measured
 * outcome is code's line), nothing that says the whole position went or that
 * the agent left the coin (a partial sale is possible), and nothing a receipt
 * does not show: no speed, no smoothness, no human life (review of the wins
 * branch, 2026-10-14). The words only say the sale is on the record and the
 * desk goes on.
 *
 * SHORT ENOUGH FOR AN ACTIVE OWNER'S POST: the result line and the tx link
 * and contract after it leave about sixty-five characters, so every part is
 * at most twenty-four (orchestrator-xpost-sale-words.test.ts).
 *
 * A HUNDRED AND FORTY-FOUR LINES, NONE A TICKER-SWAPPED TEMPLATE. The gate
 * refuses a post that shares six tenths of its content words with a recent
 * one, which is what a template with only the coin changed does. Every line is
 * "sold COIN." (or "i sold COIN."), then one part about the record and one
 * about the desk, twelve of each: two lines share at most one part, every part
 * has exactly three words the gate counts and shares none with another, so two
 * wins of different coins that share a part are under six tenths alike, and a
 * line identical to a recent win but for its coin is refused and the next one
 * tried.
 *
 * Pure: no I/O, no model, no clock.
 */
import { hash32 } from "./planner";

/** What the sale put on the record, and how the desk goes on: twelve each. */
export const SALE_PARTS: readonly [readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["receipt saved to log", "ledger row written", "history file updated", "swap marked settled", "journal note added", "books show the trade",
    "tally sheet amended", "record line made", "archive copy stored", "timeline marker placed", "report page appended", "statement item posted"]),
  Object.freeze(["desk keeps going", "terminal stays open", "radar sweeping onward", "scanner hums along", "screens remain lit", "search carries forward",
    "routine runs unchanged", "list refresh pending", "engine ticking quietly", "feed refreshes again", "monitors stay active", "charts redraw themselves"]),
]) as unknown as readonly [readonly string[], readonly string[]];

/** Every sale line for this coin, this post's own first (by its key). The caller tries each, whole, until one fits. */
export function saleLines(coin: string, seed: string): string[] {
  const name = String(coin ?? "").trim();
  const [record, desk] = SALE_PARTS;
  const n = record.length, cells = n * desk.length;
  if (!name || cells === 0) return [];
  // A stride sharing no factor with the cell count visits every line once.
  const stride = 79, start = hash32(`sale-words|${seed}`) % cells;
  const out: string[] = [];
  for (let t = 0; t < cells; t++) {
    const k = (start + t * stride) % cells;
    const r = k % n, d = Math.floor(k / n);
    out.push(`${(r + d) % 2 ? "i sold" : "sold"} ${name}. ${record[r]}, ${desk[d]}.`);
  }
  return out;
}
