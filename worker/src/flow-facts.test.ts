/**
 * What flow facts may say, and the ways each renderer could lie.
 *
 * The validator is the child's side of an IPC wire and trusts nothing; the
 * renderers are what a model (a Brain lens, later) and a public reply (X) get
 * to read, so each rule below is pinned where it would break.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FLOW_WINDOWS,
  flowFactLines,
  flowFactsOf,
  flowNumber,
  flowResultOf,
  isFlowFailure,
  renderFlowLens,
  type FlowFacts,
} from "./flow-facts";

const TOKEN = "0x00000000000000000000000000000000000000c1" as const;
const NOW = Date.parse("2026-10-12T02:00:00Z");

function facts(over: Partial<FlowFacts> = {}): FlowFacts {
  return {
    token: TOKEN,
    observedAt: NOW - 12_000,
    windows: [
      { minutes: 5, buyUsd: 412.5, sellUsd: 120.25, buys: 4, sells: 2, buyers: 3, sellers: 2 },
      { minutes: 15, buyUsd: 1388.9, sellUsd: 610, buys: 11, sells: 5, buyers: 8, sellers: 4 },
      { minutes: 60, buyUsd: 5120.75, sellUsd: 2310.4, buys: 40, sells: 18, buyers: 27, sellers: 12 },
    ],
    venues: [{ protocol: "uniswap_v4", family: "uniswap", buyUsd: 4020.5, sellUsd: 1800.4, buys: 31, sells: 13 }],
    largestSells: [{ usd: 512.75, at: NOW / 1000 - 1200, protocol: "uniswap_v4" }],
    creator: { state: "read", windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 0, transferOutUsd: 0 },
    ...over,
  };
}

describe("the failure vocabulary", () => {
  it("is the feeds' own, and nothing else passes for it", () => {
    for (const f of ["unavailable", "budget", "provider-cooldown", "timeout", "network", "invalid-body", "invalid-shape", "invalid-request", "http-429", "http-503"]) {
      assert.ok(isFlowFailure(f), f);
    }
    for (const f of ["", "error", "http-42", "http-999", "timeout ", "Budget", 7, null]) assert.equal(isFlowFailure(f), false, String(f));
  });
});

describe("flowFactsOf — the child trusts nothing on the wire", () => {
  it("a round trip through JSON is the same reading", () => {
    const f = facts();
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f))), f);
    assert.deepEqual(flowResultOf({ ok: true, facts: f }), { ok: true, facts: f });
    assert.deepEqual(flowResultOf({ ok: false, failure: "budget" }), { ok: false, failure: "budget" });
  });

  it("one field in the wrong shape rejects the whole reading — a defaulted count is a fabricated one", () => {
    const bad: unknown[] = [
      { ...facts(), token: "0xNOPE" },
      { ...facts(), token: TOKEN.toUpperCase() },
      { ...facts(), observedAt: -1 },
      { ...facts(), windows: facts().windows.slice(0, 2) },
      { ...facts(), windows: [...facts().windows].reverse() },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, buys: 1.5 } : w)) },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, buyUsd: "412" } : w)) },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, sellers: -1 } : w)) },
      { ...facts(), venues: [{ ...facts().venues[0]!, protocol: "Uniswap V4" }] },
      { ...facts(), venues: Array.from({ length: 9 }, () => facts().venues[0]) },
      { ...facts(), largestSells: [{ usd: 5, at: 0, protocol: null }] },
      { ...facts(), creator: { state: "sold" } },
      { ...facts(), creator: { state: "unavailable", failure: "exploded" } },
      { ...facts(), creator: { state: "read", windowMin: 60, sells: "1", sellUsd: 0, transfersOut: 0, transferOutUsd: 0 } },
    ];
    for (const b of bad) assert.equal(flowFactsOf(b), null, JSON.stringify(b).slice(0, 120));
    assert.equal(flowResultOf({ ok: true }), null);
    assert.equal(flowResultOf({ ok: false, failure: "nope" }), null);
  });

  it("null stays null: an unknown is carried as unknown", () => {
    const f = facts({ windows: facts().windows.map((w) => ({ ...w, buyers: null })) });
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f)))?.windows.map((w) => w.buyers), [null, null, null]);
  });

  it("flowNumber reads numbers and numeric strings, and nothing negative, infinite or absurd", () => {
    assert.equal(flowNumber("12.5"), 12.5);
    assert.equal(flowNumber(3, true), 3);
    for (const v of ["-1", "1e400", Infinity, NaN, "12abc", "", null, undefined, {}, 2e12]) assert.equal(flowNumber(v), null, String(v));
    assert.equal(flowNumber(2.5, true), null);
  });
});

describe("renderFlowLens — attribution first, labelled, never a verdict from absence", () => {
  it("opens with whose data this is and that it is not a forecast, then one JSON object, then what it is not", () => {
    const text = renderFlowLens({ ok: true, facts: facts() }, NOW)!;
    const [first, body, last] = text.split("\n");
    assert.match(first!, /^Source: an on-chain indexer's record of DEX trades.*Indexer data, not a forecast\.$/);
    assert.match(last!, /^WHAT THIS IS NOT:/);
    const j = JSON.parse(body!) as { ageSec: number; windows: Record<string, { netUsd: number; buyers: number }>; creator: { state: string } };
    assert.equal(j.ageSec, 12);
    assert.deepEqual(Object.keys(j.windows), FLOW_WINDOWS.map((m) => `${m}m`));
    assert.equal(j.windows["60m"]!.netUsd, 2810, "net flow, whole dollars from $100");
    assert.equal(j.windows["5m"]!.netUsd, 292, "412.50 - 120.25");
    assert.equal(j.creator.state, "read");
    assert.ok(text.length <= 1200);
  });

  it("names no vendor, and carries no address, hash or wallet", () => {
    const text = renderFlowLens({ ok: true, facts: facts() }, NOW)!;
    assert.doesNotMatch(text, /bitquery/i);
    assert.doesNotMatch(text, /0x[0-9a-f]{6,}/i, "the token itself is not in the block: Brain names instruments, code maps addresses");
  });

  it("renders NOTHING for a failure or an hour with no indexed trades — absence is not a verdict", () => {
    assert.equal(renderFlowLens({ ok: false, failure: "budget" }, NOW), null);
    const silent = facts({ windows: FLOW_WINDOWS.map((minutes) => ({ minutes, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 })), venues: [], largestSells: [] });
    assert.equal(renderFlowLens({ ok: true, facts: silent }, NOW), null);
  });

  it("an unknown is null in the block, never zero", () => {
    const text = renderFlowLens({ ok: true, facts: facts({ windows: facts().windows.map((w) => (w.minutes === 15 ? { ...w, sellUsd: null } : w)) }) }, NOW)!;
    const j = JSON.parse(text.split("\n")[1]!) as { windows: Record<string, { sellUsd: number | null; netUsd: number | null }> };
    assert.equal(j.windows["15m"]!.sellUsd, null);
    assert.equal(j.windows["15m"]!.netUsd, null, "a net of an unknown is unknown");
  });

  it("a creator that cannot be known says so, and is never read as 'did not sell'", () => {
    const nd = JSON.parse(renderFlowLens({ ok: true, facts: facts({ creator: { state: "not-derivable" } }) }, NOW)!.split("\n")[1]!) as { creator: unknown };
    assert.deepEqual(nd.creator, { state: "not-derivable" });
    const un = JSON.parse(renderFlowLens({ ok: true, facts: facts({ creator: { state: "unavailable", failure: "timeout" } }) }, NOW)!.split("\n")[1]!) as { creator: unknown };
    assert.deepEqual(un.creator, { state: "unknown" });
  });
});

describe("flowFactLines — what an X answer may paraphrase", () => {
  it("short, attributed, and about the coin's public tape only", () => {
    const lines = flowFactLines({ ok: true, facts: facts() });
    assert.deepEqual(lines, [
      "on-chain DEX data, last 15m: $1.4k bought vs $610 sold (8 buyers, 4 sellers)",
      "on-chain DEX data, last 60m: $5.1k bought vs $2.3k sold (27 buyers, 12 sellers)",
      "on-chain DEX data: biggest single sell in the last hour was about $513",
      "on-chain data: no creator-wallet sells or transfers out indexed in the last 60m",
    ]);
    for (const l of lines) {
      assert.match(l, /^on-chain/, "every line keeps its attribution");
      assert.doesNotMatch(l, /0x|bitquery|pnl|p&l|position/i);
    }
  });

  it("a creator who sold, or moved tokens out, is said plainly — and an unknown creator is not mentioned", () => {
    const sold = flowFactLines({ ok: true, facts: facts({ creator: { state: "read", windowMin: 60, sells: 2, sellUsd: 830, transfersOut: 3, transferOutUsd: 1210 } }) });
    assert.match(sold.at(-1)!, /creator's wallet sold in the last 60m/);
    const moved = flowFactLines({ ok: true, facts: facts({ creator: { state: "read", windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 1, transferOutUsd: 50 } }) });
    assert.match(moved.at(-1)!, /moved tokens out .* no DEX sell indexed/);
    for (const creator of [{ state: "not-derivable" as const }, { state: "unavailable" as const, failure: "timeout" as const }]) {
      assert.ok(flowFactLines({ ok: true, facts: facts({ creator }) }).every((l) => !/creator/.test(l)));
    }
  });

  it("nothing to say is an empty list, never 'no activity'", () => {
    assert.deepEqual(flowFactLines({ ok: false, failure: "provider-cooldown" }), []);
    const silent = facts({ windows: FLOW_WINDOWS.map((minutes) => ({ minutes, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 })) });
    assert.deepEqual(flowFactLines({ ok: true, facts: silent }), []);
  });

  it("the lane's parsed fixture renders end to end", async () => {
    const { parseTokenFlow } = await import("./venues/bitquery-lane");
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const data = (JSON.parse(readFileSync(path.join(HERE, "venues", "testdata", "bitquery-lane", "token-flow.json"), "utf8")) as { data: unknown }).data;
    const read = parseTokenFlow(data)!;
    const f: FlowFacts = { token: TOKEN, observedAt: NOW, ...read, creator: { state: "not-derivable" } };
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f))), f, "what the lane produces is what the wire accepts");
    assert.ok(renderFlowLens({ ok: true, facts: f }, NOW));
  });
});
