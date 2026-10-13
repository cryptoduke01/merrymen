/**
 * CODE'S CASUAL ANSWERS CLEAR THE REAL GATE (2026-10-12): a playful decline,
 * its own mood and a friendly fallback for chat, sixty-four lines a kind.
 * Every line clears the X gate with the room's base gate composed in, live,
 * paper and idle, with no opt-out notice (the owner's decision, 2026-10-12),
 * and still clears it after every other line of every kind was
 * said; none repeats another; none names a coin, a figure, a direction or a
 * buy. Here, beside the orchestrator, because only orchestrator* files may
 * import the room's gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { CHAT_SLOTS, DECLINE_SLOTS, SELF_SLOTS, SLOT, TRADES_NONE_SLOTS, TRADES_SLOTS, VIBE_SLOTS, chatAnswers, declineAnswers, latinLines, selfAnswers, tradesAnswers, vibeAnswers } from "./xpost/casual";
import { STRATEGY_SPOKEN } from "./groupchat/templates";
import { withoutReplyOptOut } from "./xpost/replies";
import { greetingAnswers, modelAnswers } from "./xpost/writer";

type Mode = "live" | "paper" | null;
const gate = (text: string, mode: Mode, recentOwn: string[] = []) => admitXPost(text, { kind: "reply", answer: true, agentName: "Alan Al Dale",
  mode, coins: [], recentOwn, recentFleet: [] }, (r, c) => admitAgentLine(r, c));

const KINDS = [["decline", declineAnswers, DECLINE_SLOTS], ["vibe", vibeAnswers, VIBE_SLOTS], ["chat", chatAnswers, CHAT_SLOTS]] as const;
/** A text's content words as similarity() counts them: three letters or more, no stopword (a word similar to itself). */
const contentWords = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && similarity(w, w) > 0));

describe("code's casual answers", () => {
  it("each kind is sixty-four lines, this mention's own first, the same mention the same order", () => {
    for (const [kind, make] of KINDS) {
      const a = make("100000000000000001", { lower: true }), b = make("100000000000000002", { lower: true });
      assert.equal(a.length, SLOT * SLOT, kind);
      assert.equal(new Set(a).size, SLOT * SLOT, `${kind}: every cell once`);
      assert.deepEqual([...a].sort(), [...b].sort(), kind);
      assert.notEqual(a[0], b[0], `${kind}: two mentions start apart`);
      assert.deepEqual(make("100000000000000001", { lower: true }), a, kind);
    }
    assert.deepEqual(latinLines([["a"], ["b", "c"], ["d"]], "1", (x, y, z) => x + y + z), [], "slots of unequal size make nothing");
  });

  it("no word is in two parts of a kind, so two lines share at most one part and are never each other's repeat", () => {
    for (const [kind, , slots] of KINDS) {
      const seen = new Map<string, string>();
      for (const part of slots.flat()) {
        for (const w of contentWords(part)) {
          assert.ok(!seen.has(w), `${kind}: "${w}" is in "${part}" and "${seen.get(w)}"`);
          seen.set(w, part);
        }
      }
    }
    // An agent's lines are all live or all paper: each set against itself, every kind together, and code's greeting and model lines.
    for (const paper of [false, true]) {
      const every = [...KINDS.flatMap(([, make]) => make("1", { lower: true }, { paper })), ...greetingAnswers("1", { lower: true }, { paper }), ...modelAnswers("1", { lower: true }, { paper })];
      const words = every.map((l) => withoutReplyOptOut(l));
      assert.equal(new Set(words).size, words.length);
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) assert.ok(similarity(words[i]!, words[j]!) < REPEAT_LIMIT, `${words[i]}\n${words[j]}`);
      }
    }
  });

  it("every line clears the real gate as an answer, live, paper and idle, and none carries an opt-out line (2026-10-12)", () => {
    for (const [kind, make] of KINDS) {
      for (const mode of ["live", "paper", null] as const) {
        for (const lower of [true, false]) {
          for (const line of make("7", { lower }, { paper: mode === "paper" })) {
            const v = gate(line, mode, []);
            assert.ok(v.ok, `${kind} ${mode} ${lower}: ${line} → ${v.ok ? "" : v.reason}`);
            assert.equal(v.ok && v.text, line, "posted exactly as built");
            assert.doesNotMatch(line, /opt out|\bstop\b|unsubscribe/i);
          }
        }
      }
    }
  });

  it("all of them can be said one after another, after code's greeting and model lines, and none is refused as a repeat", () => {
    for (const mode of ["live", "paper"] as const) {
      const said: string[] = [...greetingAnswers("3", { lower: true }, { paper: mode === "paper" }), ...modelAnswers("3", { lower: true }, { paper: mode === "paper" })];
      for (const [kind, make] of KINDS) {
        for (const line of make("3", { lower: true }, { paper: mode === "paper" })) {
          const v = gate(line, mode, said);
          assert.ok(v.ok, `${kind} ${mode} after ${said.length} lines: ${line} → ${v.ok ? "" : v.reason}`);
          said.unshift(line);
        }
      }
    }
  });

  it("no line names a coin, a figure, a direction, a buy, a holding or a stock deflection, and none claims to be trading now", () => {
    for (const [kind, make] of KINDS) {
      for (const line of [...make("9", { lower: true }), ...make("9", { lower: true }, { paper: true })]) {
        const words = withoutReplyOptOut(line);
        assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, `${kind}: ${line}`);
        assert.doesNotMatch(words, /\b(?:pepe|bonk|wif|doge|shib|btc|eth|sol|bitcoin|ether|solana|sherwood|robinhood|groq|qwen|gpt|claude|llama)\b/i, `${kind}: ${line}`);
        assert.doesNotMatch(words, /\b(?:bullish|bearish|moon|wen|wagmi|pump|dump|up only|going up|going down|higher|lower|bounce|bottom|top|rally|crash|green|red)\b/i, `${kind}: no direction: ${line}`);
        assert.doesNotMatch(words, /\b(?:bought|buy|buying|sell|selling|hold|holding|bag|position|entry|target|profit|loss|price)\b/i, `${kind}: no buy, no holding: ${line}`);
        assert.doesNotMatch(words, /\b(?:i trade|i'm trading|i am trading|trading right now)\b/i, `${kind}: never trading now: ${line}`);
        assert.doesNotMatch(words, /i don'?t comment|no comment|as an? (?:ai|bot)|financial advice|great question/i, `${kind}: ${line}`);
      }
    }
  });

  it("how it trades and what it bought, in code's words: every line clears the real gate, never repeats another, and says nothing but that (red-team review of daaae961)", () => {
    const strategies = [...Object.values(STRATEGY_SPOKEN), null];
    const coinSets: string[][] = [["Pepe"], ["PEPE", "Bonk"], ["pepe", "bonk", "wif"], []];
    // No word in two parts of a kind.
    for (const [kind, slots] of [["self", SELF_SLOTS], ["trades", TRADES_SLOTS], ["trades-none", TRADES_NONE_SLOTS]] as const) {
      const seen = new Map<string, string>();
      for (const part of slots.flat()) {
        for (const w of contentWords(part.replace(/\{[sc]\}/g, " "))) {
          assert.ok(!seen.has(w), `${kind}: "${w}" is in "${part}" and "${seen.get(w)}"`);
          seen.set(w, part);
        }
      }
    }
    for (const mode of ["live", "paper", null] as const) {
      const paper = mode === "paper";
      const lines = [...strategies.flatMap((s) => selfAnswers(s, "7", { lower: true }, { paper })), ...coinSets.flatMap((c) => tradesAnswers(c, "7", { lower: true }, { paper }))];
      for (const line of lines) {
        const coins = coinSets.flat().filter((c) => line.includes(c));
        const v = admitXPost(line, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode, coins, paperCoins: paper ? coins : [], recentOwn: [], recentFleet: [] },
          (r, c) => admitAgentLine(r, c));
        assert.ok(v.ok, `${mode}: ${line} → ${v.ok ? "" : v.reason}`);
        assert.equal(v.ok && v.text, line, "posted exactly as built");
        const words = withoutReplyOptOut(line);
        assert.doesNotMatch(words, /\p{N}|\$|@|#|https?:|0x/u, line);
        assert.doesNotMatch(words, /\b(?:hot|trending|next|soon|tonight|tomorrow|later today|early|bullish|bearish|moon|pump|up only|higher|lower|top|bottom|green|red|profit|loss|size|hold|holding|sell|selling|best|biggest|fund|merrymen|robinhood|sherwood)\b/i, line);
        assert.doesNotMatch(words, /\b(?:you should|should you|i'?d buy|buy it|get in)\b/i, line);
      }
    }
    // Every self line of one strategy, and every trades line of one set of coins, can be said one after another.
    for (const lines of [selfAnswers("trencher", "3", { lower: true }), tradesAnswers(["pepe"], "3", { lower: true }), tradesAnswers([], "3", { lower: true })]) {
      const said: string[] = [];
      for (const line of lines) {
        const v = admitXPost(line, { kind: "reply", answer: true, agentName: "Alan Al Dale", mode: "live", coins: ["pepe"], recentOwn: said, recentFleet: [] }, (r, c) => admitAgentLine(r, c));
        assert.ok(v.ok, `after ${said.length}: ${line} → ${v.ok ? "" : v.reason}`);
        said.unshift(line);
      }
    }
    // A name a line may not say is never put in one.
    assert.deepEqual(tradesAnswers(["$PEPE", "pe pe 2"], "1", { lower: true }), tradesAnswers([], "1", { lower: true }));
    // With none to name it says only that, never that it bought nothing or was quiet: it may have bought coins it cannot name.
    for (const line of tradesAnswers([], "5", { lower: true })) {
      assert.doesNotMatch(line, /\b(?:quiet|idle|calm|slow|nothing (?:bought|new)|no (?:recent )?buys|haven'?t bought|didn'?t buy|bought nothing)\b/, line);
    }
  });

  it("a paper agent's clause is about its own book: no pronoun or verb the tag's coin could take", () => {
    for (const [kind, make] of KINDS) {
      for (const line of make("11", { lower: true }, { paper: true })) {
        const clause = /\. ((?:my|all of my|this agent's) [^.]*)\.$/.exec(line)?.[1];
        assert.ok(clause, `${kind}: ${line}`);
        assert.doesNotMatch(clause!, /\b(?:it|its|it's|them|they|that|this one|one|i|i'm|play|plays|playing|hold|holding|buy|buying)\b/, clause);
        assert.match(clause!, /\b(?:paper|practice)\b/);
      }
    }
  });
});
