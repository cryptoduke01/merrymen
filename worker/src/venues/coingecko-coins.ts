/**
 * COINS BY NAME OR TICKER, FROM COINGECKO'S MAIN API — what an active agent
 * reads when someone tags it about bitcoin, eth or $SOL (docs/x-posting.md
 * "Research for answers"). Three reads, each on the fleet's CoinGecko Pro lane
 * (geckoterminal.ts cachedCoinGecko: the spacing slot, cooldown, plan latch,
 * monthly credit ceiling and a minute's cache per page):
 *
 *   /search?query=…            which coins go by that name or ticker
 *   /coins/markets?ids=…       one coin's rank, price, market cap, volume, 24h and 7d change
 *   /search/trending           CoinGecko's own trending list
 *
 * A MAJOR IS AN EXACT MATCH THAT RANKS. `pickMajor` takes a coin only when its
 * symbol or its name is exactly what was asked, case aside, and its market-cap
 * rank is at most MAJORS_MAX_RANK; between several, the best rank. "BTC2",
 * "Bitcoin Inu", an unranked token or one at #900 is no major, whatever it is
 * called, and gets no figures.
 *
 * NOTHING HERE DECIDES A TRADE. These coins are not Robinhood Chain tokens;
 * nothing read here is nominated, written where a trading decision reads, or
 * shown as anything but what CoinGecko listed. Provider text never leaves:
 * a coin's id is a lookup key, and only its symbol, through the figures
 * line's own sanitiser (xpost/figures.ts cleanTicker), is ever shown.
 */
import { readBoundedJson } from "../bounded-read";
import type { FeedResult } from "./fleet-feed-cache";
import { cachedCoinGecko, geckoRefusal, type GeckoLane } from "./geckoterminal";

/** The worst market-cap rank a coin may hold and still be answered as a major. */
export const MAJORS_MAX_RANK = 200;

/** One coin a search found: a lookup key, its symbol and name as listed, its rank (null: unranked). */
export interface CoinHit {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
}

/** One coin's market, USD. Every figure null when CoinGecko left it out; never a silent zero. */
export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
}

export interface CoinSearchRead extends FeedResult { hits: CoinHit[] }
export interface CoinMarketRead extends FeedResult { market: CoinMarket | null }
export interface CoinTrendingRead extends FeedResult { coins: CoinHit[] }

/** A lookup key as CoinGecko writes one ("bitcoin", "shiba-inu", "the-open-network"), and nothing else. */
const COIN_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * WHAT MAY BE SEARCHED FOR: one to three words of letters and digits, a
 * cashtag's $ off, lowercase, at most forty characters. Anything else is
 * null and nothing is asked: a question's other words never reach the URL.
 */
export function coinQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().replace(/^\$/, "").replace(/\s+/g, " ").toLowerCase();
  return /^[a-z0-9]+(?: [a-z0-9]+){0,2}$/.test(q) && q.length <= 40 ? q : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rankOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** A hit as the search lists it, or null: an id that is a lookup key, and a symbol and a name that are strings. */
function hitOf(raw: unknown): CoinHit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !COIN_ID.test(r.id) || typeof r.symbol !== "string" || typeof r.name !== "string") return null;
  return { id: r.id, symbol: r.symbol.slice(0, 32), name: r.name.slice(0, 80), rank: rankOf(r.market_cap_rank) };
}

/** /search's coins, at most fifty; a body of any other shape is none. */
export function parseCoinSearch(body: unknown): CoinHit[] {
  const coins = (body as { coins?: unknown } | null)?.coins;
  return Array.isArray(coins) ? coins.slice(0, 50).map(hitOf).filter((h): h is CoinHit => h !== null) : [];
}

/** /search/trending's coins, in its order, at most fifteen. */
export function parseCoinTrending(body: unknown): CoinHit[] {
  const coins = (body as { coins?: unknown } | null)?.coins;
  return Array.isArray(coins) ? coins.slice(0, 15).map((c) => hitOf((c as { item?: unknown } | null)?.item)).filter((h): h is CoinHit => h !== null) : [];
}

/** /coins/markets' row for exactly this id, or null: another coin's row is never this one's. */
export function parseCoinMarket(body: unknown, id: string): CoinMarket | null {
  if (!Array.isArray(body)) return null;
  const row = body.find((r) => (r as { id?: unknown } | null)?.id === id) as Record<string, unknown> | undefined;
  const hit = hitOf(row);
  if (!row || !hit) return null;
  return {
    ...hit,
    priceUsd: finite(row.current_price),
    marketCapUsd: finite(row.market_cap),
    volume24hUsd: finite(row.total_volume),
    change24hPct: finite(row.price_change_percentage_24h_in_currency) ?? finite(row.price_change_percentage_24h),
    change7dPct: finite(row.price_change_percentage_7d_in_currency),
  };
}

/**
 * THE MAJOR A QUESTION NAMED, OR NONE: a hit whose symbol or name is exactly
 * the query (case aside, a cashtag's $ off), ranked at most `maxRank`; the
 * best rank among several. Never a near match.
 */
export function pickMajor(query: string, hits: readonly CoinHit[], maxRank = MAJORS_MAX_RANK): CoinHit | null {
  const q = coinQuery(query);
  if (!q) return null;
  const exact = hits.filter((h) => h.rank !== null && h.rank <= maxRank && (h.symbol.toLowerCase() === q || h.name.toLowerCase() === q));
  return exact.sort((a, b) => a.rank! - b.rank!)[0] ?? null;
}

type Raw = { ok: true; body: unknown; observedAt: number } | { ok: false; failure: string; retryAfterMs?: number };

/** One GET on the main API's fixed origin: the key in a header, no redirect, a bounded body, a safe failure code. */
async function getMain(base: string, headers: Readonly<Record<string, string>>, route: string, timeoutMs: number): Promise<Raw> {
  const observedAt = Date.now();
  try {
    const res = await fetch(`${base}${route}`, { headers: { ...headers }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!res.ok) return { ok: false, ...await geckoRefusal(res) };
    const read = await readBoundedJson(res);
    return read.ok ? { ok: true, body: read.value, observedAt } : { ok: false, failure: "invalid-body" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export interface CoinReadOptions {
  /** The whole read's budget, slot wait included: past it the read is skipped, never waited on. */
  timeoutMs: number;
  /** The fleet lane, named by a reader in the orchestrator (geckoterminal.ts GeckoLane). */
  fleet?: GeckoLane;
}

/** Someone is waiting on an answer: the evidence row, priority and never extra quota (fleet-feed-cache.ts FeedLane). */
const LANE = "evidence" as const;

/** Which coins go by this name or ticker. A query that is not one (coinQuery) asks nothing. */
export async function searchCoinList(query: string, o: CoinReadOptions): Promise<CoinSearchRead> {
  const q = coinQuery(query);
  if (!q) return { hits: [], failed: true, failure: "invalid-query" };
  const route = `/search?query=${encodeURIComponent(q)}`;
  return cachedCoinGecko<CoinSearchRead>(`search:${q}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    return r.ok ? { hits: parseCoinSearch(r.body), failed: false, observedAt: r.observedAt } : { hits: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
  }, (failure) => ({ hits: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/** One coin's market, by its lookup key. A key that is not one asks nothing. */
export async function readCoinMarket(id: string, o: CoinReadOptions): Promise<CoinMarketRead> {
  if (typeof id !== "string" || !COIN_ID.test(id)) return { market: null, failed: true, failure: "invalid-id" };
  const route = `/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h,7d`;
  return cachedCoinGecko<CoinMarketRead>(`markets:${id}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    if (!r.ok) return { market: null, failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    const market = parseCoinMarket(r.body, id);
    return market ? { market, failed: false, observedAt: r.observedAt } : { market: null, failed: true, failure: "invalid-shape" };
  }, (failure) => ({ market: null, failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/** CoinGecko's trending coins, in its order. */
export async function readCoinTrending(o: CoinReadOptions): Promise<CoinTrendingRead> {
  const route = "/search/trending";
  return cachedCoinGecko<CoinTrendingRead>("trending", async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    return r.ok ? { coins: parseCoinTrending(r.body), failed: false, observedAt: r.observedAt } : { coins: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
  }, (failure) => ({ coins: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}
