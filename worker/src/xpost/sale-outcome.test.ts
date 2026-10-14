import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendSaleOutcome, gainFigure, hasSaleOutcome } from "./sale-outcome";
import { admitXPost, XPOST_MIN_WORDS, type XGateCtx } from "./gate";
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
    // Asked for more words than the gate's floor: "sold some PEPE." was refused as too short, every sale of 2026-10-14.
    assert.match(a.prompt, /five to fourteen words/);
    assert.ok(5 > XPOST_MIN_WORDS);
    assert.equal(admitXPost("sold some PEPE.", { ...gate, coins: ["PEPE"] }, base).ok, false, "the floor the prompt now clears");
    assert.match(a.prompt, /partial sale/);
    assert.match(a.system, /Trusted code adds any measured result separately/);
  });
});

describe("a measured gain leads the result line for the operator's agents (2026-10-13)", () => {
  it("is written by code: a sign, whole percent from ten up with separators, one decimal under ten", () => {
    assert.equal(gainFigure(1034.4), "+1,034%");
    assert.equal(gainFigure(42.6), "+43%");
    assert.equal(gainFigure(3.04), "+3%");
    assert.equal(gainFigure(3.46), "+3.5%");
    assert.equal(gainFigure(-12.2), "-12%");
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 1e8]) assert.equal(gainFigure(bad as number), null);
  });
  it("leads the trusted line, and the send-time check holds the post to the same figure", () => {
    const body = appendSaleOutcome("sold some pepe", "profit", 1034.4)!;
    assert.equal(body, "sold some pepe\n+1,034% gross gain before fees and gas. pleased with that part.");
    assert.equal(hasSaleOutcome(body, "profit", 1034.4), true);
    assert.equal(hasSaleOutcome(body, "profit", 980), false, "fresh evidence with another figure withholds it");
    assert.equal(hasSaleOutcome(body, "profit"), false, "an agent not given the figure never matches a figured line");
    assert.equal(appendSaleOutcome("sold some pepe", "profit"), "sold some pepe\ngross gain before fees and gas. pleased with that part.", "no figure, the old line");
    assert.equal(appendSaleOutcome("sold some pepe", "flat", 0.0), "sold some pepe\nflat before fees and gas. no victory lap.", "flat says no figure");
    assert.equal(appendSaleOutcome("sold some pepe", "unknown", 50), "sold some pepe", "unevidenced cost: no result claim at all");
  });
});

describe("a gain too small to show is no figure, never +0% (review, 2026-10-13)", () => {
  it("returns no figure under five hundredths of a percent, and the old line follows", () => {
    assert.equal(gainFigure(0.04), null);
    assert.equal(gainFigure(-0.049), null);
    assert.equal(gainFigure(0.05), "+0.1%");
    assert.equal(appendSaleOutcome("sold some pepe", "profit", 0.01), "sold some pepe\ngross gain before fees and gas. pleased with that part.");
  });
});
