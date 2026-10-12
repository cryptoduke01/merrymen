/**
 * WHERE THE TRENCHER REVIEW ASKS ABOUT HOLDS, EVIDENCE AND THE RESEARCH PLAN.
 *
 * The backoff, the hold memory, the blind-evidence rule and the momentum plan
 * are pure and tested beside their code (trencher-brain.test.ts,
 * decision-research.test.ts). What can go wrong in main() is WIRING: a guard
 * on a held position dropped, a skip moved after the paid call, or the
 * research plan reaching accounts that never opted in. main() cannot be booted
 * by a test, so each is pinned here over index.ts with comments stripped, as
 * energy-wiring.test.ts does.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const LAUNCH = CODE.indexOf("trenchBrain.launch(trenchContext, inputs, focus.token, async (review) => {");
const PAID = CODE.indexOf("return runShadow(brainConfig, inputs,", LAUNCH);

describe("the Trencher review's hold backoff, memory, evidence rule and research plan", () => {
  it("the rotation has its backoff; an idle rotation is not called a broken screen, and an evidence outage is never hidden", () => {
    assert.match(CODE, /trenchBrain\.holdBackoff = new HoldBackoff\(\(token\) => \{/);
    const at = CODE.indexOf("const backoff = fastTrencher && !trenchCandidate ? trenchBrain.backedOffBreakdown()");
    assert.ok(at > 0);
    const notice = CODE.slice(at, CODE.indexOf("const backoffIdle", at));
    // The evidence case is asked FIRST, so nothing below it can clear its notice.
    assert.match(notice, /trenchNotice\(agentId,\s*backoff\.evidence \? "Pool evidence is unavailable[^"]*"\s*: trenchSymbols\.size \|\| entriesBraked \|\| backedOff \? "" :/);
    const idle = CODE.slice(at, CODE.indexOf("const focusPositions", at));
    assert.match(idle, /held recently with nothing material moved since/);
    assert.match(idle, /waiting out an evidence skip/);
  });

  it("BOTH entry-skip branches — blind legs on a stale row, and no tape row — file evidence-unavailable and return before the paid call", () => {
    assert.ok(LAUNCH > 0 && PAID > LAUNCH);
    const run = CODE.slice(LAUNCH, PAID);
    const helper = run.slice(run.indexOf("const skipBlindEntry = (why: string): ShadowOutcome => {"), run.indexOf("if (tape) {"));
    assert.match(helper, /trenchBrain\.evidenceSkipped\(focus\.token\)/);
    assert.match(helper, /funnel\.note\(focus\.token, focus\.symbol, classifyStage\(\{ kind: "evidence-unavailable" \}\)\)/);
    assert.match(helper, /ran: false,/);
    assert.doesNotMatch(helper, /runShadow|claimReview/, "nothing paid or claimed on a skip");
    assert.match(run, /if \(!focus\.held && entryEvidenceBlind\(evidence, tapeAt, Date\.now\(\)\)\) \{[\s\S]{0,300}?return skipBlindEntry\(/);
    assert.match(run, /if \(!focus\.held\) return skipBlindEntry\("its pool has no fresh tape row/);
    assert.equal(run.split("return skipBlindEntry(").length - 1, 2, "the two skips, and no other");
  });

  it("a review that goes ahead without either leg, or without a tape row, is flagged so its HOLD backs nothing off", () => {
    const run = CODE.slice(LAUNCH, PAID);
    assert.match(run, /if \(!evidence \|\| \(evidence\.candles\.failed && evidence\.trades\.failed\)\) review\.withoutEvidence\(\);/);
    assert.match(run, /return skipBlindEntry\("its pool has no fresh tape row[^;]*;\s*review\.withoutEvidence\(\);/);
  });

  it("the hold memory line is read for ENTRY reviews only, and never displaces the paper notice", () => {
    assert.match(CODE, /const holdLine = focus\.held \? null : trenchBrain\.holdMemory\(focus\.token, focus\.symbol\);/);
    assert.match(CODE, /if \(holdLine\) inputs\.memory = leadMemory\(inputs\.memory \?\? \[\], holdLine, paper\);/);
    assert.ok(CODE.indexOf("inputs.memory = leadMemory(") > CODE.indexOf('"This is the paper ledger.'), "after the paper notice is added, so it is the last line protected");
  });

  it("the Brain reads the compact evidence copy, not the full summary", () => {
    const run = CODE.slice(LAUNCH, PAID);
    assert.match(run, /const detail = evidence \? brainEvidence\(evidence\) :/);
    assert.doesNotMatch(CODE, /summarizeEvidence\(/);
  });

  it("the momentum plan rides only on costContext, which exists only for research accounts' entry reviews", () => {
    assert.match(CODE, /const enhancedResearch = fastTrencher && !paper && decisionResearchEnabledFor\(active\.grant\.smartAccount\);/);
    assert.match(CODE, /const costContext = enhancedResearch && !focus\.held \? \{/);
    const run = CODE.slice(LAUNCH, PAID);
    assert.match(run, /if \(costContext\) \{\s*inputs\.persona \+= `\\n\\n\$\{trenchMomentumBrief\(TRENCHER_FAST, trenchBreakEven\(costResearch, costContext\), costContext\.sizeUsdg\)\}`;\s*\}/);
    assert.equal(CODE.split("trenchMomentumBrief(").length - 1, 1, "one call site");
  });
});
