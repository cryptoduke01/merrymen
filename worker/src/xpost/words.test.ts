/**
 * A DRAFT THAT NAMES A COIN IN ANY WORDS (red-team 2026-10-12): read alike for
 * every name, a word that might be a coin's beside market talk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coinTalkIn, unknownWordIn } from "./words";

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

  it("a draft handed nothing says only known words: a coin named without any market word is still found (red-team 2026-10-12)", () => {
    // Posted at fbcf8756 under "what's hot? need a new bag" and the like: coinTalkIn found no market word in any.
    for (const draft of ["wif and bonk have been the lively ones lately.", "wif has been strong lately, not a call.", "bonk is where the action is lately.",
      "wif and popcat are the ones people are on.", "zapx and qrtz have been the lively ones lately."]) {
      assert.equal(coinTalkIn(draft, "Alan Al Dale"), false, draft);
      assert.ok(unknownWordIn(draft, "Alan Al Dale"), draft);
    }
    for (const draft of ["doing alright, slow morning over here, lol.", "alan here, enjoying a quiet day.", "no read on that one just now, sorry.",
      "i keep my individual positions to myself here, sorry.", "always happy to talk about how i pick coins."]) {
      assert.equal(unknownWordIn(draft, "Alan Al Dale"), false, draft);
    }
  });
});
