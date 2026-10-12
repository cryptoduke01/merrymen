/**
 * "FOR SOME TOKENS THE CHART DID NOT LOAD ON FIRST TRY. BUT NOW IT IS RESOLVED
 * FOR SOME REASON HAHAAH. MAYBE IT WAS MY BROWSER."
 *
 * It was not his browser. This cache is a module-level Map on the SERVER, so a
 * refusal cached here is a refusal for everyone looking at that pool. Two things
 * were wrong, and the first is the one that cost him the chart:
 *
 *   1. A refusal OVERWROTE a good series. One rate-limited request replaced real
 *      bars with an empty read, and the empty read was then cached — so the
 *      chart went blank and stayed blank for the whole window.
 *   2. One TTL covered every kind of refusal. A 429 is evidence that the bucket
 *      is empty and deserves a long hold; a dropped connection says nothing
 *      about the bucket, and holding it as long silenced a token over one blip.
 *
 * The states these tests are about were already argued for in `read-candles.ts`:
 * `none` and `mismatch` are facts about the pool, `refused` "is a fact about us,
 * and rendering it as either of the others would state something about a token
 * out of our own outage." The read layer kept them apart; nothing downstream
 * did. These pin the read layer so the screen can rely on it.
 *
 * No network: `fetch` is stubbed per case.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readCandles, __resetCandleCacheForTest } from "./read-candles";
import { resetGeckoFeedsForTest } from "../../../worker/src/venues/geckoterminal";

/** One pool, one window, so every case shares a cache key. */
const POOL = "0xpool";
const TOKEN = "0x10000000000000000000000000000000000000ff";

/** A GeckoTerminal-shaped answer with one bar. */
const okBody = () => ({
  data: {
    attributes: {
      ohlcv_list: [[1_788_000_000, 1, 2, 0.5, 1.5, 1000]],
    },
  },
  meta: { base: { address: TOKEN, symbol: "MAPLE" }, quote: { symbol: "USDG" } },
});

let real: typeof globalThis.fetch;
beforeEach(() => {
  real = globalThis.fetch;
  __resetCandleCacheForTest();
});
afterEach(() => {
  globalThis.fetch = real;
});

const answer = (body: unknown, status = 200) => {
  globalThis.fetch = (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as typeof fetch;
};

describe("a refusal does not destroy a series we already have", () => {
  it("KEEPS THE BARS AND SAYS THEY ARE STALE", async () => {
    answer(okBody());
    const first = await readCandles(POOL, TOKEN, "1h");
    assert.equal(first.state, "ok");
    assert.equal(first.candles.length, 1);

    // The window lapses and the index refuses.
    __resetCandleCacheForTest({ keepLastRead: true, age: 10 * 60_000 });
    answer({}, 429);
    const second = await readCandles(POOL, TOKEN, "1h");

    assert.equal(second.state, "ok", "a blank chart over one 429 is worse than a stale one");
    assert.equal(second.candles.length, 1, "the bars survive");
    assert.equal(second.stale, true, "and the screen is told, so it can say so");
  });

  it("but a refusal with NOTHING cached is still a refusal", async () => {
    answer({}, 429);
    const read = await readCandles(POOL, TOKEN, "1h");
    assert.equal(read.state, "refused");
    assert.equal(read.candles.length, 0);
  });
});

describe("a rate limit and a dropped connection are not the same refusal", () => {
  it("A 429 IS EVIDENCE ABOUT THE BUCKET — re-asking inside the window earns another", async () => {
    answer({}, 429);
    const first = await readCandles(POOL, TOKEN, "1h");
    assert.equal(first.reason, "rate-limited");

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => okBody() } as unknown as Response;
    }) as typeof fetch;
    await readCandles(POOL, TOKEN, "1h");
    assert.equal(calls, 0, "a rate limit is held — that is what this cache is FOR");
  });

  it("a dropped connection says nothing about the bucket, so it is retried", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const first = await readCandles(POOL, TOKEN, "1h");
    assert.equal(first.state, "refused");
    assert.equal(first.reason, "unreachable");

    // Past the short backoff, the next caller gets a real attempt rather than a
    // thirty-second silence earned by one blip.
    __resetCandleCacheForTest({ keepLastRead: true, age: 5_000 });
    answer(okBody());
    const second = await readCandles(POOL, TOKEN, "1h");
    assert.equal(second.state, "ok");
  });

  it("and a shape we cannot read is never charted as an empty pool", async () => {
    // `none` would be a claim about the token. This is a claim about us.
    answer({ data: { attributes: { ohlcv_list: "not-a-list" } } });
    const read = await readCandles(POOL, TOKEN, "1h");
    assert.equal(read.state, "refused");
    assert.equal(read.reason, "unreadable");
    assert.notEqual(read.state, "none");
  });
});

describe("a pool with genuinely no history is not an outage", () => {
  it("reads as `none`, with no reason attached", async () => {
    answer({ ...okBody(), data: { attributes: { ohlcv_list: [] } } });
    const read = await readCandles(POOL, TOKEN, "1h");
    assert.equal(read.state, "none");
    assert.equal(read.reason, null);
  });
});

/**
 * THE PRO KEY IS METERED, SO ITS CHART READS SHARE THE WEB PROCESS'S LANE.
 *
 * Without a key nothing here changes (the cases above run keyless). With one,
 * each read is paced by the same knob as every other web Pro read, and one
 * 429 holds the whole process back rather than only the pool that earned it.
 */
describe("chart reads on the Pro key are paced and share one cooldown", () => {
  const KNOBS = ["MERRYMEN_COINGECKO_PRO_API_KEY", "MERRYMEN_FLEET_HOME", "MERRYMEN_COINGECKO_PRO_SPACING_MS", "MERRYMEN_COINGECKO_MONTHLY_CREDITS"] as const;
  let saved: Record<string, string | undefined> = {};
  let now = 0;
  const pool = (n: string) => `0x${n.repeat(40)}`;
  beforeEach(() => {
    saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "private-web-key";
    now = 1_000_000;
    resetGeckoFeedsForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
  });
  afterEach(() => {
    resetGeckoFeedsForTest();
    for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("two pools' charts are spaced by the Pro pace (default 3000 ms, or the knob)", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(String(input).startsWith("https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood/pools/"));
      assert.equal(new Headers(init?.headers).get("x-cg-pro-api-key"), "private-web-key");
      starts.push(now);
      return Response.json(okBody());
    }) as typeof fetch;
    assert.equal((await readCandles(pool("1"), TOKEN, "1h")).state, "ok");
    assert.equal((await readCandles(pool("2"), TOKEN, "1h")).state, "ok");
    assert.equal(starts[1]! - starts[0]!, 3000);

    resetGeckoFeedsForTest({ now: () => now, sleep: async (ms) => { now += ms; } });
    __resetCandleCacheForTest();
    process.env.MERRYMEN_COINGECKO_PRO_SPACING_MS = "1200";
    starts.length = 0;
    await readCandles(pool("3"), TOKEN, "1h");
    await readCandles(pool("4"), TOKEN, "1h");
    assert.equal(starts[1]! - starts[0]!, 1200);
  });

  it("one Pro 429 holds back every pool in the process, not only the one that earned it", async () => {
    const pro: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://pro-api.coingecko.com/")) { pro.push(url); return new Response("limited", { status: 429 }); }
      return new Response("limited", { status: 429 });
    }) as typeof fetch;
    const first = await readCandles(pool("5"), TOKEN, "1h");
    assert.equal(first.state, "refused");
    assert.equal(first.reason, "rate-limited");
    const other = await readCandles(pool("6"), TOKEN, "4h");
    assert.equal(other.reason, "rate-limited");
    assert.equal(pro.length, 1, "the second pool did not spend a Pro request into a known 429");
  });

  it("a Pro outage still charts from the public index, which never sees the key", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pro-api.coingecko.com/")) return new Response("down", { status: 503 });
      assert.equal(new Headers(init?.headers).get("x-cg-pro-api-key"), null);
      return Response.json(okBody());
    }) as typeof fetch;
    const read = await readCandles(pool("7"), TOKEN, "1h");
    assert.equal(read.state, "ok");
    assert.equal(read.candles.length, 1);
  });
});
