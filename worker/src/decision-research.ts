import { CASH } from "../../packages/core/src/index";
import { tradeFeeUsdg } from "./fees";
import type { TrencherConfig } from "./strategies/trencher";
import type { PoolFacts } from "./trencher-discovery";
import { FEE_TIERS, pickBestQuote, quotePath, quoteTier, type Quote } from "./venues/uniswap";
import type { Address, PublicClient } from "viem";

/** Operator opt-in for extra evidence, never an execution permission. */
export function decisionResearchEnabledFor(account: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const address = /^0x[0-9a-f]{40}$/i;
  if (!address.test(account) || /^0x0{40}$/i.test(account)) return false;
  return (env.MERRYMEN_DECISION_RESEARCH_ACCOUNTS ?? "").split(/[\s,]+/)
    .some(value => address.test(value) && value.toLowerCase() === account.toLowerCase());
}

/** Quote the existing strategy ceiling, including any smaller signed or early-entry bound. */
export function researchEntrySize(bounds: readonly bigint[]): bigint {
  const size = bounds.length ? bounds.reduce((a, b) => a < b ? a : b) : 0n;
  return size > 0n ? size : 0n;
}

export const DECISION_RESEARCH_GUIDANCE = "Before buying, explain the supplied evidence for demand, the strongest contrary evidence, what would invalidate the thesis, and why the expected move could cover a full entry and exit at the quoted size. An unavailable quote or cost is unknown, never zero. Historical outcomes are a small descriptive sample, not a calibrated probability or proof of future returns. Do not increase size, loosen limits or delay protective exits to recover a loss.";

type Route = { tokens: readonly Address[]; fees: readonly number[] };
type QuoteReader = (route: Route, amountIn: bigint) => Promise<Quote | null>;
const unavailable = "Entry and exit quote evidence unavailable; trading costs and exit liquidity have not been established by this read.";

type CostArgs = {
  client: PublicClient;
  token: Address;
  facts: PoolFacts | undefined;
  sizeUsdg: bigint;
  gasPerOperationUsdg: bigint | null;
  tradeFeeBps: number;
};
type CostDeps = { quote?: QuoteReader; now?: () => number; budgetMs?: number };

/**
 * The same research as `entryCostEvidence`, with the figures it printed: what
 * went in, what the reverse quote gave back and the total drag, micro-USDG.
 * `back` and `drag` are null whenever the text says unavailable or unknown —
 * the numbers can never say more than the sentence does.
 */
export type EntryCostResearch = { text: string; sizeUsdg: bigint; backUsdg: bigint | null; dragUsdg: bigint | null };

/**
 * Read-only quotes of a factory-verified v3 route and its reverse. Two independent
 * state reads are research, not a simulated round trip, approval, or guaranteed fill.
 * A slow lookup cannot block the tick or change a review after its deadline.
 */
export async function entryCostEvidence(args: CostArgs, deps: CostDeps = {}): Promise<string> {
  return (await entryCostResearch(args, deps)).text;
}

export async function entryCostResearch(args: CostArgs, deps: CostDeps = {}): Promise<EntryCostResearch> {
  const none = { text: unavailable, sizeUsdg: args.sizeUsdg, backUsdg: null, dragUsdg: null };
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + (deps.budgetMs ?? 5000);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { facts, token, sizeUsdg: size } = args;
  if (!facts || size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isInteger(facts.fee) || facts.fee < 0 || facts.fee >= 1_000_000 ||
      !Number.isInteger(args.tradeFeeBps) || args.tradeFeeBps < 0 || args.tradeFeeBps >= 10_000) return none;
  if (same(facts.token0, token) === same(facts.token1, token)) return none;
  const other = same(facts.token0, token) ? facts.token1 : facts.token0;
  const routes: Route[] = same(other, CASH.USDG)
    ? [{ tokens: [CASH.USDG, token], fees: [facts.fee] }]
    : same(other, CASH.WETH)
      ? FEE_TIERS.map(fee => ({ tokens: [CASH.USDG, CASH.WETH, token], fees: [fee, facts.fee] }))
      : [];
  if (!routes.length) return none;
  const read: QuoteReader = deps.quote ?? (async (route, amountIn) => route.tokens.length === 2
    ? quoteTier(args.client, { tokenIn: route.tokens[0]!, tokenOut: route.tokens[1]!, fee: route.fees[0]!, amountIn })
    : quotePath(args.client, { ...route, amountIn }));
  const safeRead: QuoteReader = async (route, amountIn) => {
    if (now() >= deadline) return null;
    try { return await read(route, amountIn); } catch { return null; }
  };
  const job = async (): Promise<EntryCostResearch> => {
    const quotes = await Promise.all(routes.map(route => safeRead(route, size)));
    const buy = pickBestQuote(quotes);
    if (!buy || now() >= deadline) return none;
    const route = routes[quotes.indexOf(buy)]!;
    const sell = await safeRead({ tokens: [...route.tokens].reverse(), fees: [...route.fees].reverse() }, buy.amountOut);
    if (!sell || sell.amountOut <= 0n || sell.amountOut > BigInt(Number.MAX_SAFE_INTEGER) || now() >= deadline) return none;
    const fee = tradeFeeUsdg(size, args.tradeFeeBps) + tradeFeeUsdg(sell.amountOut, args.tradeFeeBps);
    const gas = args.gasPerOperationUsdg !== null && args.gasPerOperationUsdg >= 0n
      ? args.gasPerOperationUsdg * 2n : null;
    const cash = (n: bigint) => (Number(n) / 1e6).toFixed(6);
    const drag = gas === null ? null : size - sell.amountOut + fee + gas;
    const text = `Entry/exit research at ${new Date(start).toISOString()}: ${cash(size)} USDG in; ` +
      `selling the quoted token output on the reverse v3 route quotes ${cash(sell.amountOut)} USDG back. ` +
      `Venue fees and price impact are already in those quotes. Estimated turnover fees for both legs: ${cash(fee)} USDG; ` +
      `gas for two operations: ${gas === null ? "unknown" : `${cash(gas)} USDG (estimate)`}. ` +
      (drag === null ? "Total round-trip drag is unknown. " : `Illustrative round-trip drag: ${cash(drag)} USDG (${(Number(drag) / Number(size) * 100).toFixed(2)}% of entry). `) +
      "Quotes use independent current-state reads, not a sequential transaction simulation. Excludes future price movement, additional slippage, first-deployment costs and account-level performance fees. This is cost evidence, not expected profit, a guaranteed exit, or permission to trade.";
    return { text, sizeUsdg: size, backUsdg: sell.amountOut, dragUsdg: drag };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job(), new Promise<EntryCostResearch>(resolve => {
      timer = setTimeout(() => resolve(none), Math.max(1, deadline - now()));
    })]);
  } catch { return none; }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * WHAT A ROUND TRIP COSTS AS A SHARE OF THE ENTRY, and the move that pays it.
 *
 * Quoted when the entry/exit research priced both legs and gas: the drag over
 * the entry, and the rise that turns the quoted exit back into entry plus
 * costs (drag over what the exit returned). Otherwise, when gas is known, a
 * FLOOR — gas for two operations and both turnover fees only, because venue
 * fees and price impact were not quoted. Otherwise unknown, and said so.
 */
export type BreakEven =
  | { basis: "quoted"; roundTripPct: number; movePct: number }
  | { basis: "gas-and-fees"; roundTripPct: number; movePct: number }
  | { basis: "unknown" };

export function trenchBreakEven(
  cost: Pick<EntryCostResearch, "sizeUsdg" | "backUsdg" | "dragUsdg"> | null,
  fallback: { sizeUsdg: bigint; gasPerOperationUsdg: bigint | null; tradeFeeBps: number },
): BreakEven {
  const pct = (n: bigint, d: bigint) => Number(n) / Number(d) * 100;
  if (cost && cost.sizeUsdg > 0n && cost.backUsdg !== null && cost.backUsdg > 0n && cost.dragUsdg !== null) {
    return { basis: "quoted", roundTripPct: pct(cost.dragUsdg, cost.sizeUsdg), movePct: pct(cost.dragUsdg, cost.backUsdg) };
  }
  const { sizeUsdg: size, gasPerOperationUsdg: gas, tradeFeeBps: bps } = fallback;
  if (size > 0n && gas !== null && gas >= 0n && Number.isInteger(bps) && bps >= 0 && bps < 10_000) {
    const floor = pct(gas * 2n + tradeFeeUsdg(size, bps) * 2n, size);
    return { basis: "gas-and-fees", roundTripPct: floor, movePct: floor };
  }
  return { basis: "unknown" };
}

/**
 * THE TRENCHER'S OWN TERMS, PUT TO THE BRAIN — for research-enabled accounts,
 * entry reviews only (index.ts appends it to the strategy brief, which every
 * analyst and the manager read).
 *
 * WHY. The Brain was asked to judge a minutes-long momentum entry with no
 * horizon, no exit plan and no cost line, told not to invent an expected
 * return, and then made to state one (`expected_edge_usdg`). HOLD was the
 * only answer that did not require a number from nowhere. This gives it the
 * number's ingredients instead: the mechanical exits (read from the strategy
 * config, never restated by hand), the round-trip cost and the move that pays
 * it, the bracket arithmetic that turns odds into edge, and what continuation
 * and distribution look like over minutes.
 *
 * WHAT IT DOES NOT DO. It changes no cap, floor, guard, gate or exit; the
 * persona's disqualifiers and every check after the review are untouched,
 * and it says so. It does not tell the model to buy: the odds are its call.
 */
export function trenchMomentumBrief(
  cfg: Pick<TrencherConfig, "stopLossBps" | "takeProfitBps" | "maxHoldSec" | "liquidityDrainFraction">,
  be: BreakEven,
  entryUsdg: bigint,
): string {
  const stop = cfg.stopLossBps / 100, take = cfg.takeProfitBps / 100;
  const minutes = Math.round(cfg.maxHoldSec / 60);
  const drain = Math.round((1 - cfg.liquidityDrainFraction) * 100);
  // Fixed decimals with trailing zeros dropped: 10, 3.29, 44 — never "1" for 10.
  const n = (v: number, dp: number) => {
    const s = v.toFixed(dp);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  const entry = (Number(entryUsdg) / 1e6).toFixed(2);
  const cost = be.basis === "quoted"
    ? `A round trip at the ${entry} USDG entry costs about ${n(be.roundTripPct, 2)}% (quoted entry and exit, gas and fees), so price must rise about ${n(be.movePct, 2)}% to break even.`
    : be.basis === "gas-and-fees"
      ? `A round trip at the ${entry} USDG entry costs at least ${n(be.roundTripPct, 2)}% (gas and fees only; venue fee and price impact were not quoted), so price must rise more than that to break even.`
      : "The round-trip cost could not be priced; treat a marginal setup as insufficient.";
  const c = be.basis === "unknown" ? null : be.roundTripPct;
  const odds = c === null
    ? `positive only when P is clearly above ${n(stop * 100 / (take + stop), 0)}% plus the unknown cost`
    : `positive only when P is above about ${n((stop + c) * 100 / (take + stop), 0)}%`;
  return `MOMENTUM ENTRY PLAN. Horizon: minutes, not days; a position lives at most ${minutes} minutes. ` +
    `Exits are mechanical, checked each tick (fills can overshoot): stop at -${n(stop, 1)}% from entry, ` +
    `take profit at +${n(take, 1)}%, close at ${minutes} minutes whatever the price, and early if ${drain}% of entry liquidity drains. ` +
    `${cost} ` +
    `Judge the setup against these brackets instead of inventing a target. With P your odds of +${n(take, 1)}% before -${n(stop, 1)}%, ` +
    `edge per entry is about P x (${n(take, 1)} - cost)% - (1 - P) x (${n(stop, 1)} + cost)%, ${odds}; the time stop usually exits near flat, less cost. ` +
    "Reason P from flow; state that edge at the entry size as expected_edge_usdg (a bracket estimate, not an invented return). " +
    "Continuation: distinct buyers and buy share rising from 1h to 5m, higher 5-minute lows, volume expanding with price, liquidity holding. " +
    "Distribution: sellers dominating recent windows or one wallet doing most selling, lower highs, liquidity draining, or overextension after a vertical spike. " +
    "Missing news, fundamentals or social-media data is not by itself a reason to hold for this strategy; the decision rests on flow, liquidity, cost and the exit plan. " +
    "Every disqualifier, limit and check above still applies.";
}
