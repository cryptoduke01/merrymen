/**
 * A MARKET ANSWER'S WORDS ARE CODE'S (red-team review, 2026-10-12): every
 * frame clears the X gate for every read, carries no digit, names no coin,
 * says nothing of itself (but a paper agent's paper clause), and no two
 * frames are a repeat of each other, so the same read is said again in other
 * words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { hotAnswers, hotNoneAnswers, hotUnreadAnswers, majorAnswers, majorsDirOf, majorUnreadAnswers, marketAnswers, moveOf, type HotRead, type MajorRead, type MarketRead, type Move } from "./xpost/market";
import { withoutReplyOptOut } from "./xpost/replies";

const MOVES: (Move | null)[] = [null, { dir: "flat", size: null },
  ...(["up", "down"] as const).flatMap((dir) => (["a little", "a fair bit", "sharply"] as const).map((size) => ({ dir, size })))];
const gate = (text: string, recentOwn: string[], mode: "live" | "paper") =>
  admitXPost(text, { kind: "reply", agentName: "Alan Al Dale", mode, coins: [], recentOwn, recentFleet: [] }, (r, c) => admitAgentLine(r, c));

/** Every line of one read: each clears the gate alone and after all the others were said, and none repeats another. */
function judged(lines: string[], paper: boolean): void {
  assert.equal(lines.length, 8);
  const said: string[] = [];
  for (const [i, line] of lines.entries()) {
    assert.doesNotMatch(line, /\p{N}|\$|@|#|https?:/u, line);
    const alone = gate(line, [], paper ? "paper" : "live");
    assert.ok(alone.ok, `${line} → ${alone.ok ? "" : alone.reason}`);
    const after = gate(line, said, paper ? "paper" : "live");
    assert.ok(after.ok, `${line} after the others → ${after.ok ? "" : after.reason}`);
    said.unshift(line);
    for (const other of lines.slice(i + 1)) {
      assert.ok(similarity(withoutReplyOptOut(line), withoutReplyOptOut(other)) < REPEAT_LIMIT, `${line}\n${other}`);
    }
    const words = withoutReplyOptOut(line).replace(/\. (?:all my|my|every) [^.]*\.$/, ".");
    assert.doesNotMatch(words, /\b(?:i|i'?m|i'?d|i'?ve|me|my|mine|we|our|buy|buying|bought|sell|early|pick|play|own|hold|holding|long|target|should|worth)\b/i, words);
  }
}

describe("what's hot in code's words", () => {
  it("moves by code's own thresholds: flat under half a percent, a little under three, a fair bit under ten, sharply past it", () => {
    assert.deepEqual(moveOf(0.4), { dir: "flat", size: null });
    assert.deepEqual(moveOf(-2.9), { dir: "down", size: "a little" });
    assert.deepEqual(moveOf(9.9), { dir: "up", size: "a fair bit" });
    assert.deepEqual(moveOf(412.4), { dir: "up", size: "sharply" });
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "12"]) assert.equal(moveOf(bad), null);
  });

  it("eight frames for every read, live or on paper: each clears the gate, none repeats another, none says a name, a figure or a pick", () => {
    for (const paper of [false, true]) {
      for (const coins of [1, 2, 3]) {
        for (const lead of MOVES) judged(hotAnswers({ coins, lead }, "1000000000000000123", { lower: false }, { paper }), paper);
      }
    }
  });

  it("nothing past the floors, and nothing read: eight lines each, never a draft, never a guess (red-team 2026-10-12)", () => {
    for (const paper of [false, true]) {
      judged(hotNoneAnswers("1000000000000000123", { lower: false }, { paper }), paper);
      judged(hotUnreadAnswers("1000000000000000123", { lower: false }, { paper }), paper);
    }
  });

  it("a major: eight frames for every whole read, live or on paper, none repeating another; a partial read still clears the gate (red-team 2026-10-12)", () => {
    const moves = MOVES.filter((m): m is Move => m !== null);
    for (const paper of [false, true]) {
      for (const rank of ["top", "large", "mid"] as const) {
        for (const day of moves) {
          for (const week of [moves[1]!, moves[4]!, moves[7]!]) {
            for (const volume of ["heavy", "light", "ordinary"] as const) judged(majorAnswers({ rank, day, week, volume }, "1000000000000000123", { lower: false }, { paper }), paper);
          }
        }
      }
      for (const read of [{ rank: null, day: moves[2]!, week: null, volume: null }, { rank: "mid", day: null, week: null, volume: "light" }] as MajorRead[]) {
        for (const line of majorAnswers(read, "7", { lower: false }, { paper })) assert.ok(gate(line, [], paper ? "paper" : "live").ok, line);
      }
      judged(majorUnreadAnswers("1000000000000000123", { lower: false }, { paper }), paper);
    }
    assert.deepEqual(majorAnswers({ rank: null, day: null, week: null, volume: null }, "1", { lower: false }), [], "nothing to say: no answer");
    for (const line of majorAnswers({ rank: "top", day: moves[0]!, week: moves[0]!, volume: "heavy" }, "1", { lower: false })) assert.match(line, /coingecko/);
  });

  it("a paper agent's clause is about its own trading, never a pronoun or a verb the coin just described could take (red-team 2026-10-12)", () => {
    // At fbcf8756: "coingecko's view: a heavyweight, rising solidly lately, … a snapshot. i play it on paper. coingecko: $ETH #2, …".
    const lines = [
      ...majorAnswers({ rank: "top", day: { dir: "up", size: "a fair bit" }, week: { dir: "up", size: "a little" }, volume: "ordinary" }, "1000000000000000903", { lower: true }, { paper: true }),
      ...majorUnreadAnswers("1000000000000000903", { lower: true }, { paper: true }),
      ...hotAnswers({ coins: 3, lead: { dir: "up", size: "sharply" } }, "1000000000000000903", { lower: true }, { paper: true }),
    ];
    for (const line of lines) {
      const clause = /\. ((?:all my|my|every) [^.]*)\. say stop to opt out\.$/.exec(line)?.[1];
      assert.ok(clause, line);
      // Its own book is the subject: no pronoun the coin could be, and no verb it could be the object of.
      assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
      assert.match(clause!, /\b(?:paper|practice)\b/);
    }
    assert.ok(lines.every((l) => !/i play it on paper|i trade on paper|i'm trading on paper/.test(l)));
  });

  it("this mention's own frame first, every frame once, the notice in the agent's case; no coin, no answer", () => {
    const read: HotRead = { coins: 3, lead: { dir: "up", size: "sharply" } };
    const a = hotAnswers(read, "1", { lower: false }), b = hotAnswers(read, "2", { lower: false });
    assert.notEqual(a[0], b[0]);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.ok(a.every((l) => l.endsWith(". Say stop to opt out.")));
    assert.ok(hotAnswers(read, "1", { lower: true }).every((l) => l.endsWith(". say stop to opt out.")));
    assert.deepEqual(hotAnswers({ coins: 0, lead: null }, "1", { lower: false }), []);
  });

  it("how's the market, in code's casual words: every line of every read clears the gate, none repeats another of its read, none names a coin or a figure (2026-10-12)", () => {
    const told = (text: string, mode: "live" | "paper" | null, recentOwn: string[], noticeShown: boolean) => admitXPost(text, { kind: "reply", answer: true, noticeShown,
      agentName: "Alan Al Dale", mode, coins: [], recentOwn, recentFleet: [] }, (r, c) => admitAgentLine(r, c));
    const majorsReads: MarketRead["majors"][] = [{ dir: "up" }, { dir: "down" }, { dir: "mixed" }, { dir: "flat" }, null];
    const chainReads: MarketRead["chain"][] = [{ coins: 3, lead: { dir: "up", size: "sharply" } }, { coins: 1, lead: null }, { coins: 0, lead: null }, null];
    for (const majors of majorsReads) {
      for (const chain of chainReads) {
        for (const mode of ["live", "paper", null] as const) {
          const lines = marketAnswers({ majors, chain }, "1000000000000000777", { lower: true }, { paper: mode === "paper" });
          assert.equal(lines.length, 64);
          assert.equal(new Set(lines).size, 64);
          const said: string[] = [];
          for (const line of lines) {
            const words = withoutReplyOptOut(line);
            assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, line);
            assert.doesNotMatch(words, /\b(?:btc|eth|sol|bitcoin|ether|ethereum|solana|pepe|bonk|wif|doge)\b/i, line);
            assert.doesNotMatch(words, /\b(?:buy|buying|bought|sell|hold|holding|entry|target|bullish|bearish|moon|pump|bounce|bottom|recover\w*|cheap|from here)\b/i, line);
            const v = told(line, mode, said, false);
            assert.ok(v.ok, `${JSON.stringify(majors)} ${JSON.stringify(chain)} ${mode}: ${line} → ${v.ok ? "" : v.reason}`);
            said.unshift(line);
          }
          // Told already: the same words, no notice, still admitted.
          for (const line of marketAnswers({ majors, chain }, "9", { lower: false }, { paper: mode === "paper", notice: false })) {
            assert.doesNotMatch(line, /opt out/i);
            const v = told(line, mode, [], true);
            assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
          }
        }
      }
    }
    // The words say what was read, and only that.
    const up = marketAnswers({ majors: { dir: "up" }, chain: { coins: 3, lead: null } }, "1", { lower: true });
    assert.ok(up.every((l) => /robinhood|chain|onchain|geckoterminal|trenches|index|trending|over there/.test(l)), "it says where the movers are");
    const unread = marketAnswers({ majors: null, chain: null }, "1", { lower: true });
    assert.ok(unread.every((l) => /\bno (?:read|view|glimpse|data|word|signal)\b|can't spot|zilch from/.test(l)), "no read is said as none");
    assert.equal(majorsDirOf([moveOf(1.2), moveOf(3.4), moveOf(0.6)])?.dir, "up");
    assert.equal(majorsDirOf([moveOf(-1.2), moveOf(0.1), moveOf(-4)])?.dir, "down");
    assert.equal(majorsDirOf([moveOf(1.2), moveOf(-3.4), null])?.dir, "mixed");
    assert.equal(majorsDirOf([moveOf(0.2), moveOf(-0.3), null])?.dir, "flat");
    assert.equal(majorsDirOf([null, null]), null);
  });

  it("a paper agent's market line closes with a clause about its own book, never one the coins could take (2026-10-12)", () => {
    for (const line of marketAnswers({ majors: { dir: "up" }, chain: { coins: 2, lead: null } }, "5", { lower: true }, { paper: true })) {
      const clause = /\. ((?:all my|my|every) [^.]*)\. say stop to opt out\.$/.exec(line)?.[1];
      assert.ok(clause, line);
      assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
    }
  });

  it("for someone already told they can say stop, every frame leaves the notice off and still clears the gate told so (2026-10-12)", () => {
    const told = (text: string, paper: boolean) => admitXPost(text, { kind: "reply", answer: true, noticeShown: true, agentName: "Alan Al Dale", mode: paper ? "paper" : "live",
      coins: [], recentOwn: [], recentFleet: [] }, (r, c) => admitAgentLine(r, c));
    for (const paper of [false, true]) {
      const sets = [
        hotAnswers({ coins: 2, lead: { dir: "down", size: "a little" } }, "7", { lower: true }, { paper, notice: false }),
        hotNoneAnswers("7", { lower: true }, { paper, notice: false }), hotUnreadAnswers("7", { lower: true }, { paper, notice: false }),
        majorAnswers({ rank: "large", day: { dir: "up", size: "a fair bit" }, week: null, volume: "light" }, "7", { lower: true }, { paper, notice: false }),
        majorUnreadAnswers("7", { lower: true }, { paper, notice: false }),
      ];
      for (const line of sets.flat()) {
        assert.doesNotMatch(line, /opt out/, line);
        const v = told(line, paper);
        assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
        const owed = admitXPost(line, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode: paper ? "paper" : "live", coins: [], recentOwn: [], recentFleet: [] },
          (r, c) => admitAgentLine(r, c));
        assert.deepEqual(owed, { ok: false, reason: "opt-out-unsaid" }, "not told: the notice is owed");
      }
    }
  });
});
