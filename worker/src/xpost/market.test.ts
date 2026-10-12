/**
 * A MARKET ANSWER'S WORDS ARE CODE'S (red-team review, 2026-10-12): every
 * frame clears the X gate for every read, carries no digit, names no coin,
 * says nothing of itself (but a paper agent's paper clause), and no two
 * frames are a repeat of each other, so the same read is said again in other
 * words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "../groupchat/policy";
import { REPEAT_LIMIT, similarity } from "../social-post";
import { admitXPost } from "./gate";
import { hotAnswers, moveOf, type HotRead, type Move } from "./market";
import { withoutReplyOptOut } from "./replies";

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
    const words = withoutReplyOptOut(line).replace(/\. i(?:'m| trade| play)[^.]*\.$/, ".");
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

  it("this mention's own frame first, every frame once, the notice in the agent's case; no coin, no answer", () => {
    const read: HotRead = { coins: 3, lead: { dir: "up", size: "sharply" } };
    const a = hotAnswers(read, "1", { lower: false }), b = hotAnswers(read, "2", { lower: false });
    assert.notEqual(a[0], b[0]);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.ok(a.every((l) => l.endsWith(". Say stop to opt out.")));
    assert.ok(hotAnswers(read, "1", { lower: true }).every((l) => l.endsWith(". say stop to opt out.")));
    assert.deepEqual(hotAnswers({ coins: 0, lead: null }, "1", { lower: false }), []);
  });
});
