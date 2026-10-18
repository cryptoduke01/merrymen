import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Encode } from "../../packages/core/src/ids";
import type { SolanaMint, SolanaQuote, SolanaSwapIntent } from "../../packages/core/src/solana";
import { SolanaPaperStore } from "./solana-paper-store";
import { createSolanaPaperService, type SolanaPaperMarket } from "./solana-paper-service";
import { paperUsdgRaw, runSolanaPaperCommand } from "./solana-paper-command";

const OWNER = base58Encode(new Uint8Array(32).fill(7));
const OTHER = base58Encode(new Uint8Array(32).fill(8));
const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NOW = 1_790_000_000_000;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function harness() {
  const home = mkdtempSync(path.join(tmpdir(), "solana-paper-service-"));
  const file = path.join(home, "paper.sqlite");
  const clock = { value: NOW };
  const store = new SolanaPaperStore(file, { now: () => clock.value });
  cleanup.push(() => { try { store.close(); } catch {} rmSync(home, { recursive: true, force: true }); });
  const calls: SolanaSwapIntent[] = [];
  const limits = { perTradeUsdg: "25000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 1000, expiresAtMs: NOW + 86_400_000 };
  const mint = (address: string): SolanaMint => ({
    address, program: address === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    decimals: address === SOLANA_USDG_MINT ? 6 : 9, slot: 100, observedAtMs: clock.value, buyBlockedReasons: [],
  });
  const quote = (intent: SolanaSwapIntent): SolanaQuote => {
    const amount = BigInt(intent.amountRaw);
    const out = intent.inputMint === SOLANA_USDG_MINT ? amount * 10n : amount / 10n;
    return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint,
      inAmount: intent.amountRaw, outAmount: out.toString(), minOutAmount: (out * 99n / 100n).toString(),
      slippageBps: 100, contextSlot: 100, quotedAtMs: clock.value, expiresAtMs: clock.value + 30_000 };
  };
  const market: SolanaPaperMarket = {
    readMint: async (address) => mint(address),
    quote: async (intent) => { calls.push(intent); return quote(intent); },
  };
  const intent = (requestId = "buy-1", change: Partial<SolanaSwapIntent> = {}): SolanaSwapIntent => ({
    kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId,
    inputMint: SOLANA_USDG_MINT, outputMint: SOL, amountRaw: "1000000", slippageBps: 100, ...change,
  });
  const service = createSolanaPaperService(store, market, () => clock.value);
  store.create(OWNER, "1000000000", limits, clock.value);
  return { store, file, clock, calls, limits, market, mint, quote, intent, service };
}

describe("Solana paper service", () => {
  it("buys and fully exits through the market/ledger boundary with durable receipts", async () => {
    const h = harness();
    const buy = await h.service.trade(OWNER, h.intent());
    assert.equal(buy.execution, "simulated");
    assert.equal(buy.excludesNetworkFeesAndRent, true);
    assert.deepEqual(h.calls.map((c) => c.inputMint), [SOLANA_USDG_MINT, SOL], "entry checks an exit route");
    const sell = h.intent("sell-1", { inputMint: SOL, outputMint: SOLANA_USDG_MINT, amountRaw: buy.outputAmountRaw });
    await h.service.trade(OWNER, sell);
    assert.equal(h.store.get(OWNER)!.positions.length, 0);
    assert.equal(h.store.get(OWNER)!.cashRaw, "999980100");
    assert.equal(h.store.get(OWNER)!.realizedPnlRaw, "-19900");
    assert.equal(h.store.get(OWNER)!.trades.length, 2);
  });

  it("returns a committed trade after restart and expiry with every provider unavailable", async () => {
    const h = harness();
    const original = await h.service.trade(OWNER, h.intent());
    const reopened = new SolanaPaperStore(h.file, { now: () => NOW + 2 * 86_400_000 });
    try {
      const unavailable = { readMint: async () => { throw new Error("must not call RPC"); }, quote: async () => { throw new Error("must not quote"); } };
      const retry = createSolanaPaperService(reopened, unavailable, () => NOW + 2 * 86_400_000);
      assert.deepEqual(await retry.trade(OWNER, h.intent()), original);
      await assert.rejects(retry.trade(OWNER, h.intent("buy-1", { amountRaw: "2000000" })), /different paper trade/);
      assert.equal(reopened.get(OWNER)!.trades.length, 1);
    } finally { reopened.close(); }
  });

  it("does not treat one owner's request as another owner's receipt", async () => {
    const h = harness();
    await h.service.trade(OWNER, h.intent());
    await assert.rejects(h.service.trade(OTHER, h.intent()), /Create the Solana paper book/);
    assert.equal(h.store.get(OTHER), null);
  });

  it("refuses unsafe new exposure but permits selling a held mint with buy restrictions", async () => {
    const h = harness();
    h.market.readMint = async (address) => ({ ...h.mint(address), buyBlockedReasons: address === SOL ? ["freeze-authority"] : [] });
    await assert.rejects(h.service.trade(OWNER, h.intent()), /token safety/);
    assert.equal(h.store.get(OWNER)!.version, 0);
    h.market.readMint = async (address) => h.mint(address);
    const buy = await h.service.trade(OWNER, h.intent());
    h.market.readMint = async (address) => ({ ...h.mint(address), buyBlockedReasons: ["transfer-hook"] });
    await h.service.trade(OWNER, h.intent("sell-1", { inputMint: SOL, outputMint: SOLANA_USDG_MINT, amountRaw: buy.outputAmountRaw }));
    assert.equal(h.store.get(OWNER)!.positions.length, 0);
  });

  it("holds buys when issuer cash extensions change or mint identity/decimals disagree", async () => {
    for (const change of [
      { buyBlockedReasons: ["transfer-fee"] }, { decimals: 9 }, { program: TOKEN_PROGRAM },
      { address: SOL }, { observedAtMs: NOW - 30_000 }, { observedAtMs: NOW + 1 },
    ]) {
      const h = harness();
      h.market.readMint = async (address) => ({ ...h.mint(address), ...(address === SOLANA_USDG_MINT ? change : {}) });
      await assert.rejects(h.service.trade(OWNER, h.intent()));
      assert.equal(h.store.get(OWNER)!.version, 0);
    }
  });

  it("refuses a one-way buy and leaves no partial fill when the exit quote is absent", async () => {
    const h = harness();
    h.market.quote = async (intent) => {
      if (intent.inputMint !== SOLANA_USDG_MINT) throw new Error("No exit route");
      return h.quote(intent);
    };
    await assert.rejects(h.service.trade(OWNER, h.intent()), /No exit route/);
    assert.equal(h.store.get(OWNER)!.version, 0);
  });

  it("requires marks before new exposure, while a sell does not query unrelated positions", async () => {
    const h = harness();
    const buy = await h.service.trade(OWNER, h.intent());
    h.calls.length = 0;
    await h.service.trade(OWNER, h.intent("buy-2"));
    assert.ok(h.calls.some((c) => c.requestId.startsWith("mark-") && c.amountRaw === buy.outputAmountRaw));
    h.calls.length = 0;
    await h.service.trade(OWNER, h.intent("sell-1", { inputMint: SOL, outputMint: SOLANA_USDG_MINT, amountRaw: buy.outputAmountRaw }));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.requestId, "sell-1");
  });

  it("rechecks mint age after slow quote preparation", async () => {
    const h = harness();
    h.market.quote = async (intent) => { h.clock.value += 16_000; return h.quote(intent); };
    await assert.rejects(h.service.trade(OWNER, h.intent()), /mint evidence/);
    assert.equal(h.store.get(OWNER)!.version, 0);
  });

  it("rechecks the exit quote after portfolio preparation takes longer than its expiry", async () => {
    const h = harness();
    await h.service.trade(OWNER, h.intent());
    const before = h.store.get(OWNER);
    h.market.quote = async (intent) => {
      if (intent.requestId === "entry-exit-check") return { ...h.quote(intent), expiresAtMs: h.clock.value + 1000 };
      if (intent.requestId.startsWith("mark-")) h.clock.value += 1001;
      return h.quote(intent);
    };
    await assert.rejects(h.service.trade(OWNER, h.intent("buy-2")), /quote is stale/);
    assert.deepEqual(h.store.get(OWNER), before);
  });

  it("rejects live mode, unsafe slippage and quote tampering before any write", async () => {
    const h = harness();
    await assert.rejects(h.service.trade(OWNER, { ...h.intent(), mode: "live" }));
    await assert.rejects(h.service.trade(OWNER, h.intent("buy-1", { slippageBps: 101 })));
    assert.equal(h.calls.length, 0);
    h.market.quote = async (intent) => ({ ...h.quote(intent), inAmount: "2000000" });
    await assert.rejects(h.service.trade(OWNER, h.intent()));
    assert.equal(h.store.get(OWNER)!.version, 0);
  });

  it("previews never alter balances and hosted mode never reaches a provider", async () => {
    const h = harness();
    await h.service.preview(OWNER, h.intent());
    assert.equal(h.store.get(OWNER)!.version, 0);
    const saved = process.env.MERRYMEN_HOSTED;
    process.env.MERRYMEN_HOSTED = "true";
    try {
      h.market.readMint = async () => { assert.fail("RPC must not be called"); };
      await assert.rejects(h.service.trade(OWNER, h.intent()), /local-only/);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_HOSTED; else process.env.MERRYMEN_HOSTED = saved;
    }
  });
});

describe("Solana paper command", () => {
  it("parses display amounts without floating-point rounding", () => {
    assert.equal(paperUsdgRaw("9007199254.740993"), "9007199254740993");
    assert.equal(paperUsdgRaw("0.000001"), "1");
    for (const value of ["1e2", "0", "-1", "1.0000001", "01", "1 ", "NaN"]) assert.throws(() => paperUsdgRaw(value));
  });

  it("rejects unknown/live/duplicate/missing options before opening any database", async () => {
    let opens = 0;
    const deps = { openStore: () => { opens++; throw new Error("should not open"); } };
    for (const args of [
      ["trade", "--owner", OWNER, "--live", "true"], ["status", "--owner", OWNER, "--owner", OTHER],
      ["status", "--owner"], ["trade", "--owner", OWNER], ["init", "--owner", OWNER, "--expires-days", "0"],
    ]) await assert.rejects(runSolanaPaperCommand(args, deps));
    assert.equal(opens, 0);
  });

  it("initializes, reads and retries offline without ever constructing a market client", async () => {
    const h = harness();
    const receipt = await h.service.trade(OWNER, h.intent());
    const deps = { openStore: () => new SolanaPaperStore(h.file, { now: () => NOW }), market: (): SolanaPaperMarket => { assert.fail("market configuration not needed"); }, now: () => NOW };
    const initial = await runSolanaPaperCommand(["init", "--owner", OTHER], deps) as { mode: string; cashRaw: string };
    assert.equal(initial.mode, "paper");
    assert.equal(initial.cashRaw, "1000000000");
    await assert.rejects(runSolanaPaperCommand(["init", "--owner", OTHER], deps), /already exists/);
    const status = await runSolanaPaperCommand(["status", "--owner", OWNER], deps) as { version: number };
    assert.equal(status.version, 1);
    const retry = await runSolanaPaperCommand(["trade", "--owner", OWNER, "--input", SOLANA_USDG_MINT,
      "--output", SOL, "--amount-raw", "1000000", "--request-id", "buy-1"], deps);
    assert.deepEqual(retry, receipt);
  });

  it("help has no filesystem or provider effects and explains omitted execution costs", async () => {
    const text = await runSolanaPaperCommand(["--help"], { openStore: () => { assert.fail(); } });
    assert.match(String(text), /network fees and rent are excluded/i);
  });
});
