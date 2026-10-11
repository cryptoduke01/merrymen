import { CASH } from "../../packages/core/src/index";
import { tradeFeeUsdg } from "./fees";
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

/**
 * Read-only quotes of a factory-verified v3 route and its reverse. Two independent
 * state reads are research, not a simulated round trip, approval, or guaranteed fill.
 * A slow lookup cannot block the tick or change a review after its deadline.
 */
export async function entryCostEvidence(args: {
  client: PublicClient;
  token: Address;
  facts: PoolFacts | undefined;
  sizeUsdg: bigint;
  gasPerOperationUsdg: bigint | null;
  tradeFeeBps: number;
}, deps: { quote?: QuoteReader; now?: () => number; budgetMs?: number } = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + (deps.budgetMs ?? 5000);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { facts, token, sizeUsdg: size } = args;
  if (!facts || size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isInteger(facts.fee) || facts.fee < 0 || facts.fee >= 1_000_000 ||
      !Number.isInteger(args.tradeFeeBps) || args.tradeFeeBps < 0 || args.tradeFeeBps >= 10_000) return unavailable;
  if (same(facts.token0, token) === same(facts.token1, token)) return unavailable;
  const other = same(facts.token0, token) ? facts.token1 : facts.token0;
  const routes: Route[] = same(other, CASH.USDG)
    ? [{ tokens: [CASH.USDG, token], fees: [facts.fee] }]
    : same(other, CASH.WETH)
      ? FEE_TIERS.map(fee => ({ tokens: [CASH.USDG, CASH.WETH, token], fees: [fee, facts.fee] }))
      : [];
  if (!routes.length) return unavailable;
  const read: QuoteReader = deps.quote ?? (async (route, amountIn) => route.tokens.length === 2
    ? quoteTier(args.client, { tokenIn: route.tokens[0]!, tokenOut: route.tokens[1]!, fee: route.fees[0]!, amountIn })
    : quotePath(args.client, { ...route, amountIn }));
  const safeRead: QuoteReader = async (route, amountIn) => {
    if (now() >= deadline) return null;
    try { return await read(route, amountIn); } catch { return null; }
  };
  const job = async (): Promise<string> => {
    const quotes = await Promise.all(routes.map(route => safeRead(route, size)));
    const buy = pickBestQuote(quotes);
    if (!buy || now() >= deadline) return unavailable;
    const route = routes[quotes.indexOf(buy)]!;
    const sell = await safeRead({ tokens: [...route.tokens].reverse(), fees: [...route.fees].reverse() }, buy.amountOut);
    if (!sell || sell.amountOut <= 0n || sell.amountOut > BigInt(Number.MAX_SAFE_INTEGER) || now() >= deadline) return unavailable;
    const fee = tradeFeeUsdg(size, args.tradeFeeBps) + tradeFeeUsdg(sell.amountOut, args.tradeFeeBps);
    const gas = args.gasPerOperationUsdg !== null && args.gasPerOperationUsdg >= 0n
      ? args.gasPerOperationUsdg * 2n : null;
    const cash = (n: bigint) => (Number(n) / 1e6).toFixed(6);
    const drag = gas === null ? null : size - sell.amountOut + fee + gas;
    return `Entry/exit research at ${new Date(start).toISOString()}: ${cash(size)} USDG in; ` +
      `selling the quoted token output on the reverse v3 route quotes ${cash(sell.amountOut)} USDG back. ` +
      `Venue fees and price impact are already in those quotes. Estimated turnover fees for both legs: ${cash(fee)} USDG; ` +
      `gas for two operations: ${gas === null ? "unknown" : `${cash(gas)} USDG (estimate)`}. ` +
      (drag === null ? "Total round-trip drag is unknown. " : `Illustrative round-trip drag: ${cash(drag)} USDG (${(Number(drag) / Number(size) * 100).toFixed(2)}% of entry). `) +
      "Quotes use independent current-state reads, not a sequential transaction simulation. Excludes future price movement, additional slippage, first-deployment costs and account-level performance fees. This is cost evidence, not expected profit, a guaranteed exit, or permission to trade.";
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job(), new Promise<string>(resolve => {
      timer = setTimeout(() => resolve(unavailable), Math.max(1, deadline - now()));
    })]);
  } catch { return unavailable; }
  finally { if (timer) clearTimeout(timer); }
}
