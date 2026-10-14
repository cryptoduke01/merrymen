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
 * branch, 2026-10-14). The words only say the sale is on the record, the desk
 * goes on, and nothing more.
 *
 * SHORT ENOUGH FOR AN ACTIVE OWNER'S POST: the result line and the tx link
 * and contract after it leave about sixty-five characters, so every part is
 * at most fifteen (orchestrator-xpost-sale-words.test.ts).
 *
 * A HUNDRED AND FORTY-FOUR LINES, NONE A TEMPLATE TO THE REPEAT CHECK. The
 * gate refuses a post that shares six tenths of its content words with a
 * recent one. Every line is "sold COIN." (or "i sold COIN.") and then three
 * parts, one from each slot of twelve, joined by a Latin square (casual.ts
 * latinLines's arrangement), so any two lines share at most one part; every
 * part has exactly two words the gate counts and shares none with another.
 * Two wins sharing a part are half alike at most, the same coin's too while
 * its name is one or two words (second review of the wins branch: with two
 * parts of three words, the twelfth win of one coin in memory had no line
 * left); a longer name's lines meet the limit sooner, and its other vetted
 * names are tried. A line identical to a recent one is refused and the next
 * tried.
 *
 * Pure: no I/O, no model, no clock.
 */
import { hash32 } from "./planner";

/** What the sale put on the record, how the desk goes on, and what else was noted: twelve each, none a claim a receipt does not show. */
export const SALE_PARTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["receipt saved", "ledger updated", "history noted", "swap settled", "journal note", "books show it", "tally amended", "record made",
    "archive copy", "log marked", "report filed", "sheet posted"]),
  Object.freeze(["desk running", "terminal open", "radar sweeping", "scanner busy", "screens lit", "search goes", "routine intact", "list refreshed",
    "engine ticking", "feed updating", "monitors awake", "charts redraw"]),
  // Third review of the wins branch: "rules followed", "calm operations", "tidy habits", "basic hygiene", "steady state",
  // "standard fare" and "nothing further" claimed a quality or an end no receipt shows; these only note the record.
  Object.freeze(["time stamped", "hash stored", "process repeats", "cycle resumes", "slot cleared", "counter ticked", "block included",
    "date logged", "reference added", "pair tagged", "queue advanced", "status recorded"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/**
 * Every sale line for this coin, this post's own first (by its key): the
 * hundred and forty-four of three parts, or (`parts` 2) the same pairs of a
 * record and a desk part alone, shorter, for a name too long for three beside
 * an active owner's tx link and contract (third review of the wins branch: a
 * name of twenty characters or more had no line that fit). The caller tries
 * each, whole, until one fits: every name's three-part lines first.
 */
export function saleLines(coin: string, seed: string, parts: 2 | 3 = 3): string[] {
  const name = String(coin ?? "").replace(/\s+/g, " ").trim();
  const [record, desk, close] = SALE_PARTS;
  const n = record.length, cells = n * n;
  if (!name || n === 0 || desk.length !== n || close.length !== n) return [];
  // A stride sharing no factor with the cell count visits every line once.
  const stride = 79, start = hash32(`sale-words|${seed}`) % cells;
  const out: string[] = [];
  for (let t = 0; t < cells; t++) {
    const k = (start + t * stride) % cells;
    const a = k % n, b = Math.floor(k / n), c = (a + b) % n;
    const opener = `${a % 2 ? "i sold" : "sold"} ${name}.`;
    out.push(parts === 2 ? `${opener} ${record[a]}, ${desk[b]}.` : `${opener} ${record[a]}, ${desk[b]}, ${close[c]}.`);
  }
  return out;
}
