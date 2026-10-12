/**
 * THE LANE'S PROMISES, EACH OF WHICH IS A WAY A PAID API BECOMES A BILL OR A LIE.
 *
 * Nothing here touches the network: every request goes to a stubbed fetch, and
 * the provider's answers are recorded-SHAPE fixtures written from Bitquery's
 * documented response shapes (testdata/bitquery-lane). They prove this code
 * reads the shape it asks for; they cannot prove the provider answers in it —
 * that is the IDE check in docs/bitquery-lane.md, before the key is set.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import {
  BITQUERY_LANE_DEFAULTS,
  BitqueryLane,
  CREATOR_FLOW_QUERY,
  LANE_POINTS,
  LANE_TTL_MS,
  TOKEN_FLOW_QUERY,
  V3_POOLS_QUERY,
  bitqueryLaneSetup,
  buildLaneRequest,
  clampLaneInput,
  parseCreatorFlow,
  parseTokenFlow,
  parseV3Pools,
  type BitqueryLaneConfig,
  type LaneClock,
} from "./bitquery-lane";
import { BITQUERY_DEFAULT_ENDPOINT } from "./bitquery";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): { data: unknown } => JSON.parse(readFileSync(path.join(HERE, "testdata", "bitquery-lane", name), "utf8")) as { data: unknown };

const TOKEN = "0x00000000000000000000000000000000000000c1";
const TOKEN_B = "0x00000000000000000000000000000000000000c2";
const CREATOR = "0x00000000000000000000000000000000000000a7";
const T0 = Date.parse("2026-10-12T02:00:00Z");

function fakeClock(start = T0): LaneClock & { set(ms: number): void; advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    async sleep(ms: number) {
      now += ms;
      await new Promise((r) => setImmediate(r));
    },
    set(ms: number) {
      now = ms;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

type Call = { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } };

function stubFetch(answer: (call: Call, n: number) => Promise<Response> | Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Answers each named query with its fixture. */
const byQuery = (call: Call): Response =>
  json(
    call.body.query === TOKEN_FLOW_QUERY
      ? fixture("token-flow.json")
      : call.body.query === CREATOR_FLOW_QUERY
        ? fixture("creator-flow.json")
        : fixture("v3-pools.json"),
  );

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "merrymen-bq-lane-"));
const config = (over: Partial<BitqueryLaneConfig> = {}): BitqueryLaneConfig => ({ apiKey: "ory_at_test", pointsPerDay: 25_000, rpm: 60, ...over });

describe("bitqueryLaneSetup — off unless a key is set, and the key is never said", () => {
  it("no key: off, and the line says where the key belongs", () => {
    const s = bitqueryLaneSetup({});
    assert.equal(s.off, true);
    assert.equal(s.config, null);
    assert.match(s.lines[0]!, /orchestrator only/);
  });

  it("MERRYMEN_BITQUERY_LANE=0 turns it off with the key still set", () => {
    const s = bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "ory_at_secret", MERRYMEN_BITQUERY_LANE: "0" });
    assert.equal(s.off, true);
    assert.equal(s.config, null);
  });

  it("defaults: 25,000 points a day, 60 a minute, 3 at once", () => {
    const s = bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "ory_at_secret" });
    assert.equal(s.off, false);
    assert.deepEqual(s.config, { apiKey: "ory_at_secret", pointsPerDay: 25_000, rpm: 60 });
    assert.equal(BITQUERY_LANE_DEFAULTS.maxConcurrency, 3);
    assert.ok(25_000 * 31 < 1_000_000, "a 31-day month stays under a 1M plan at the default");
    assert.match(s.lines[0]!, /25000 points\/UTC day \(20000 for child evidence\), 60 requests\/min, 3 at once/);
  });

  it("knobs are clamped to the plan's ceilings and a bad value is described, never echoed", () => {
    const s = bitqueryLaneSetup({
      MERRYMEN_BITQUERY_API_KEY: "ory_at_secret",
      MERRYMEN_BITQUERY_POINTS_PER_DAY: "ory_at_pasted_into_the_wrong_box",
      MERRYMEN_BITQUERY_RPM: "500",
    });
    assert.equal(s.config!.pointsPerDay, 25_000);
    assert.equal(s.config!.rpm, 90, "never above the plan's 90/min");
    const said = s.lines.join("\n");
    assert.doesNotMatch(said, /ory_at_/, "neither the key nor a key-shaped knob value reaches the log");
    assert.match(said, /not a positive whole number \(32 characters\)/);
    assert.match(said, /above the ceiling of 90/);
    assert.equal(bitqueryLaneSetup({ MERRYMEN_BITQUERY_API_KEY: "k", MERRYMEN_BITQUERY_POINTS_PER_DAY: "0" }).config!.pointsPerDay, 25_000, "zero is not a budget");
  });
});

describe("named queries, clamped variables — no caller writes GraphQL", () => {
  it("a caller passes a token and nothing else reaches the query text", () => {
    for (const [name, q] of [["tokenFlow", TOKEN_FLOW_QUERY], ["creatorFlow", CREATOR_FLOW_QUERY], ["v3Pools", V3_POOLS_QUERY]] as const) {
      const c = clampLaneInput(name, { token: TOKEN, creator: CREATOR } as never)!;
      const req = buildLaneRequest(c, T0);
      assert.equal(req.query, q, `${name} sends its catalogue text, verbatim`);
      assert.ok(!req.query.includes(TOKEN), "the token travels as a variable, never spliced into the text");
    }
  });

  it("refuses anything that is not a token, and a creator that is the token itself", () => {
    for (const token of ["", "0x123", "not-an-address", "0x0000000000000000000000000000000000000000", null, 42]) {
      assert.equal(clampLaneInput("tokenFlow", { token } as never), null, `token ${String(token)}`);
    }
    assert.equal(clampLaneInput("creatorFlow", { token: TOKEN, creator: "0xnope" }), null);
    assert.equal(clampLaneInput("creatorFlow", { token: TOKEN, creator: TOKEN }), null);
  });

  it("clamps every number a caller may suggest", () => {
    assert.deepEqual(clampLaneInput("tokenFlow", { token: TOKEN, sellLimit: 10_000 }), { name: "tokenFlow", token: TOKEN, sellLimit: 10 });
    assert.deepEqual(clampLaneInput("tokenFlow", { token: TOKEN.toUpperCase().replace("0X", "0x") }), { name: "tokenFlow", token: TOKEN, sellLimit: 5 });
    assert.equal((clampLaneInput("creatorFlow", { token: TOKEN, creator: CREATOR, windowMin: 99_999 }) as { windowMin: number }).windowMin, 240);
    assert.equal((clampLaneInput("creatorFlow", { token: TOKEN, creator: CREATOR, windowMin: 0 }) as { windowMin: number }).windowMin, 5);
    const v3 = clampLaneInput("v3Pools", { token: TOKEN, sinceHours: 10_000, limit: 10_000 }) as { sinceHours: number; limit: number };
    assert.equal(v3.sinceHours, 24);
    assert.equal(v3.limit, 20);
  });

  it("the windows are fixed at 5, 15 and 60 minutes before now", () => {
    const req = buildLaneRequest(clampLaneInput("tokenFlow", { token: TOKEN })!, T0);
    assert.equal(req.variables.t5, new Date(T0 - 5 * 60_000).toISOString());
    assert.equal(req.variables.t15, new Date(T0 - 15 * 60_000).toISOString());
    assert.equal(req.variables.t60, new Date(T0 - 60 * 60_000).toISOString());
    assert.equal(req.variables.venueLimit, 8);
  });

  it("addresses go in both spellings, so an index's case choice cannot read as 'no trades'", () => {
    const lower = "0xabcdef0000000000000000000000000000000001";
    const req = buildLaneRequest(clampLaneInput("creatorFlow", { token: lower.toUpperCase().replace("0X", "0x"), creator: CREATOR })!, T0);
    assert.deepEqual(req.variables.tokens, [lower, getAddress(lower)]);
    assert.notEqual(getAddress(lower), lower, "the checksum spelling really is a second spelling");
  });

  it("v3 pools are asked of the pinned Uniswap factory and no other", () => {
    const req = buildLaneRequest(clampLaneInput("v3Pools", { token: TOKEN })!, T0);
    assert.ok((req.variables.factory as string[]).includes("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"));
    assert.match(V3_POOLS_QUERY, /LogHeader: \{Address: \{in: \$factory\}\}/);
    assert.match(V3_POOLS_QUERY, /Name: \{is: "PoolCreated"\}/);
  });

  it("the flow query is the Robinhood Trading cube, reads Side as the trader's side, and selects no wallet", () => {
    assert.match(TOKEN_FLOW_QUERY, /NetworkBid: \{is: "bid:robinhood"\}/);
    assert.match(TOKEN_FLOW_QUERY, /buys60: count\(if: \{Side: \{is: "Buy"\}, Block: \{Time: \{since: \$t60\}\}\}\)/);
    assert.match(TOKEN_FLOW_QUERY, /buyers5: count\(distinct: Trader_Address, if: \{Side: \{is: "Buy"\}/);
    assert.doesNotMatch(TOKEN_FLOW_QUERY, /Trader \{|Transaction \{|TransactionHeader/, "no address or hash is selected in a flow reading");
  });
});

describe("parsing — third-party JSON on its way to a trading agent", () => {
  it("reads the token-flow fixture: strings and numbers alike, sells sorted largest first", () => {
    const r = parseTokenFlow(fixture("token-flow.json").data)!;
    assert.deepEqual(r.windows.map((w) => w.minutes), [5, 15, 60]);
    assert.deepEqual(r.windows[0], { minutes: 5, buyUsd: 412.5, sellUsd: 120.25, buys: 4, sells: 2, buyers: 3, sellers: 2 });
    assert.equal(r.windows[2]!.buyUsd, 5120.75);
    assert.deepEqual(r.venues.map((v) => [v.protocol, v.family]), [["uniswap_v4", "uniswap"], ["pons_curve", "pons"]]);
    assert.deepEqual(r.largestSells.map((s) => s.usd), [512.75, 350.2, 240]);
    assert.equal(r.largestSells[0]!.at, Date.parse("2026-10-12T01:40:00Z") / 1000);
  });

  it("a MISSING aggregate is unknown (null), never zero", () => {
    const data = structuredClone(fixture("token-flow.json").data) as { Trading: { totals: Record<string, unknown>[] } };
    delete data.Trading.totals[0]!.buyers5;
    data.Trading.totals[0]!.sellUsd15 = "-3";
    data.Trading.totals[0]!.buys60 = "1.5";
    const r = parseTokenFlow(data)!;
    assert.equal(r.windows[0]!.buyers, null);
    assert.equal(r.windows[1]!.sellUsd, null, "a negative dollar figure is not a figure");
    assert.equal(r.windows[2]!.buys, null, "half a trade is not a count");
  });

  it("an EMPTY aggregate list is the index answering 'none', which is zero", () => {
    const r = parseTokenFlow({ Trading: { totals: [], venues: [], bigSells: [] } })!;
    assert.deepEqual(r.windows[2], { minutes: 60, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 });
  });

  it("the wrong shape is null — not a guess — and junk rows are dropped", () => {
    for (const bad of [null, {}, { Trading: {} }, { Trading: { totals: {}, venues: [], bigSells: [] } }, { Trading: { totals: [], venues: null, bigSells: [] } }]) {
      assert.equal(parseTokenFlow(bad), null);
    }
    const r = parseTokenFlow({
      Trading: {
        totals: [],
        venues: [{ Pair: { Market: { Protocol: "<script>" } } }, { Pair: { Market: {} } }, "x"],
        bigSells: [{ AmountsInUsd: { Base: 5 } }, { Block: { Time: "nope" }, AmountsInUsd: { Base: 5 } }, { Block: { Time: "2026-10-12T01:00:00Z" }, AmountsInUsd: { Base: "abc" } }],
      },
    })!;
    assert.deepEqual(r.venues.map((v) => v.protocol), ["script"], "a slug is reduced to a safe alphabet");
    assert.deepEqual(r.largestSells, []);
  });

  it("creator flow: both halves, or nothing", () => {
    assert.deepEqual(parseCreatorFlow(fixture("creator-flow.json").data), { sells: 2, sellUsd: 830.5, transfersOut: 3, transferOutUsd: 1210.75 });
    assert.deepEqual(parseCreatorFlow({ Trading: { creatorSells: [] }, EVM: { creatorOut: [] } }), { sells: 0, sellUsd: 0, transfersOut: 0, transferOutUsd: 0 });
    assert.equal(parseCreatorFlow({ Trading: { creatorSells: [] } }), null, "a missing half is not a quiet creator");
  });

  it("v3 pools: the pinned factory, the asked-for token, a pool address and a real fee — or dropped", () => {
    const pools = parseV3Pools(fixture("v3-pools.json").data, TOKEN)!;
    assert.deepEqual(pools.map((p) => [p.pool, p.fee, p.tickSpacing]), [
      ["0x00000000000000000000000000000000000000e1", 10000, 200],
      ["0x00000000000000000000000000000000000000e7", 3000, 60],
    ]);
    assert.equal(pools[0]!.token0, TOKEN, "addresses are lowercased");
    assert.equal(parseV3Pools({ EVM: {} }, TOKEN), null);
  });
});

describe("the lane — budget, cache, rate and cooldown", () => {
  it("talks to Bitquery's endpoint with the plan key in the right header, and caches the answer", async () => {
    const clock = fakeClock();
    const { fetch, calls } = stubFetch(byQuery);
    const lane = new BitqueryLane({ dir: tmp(), config: config(), fetch, clock });
    const a = await lane.tokenFlow(TOKEN);
    assert.equal(a.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, BITQUERY_DEFAULT_ENDPOINT);
    assert.equal(calls[0]!.headers.Authorization, "Bearer ory_at_test");
    assert.equal(calls[0]!.headers["X-API-KEY"], undefined);
    clock.advance(LANE_TTL_MS.tokenFlow - 1);
    const b = await lane.tokenFlow(TOKEN);
    assert.ok(b.ok && b.servedFrom === "cache", "inside the TTL nothing is spent");
    assert.equal(b.ok && a.ok && b.observedAt, a.ok && a.observedAt, "a cache hit keeps the time it was observed");
    assert.equal(calls.length, 1);
    clock.advance(2);
    assert.ok((await lane.tokenFlow(TOKEN)).ok);
    assert.equal(calls.length, 2, "past the TTL it asks again");
    assert.deepEqual(lane.spentToday(), { day: "2026-10-12", points: 2 * LANE_POINTS.tokenFlow, calls: 2, refused: 0 });
    lane.close();
  });

  it("a V1 key goes in X-API-KEY", async () => {
    const { fetch, calls } = stubFetch(byQuery);
    const lane = new BitqueryLane({ dir: tmp(), config: config({ apiKey: "BQY_legacy" }), fetch, clock: fakeClock() });
    await lane.v3Pools(TOKEN);
    assert.deepEqual([calls[0]!.headers["X-API-KEY"], calls[0]!.headers.Authorization], ["BQY_legacy", undefined]);
    lane.close();
  });

  it("the cache is the fleet's: a second lane on the same directory serves it", async () => {
    const dir = tmp();
    const clock = fakeClock();
    const { fetch, calls } = stubFetch(byQuery);
    const one = new BitqueryLane({ dir, config: config(), fetch, clock });
    await one.creatorFlow(TOKEN, CREATOR);
    one.close();
    const two = new BitqueryLane({ dir, config: config(), fetch, clock });
    const r = await two.creatorFlow(TOKEN, CREATOR);
    assert.ok(r.ok && r.servedFrom === "cache");
    assert.equal(calls.length, 1);
    two.close();
  });

  it("concurrent askers for one reading share ONE request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = stubFetch(async (c) => {
      await gate;
      return byQuery(c);
    });
    const lane = new BitqueryLane({ dir: tmp(), config: config(), fetch, clock: fakeClock() });
    const all = Promise.all(Array.from({ length: 10 }, () => lane.tokenFlow(TOKEN)));
    await new Promise((r) => setImmediate(r));
    release();
    const answers = await all;
    assert.equal(calls.length, 1);
    assert.ok(answers.every((a) => a.ok));
    lane.close();
  });

  it("the day's points are reserved BEFORE the call, refused past the cap, and survive a restart", async () => {
    const dir = tmp();
    const clock = fakeClock();
    const { fetch, calls } = stubFetch(byQuery);
    const lane = new BitqueryLane({ dir, config: config({ pointsPerDay: 20 }), fetch, clock });
    assert.ok((await lane.tokenFlow(TOKEN)).ok, "15 of 20");
    assert.deepEqual(await lane.tokenFlow(TOKEN_B), { ok: false, failure: "budget" }, "15 more would pass 20");
    assert.ok((await lane.v3Pools(TOKEN)).ok, "5 more fits exactly");
    assert.equal(calls.length, 2, "a refused request is never sent");
    lane.close();
    const again = new BitqueryLane({ dir, config: config({ pointsPerDay: 20 }), fetch, clock });
    assert.deepEqual(await again.v3Pools(TOKEN_B), { ok: false, failure: "budget" }, "a restart does not refill the day");
    clock.set(Date.parse("2026-10-13T00:00:01Z"));
    assert.ok((await again.v3Pools(TOKEN_B)).ok, "a new UTC day does");
    assert.equal(again.spentToday()!.points, 5);
    again.close();
  });

  it("a request that fails keeps its reservation — a provider may bill a bad answer", async () => {
    const { fetch } = stubFetch(() => json({}, 500));
    const lane = new BitqueryLane({ dir: tmp(), config: config(), fetch, clock: fakeClock() });
    assert.deepEqual(await lane.tokenFlow(TOKEN), { ok: false, failure: "http-500" });
    assert.equal(lane.spentToday()!.points, LANE_POINTS.tokenFlow);
    lane.close();
  });

  it("child evidence stops at its share, leaving the rest for the orchestrator's own answers", async () => {
    const { fetch } = stubFetch(byQuery);
    const lane = new BitqueryLane({ dir: tmp(), config: config({ pointsPerDay: 25 }), fetch, clock: fakeClock() });
    assert.ok((await lane.tokenFlow(TOKEN, { purpose: "evidence" })).ok, "15 of the evidence share of 20");
    assert.deepEqual(await lane.creatorFlow(TOKEN, CREATOR, { purpose: "evidence" }), { ok: false, failure: "budget" }, "15 + 10 passes the share");
    assert.ok((await lane.creatorFlow(TOKEN, CREATOR)).ok, "the same 10 for the orchestrator's own answer fits the whole 25");
    lane.close();
  });

  it("never more than three at once, and never more than the rate allows", async () => {
    const releases: (() => void)[] = [];
    let open = 0;
    let peak = 0;
    const { fetch } = stubFetch(async (c) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise<void>((r) => releases.push(r));
      open--;
      return byQuery(c);
    });
    const clock = fakeClock();
    const lane = new BitqueryLane({ dir: tmp(), config: config(), fetch, clock });
    const tokens = Array.from({ length: 6 }, (_, i) => `0x${(0xd0 + i).toString(16).padStart(40, "0")}`);
    const all = Promise.all(tokens.map((t) => lane.v3Pools(t)));
    for (let i = 0; i < 40 && releases.length < 3; i++) await new Promise((r) => setImmediate(r));
    assert.equal(releases.length, 3, "three requests open");
    while (releases.length > 0 || open > 0) {
      releases.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    const done = await all;
    assert.equal(peak, 3);
    assert.ok(done.every((d) => d.ok));
    lane.close();

    const { fetch: f2, calls } = stubFetch(byQuery);
    const slow = new BitqueryLane({ dir: tmp(), config: config({ rpm: 2 }), fetch: f2, clock: fakeClock(), waitMs: 1_000 });
    assert.ok((await slow.v3Pools(tokens[0]!)).ok);
    assert.ok((await slow.v3Pools(tokens[1]!)).ok);
    assert.deepEqual(await slow.v3Pools(tokens[2]!), { ok: false, failure: "budget" }, "the third in a minute waits, then says so");
    assert.equal(calls.length, 2);
    slow.close();
  });

  it("a 429 cools the whole lane, honours Retry-After, and the cooldown outlives a restart", async () => {
    const dir = tmp();
    const clock = fakeClock();
    let mode: "limited" | "ok" = "limited";
    const { fetch, calls } = stubFetch((c) => (mode === "limited" ? json({}, 429, { "retry-after": "120" }) : byQuery(c)));
    const lane = new BitqueryLane({ dir, config: config(), fetch, clock });
    assert.deepEqual(await lane.tokenFlow(TOKEN), { ok: false, failure: "http-429" });
    assert.deepEqual(await lane.v3Pools(TOKEN_B), { ok: false, failure: "provider-cooldown" }, "another query is not sent into a refusal");
    lane.close();
    mode = "ok";
    const again = new BitqueryLane({ dir, config: config(), fetch, clock });
    clock.advance(100_000);
    assert.deepEqual(await again.v3Pools(TOKEN_B), { ok: false, failure: "provider-cooldown" }, "Retry-After (120 s) beats the 60 s first rung, across a restart");
    clock.advance(21_000);
    assert.ok((await again.v3Pools(TOKEN_B)).ok);
    assert.equal(calls.length, 2);
    again.close();
  });

  it("a refused credential holds off for a quarter hour, and a redeploy with a new key does not inherit it", async () => {
    const dir = tmp();
    const clock = fakeClock();
    const logs: string[] = [];
    const { fetch, calls } = stubFetch(() => json({}, 401));
    const lane = new BitqueryLane({ dir, config: config(), fetch, clock, log: (l) => logs.push(l) });
    assert.deepEqual(await lane.tokenFlow(TOKEN), { ok: false, failure: "http-401" });
    clock.advance(10 * 60_000);
    assert.deepEqual(await lane.tokenFlow(TOKEN_B), { ok: false, failure: "provider-cooldown" });
    assert.equal(calls.length, 1);
    assert.match(logs.join("\n"), /check MERRYMEN_BITQUERY_API_KEY/);
    assert.doesNotMatch(logs.join("\n"), /ory_at_test/);
    lane.close();
    const fresh = new BitqueryLane({ dir, config: config({ apiKey: "ory_at_new" }), fetch: stubFetch(byQuery).fetch, clock });
    assert.ok((await fresh.tokenFlow(TOKEN_B)).ok);
    fresh.close();
  });

  it("timeouts, network failures, refusals and wrong shapes are words, and a failed key is not re-asked at once", async () => {
    const clock = fakeClock();
    const hang = stubFetch((_c) => new Promise<Response>(() => {}));
    const hanging = new BitqueryLane({
      dir: tmp(),
      config: config(),
      clock,
      requestTimeoutMs: 20,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        void hang.fetch(url, init);
        return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }) as typeof fetch,
    });
    assert.deepEqual(await hanging.tokenFlow(TOKEN), { ok: false, failure: "timeout" });
    hanging.close();

    const net = new BitqueryLane({ dir: tmp(), config: config(), clock, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    assert.deepEqual(await net.tokenFlow(TOKEN), { ok: false, failure: "network" });
    net.close();

    const logs: string[] = [];
    const refused = stubFetch(() => json({ errors: [{ message: `Field 'Trades' unknown for 0x${"ab".repeat(20)} with key ory_at_test` }] }));
    const r = new BitqueryLane({ dir: tmp(), config: config(), clock, fetch: refused.fetch, log: (l) => logs.push(l) });
    assert.deepEqual(await r.tokenFlow(TOKEN), { ok: false, failure: "invalid-body" });
    assert.match(logs.join("\n"), /tokenFlow was refused by the provider: Field 'Trades' unknown for 0x… with key \*\*\*/);
    assert.deepEqual(await r.tokenFlow(TOKEN), { ok: false, failure: "invalid-body" });
    assert.equal(refused.calls.length, 1, "inside the failure TTL the same key is not re-asked");
    clock.advance(BITQUERY_LANE_DEFAULTS.failureTtlMs + 1);
    await r.tokenFlow(TOKEN);
    assert.equal(refused.calls.length, 2);
    r.close();

    const shaped = new BitqueryLane({ dir: tmp(), config: config(), clock, fetch: stubFetch(() => json({ data: { Trading: {} } })).fetch });
    assert.deepEqual(await shaped.tokenFlow(TOKEN), { ok: false, failure: "invalid-shape" });
    shaped.close();
  });

  it("a request that names no token is refused before anything is spent; a closed lane is unavailable", async () => {
    const { fetch, calls } = stubFetch(byQuery);
    const lane = new BitqueryLane({ dir: tmp(), config: config(), fetch, clock: fakeClock() });
    assert.deepEqual(await lane.tokenFlow("0xnope"), { ok: false, failure: "invalid-request" });
    assert.equal(calls.length, 0);
    assert.equal(lane.spentToday()!.points, 0);
    lane.close();
    assert.deepEqual(await lane.tokenFlow(TOKEN), { ok: false, failure: "unavailable" });
  });
});
