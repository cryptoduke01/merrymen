import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import { boundSolanaRebalanceSell, createSolanaAgent, planSolanaRebalance } from "./solana-agent";
import { wrapSqlite } from "./db";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { ensureSolanaTradingSchema } from "./solana-trading-store";

const NOW = 1_000_000;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 1000000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "5000000", intervalSeconds: 60 };
const input = { cashRaw: "100000000", wsolRaw: "0", solValueUsdgRaw: "0", limits, strategy, mode: "paper" as const, revision: 3, nowMs: NOW };
test("rebalance sizes integer buys to the strictest cap without using floating point", () => {
  const buy = planSolanaRebalance(input)!;
  assert.equal(buy.inputMint, SOLANA_USDG_MINT); assert.equal(buy.amountRaw, "5000000");
  assert.equal(planSolanaRebalance({ ...input, limits: { ...limits, perTradeUsdg: "1000000" } })!.amountRaw, "1000000");
  assert.equal(planSolanaRebalance({ ...input, cashRaw: "18446744073709551615" })!.amountRaw, "5000000");
});
test("rebalance sells proportional real units, respects bands, and does not pretend unquoted SOL is worth zero", () => {
  const sell = planSolanaRebalance({ ...input, cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "100000000" })!;
  assert.equal(sell.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(sell.amountRaw, "50000000");
  assert.equal(planSolanaRebalance({ ...input, cashRaw: "50000000", wsolRaw: "1000000000", solValueUsdgRaw: "50000000" }), null);
  assert.throws(() => planSolanaRebalance({ ...input, wsolRaw: "1000000000" }), /valuation/);
});
test("request identity is stable inside an interval and changes only at next interval or settings revision", () => {
  assert.equal(planSolanaRebalance(input)!.requestId, planSolanaRebalance({ ...input, nowMs: NOW + 1000 })!.requestId);
  assert.notEqual(planSolanaRebalance(input)!.requestId, planSolanaRebalance({ ...input, nowMs: NOW + 60000 })!.requestId);
  assert.notEqual(planSolanaRebalance(input)!.requestId, planSolanaRebalance({ ...input, revision: 4 })!.requestId);
  assert.equal(planSolanaRebalance({ ...input, strategy: { ...strategy, enabled: false } }), null);
  assert.throws(() => planSolanaRebalance({ ...input, nowMs: limits.expiresAtMs }), /expired/);
});
test("partial sells re-quote below the explicit strategy cap instead of treating a haircut as the unit price", async () => {
  const candidate = planSolanaRebalance({ ...input, strategy: { ...strategy, tradeUsdgRaw: "10000000" },
    cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "99500000" })!;
  assert.equal(candidate.amountRaw, "100502512");
  let quotes = 0;
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async i => {
    quotes++;
    const out = BigInt(i.amountRaw) / 10n;
    return { source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: out.toString(),
      minOutAmount: (out * 995n / 1000n).toString(), slippageBps: 50, contextSlot: 1, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  } };
  const sized = await boundSolanaRebalanceSell(candidate, 10000000n, market, () => NOW);
  assert.ok(sized); assert.ok(BigInt(sized.amountRaw) / 10n <= 10000000n); assert.equal(quotes, 2);
  assert.equal(sized.requestId, candidate.requestId);
});

test("actual paper agent ticks are durable, opt-in and cannot duplicate a fill after worker restart", async () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
  const tenant = "0x1111111111111111111111111111111111111111", owner = "So11111111111111111111111111111111111111112";
  const scope = { tenant, owner };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
    quote: async i => ({ source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
      outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
      contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30000 }),
  };
  const rpc = { read: async () => { throw new Error("No live RPC in a paper worker test"); }, send: async () => { throw new Error("Must never send"); } };
  try {
    await bindings.bind(tenant, "did:privy:test", owner);
    await bindings.settings(tenant, owner, 0, "paper", limits);
    const runtime = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });
    await runtime.setupPaper(scope, { initialCashRaw: input.cashRaw, limits });
    const agent = createSolanaAgent({ db, runtime, market, now: () => NOW });
    assert.deepEqual(await agent.tick(), []);
    await bindings.strategy(tenant, owner, 1, strategy);
    assert.equal((await agent.tick())[0]!.outcome, "submitted");
    const restarted = createSolanaAgent({ db, runtime: createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW }), market, now: () => NOW });
    await restarted.tick();
    assert.equal((await runtime.status(scope)).paper!.trades.length, 1);
    const binding = (await bindings.get(tenant))!;
    await bindings.strategy(tenant, owner, binding.revision, { ...strategy, enabled: false });
    assert.deepEqual(await restarted.tick(), []);
    assert.equal((await runtime.status(scope)).paper!.trades.length, 1);
  } finally { raw.close(); }
});

test("pending confirmation recovery runs even with no enabled strategies", async () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), seen: string[] = [];
  try {
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.get("0x0000000000000000000000000000000000000000");
    await ensureSolanaTradingSchema(db);
    await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run("tenant", "owner", JSON.stringify({ status: "pending" }));
    const actual = createSolanaAppRuntime({ db, env: {} });
    const agent = createSolanaAgent({ db, runtime: { ...actual, status: async scope => { seen.push(scope.owner); throw new Error("provider temporarily unavailable"); } },
      market: { readMint: async () => { throw new Error(); }, quote: async () => { throw new Error(); } } });
    assert.deepEqual(await agent.tick(), []); assert.deepEqual(seen, ["owner"]);
  } finally { raw.close(); }
});

test("process shutdown during an in-flight status or market read never admits a following trade", async t => {
  for (const stage of ["status", "quote"] as const) await t.test(stage, async () => {
    const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
    const tenant = "0x1111111111111111111111111111111111111111", owner = SOLANA_WRAPPED_SOL_MINT;
    const scope = { tenant, owner }, controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let armed = false, tradeCalls = 0;
    const pause = async () => { entered(); await resume; };
    const market: SolanaPaperMarket = {
      readMint: async mint => ({ address: mint,
        program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
      quote: async intent => {
        if (armed && stage === "quote") await pause();
        return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
          outAmount: intent.amountRaw, minOutAmount: (BigInt(intent.amountRaw) * 995n / 1000n).toString(),
          slippageBps: intent.slippageBps, contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
      },
    };
    const rpc = { read: async () => { throw new Error("No live RPC in a paper shutdown test"); }, send: async () => { throw new Error("Must never send"); } };
    try {
      const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
      await bindings.bind(tenant, "did:privy:shutdown", owner);
      await bindings.settings(tenant, owner, 0, "paper", limits);
      const actual = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });
      await actual.setupPaper(scope, { initialCashRaw: input.cashRaw, limits });
      // A real held position forces the worker through its valuation quote.
      if (stage === "quote") await actual.trade(scope, { mode: "paper", intent: {
        kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "initial-holding",
        inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000000", slippageBps: 50,
      } });
      const initialTrades = (await actual.status(scope)).paper!.trades.length;
      await bindings.strategy(tenant, owner, 1, strategy);
      const runtime: Pick<typeof actual, "status" | "trade"> = {
        status: async account => {
          const status = await actual.status(account);
          if (armed && stage === "status") await pause();
          return status;
        },
        trade: async (...args) => { tradeCalls++; return actual.trade(...args); },
      };
      armed = true;
      const tick = createSolanaAgent({ db, runtime, market, now: () => NOW, signal: controller.signal }).tick();
      await inFlight;
      assert.equal(tradeCalls, 0);
      controller.abort(); release();
      assert.deepEqual(await tick, []);
      assert.equal(tradeCalls, 0, "shutdown must stop at the agent boundary, before runtime admission");
      armed = false;
      assert.equal((await actual.status(scope)).paper!.trades.length, initialTrades);
      // The same persisted strategy is actionable when a new process is running.
      const restarted = createSolanaAgent({ db, runtime, market, now: () => NOW, signal: new AbortController().signal });
      assert.equal((await restarted.tick())[0]!.outcome, "submitted");
      assert.equal(tradeCalls, 1);
      assert.equal((await actual.status(scope)).paper!.trades.length, initialTrades + 1);
    } finally { release(); raw.close(); }
  });
});
