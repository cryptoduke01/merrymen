/**
 * The orchestrator's flow service and its glue: who may ask, on whose budget,
 * and where a creator's address comes from — the three things a lane cannot
 * decide for itself.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { createFlowClient, type FlowPort } from "./flow-broker";
import { attachFlowBroker, CREATOR_WINDOW_MIN, makeFlowService, startFlowRuntime, type CreatorLookup, type FlowService } from "./orchestrator-flow";
import type { BitqueryLane, LaneAnswer, CreatorFlowRead, TokenFlowRead } from "./venues/bitquery-lane";

const TOKEN = "0x00000000000000000000000000000000000000c1";
const CREATOR = "0x00000000000000000000000000000000000000a7";
const ALAN_ACCOUNT = "0x7Ac219f42F2303630646e09aa6507B0349bc5523";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const READ: TokenFlowRead = {
  windows: [5, 15, 60].map((minutes) => ({ minutes: minutes as 5 | 15 | 60, buyUsd: 10, sellUsd: 4, buys: 2, sells: 1, buyers: 2, sellers: 1 })),
  venues: [],
  largestSells: [],
};

function fakeLane(o: { flow?: LaneAnswer<TokenFlowRead>; creator?: LaneAnswer<CreatorFlowRead> } = {}) {
  const calls: { q: string; args: unknown[] }[] = [];
  const lane: Pick<BitqueryLane, "tokenFlow" | "creatorFlow"> = {
    async tokenFlow(...args) {
      calls.push({ q: "tokenFlow", args });
      return o.flow ?? { ok: true, data: READ, observedAt: 1_000, servedFrom: "live" };
    },
    async creatorFlow(...args) {
      calls.push({ q: "creatorFlow", args });
      return o.creator ?? { ok: true, data: { sells: 1, sellUsd: 50, transfersOut: 1, transferOutUsd: 50 }, observedAt: 1_000, servedFrom: "live" };
    },
  };
  return { lane, calls };
}

describe("makeFlowService — one reading, assembled on the orchestrator", () => {
  it("joins the flow and the creator's sells, the creator resolved here from the chain", async () => {
    const { lane, calls } = fakeLane();
    const looked: string[] = [];
    const svc = makeFlowService({ lane, creatorOf: async (t) => (looked.push(t), { state: "known", creator: CREATOR }) });
    const r = await svc.flowFor(TOKEN.toUpperCase().replace("0X", "0x"));
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "read", windowMin: CREATOR_WINDOW_MIN, sells: 1, sellUsd: 50, transfersOut: 1, transferOutUsd: 50 });
    assert.equal(r.facts.observedAt, 1_000);
    assert.deepEqual(looked, [TOKEN]);
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow", "creatorFlow"]);
    assert.deepEqual(calls[1]!.args.slice(0, 2), [TOKEN, CREATOR]);
    assert.ok(!JSON.stringify(r).includes(CREATOR.slice(2)), "the creator's address is a query variable, never part of the reading");
  });

  it("a coin with no recorded creator is 'not-derivable', and nothing is spent asking", async () => {
    const { lane, calls } = fakeLane();
    const r = await makeFlowService({ lane, creatorOf: async () => ({ state: "none" }) }).flowFor(TOKEN);
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "not-derivable" });
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow"]);
  });

  it("an unreadable chain, or a failed creator query, is 'unavailable' — never 'did not sell'", async () => {
    const a = await makeFlowService({ lane: fakeLane().lane, creatorOf: async () => { throw new Error("rpc down"); } }).flowFor(TOKEN);
    assert.ok(a.ok);
    assert.deepEqual(a.facts.creator, { state: "unavailable", failure: "unavailable" });
    const b = await makeFlowService({ lane: fakeLane({ creator: { ok: false, failure: "budget" } }).lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.ok(b.ok);
    assert.deepEqual(b.facts.creator, { state: "unavailable", failure: "budget" });
  });

  it("a failed flow reading is the whole answer, and the creator's query is never sent", async () => {
    const { lane, calls } = fakeLane({ flow: { ok: false, failure: "provider-cooldown" } });
    const r = await makeFlowService({ lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) }).flowFor(TOKEN);
    assert.deepEqual(r, { ok: false, failure: "provider-cooldown" });
    assert.deepEqual(calls.map((c) => c.q), ["tokenFlow"]);
  });

  it("the purpose decides the budget share, and the caller cannot pick a window", async () => {
    const { lane, calls } = fakeLane();
    const svc = makeFlowService({ lane, creatorOf: async () => ({ state: "known", creator: CREATOR }) });
    await svc.flowFor(TOKEN, { purpose: "evidence" });
    assert.deepEqual(calls.map((c) => (c.args.at(-1) as { purpose: string }).purpose), ["evidence", "evidence"]);
    assert.equal((calls[1]!.args[2] as { windowMin: number }).windowMin, CREATOR_WINDOW_MIN);
  });

  it("a creator lookup is remembered, a failed one only briefly", async () => {
    let t = 0;
    let n = 0;
    let answer: CreatorLookup = { state: "unreadable" };
    const svc = makeFlowService({ lane: fakeLane().lane, now: () => t, creatorOf: async () => (n++, answer) });
    await svc.flowFor(TOKEN);
    t += 61_000;
    answer = { state: "known", creator: CREATOR };
    await svc.flowFor(TOKEN);
    t += 12 * 3_600_000;
    await svc.flowFor(TOKEN);
    assert.equal(n, 2, "unreadable retried after a minute; known kept for a day");
  });

  it("a recorded 'creator' that is the token itself is no creator", async () => {
    const r = await makeFlowService({ lane: fakeLane().lane, creatorOf: async () => ({ state: "known", creator: TOKEN as `0x${string}` }) }).flowFor(TOKEN);
    assert.ok(r.ok);
    assert.deepEqual(r.facts.creator, { state: "not-derivable" });
  });

  it("not a token is 'invalid-request'; nothing throws", async () => {
    const svc = makeFlowService({ lane: fakeLane().lane, creatorOf: async () => ({ state: "none" }) });
    assert.deepEqual(await svc.flowFor("pepe"), { ok: false, failure: "invalid-request" });
    const broken = makeFlowService({ lane: { tokenFlow: () => { throw new Error("boom"); }, creatorFlow: async () => ({ ok: false, failure: "network" }) }, creatorOf: async () => ({ state: "none" }) });
    assert.deepEqual(await broken.flowFor(TOKEN), { ok: false, failure: "unavailable" });
  });
});

describe("startFlowRuntime — off without a key, and nothing built while off", () => {
  it("no key: no service, no store, a line saying so", () => {
    const lines: string[] = [];
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-rt-"));
    const rt = startFlowRuntime({ env: {}, home, rpcUrl: "https://example.invalid", log: (l) => lines.push(l) });
    assert.equal(rt.service, null);
    assert.match(lines.join("\n"), /bitquery lane: off/);
  });

  it("with a key: a service, its store under the fleet home, and the key never logged", () => {
    const lines: string[] = [];
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-rt-"));
    const rt = startFlowRuntime({ env: { MERRYMEN_BITQUERY_API_KEY: "ory_at_never_logged" }, home, rpcUrl: "https://example.invalid", log: (l) => lines.push(l) });
    assert.ok(rt.service);
    assert.doesNotMatch(lines.join("\n"), /ory_at_never_logged/);
    assert.ok(readFileSync(path.join(home, "bitquery-lane", "lane.sqlite")).length >= 0, "the fleet cache lives under the fleet home");
  });
});

/** A ChildProcess stand-in whose channel is an in-memory pair. */
function fakeChild(): { proc: ChildProcess; childPort: FlowPort; exit(): void } {
  const proc = new EventEmitter() as EventEmitter & { connected: boolean; send: (m: unknown, cb?: () => void) => boolean };
  const childSide = new EventEmitter();
  proc.connected = true;
  proc.send = (m, cb) => {
    setImmediate(() => childSide.emit("message", JSON.parse(JSON.stringify(m))));
    cb?.();
    return true;
  };
  const childPort: FlowPort = {
    send(m) {
      setImmediate(() => proc.emit("message", JSON.parse(JSON.stringify(m))));
      return true;
    },
    onMessage(h) {
      childSide.on("message", h);
      return () => childSide.off("message", h);
    },
    connected: () => proc.connected,
  };
  return { proc: proc as unknown as ChildProcess, childPort, exit: () => proc.emit("exit", 0) };
}

describe("attachFlowBroker — only allowlisted accounts, only as evidence", () => {
  const service = (): FlowService & { purposes: string[] } => {
    const purposes: string[] = [];
    return {
      purposes,
      async flowFor(t, o) {
        purposes.push(o?.purpose ?? "?");
        return { ok: true, facts: { token: t.toLowerCase() as `0x${string}`, observedAt: 1, ...READ, creator: { state: "not-derivable" } } };
      },
    };
  };

  it("an account on MERRYMEN_DECISION_RESEARCH_ACCOUNTS gets readings, spent from the evidence share", async () => {
    const svc = service();
    const c = fakeChild();
    attachFlowBroker(svc, "0xab7bdeb2d75cf8ab224774cfc45b61c2c169e291", c.proc, ALAN_ACCOUNT, () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: ALAN_ACCOUNT.toLowerCase() });
    const r = await createFlowClient(c.childPort).facts(TOKEN);
    assert.equal(r.ok, true);
    assert.deepEqual(svc.purposes, ["evidence"]);
  });

  it("any other account is answered 'unavailable' and costs nothing", async () => {
    const svc = service();
    const c = fakeChild();
    attachFlowBroker(svc, "0xother", c.proc, "0x00000000000000000000000000000000000000b0", () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: ALAN_ACCOUNT });
    assert.deepEqual(await createFlowClient(c.childPort).facts(TOKEN), { ok: false, failure: "unavailable" });
    assert.deepEqual(svc.purposes, []);
  });

  it("a no-op with the lane off or without a channel, and released when the child exits", async () => {
    const c = fakeChild();
    assert.equal(attachFlowBroker(null, "0xt", c.proc, ALAN_ACCOUNT, () => {}), null);
    const unconnected = fakeChild();
    (unconnected.proc as unknown as { connected: boolean }).connected = false;
    assert.equal(attachFlowBroker(service(), "0xt", unconnected.proc, ALAN_ACCOUNT, () => {}), null);
    const svc = service();
    const live = fakeChild();
    assert.ok(attachFlowBroker(svc, "0xt", live.proc, ALAN_ACCOUNT, () => {}, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: ALAN_ACCOUNT }));
    assert.equal((live.proc as unknown as EventEmitter).listenerCount("message"), 1);
    live.exit();
    assert.equal((live.proc as unknown as EventEmitter).listenerCount("message"), 0, "released on exit");
  });
});

describe("the orchestrator's wiring", () => {
  const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");

  it("attaches the flow broker right after the Fomo broker, with the smart account it spawned the child for", () => {
    const spawnChild = SRC.slice(SRC.indexOf("async function spawnChild("), SRC.indexOf("export type PaperRestore"));
    assert.match(spawnChild, /attachFomoBroker\(tenant, proc\);[\s\S]{0,300}attachFlowBroker\(flowRuntimeNow\(\)\.service, tenant, proc, smartAccount, log\);/);
  });

  it("does not open an IPC channel of its own: the spawn's stdio is still Fomo's decision", () => {
    assert.match(SRC, /stdio: fomoBootNow\(\)\.off \? \["ignore", "pipe", "pipe"\] : \["ignore", "pipe", "pipe", "ipc"\]/);
  });

  it("says the lane's switches at boot, right after Fomo's", () => {
    const boot = SRC.slice(SRC.indexOf("export async function runOrchestrator("));
    assert.match(boot, /fomoBootNow\(\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*flowRuntimeNow\(\);/);
  });

  it("exports flowFor for the orchestrator's own answers, on the whole day's budget", () => {
    assert.match(SRC, /export async function flowFor\(token: string\): Promise<FlowResult> \{[\s\S]{0,200}purpose: "answer"/);
  });

  it("MERRYMEN_BITQUERY_API_KEY is read by the orchestrator's setup alone — never by a child's code", () => {
    const files = ["index.ts", "settings.ts", "flow-broker.ts", "flow-facts.ts", "orchestrator-flow.ts", "venues/bitquery.ts", "venues/bitquery-lane.ts"];
    const readers = files.filter((f) => /process\.env\.MERRYMEN_BITQUERY_API_KEY|env\.MERRYMEN_BITQUERY_API_KEY/.test(readFileSync(path.join(HERE, f), "utf8")));
    assert.deepEqual(readers, ["venues/bitquery-lane.ts"], "only bitqueryLaneSetup reads it, from the env the orchestrator hands it");
    const index = readFileSync(path.join(HERE, "index.ts"), "utf8");
    assert.doesNotMatch(index, /from "\.\/venues\/bitquery-lane"|from "\.\/orchestrator-flow"/, "a child never imports the lane");
    assert.doesNotMatch(readFileSync(path.join(HERE, "venues", "bitquery-lane.ts"), "utf8"), /process\.env/, "the lane takes its env as an argument");
  });

  it("flow facts name no vendor, so nothing downstream learns one", () => {
    for (const f of ["flow-facts.ts", "flow-broker.ts"]) {
      const code = readFileSync(path.join(HERE, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /bitquery/i, `${f} speaks flow, not a supplier`);
    }
  });
});
