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
const LAUNCH = CODE.indexOf("trenchBrain.launch(trenchContext, inputs, focus.token, async () => {");
const PAID = CODE.indexOf("return runShadow(brainConfig, inputs,", LAUNCH);

describe("the Trencher review's hold backoff, memory, evidence rule and research plan", () => {
  it("the rotation has its backoff, and an idle rotation is not called a broken screen", () => {
    assert.match(CODE, /trenchBrain\.holdBackoff = new HoldBackoff\(\(token\) => \{/);
    assert.match(CODE, /trenchNotice\(agentId, trenchSymbols\.size \|\| entriesBraked \|\| backedOff \? "" :/);
  });

  it("the hold memory line is read for ENTRY reviews only", () => {
    assert.match(CODE, /const holdLine = focus\.held \? null : trenchBrain\.holdMemory\(focus\.token, focus\.symbol\);/);
  });

  it("the blind-evidence skip guards on an unheld focus and returns BEFORE the paid call", () => {
    assert.ok(LAUNCH > 0 && PAID > LAUNCH);
    const run = CODE.slice(LAUNCH, PAID);
    const skip = run.indexOf("if (!focus.held && entryEvidenceBlind(evidence, tapeAt, Date.now())) {");
    assert.ok(skip > 0, "the skip asks about the held flag first");
    const body = run.slice(skip, run.indexOf("satisfies ShadowOutcome;", skip));
    assert.match(body, /trenchBrain\.evidenceSkipped\(focus\.token\)/);
    assert.match(body, /return \{\s*ran: false,/);
    assert.doesNotMatch(body, /runShadow|claimReview/, "nothing paid or claimed on the skip");
  });

  it("the momentum plan rides only on costContext, which exists only for research accounts' entry reviews", () => {
    assert.match(CODE, /const enhancedResearch = fastTrencher && !paper && decisionResearchEnabledFor\(active\.grant\.smartAccount\);/);
    assert.match(CODE, /const costContext = enhancedResearch && !focus\.held \? \{/);
    const run = CODE.slice(LAUNCH, PAID);
    assert.match(run, /if \(costContext\) \{\s*inputs\.persona \+= `\\n\\n\$\{trenchMomentumBrief\(TRENCHER_FAST, trenchBreakEven\(costResearch, costContext\), costContext\.sizeUsdg\)\}`;\s*\}/);
    assert.equal(CODE.split("trenchMomentumBrief(").length - 1, 1, "one call site");
  });
});
