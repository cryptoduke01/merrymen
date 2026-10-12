/**
 * COINS BY NAME OR TICKER: an exact match that ranks, read on the fleet's
 * CoinGecko Pro lane and nowhere else. Every response here is a fake; no test
 * reaches a provider.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MAJORS_MAX_RANK, coinQuery, parseCoinMarket, parseCoinSearch, parseCoinTrending, pickMajor, readCoinMarket, readCoinTrending, searchCoinList, type CoinHit,
} from "./coingecko-coins";
import { resetGeckoFeedsForTest } from "./geckoterminal";

const hit = (id: string, symbol: string, name: string, rank: number | null): CoinHit => ({ id, symbol, name, rank });

/** A /search body as CoinGecko answers it, with the noise its coins come with. */
const SEARCH = { coins: [
  { id: "bitcoin", name: "Bitcoin", api_symbol: "bitcoin", symbol: "BTC", market_cap_rank: 1, thumb: "x" },
  { id: "bitcoin-2", name: "Bitcoin 2", symbol: "BTC2", market_cap_rank: null },
  { id: "wrapped-bitcoin", name: "Wrapped Bitcoin", symbol: "WBTC", market_cap_rank: 15 },
  { id: "batcat", name: "batcat", symbol: "BTC", market_cap_rank: 2400 },
], exchanges: [], categories: [] };
const MARKETS = [{ id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3412.5, market_cap: 411_000_000_000, market_cap_rank: 2,
  total_volume: 18_200_000_000, price_change_percentage_24h: 1.1, price_change_percentage_24h_in_currency: 1.24, price_change_percentage_7d_in_currency: -3.4 }];

describe("a major is an exact match that ranks", () => {
  it("the query is one to three plain words, a cashtag's $ off", () => {
    assert.equal(coinQuery("$SOL"), "sol");
    assert.equal(coinQuery("  Shiba   Inu "), "shiba inu");
    for (const bad of ["", "$", "btc?", "eth/usd", "a b c d", "x".repeat(41), "ВТС", null]) assert.equal(coinQuery(bad), null, String(bad));
  });

  it("parses a search, keeping only coins with a lookup key, a symbol and a name", () => {
    const hits = parseCoinSearch({ coins: [...SEARCH.coins, { id: "Bad Id!", symbol: "X", name: "x" }, { id: "nosymbol", name: "n" }, null] });
    assert.deepEqual(hits.map((h) => h.id), ["bitcoin", "bitcoin-2", "wrapped-bitcoin", "batcat"]);
    assert.equal(hits[1]!.rank, null);
    assert.deepEqual(parseCoinSearch({ nope: true }), []);
    assert.deepEqual(parseCoinSearch("<html>"), []);
  });

  it("by exact symbol or exact name, at most rank two hundred, the best rank among several", () => {
    const hits = parseCoinSearch(SEARCH);
    assert.equal(pickMajor("btc", hits)?.id, "bitcoin", "the ranked BTC, not batcat at #2400");
    assert.equal(pickMajor("$BTC", hits)?.id, "bitcoin");
    assert.equal(pickMajor("Bitcoin", hits)?.id, "bitcoin");
    assert.equal(pickMajor("wbtc", hits)?.id, "wrapped-bitcoin");
    // Copycats, near matches and the unranked are no major.
    for (const q of ["btc2", "bitcoin 2", "bitc", "bitcoin inu", "wrapped"]) assert.equal(pickMajor(q, hits), null, q);
    assert.equal(pickMajor("x", [hit("x-coin", "X", "X", MAJORS_MAX_RANK + 1)]), null, "past the rank cap");
    assert.equal(pickMajor("x", [hit("x-coin", "X", "X", MAJORS_MAX_RANK)])?.id, "x-coin", "at the cap");
    assert.equal(pickMajor("sol", [hit("solana", "SOL", "Solana", 5), hit("sol-wormhole", "SOL", "SOL (Wormhole)", 150)])?.id, "solana", "the tie goes to the best rank");
  });

  it("a market row is the asked id's own, every missing figure null", () => {
    const m = parseCoinMarket(MARKETS, "ethereum")!;
    assert.deepEqual(m, { id: "ethereum", symbol: "eth", name: "Ethereum", rank: 2, priceUsd: 3412.5, marketCapUsd: 411e9, volume24hUsd: 18.2e9, change24hPct: 1.24, change7dPct: -3.4 });
    assert.equal(parseCoinMarket(MARKETS, "bitcoin"), null, "another coin's row is never this one's");
    assert.deepEqual(parseCoinMarket([{ id: "x", symbol: "x", name: "x", current_price: "12", market_cap: null }], "x"),
      { id: "x", symbol: "x", name: "x", rank: null, priceUsd: null, marketCapUsd: null, volume24hUsd: null, change24hPct: null, change7dPct: null });
    assert.equal(parseCoinMarket({ error: "x" }, "ethereum"), null);
  });

  it("the trending list in its order", () => {
    const t = parseCoinTrending({ coins: [{ item: { id: "pepe", symbol: "PEPE", name: "Pepe", market_cap_rank: 30 } }, { item: { id: "x" } }, { item: { id: "tao", symbol: "TAO", name: "Bittensor", market_cap_rank: 40 } }] });
    assert.deepEqual(t.map((c) => c.symbol), ["PEPE", "TAO"]);
  });
});

describe("read on the fleet's CoinGecko Pro lane, and only with its key", () => {
  const realFetch = globalThis.fetch;
  const KNOBS = ["MERRYMEN_COINGECKO_PRO_API_KEY", "MERRYMEN_FLEET_HOME", "MERRYMEN_COINGECKO_PRO_SPACING_MS", "MERRYMEN_COINGECKO_MONTHLY_CREDITS"] as const;
  let saved: Record<string, string | undefined> = {};
  let now = 0;
  beforeEach(() => {
    saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "private-pro-key";
    now = 1_000_000;
    resetGeckoFeedsForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetGeckoFeedsForTest();
    for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("no key, nothing asked: the public source has no such endpoints and the key never goes anywhere else", async () => {
    delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(SEARCH); }) as typeof globalThis.fetch;
    assert.equal((await searchCoinList("btc", { timeoutMs: 4000 })).failure, "no-pro-key");
    assert.equal((await readCoinMarket("bitcoin", { timeoutMs: 4000 })).failure, "no-pro-key");
    assert.equal((await readCoinTrending({ timeoutMs: 4000 })).failure, "no-pro-key");
    assert.equal(calls, 0);
  });

  it("the Pro origin, the key in a header, no redirect; a coin is read once a minute however often it is asked", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      assert.equal(new Headers(init?.headers).get("x-cg-pro-api-key"), "private-pro-key");
      assert.equal(init?.redirect, "error");
      return String(input).includes("/coins/markets") ? Response.json(MARKETS) : Response.json(SEARCH);
    }) as typeof globalThis.fetch;
    const s = await searchCoinList("$BTC", { timeoutMs: 4000 });
    assert.equal(s.failed, false);
    assert.equal(s.provider, "coingecko-pro");
    assert.equal(pickMajor("btc", s.hits)?.id, "bitcoin");
    const m = await readCoinMarket("ethereum", { timeoutMs: 4000 });
    assert.equal(m.market?.rank, 2);
    assert.deepEqual(urls, [
      "https://pro-api.coingecko.com/api/v3/search?query=btc",
      "https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum&price_change_percentage=24h,7d",
    ]);
    // Asked again inside the minute: the lane's cache answers, nothing is spent.
    now += 30_000;
    await readCoinMarket("ethereum", { timeoutMs: 4000 });
    await searchCoinList("btc", { timeoutMs: 4000 });
    assert.equal(urls.length, 2);
    assert.doesNotMatch(JSON.stringify(m), /private-pro-key/);
  });

  it("shares the lane's pace: a read that cannot get its slot inside its budget is skipped, never waited on or paid for", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async () => { starts.push(now); return Response.json(SEARCH); }) as typeof globalThis.fetch;
    await searchCoinList("btc", { timeoutMs: 4000 });
    const late = await searchCoinList("eth", { timeoutMs: 1000 });
    assert.equal(late.failed, true);
    assert.match(late.failure ?? "", /^(?:request-budget|timeout)$/);
    assert.equal(starts.length, 1, "the second read never reached the provider");
    const later = await searchCoinList("sol", { timeoutMs: 4000 });
    assert.equal(later.failed, false);
    assert.equal(starts[1]! - starts[0]!, 3000, "the Pro lane's spacing");
  });

  it("CoinGecko's plan refusal latches the endpoint for the key, and a refusal's text never comes back", async () => {
    const warn = console.warn, lines: string[] = [];
    console.warn = (line: string) => { lines.push(String(line)); };
    let markets = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/coins/markets")) {
        markets++;
        return new Response(JSON.stringify({ status: { error_code: 10005, error_message: "You may not have access to this endpoint" } }), { status: 401 });
      }
      return Response.json(SEARCH);
    }) as typeof globalThis.fetch;
    try {
      const first = await readCoinMarket("bitcoin", { timeoutMs: 4000 });
      assert.equal(first.failure, "plan-restricted");
      assert.doesNotMatch(JSON.stringify(first), /You may not|private-pro-key/);
      now += 10_000;
      assert.equal((await readCoinMarket("ethereum", { timeoutMs: 4000 })).failure, "plan-restricted");
      assert.equal(markets, 1, "the latched family spends nothing more");
      assert.ok(lines.some((l) => /refused coins\/markets/.test(l)));
      assert.equal((await searchCoinList("btc", { timeoutMs: 4000 })).failed, false, "another endpoint still reads");
    } finally { console.warn = warn; }
  });

  it("a rate limit or an odd body is a failure, never an empty list", async () => {
    globalThis.fetch = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } })) as typeof globalThis.fetch;
    const r = await readCoinTrending({ timeoutMs: 4000 });
    assert.equal(r.failed, true);
    assert.equal(r.failure, "http-429");
    resetGeckoFeedsForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
    globalThis.fetch = (async () => Response.json({ unexpected: true })) as typeof globalThis.fetch;
    assert.equal((await readCoinMarket("bitcoin", { timeoutMs: 4000 })).failure, "invalid-shape");
  });

  it("only a query or a key that is one ever reaches the URL", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(SEARCH); }) as typeof globalThis.fetch;
    assert.equal((await searchCoinList("btc&vs=1", { timeoutMs: 4000 })).failure, "invalid-query");
    assert.equal((await readCoinMarket("../simple/price", { timeoutMs: 4000 })).failure, "invalid-id");
    assert.equal(calls, 0);
  });
});
