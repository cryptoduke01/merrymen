import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { CASH } from "../../packages/core/src/index";
import { decisionResearchEnabledFor, entryCostEvidence, researchEntrySize } from "./decision-research";

const TOKEN = `0x${"a".repeat(40)}` as const;
const OTHER = `0x${"b".repeat(40)}` as const;
const quote = (amountOut: bigint) => ({ amountOut, fee: 3000, gasEstimate: 100_000n });
const args = {
  client: {} as PublicClient, token: TOKEN,
  facts: { token0: CASH.USDG, token1: TOKEN, fee: 3000 },
  sizeUsdg: 2_500_000n, gasPerOperationUsdg: 10_000n, tradeFeeBps: 25,
};

test("research opt-in binds exact account addresses and accepts no wildcard or prefix", () => {
  assert.equal(decisionResearchEnabledFor(TOKEN, {}), false);
  for (const value of ["all", "*", TOKEN.slice(0, 10), `${TOKEN}junk`, "0x" + "0".repeat(40)]) {
    assert.equal(decisionResearchEnabledFor(TOKEN, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: value }), false);
  }
  const env = { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: `${OTHER},\n${TOKEN.toUpperCase().replace("0X", "0x")}` };
  assert.equal(decisionResearchEnabledFor(TOKEN, env), true);
  assert.equal(decisionResearchEnabledFor(`0x${"c".repeat(40)}`, env), false);
});

test("research sizing cannot exceed the strategy, signed cap, remaining daily spend, cash or early bound", () => {
  assert.equal(researchEntrySize([2_500_000n, 10_000_000n, 50_000_000n, 100_000_000n]), 2_500_000n);
  assert.equal(researchEntrySize([2_500_000n, 1_000_000n, 50_000_000n]), 1_000_000n);
  assert.equal(researchEntrySize([2_500_000n, 10_000_000n, 750_000n]), 750_000n);
  assert.equal(researchEntrySize([2_500_000n, 0n]), 0n);
  assert.equal(researchEntrySize([2_500_000n, -1n]), 0n);
  assert.equal(researchEntrySize([]), 0n);
});

test("quotes the exact entry output back to cash, counting two gas costs and both turnover fees once", async () => {
  const calls: { tokens: readonly string[]; amount: bigint }[] = [];
  const text = await entryCostEvidence(args, { quote: async (route, amount) => {
    calls.push({ tokens: route.tokens, amount });
    return quote(calls.length === 1 ? 1_234_000n : 2_450_000n);
  } });
  assert.deepEqual(calls, [
    { tokens: [CASH.USDG, TOKEN], amount: 2_500_000n },
    { tokens: [TOKEN, CASH.USDG], amount: 1_234_000n },
  ]);
  assert.match(text, /2\.450000 USDG back/);
  assert.match(text, /turnover fees for both legs: 0\.012375 USDG/);
  assert.match(text, /gas for two operations: 0\.020000 USDG/);
  assert.match(text, /round-trip drag: 0\.082375 USDG \(3\.29% of entry\)/);
  assert.match(text, /not a sequential transaction simulation/);
  assert.match(text, /not expected profit, a guaranteed exit, or permission to trade/);
  assert.doesNotMatch(text, /0x[a-f0-9]{40}/i);
});

test("WETH bridge search is bounded and reverses the winning route's fee order", async () => {
  const calls: { tokens: readonly string[]; fees: readonly number[]; amount: bigint }[] = [];
  const text = await entryCostEvidence({ ...args, facts: { token0: TOKEN, token1: CASH.WETH, fee: 10000 } }, {
    quote: async (route, amount) => {
      calls.push({ ...route, amount });
      return quote(route.tokens[0] === CASH.USDG ? BigInt(route.fees[0]!) : 2_400_000n);
    },
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.at(-1), { tokens: [TOKEN, CASH.WETH, CASH.USDG], fees: [10000, 10000], amount: 10000n });
  assert.match(text, /2\.400000 USDG back/);
});

test("missing or failed exit quotes are unknown, not evidence of a cheap trade", async () => {
  let calls = 0;
  const text = await entryCostEvidence(args, { quote: async () => ++calls === 1 ? quote(100n) : null });
  assert.match(text, /unavailable/);
  assert.doesNotMatch(text, /0\.00|drag:/);
  const missingGas = await entryCostEvidence({ ...args, gasPerOperationUsdg: null }, { quote: async route => quote(route.tokens[0] === TOKEN ? 2_490_000n : 100n) });
  assert.match(missingGas, /gas for two operations: unknown/);
  assert.match(missingGas, /Total round-trip drag is unknown/);
});

test("unknown, unsupported and mismatched verified pool facts make no quote requests", async () => {
  let calls = 0;
  for (const facts of [undefined, { token0: OTHER, token1: CASH.USDG, fee: 3000 }, { token0: TOKEN, token1: OTHER, fee: 3000 }]) {
    assert.match(await entryCostEvidence({ ...args, facts }, { quote: async () => { calls++; return null; } }), /unavailable/);
  }
  assert.equal(calls, 0);
});

test("a budget miss returns promptly and late entry evidence cannot start an exit request", async () => {
  let time = 1000;
  let finish!: (q: ReturnType<typeof quote>) => void;
  let calls = 0;
  const result = await entryCostEvidence(args, { now: () => time, budgetMs: 1, quote: async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.match(result, /unavailable/);
  time = 1002;
  finish(quote(100n));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
