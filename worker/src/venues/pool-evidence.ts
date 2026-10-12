import { cachedGeckoDetail, geckoSource, GECKO_NETWORK } from './geckoterminal';
import { readBoundedJson } from '../bounded-read';
import type { FeedResult } from './fleet-feed-cache';

/**
 * `wallet` is the transaction's sender as the index reports it, lowercased —
 * counted for DISTINCT wallets and never passed on as an address. Null when
 * the index gave none; optional so a trade built before it existed still is one.
 */
export type MarketTrade = { id: string; tx: string; time: number; side: 'buy' | 'sell'; usd: number | null; priceUsd: number | null; wallet?: string | null };
/** `volume` is the bar's USD volume as the index reports it; null when it gave none, never 0. */
export type PriceBar = { time: number; open: number; high: number; low: number; close: number; volume?: number | null };
export type EvidenceRead<T> = FeedResult & { data: T[] };
export type PoolEvidence = { poolId: string; token: string; candles: EvidenceRead<PriceBar>; trades: EvidenceRead<MarketTrade> };
const number = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
};
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v as Record<string, any> : {};

/** Direction comes from token addresses, never the pool's default base side. */
export function parseTrades(body: unknown, token: string, now = Date.now()): MarketTrade[] | null {
  const rows = object(body).data;
  if (!Array.isArray(rows)) return null;
  const seen = new Set<string>();
  return rows.flatMap(row => {
    const a = object(object(row).attributes), id = object(row).id;
    const time = Date.parse(a.block_timestamp) / 1000;
    const from = typeof a.from_token_address === 'string' ? a.from_token_address.toLowerCase() : '';
    const to = typeof a.to_token_address === 'string' ? a.to_token_address.toLowerCase() : '';
    const target = token.toLowerCase();
    if (typeof id !== 'string' || seen.has(id) || !/^0x[\da-f]{64}$/i.test(a.tx_hash ?? '') ||
      !Number.isFinite(time) || time <= 0 || time > now / 1000 + 30 || time < now / 1000 - 86400 ||
      (from === target) === (to === target)) return [];
    seen.add(id);
    const side = to === target ? 'buy' as const : 'sell' as const;
    const wallet = typeof a.tx_from_address === 'string' && /^0x[\da-f]{40}$/i.test(a.tx_from_address) ? a.tx_from_address.toLowerCase() : null;
    return [{ id, tx: a.tx_hash, time, side, usd: number(a.volume_in_usd), priceUsd: number(side === 'buy' ? a.price_to_in_usd : a.price_from_in_usd), wallet }];
  }).sort((a, b) => b.time - a.time).slice(0, TRADE_SAMPLE_MAX);
}

/** The index returns at most this many of a pool's latest trades; a full sample may not reach back a whole window. */
export const TRADE_SAMPLE_MAX = 300;

export function parsePriceBars(body: unknown, token: string, now = Date.now()): PriceBar[] | null {
  const j = object(body), rows = object(object(j.data).attributes).ohlcv_list;
  if (!Array.isArray(rows) || object(object(j.meta).base).address?.toLowerCase() !== token.toLowerCase()) return null;
  const bars = new Map<number, PriceBar>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(number);
    if (!time || !open || !high || !low || !close || time % 300 !== 0 || time + 300 > now / 1000 ||
      low > Math.min(open, close) || high < Math.max(open, close) || high < low) continue;
    bars.set(time, { time, open, high, low, close, volume: volume ?? null });
  }
  return [...bars.values()].sort((a, b) => a.time - b.time).slice(-24);
}

const memo = new Map<string, { until: number; value: EvidenceRead<any> }>();
const pending = new Map<string, Promise<EvidenceRead<any>>>();
async function read<T>(key: string, route: string, parse: (body: unknown) => T[] | null): Promise<EvidenceRead<T>> {
  const source = geckoSource(), cacheKey = `${source.id}:${key}`;
  const cached = memo.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.value;
  if (pending.has(cacheKey)) return pending.get(cacheKey)!;
  const unavailable = (failure: string): EvidenceRead<T> => ({ failed: true, failure, data: [] });
  const job = cachedGeckoDetail(key, async (source, remainingMs) => {
    const observedAt = Date.now();
    try {
      const res = await fetch(`${source.base}/networks/${GECKO_NETWORK}/pools/${route}`, {
        headers: source.headers, redirect: 'error', signal: AbortSignal.timeout(Math.min(5000, remainingMs)),
      });
      if (!res.ok) {
        const retry = res.headers.get('retry-after');
        const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry ?? '') - Date.now();
        await res.body?.cancel().catch(() => {});
        return { ...unavailable(`http-${res.status}`), retryAfterMs: Number.isFinite(ms) ? Math.max(0, ms) : 0 };
      }
      const json = await readBoundedJson(res);
      const data = json.ok ? parse(json.value) : null;
      return data === null ? unavailable('invalid-body') : { failed: false, observedAt, data };
    } catch { return unavailable('unavailable'); }
  }, unavailable).then(value => {
    if (memo.size >= 256) memo.delete(memo.keys().next().value!);
    memo.set(cacheKey, { until: value.failed ? Date.now() + 5000 : (value.observedAt ?? 0) + 60000, value });
    return value;
  }).finally(() => pending.delete(cacheKey));
  pending.set(cacheKey, job);
  return job;
}

/**
 * EACH LEG GETS ITS OWN CLOCK.
 *
 * ── WHY THE PAIR MUST NOT SHARE ONE DEADLINE ─────────────────────────────
 *
 * These two reads were joined with `Promise.all` and the caller raced the
 * single combined promise against one timer. `Promise.all` settles only when
 * BOTH legs settle, so a candle set that arrived in a second was thrown away
 * whenever the trade leg was slow — and the caller, holding only a nullable
 * object, could not tell which leg had missed or even that one had made it.
 *
 * That is not a rare interleaving. The two legs use different cache keys, so
 * they cannot share a fleet pacing slot (`fleet-feed-cache.ts`, 3s spacing on
 * one row shared by every tenant): on a completely idle gate the second leg
 * cannot BEGIN before ~3s, leaving under 2s of a 5s budget for its round trip.
 * One other request queued ahead and the miss is certain. Measured on the
 * fleet 2026-09-20: 29% of Trencher Brain reviews were handed no evidence at
 * all, and because the caller's log drove both halves off the same nullable,
 * every one of them printed `candles=budget trades=budget` — a line that
 * cannot distinguish "both legs missed" from "one did".
 *
 * So the budget is applied PER LEG, here, where the two are still separate. A
 * late leg degrades to a `budget` failure and the other leg's real data
 * survives. `summarizeEvidence` already models exactly this — independent
 * freshness gates and independent failure fields — so nothing downstream had
 * to change to accept it.
 *
 * ── AND WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It issues no additional requests and shortens no timeout, so the provider
 * quota is untouched. Abandoning a leg does not cancel it: the underlying
 * fetch runs on and fills the memo, so the request already paid for warms the
 * next review rather than being wasted. And a leg that misses its budget is
 * recorded as FAILED, never as empty — `observedAt` stays unset, so nothing
 * downstream can mistake it for a reading of no activity.
 */
export const EVIDENCE_BUDGET_MS = 5000;

/**
 * The two reads, injectable.
 *
 * The race had no seam at all, so the one behaviour that matters here — what
 * happens when ONE leg is late — could not be tested, and it shipped wrong.
 * Production passes nothing and gets the real reads.
 */
export interface EvidenceLegs {
  candles: () => Promise<EvidenceRead<PriceBar>>;
  trades: () => Promise<EvidenceRead<MarketTrade>>;
}

export async function readPoolEvidence(
  poolId: string,
  token: string,
  budgetMs = EVIDENCE_BUDGET_MS,
  legs?: EvidenceLegs,
): Promise<PoolEvidence> {
  if (!/^0x([\da-f]{40}|[\da-f]{64})$/i.test(poolId) || !/^0x[\da-f]{40}$/i.test(token)) throw new Error('Invalid market identity');
  poolId = poolId.toLowerCase(); token = token.toLowerCase();
  const within = async <T>(p: Promise<EvidenceRead<T>>): Promise<EvidenceRead<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `failed: true` with no `observedAt` — a budget miss is an absence of
    // evidence, and must never read as evidence of absence.
    const missed: EvidenceRead<T> = { failed: true, failure: 'budget', data: [] };
    try {
      return await Promise.race([
        p.catch(() => missed),
        new Promise<EvidenceRead<T>>(resolve => { timer = setTimeout(() => resolve(missed), budgetMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const candleLeg = legs
    ? legs.candles()
    : read(`${poolId}:${token}:5m`, `${poolId}/ohlcv/minute?aggregate=5&limit=24&currency=usd&token=${token}`, b => parsePriceBars(b, token));
  const tradeLeg = legs ? legs.trades() : read(`${poolId}:${token}:trades`, `${poolId}/trades?token=${token}`, b => parseTrades(b, token));
  const [candles, trades] = await Promise.all([within(candleLeg), within(tradeLeg)]);
  return { poolId, token, candles, trades };
}

/** The trade windows a review is shown: five minutes, a quarter hour and the hour. */
const TRADE_WINDOWS = [['m5', 300], ['m15', 900], ['h1', 3600]] as const;
/** Completed 5-minute bars a review is shown one by one; the rest are summarised. */
const RECENT_BARS = 6;

const round = (v: number | null, dp: number) => v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp;
const sig = (v: number) => Number(v.toPrecision(6));

/**
 * ONE WINDOW OF THE TRADE SAMPLE, counted every way a short-horizon read needs:
 * how many trades each side, how many DISTINCT wallets, the buy share of USD
 * flow, and how much of the selling one wallet did. A single seller doing
 * most of it is distribution; many small buyers is demand. Every amount is
 * null when any trade in the window has none — a missing amount is never 0.
 *
 * `sampleCoversWindow` is false when the index's sample was full and its
 * oldest trade is newer than the window's start: the counts are then the
 * window's latest trades, not all of them.
 */
function tradeWindow(trades: readonly MarketTrade[], seconds: number, nowSec: number, sampleFull: boolean) {
  const start = nowSec - seconds;
  const inWindow = trades.filter(t => t.time >= start);
  const buys = inWindow.filter(t => t.side === 'buy'), sells = inWindow.filter(t => t.side === 'sell');
  const priced = inWindow.every(t => t.usd !== null);
  const usd = (ts: readonly MarketTrade[]) => priced ? ts.reduce((s, t) => s + t.usd!, 0) : null;
  const buyUsd = usd(buys), sellUsd = usd(sells);
  const attributed = inWindow.every(t => typeof t.wallet === 'string');
  const distinct = (ts: readonly MarketTrade[]) => attributed ? new Set(ts.map(t => t.wallet)).size : null;
  let topSeller: number | null = null;
  if (attributed && sellUsd !== null && sellUsd > 0) {
    const bySeller = new Map<string, number>();
    for (const t of sells) bySeller.set(t.wallet!, (bySeller.get(t.wallet!) ?? 0) + t.usd!);
    topSeller = Math.max(...bySeller.values()) / sellUsd * 100;
  }
  const oldest = trades.length ? Math.min(...trades.map(t => t.time)) : undefined;
  return {
    trades: inWindow.length, buys: buys.length, sells: sells.length,
    distinctBuyers: distinct(buys), distinctSellers: distinct(sells),
    buyUsd: round(buyUsd, 2), sellUsd: round(sellUsd, 2),
    buySharePct: buyUsd !== null && sellUsd !== null && buyUsd + sellUsd > 0 ? round(buyUsd / (buyUsd + sellUsd) * 100, 1) : null,
    topSellerSharePctOfSellUsd: round(topSeller, 1),
    sampleCoversWindow: !sampleFull || (oldest !== undefined && oldest <= start),
  };
}

/** Descriptive measurements only: sampled flow is not total market volume or a forecast. */
export function summarizeEvidence(e: PoolEvidence, now = Date.now()) {
  const fresh = (r: FeedResult) => !r.failed && r.observedAt !== undefined && now - r.observedAt <= 120000;
  const bars = fresh(e.candles) ? e.candles.data : [];
  const contiguous = bars.length >= 2 && bars.every((b, i) => !i || b.time - bars[i - 1]!.time === 300);
  const last = bars.at(-1), first = bars[0];
  const current = last && now / 1000 - (last.time + 300) <= 600;
  const returns = contiguous && current ? bars.slice(1).map((b, i) => Math.log(b.close / bars[i]!.close)) : [];
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const trades = fresh(e.trades) ? e.trades.data.filter(t => t.time >= now / 1000 - 300) : [];
  const priced = trades.length > 0 && trades.every(t => t.usd !== null);
  const buy = priced ? trades.filter(t => t.side === 'buy').reduce((s, t) => s + t.usd!, 0) : null;
  const sell = priced ? trades.filter(t => t.side === 'sell').reduce((s, t) => s + t.usd!, 0) : null;
  // CANDLE VOLUME, which this summary used to leave out entirely — so "price
  // rose on expanding volume" and "price drifted up on nothing" read the
  // same. Null unless every bar read carried one. The two quarter-hours are
  // compared only on a contiguous, current series: a gap would compare
  // different stretches of time.
  const volumes = bars.map(b => b.volume);
  const volumeKnown = bars.length > 0 && volumes.every(v => typeof v === 'number' && Number.isFinite(v));
  const sumOf = (vs: readonly (number | null | undefined)[]) => vs.reduce<number>((s, v) => s + (v as number), 0);
  const candleVolumeUsd = fresh(e.candles) && volumeKnown ? {
    allBars: round(sumOf(volumes), 2),
    last15m: contiguous && current && bars.length >= 3 ? round(sumOf(volumes.slice(-3)), 2) : null,
    prior15m: contiguous && current && bars.length >= 6 ? round(sumOf(volumes.slice(-6, -3)), 2) : null,
  } : null;
  const nowSec = now / 1000;
  const sampleFull = e.trades.data.length >= TRADE_SAMPLE_MAX;
  const tradeWindows = fresh(e.trades)
    ? Object.fromEntries(TRADE_WINDOWS.map(([name, seconds]) => [name, tradeWindow(e.trades.data, seconds, nowSec, sampleFull)]))
    : null;
  return { source: 'CoinGecko / GeckoTerminal indexed pool data',
    candleObservedAt: e.candles.observedAt ?? null, tradeObservedAt: e.trades.observedAt ?? null,
    candleFailure: e.candles.failure ?? null, tradeFailure: e.trades.failure ?? null,
    // NULL, NOT 0, WHEN THE CANDLE READ DID NOT LAND. `bars` is empty both for
    // a pool that printed nothing and for a feed we never got an answer from,
    // and `0 completed bars` is a measurement — a model reading it is being
    // told this market was quiet. The trade side one line down already got this
    // right (`fresh(e.trades) ? … : null`); the candle side did not, and the
    // caveat's own promise that "missing or stale evidence is unknown" was
    // false for the one figure most likely to be missing.
    //
    // `contiguous` goes the same way for the same reason: `false` asserts the
    // bars we read had a gap, which is not what an unread feed tells us.
    completedFiveMinuteBars: fresh(e.candles) ? bars.length : null,
    contiguous: fresh(e.candles) ? contiguous : null,
    start: first?.time ?? null, end: last ? last.time + 300 : null,
    measuredReturnPct: contiguous && current && first && last ? (last.close / first.open - 1) * 100 : null,
    fiveMinuteLogReturnStdDevPct: returns.length >= 2 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100 : null,
    latestFiveMinuteReturnPct: current && last ? (last.close / last.open - 1) * 100 : null,
    candleVolumeUsd,
    // AT 5, 15 AND 60 MINUTES, not 5 alone: one five-minute window cannot
    // tell a building move from a blip, and the hour is where distribution
    // shows. Null when the trade read did not land — unknown, not quiet.
    tradeWindows,
    // The last bars themselves, for highs, lows and volume bar by bar.
    recentBars: bars.slice(-RECENT_BARS).map(b => ({ end: b.time + 300, open: sig(b.open), high: sig(b.high), low: sig(b.low), close: sig(b.close), volumeUsd: round(b.volume ?? null, 2) })),
    caveat: 'Latest 300 indexed trades maximum, not exhaustive volume; a window the sample does not reach back across says so. Distinct wallets are transaction senders, not verified owners. Candle volume is the index\'s USD volume per completed bar. Missing or stale evidence is unknown. Volatility is not annualized. Measurements are not a forecast or permission to trade.',
    // The five-minute figures under their original names, for readers written
    // against them (web market-intel). `tradeWindows.m5` is the same window.
    sampledTrades5m: fresh(e.trades) ? trades.length : null, sampledBuyUsd5m: buy, sampledSellUsd5m: sell,
    sampledBuySharePct5m: buy !== null && sell !== null && buy + sell > 0 ? buy / (buy + sell) * 100 : null,
    poolId: e.poolId, token: e.token };
}
