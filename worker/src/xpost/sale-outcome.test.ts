import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendSaleOutcome, hasSaleOutcome } from "./sale-outcome";
import { admitXPost, type XGateCtx } from "./gate";
import { sellPrompt, type WriterFacts } from "./writer";

const facts: WriterFacts = { agentName: "Alan", strategy: null, flavour: null, traits: [], mode: "live", style: { lower: true, emoji: 0, exclaim: 0 }, recentOwn: [] };
const gate: XGateCtx = { kind: "sell", agentName: "Alan", mode: "live", coins: ["Pepe"], recentOwn: [], recentFleet: [], emojiOk: false };
const base = (text: string) => ({ ok: true as const, text });

describe("sale prose and deterministic gross outcome", () => {
  it("allows a factual partial sale, with performance commentary coming only from evidence", () => {
    const text = "sold pepe. keeping the notes for my next decision.";
    assert.equal(admitXPost(text, gate, base).ok, true);
    assert.equal(admitXPost(text, { ...gate, kind: "buy" }, base).ok, false);
    for (const outcome of ["profit", "loss", "flat"] as const) {
      const body = appendSaleOutcome(text, outcome)!;
      assert.match(body, /before fees and gas/);
      assert.equal(hasSaleOutcome(body, outcome), true);
      assert.equal(hasSaleOutcome(`${body}\nca: 0x${"a".repeat(40)}`, outcome), true);
      assert.equal(hasSaleOutcome(body, "unknown"), false);
    }
    assert.equal(appendSaleOutcome(text, "unknown"), text);
    assert.equal(hasSaleOutcome(text, "unknown"), true);
    assert.equal(hasSaleOutcome(appendSaleOutcome(text, "profit")!, "loss"), false);
  });

  it("refuses invented results, complete exits, explanations and post-exit hindsight", () => {
    for (const text of [
      "sold pepe for a profit", "sold pepe. nice gains", "sold pepe. painful loss",
      "sold pepe. i won", "sold pepe. i am happy", "sold pepe. that worked",
      "sold pepe too early", "sold pepe and jeeted", "sold pepe before it kept pumping",
      "sold pepe. fully closed", "sold pepe because the thesis changed", "sold pepe and got out",
    ]) assert.equal(admitXPost(text, gate, base).ok, false, text);
    assert.equal(admitXPost("made my decision about pepe", gate, base).ok, false);
    assert.equal(admitXPost("sold the coin. keeping my notes.", gate, base).ok, false);
    assert.equal(admitXPost("sold pepe on paper. keeping my notes.", gate, base).ok, false);
    assert.equal(appendSaleOutcome("x".repeat(280), "profit"), null);
  });

  it("never hands outcome or money to the model and reserves room for verified suffixes", () => {
    const a = sellPrompt({ ...facts, coin: "Pepe", paper: false, outcome: "profit" });
    const b = sellPrompt({ ...facts, coin: "Pepe", paper: false, outcome: "loss" });
    assert.deepEqual(a, b);
    assert.match(a.prompt, /under ninety characters/);
    assert.match(a.prompt, /partial sale/);
    assert.match(a.system, /Trusted code adds any measured result separately/);
  });
});
