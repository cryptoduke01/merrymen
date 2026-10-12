/**
 * A DRAFT THAT NAMES A COIN IN ANY WORDS (red-team 2026-10-12): read alike for
 * every name, a word that might be a coin's beside market talk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coinTalkIn } from "./words";

describe("a coin named in a draft's words", () => {
  it("a name-like word beside market talk is a coin named; everyday chat and the agent's own name are not", () => {
    for (const draft of ["wif and bonk look hot right now.", "i'd keep it simple, wif and bonk are the ones running hot today.", "honestly brett is the coin everyone is on.",
      "pepe's pumping again", "zorb looks like a fun play",
      // Errs toward yes: a hot day is read as a hot coin, which costs one chat answer.
      "alan here, the hot weather is a lot today."]) {
      assert.ok(coinTalkIn(draft, "Alan Al Dale"), draft);
    }
    for (const draft of ["doing alright, slow morning over here, lol.", "always happy to talk about how i pick coins.", "alan here, enjoying a quiet day.",
      "nothing much, just watching the market like everyone else."]) {
      assert.equal(coinTalkIn(draft, "Alan Al Dale"), false, draft);
    }
  });
});
