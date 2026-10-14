/**
 * A WIN'S OWN WORDS WHEN THE MODEL'S ARE NOT THERE (the owner's ask,
 * 2026-10-14). Every line clears the real gate as a sale, names the coin, says
 * sold and nothing more; no two wins of different coins read as one template.
 * Here beside the orchestrator because the real gate takes the room's line
 * screen (groupchat/policy.ts), which only the orchestrator may import.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { SALE_SLOTS, saleLines } from "./xpost/sale-words";

const counted = (t: string) => t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && similarity(w, w) > 0);
const admit = (line: string, coin: string, recentOwn: string[] = []) =>
  admitXPost(line, { kind: "sell", agentName: "Alan Al Dale", mode: "live", coins: [coin], recentOwn, recentFleet: [], house: true }, (r, c) => admitAgentLine(r, c));

describe("a win's own words", () => {
  it("a hundred and forty-four lines, this post's own first, the same set for every key", () => {
    const a = saleLines("WISP", "sell:a"), b = saleLines("WISP", "sell:b");
    assert.equal(a.length, 144);
    assert.equal(new Set(a).size, 144);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.notEqual(a[0], b[0]);
    assert.deepEqual(saleLines("", "sell:a"), []);
  });

  it("an opening that says sold and the coin and nothing else counted; every other part three counted words, none shared", () => {
    for (const part of SALE_SLOTS[0]) {
      assert.ok(part.includes("{c}"), part);
      assert.deepEqual(counted(part.replace("{c}", "")), ["sold"], part);
    }
    const seen = new Map<string, string>();
    for (const part of [...SALE_SLOTS[1], ...SALE_SLOTS[2]]) {
      const words = counted(part);
      assert.equal(words.length, 3, part);
      for (const w of words) {
        assert.ok(!seen.has(w), `"${w}" is in "${part}" and "${seen.get(w)}"`);
        seen.set(w, part);
      }
    }
  });

  it("every line clears the real gate as a sale, but the ones a long name runs past ninety characters", () => {
    for (const coin of ["CAPITOL", "WISP", "IGNITION", "ALTAI", "INDEX", "Pudgy Penguin", "MOON", "T57F813C4571"]) {
      for (const line of saleLines(coin, `sell:${coin}`)) {
        const v = admit(line, coin);
        if (line.length > 90) assert.equal(v.ok ? "ok" : v.reason, "sale-length", line);
        else assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
      }
    }
  });

  it("says no result, timing or whole-position word: the measured outcome is code's line after it", () => {
    for (const line of saleLines("WISP", "x")) {
      assert.match(line, /\bsold\b/);
      assert.match(line, /\bWISP\b/);
      assert.doesNotMatch(line, /\p{N}|%|\$|@|#|https?:|\b(?:profit|gain|loss|green|red|win|won|up|down|all|closed|exited|out|early|late|pleased|nice)\b/iu, line);
    }
  });

  it("two wins of different coins are never one template: sharing a part is half alike, a coin-swapped copy is refused and the next line taken", () => {
    const capitol = saleLines("CAPITOL", "s"), wisp = saleLines("WISP", "s");
    const parts = (line: string) => SALE_SLOTS.slice(1).map((slot) => slot.findIndex((p) => line.includes(p)));
    for (const p of capitol) for (const q of wisp) {
      const shared = parts(p).filter((x, i) => x === parts(q)[i]).length;
      if (shared < 2) assert.ok(similarity(p, q) < REPEAT_LIMIT, `${p} | ${q} → ${similarity(p, q)}`);
    }
    // Yesterday's win, said in the line this one would open with: refused, and a later line admitted.
    const said = capitol[0]!.replace("CAPITOL", "WISP");
    const first = saleLines("WISP", "s").find((l) => admit(l, "WISP", [said]).ok);
    assert.ok(first && first !== said);
    assert.equal(admit(said, "WISP", [said]).ok, false);
  });
});
