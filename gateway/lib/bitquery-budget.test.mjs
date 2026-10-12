/**
 * THE GATEWAY'S FLEET-WIDE BITQUERY CAP — one daily allowance across every
 * holder and the public memescope, reserved before each upstream call.
 *
 * Before the worker sent holders' tokens where the gateway reads them, every
 * holder's discovery call was a 401 and spent nothing. Once it was fixed, each
 * holder polling at the default interval costs roughly 720 points a day, and
 * the per-address bucket bounds one holder, never all of them. These pin the
 * cap that bounds all of them. No network: fetch is stubbed throughout.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bitqueryPointsPerDayFrom, BITQUERY_POINTS_PER_DAY_CEILING, createGateway, DEFAULTS } from "./core.mjs";
import { createStore } from "./store.mjs";

const SECRET = "test-secret-at-least-32-bytes-long-for-hmac!!";
const HOLDER = "0x1111111111111111111111111111111111111111";
const MEME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Counts upstream calls; answers like Bitquery with one Initialize event. */
function stubUpstream() {
  const seen = { calls: 0 };
  globalThis.fetch = async () => {
    seen.calls++;
    const body = { data: { EVM: { Events: [{ Block: { Time: "2026-10-12T00:00:00Z" }, Transaction: { Hash: "0xbeef" }, Arguments: [{ Value: { address: USDG } }, { Value: { address: MEME } }] }] } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return seen;
}

function gateway(over = {}) {
  return createGateway({
    secret: SECRET,
    upstreamUrl: "https://example.invalid",
    upstreamKey: "x",
    model: "test-model",
    domain: "merrymen.dev",
    minTokens: 10_000n,
    tokenAddress: "0x0000000000000000000000000000000000000000",
    bitqueryKey: "k",
    bitqueryUrl: "https://example.invalid/graphql",
    publicClient: { readContract: async ({ functionName }) => (functionName === "symbol" ? "PEPE" : functionName === "decimals" ? 18 : 10_000n * 10n ** 18n) },
    store: createStore(),
    ...over,
    tunables: { BITQUERY_RATE_PER_MIN: 1_000, MEMESCOPE_RATE_PER_MIN: 1_000, MEMESCOPE_TTL_SEC: 0, ...(over.tunables ?? {}) },
  });
}

describe("MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY", () => {
  it("defaults to 5,000 a day, which with the lane's 25,000 stays under a 1,000,000-point month", () => {
    assert.equal(DEFAULTS.BITQUERY_POINTS_PER_DAY, 5_000);
    assert.deepEqual(bitqueryPointsPerDayFrom(undefined), { points: 5_000, note: null });
    assert.ok((25_000 + DEFAULTS.BITQUERY_POINTS_PER_DAY) * 31 < 1_000_000);
  });

  it("takes a positive whole number, clamps at the ceiling, and never echoes a bad value", () => {
    assert.deepEqual(bitqueryPointsPerDayFrom(" 2000 "), { points: 2_000, note: null });
    const high = bitqueryPointsPerDayFrom("999999");
    assert.equal(high.points, BITQUERY_POINTS_PER_DAY_CEILING);
    assert.match(high.note, /above the ceiling/);
    for (const bad of ["0", "-5", "1.5", "ory_at_pasted_here"]) {
      const r = bitqueryPointsPerDayFrom(bad);
      assert.equal(r.points, 5_000, bad);
      assert.match(r.note, new RegExp(`\\(${bad.length} characters\\)`));
      assert.ok(!r.note.includes(bad) || /^\d$/.test(bad), "the value itself is not in the line");
    }
  });
});

describe("one daily allowance, reserved before every upstream call", () => {
  it("holder discovery stops at the cap with a 503 that says so, and the refused call is never sent", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 10 } });
    const token = gw._tokens.issueToken(HOLDER);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    assert.equal((await gw.bitquery({ token, body: { query: "recentPools" }, ip: "1.1.1.1" })).status, 200);
    const third = await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" });
    assert.equal(third.status, 503);
    assert.match(third.json.error, /daily discovery allowance is spent/);
    assert.equal(upstream.calls, 2, "a refusal costs nothing upstream");
  });

  it("is fleet-wide: a second holder shares the first one's day", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 } });
    assert.equal((await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    const other = await gw.bitquery({ token: gw._tokens.issueToken("0x2222222222222222222222222222222222222222"), body: { query: "ping" }, ip: "2.2.2.2" });
    assert.equal(other.status, 503);
    assert.equal(upstream.calls, 1);
  });

  it("a bad token, a non-holder or an unknown query spends none of it", async () => {
    stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 } });
    const token = gw._tokens.issueToken(HOLDER);
    assert.equal((await gw.bitquery({ token: "mmk_bad.x", body: { query: "ping" }, ip: "1.1.1.1" })).status, 401);
    assert.equal((await gw.bitquery({ token, body: { query: "{ raw }" }, ip: "1.1.1.1" })).status, 400);
    const poor = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 }, publicClient: { readContract: async () => 0n } });
    assert.equal((await poor.bitquery({ token: poor._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 403);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200, "the whole allowance is still there");
  });

  it("the public memescope spends from the same day: stale rows once it is gone, an honest 503 with none", async () => {
    const upstream = stubUpstream();
    const store = createStore();
    const gw = gateway({ store, tunables: { BITQUERY_POINTS_PER_DAY: 10 } });
    assert.equal((await gw.memescope({ ip: "9.9.9.1" })).status, 200, "first refresh fits");
    assert.equal((await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 200, "a holder takes the rest");
    const stale = await gw.memescope({ ip: "9.9.9.1" });
    assert.equal(stale.status, 200);
    assert.equal(stale.json.stale, true, "the page keeps its rows rather than blanking");
    assert.equal(upstream.calls, 2);
    const empty = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 10 }, store });
    const none = await empty.memescope({ ip: "9.9.9.2" });
    assert.equal(none.status, 503);
    assert.equal(upstream.calls, 2, "no refresh was attempted past the cap");
  });

  it("a store that cannot count refuses, rather than spending what it cannot count", async () => {
    const upstream = stubUpstream();
    const base = createStore();
    const broken = { ...base, reservePoints: async () => null };
    const gw = gateway({ store: broken });
    const r = await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /cannot count/);
    const old = { ...base };
    delete old.reservePoints;
    const legacy = gateway({ store: old });
    assert.equal((await legacy.bitquery({ token: legacy._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 503);
    assert.equal(upstream.calls, 0);
  });

  it("the in-memory counter refuses past the cap without consuming, and keeps days apart", async () => {
    const s = createStore();
    assert.equal(await s.reservePoints("d1", 5, 8, 60), true);
    assert.equal(await s.reservePoints("d1", 5, 8, 60), false);
    assert.equal(await s.reservePoints("d1", 3, 8, 60), true, "the refused 5 were not counted");
    assert.equal(await s.reservePoints("d2", 5, 8, 60), true, "another day is another allowance");
  });
});
