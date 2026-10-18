/**
 * A WIN'S OWN WORDS WHEN THE MODEL'S ARE NOT THERE (the owner's ask,
 * 2026-10-14). Every line clears the real gate as a sale, names the coin, says
 * sold and nothing a receipt does not show; it fits whole in an active owner's
 * post beside the result line, tx link and contract; no two wins of different
 * coins read as one template. Here beside the orchestrator because the real
 * gate takes the room's line screen (groupchat/policy.ts), which only the
 * orchestrator may import.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { appendPublicToken } from "./xpost/public-wallet";
import { appendSaleOutcome } from "./xpost/sale-outcome";
import { SALE_PARTS, saleLines } from "./xpost/sale-words";

const counted = (t: string) => t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && similarity(w, w) > 0);
const admit = (line: string, coin: string, recentOwn: string[] = []) =>
  admitXPost(line, { kind: "sell", agentName: "Alan Al Dale", mode: "live", coins: [coin], recentOwn, recentFleet: [], house: true }, (r, c) => admitAgentLine(r, c));
/** An active owner's landed sale: the tx link and the contract after code's result line. */
const TOKEN = { address: `0x${"ab".repeat(20)}`, chainId: 4663, txHash: `0x${"cd".repeat(32)}` };
const whole = (line: string, gainPct: number) => {
  const said = appendSaleOutcome(line, "profit", gainPct);
  return said ? appendPublicToken(said, TOKEN, true) : null;
};

describe("a win's own words", () => {
  it("a hundred and forty-four lines of three parts, this post's own first, and the same pairs with two; the same set for every key", () => {
    const a = saleLines("WISP", "sell:a"), b = saleLines("WISP", "sell:b");
    assert.equal(a.length, 144);
    assert.equal(new Set(a).size, 144);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.notEqual(a[0], b[0]);
    const parts = (l: string) => l.split(". ")[1]!.split(", ").length;
    const two = saleLines("WISP", "sell:a", 2);
    assert.ok(a.every((l) => parts(l) === 3) && two.length === 144 && new Set(two).size === 144 && two.every((l) => parts(l) === 2));
    assert.deepEqual(saleLines("", "sell:a"), []);
  });

  it("opens with 'sold COIN' or 'i sold COIN' alone; every part two counted words, none shared, short", () => {
    for (const line of saleLines("WISP", "x")) assert.match(line, /^(?:i )?sold WISP\. /);
    assert.equal(saleLines("Pudgy  Penguin", "x")[0]!.includes("Pudgy Penguin."), true, "a name's spaces tidied");
    const seen = new Map<string, string>();
    for (const part of SALE_PARTS.flat()) {
      const words = counted(part);
      assert.equal(words.length, 2, part);
      assert.ok(part.length <= 15, `${part}: ${part.length}`);
      for (const w of words) {
        assert.ok(!seen.has(w), `"${w}" is in "${part}" and "${seen.get(w)}"`);
        seen.set(w, part);
      }
    }
  });

  it("every line clears the real gate as a sale", () => {
    for (const coin of ["CAPITOL", "WISP", "IGNITION", "ALTAI", "INDEX", "Pudgy Penguin", "MOON", "T57F813C4571"]) {
      for (const line of saleLines(coin, `sell:${coin}`)) {
        const v = admit(line, coin);
        assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
      }
    }
  });

  it("the real gate refuses a sale's timing, amount or holding, which no line says (trade-wording review, 2026-10-18)", () => {
    for (const text of [
      "just sold some casino from the stack", "sold some casino, still holding the rest", "sold casino, rest of the bag stays put",
      "sold half of my casino here", "sold casino at the top of the range", "sold casino into strength, still in some",
    ]) assert.equal(admit(text, "Casino").ok, false, text);
  });

  it("fits whole in an active owner's post, result line, tx link and contract included (review of the wins branch)", () => {
    for (const coin of ["PEPE", "CAPITOL", "IGNITION", "ALTAI", "MOON"]) {
      for (const gain of [0.1, 12.4, 99]) assert.ok(saleLines(coin, "s").every((l) => whole(l, gain) !== null), `${coin} at +${gain}%: every line fits`);
    }
    // A name of twenty-four characters, the longest a name may be, still fits at a five-figure gain, by its two-part lines (third review).
    assert.ok(!saleLines("Wrapped Robinhood Ethers", "s").some((l) => whole(l, 12345) !== null), "three parts do not fit");
    assert.ok(saleLines("Wrapped Robinhood Ethers", "s", 2).some((l) => admit(l, "Wrapped Robinhood Ethers").ok && whole(l, 12345) !== null));
    // A four-figure gain or a long name leaves fewer, at least a quarter: the writer tries the next, then the coin's other names.
    for (const coin of ["IGNITION", "Pudgy Penguin", "T57F813C4571"]) {
      const fit = saleLines(coin, "s").filter((l) => whole(l, 1234) !== null).length;
      assert.ok(fit >= 36, `${coin} at +1,234%: ${fit} fit`);
    }
  });

  it("says nothing a receipt does not show: no result, timing, speed or quality word, no whole position, no leaving the coin, no human life", () => {
    for (const line of saleLines("WISP", "x")) {
      assert.match(line, /\bsold\b/);
      assert.match(line, /\bWISP\b/);
      assert.doesNotMatch(line, /\p{N}|%|\$|@|#|https?:|\b(?:profit|gain|loss|green|red|win|won|up|down|all|closed|exited|out|early|late|pleased|nice)\b/iu, line);
      assert.doesNotMatch(line, /\b(?:just|now|then|today|fast|quick\w*|prompt\w*|smooth\w*|fine|safe\w*|neat\w*|proper\w*|clean\w*|moving on|next|elsewhere|fresh|is sold|coffee|eyes|me|calm\w*|tidy|hygiene|rules?|steady|standard|further|nothing)\b/i, line);
    }
  });

  it("thirty wins of one coin in memory still leave a line: two lines share at most one part, half alike even for the same coin (second review)", () => {
    const said: string[] = [];
    for (let i = 0; i < 30; i++) {
      const line = saleLines("PEPE", `sell:${i}`).find((l) => admit(l, "PEPE", said).ok);
      assert.ok(line, `win ${i + 1}`);
      said.push(line!);
    }
  });

  it("two wins of different coins are never one template: sharing a part is under the repeat limit, a coin-swapped copy is refused and the next line taken", () => {
    const parts = (line: string) => SALE_PARTS.map((slot) => slot.findIndex((p) => line.includes(p)));
    for (const [x, y] of [["CAPITOL", "WISP"], ["T57F813C4571", "T99A"]] as const) {
      const a = saleLines(x, "s"), b = saleLines(y, "s");
      for (const p of a) for (const q of b) {
        const shared = parts(p).filter((v, i) => v === parts(q)[i]).length;
        if (shared < 2) assert.ok(similarity(p, q) < REPEAT_LIMIT, `${p} | ${q} → ${similarity(p, q)}`);
      }
    }
    const said = saleLines("CAPITOL", "s")[0]!.replace("CAPITOL", "WISP");
    assert.equal(admit(said, "WISP", [said]).ok, false);
    const first = saleLines("WISP", "s").find((l) => admit(l, "WISP", [said]).ok);
    assert.ok(first && first !== said);
  });
});
