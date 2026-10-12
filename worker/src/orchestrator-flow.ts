/**
 * THE ORCHESTRATOR'S FLOW SERVICE — Bitquery lane in, flow facts out.
 *
 * Kept beside orchestrator.ts, as orchestrator-xpost.ts and orchestrator-fomo.ts
 * are, so the orchestrator's own diff is a handful of lines: build the runtime
 * once, export `flowFor`, attach the broker to each child it spawns.
 *
 * WHO ASKS, AND ON WHOSE BUDGET.
 *
 *   flowFor(token)          the orchestrator's own answers (X replies). Spends
 *                           from the whole day's points.
 *   a child, over IPC       decision evidence for a review. Spends from the
 *                           evidence share only (bitquery-lane.ts), and only a
 *                           child whose smart account the operator listed in
 *                           MERRYMEN_DECISION_RESEARCH_ACCOUNTS may ask at all.
 *
 * THE CREATOR IS RESOLVED HERE, FROM THE CHAIN. Whether a coin's creator sold
 * needs the creator's address, and a caller that could supply one could point
 * the lane at any wallet — another tenant's account included — and learn what
 * it sold. So nobody supplies it: this process reads the deployer the token
 * itself records (pons-meta.ts readTokenDeployer), and a coin that records
 * none is "not-derivable", never "did not sell". The address is used as a
 * query variable and goes no further: no fact, log line or reply carries it.
 */

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { decisionResearchEnabledFor } from "./decision-research";
import { childProcessFlowPort, serveFlowRequests } from "./flow-broker";
import type { CreatorFlow, FlowResult } from "./flow-facts";
import { merrymenHome } from "./home";
import { BitqueryLane, bitqueryLaneSetup, type BitqueryLaneSetup, type LanePurpose } from "./venues/bitquery-lane";
import { readTokenDeployer } from "./venues/pons-meta";

export type CreatorLookup = { state: "known"; creator: `0x${string}` } | { state: "none" } | { state: "unreadable" };

export interface FlowService {
  /** Flow facts for a token, or the word for why not. Never throws; bounded by the lane's own deadlines. */
  flowFor(token: string, opts?: { purpose?: LanePurpose }): Promise<FlowResult>;
}

/** The window the creator question covers, in minutes: the widest flow window. */
export const CREATOR_WINDOW_MIN = 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A recorded deployer does not change; a failed read is retried soon. */
const CREATOR_TTL_MS = { known: 24 * 3_600_000, none: 24 * 3_600_000, unreadable: 60_000 } as const;
const CREATOR_CACHE_MAX = 2048;

export function makeFlowService(deps: {
  lane: Pick<BitqueryLane, "tokenFlow" | "creatorFlow">;
  creatorOf: (token: `0x${string}`) => Promise<CreatorLookup>;
  now?: () => number;
}): FlowService {
  const now = deps.now ?? Date.now;
  const creators = new Map<string, { lookup: CreatorLookup; until: number }>();

  async function creatorOf(token: `0x${string}`): Promise<CreatorLookup> {
    const hit = creators.get(token);
    if (hit && hit.until > now()) return hit.lookup;
    let lookup: CreatorLookup;
    try {
      lookup = await deps.creatorOf(token);
    } catch {
      lookup = { state: "unreadable" };
    }
    if (lookup.state === "known" && (!ADDRESS.test(lookup.creator) || lookup.creator.toLowerCase() === token)) lookup = { state: "none" };
    if (creators.size >= CREATOR_CACHE_MAX) creators.delete(creators.keys().next().value!);
    creators.set(token, { lookup, until: now() + CREATOR_TTL_MS[lookup.state] });
    return lookup;
  }

  return {
    async flowFor(raw, opts = {}) {
      try {
        if (typeof raw !== "string" || !ADDRESS.test(raw) || /^0x0{40}$/i.test(raw)) return { ok: false, failure: "invalid-request" };
        const token = raw.toLowerCase() as `0x${string}`;
        const purpose = opts.purpose ?? "answer";
        // The chain read runs beside the flow query; the creator's own query
        // waits for the flow to succeed, so a failed reading spends no more.
        const creatorP = creatorOf(token);
        const flow = await deps.lane.tokenFlow(token, { purpose });
        if (!flow.ok) return { ok: false, failure: flow.failure };
        const look = await creatorP;
        let creator: CreatorFlow;
        if (look.state === "none") creator = { state: "not-derivable" };
        else if (look.state === "unreadable") creator = { state: "unavailable", failure: "unavailable" };
        else {
          const c = await deps.lane.creatorFlow(token, look.creator, { purpose, windowMin: CREATOR_WINDOW_MIN });
          creator = c.ok ? { state: "read", windowMin: CREATOR_WINDOW_MIN, ...c.data } : { state: "unavailable", failure: c.failure };
        }
        return { ok: true, facts: { token, observedAt: flow.observedAt, ...flow.data, creator } };
      } catch {
        return { ok: false, failure: "unavailable" };
      }
    },
  };
}

/** The deployer a Pons-template token records, through this process's RPC. */
export function ponsCreatorLookup(client: () => PublicClient): (token: `0x${string}`) => Promise<CreatorLookup> {
  return async (token) => {
    try {
      const r = await readTokenDeployer(client(), token);
      return r.state === "known" ? { state: "known", creator: r.deployer } : r;
    } catch {
      return { state: "unreadable" };
    }
  };
}

export interface FlowRuntime {
  setup: BitqueryLaneSetup;
  /** Null while the lane is off: every flow question then answers "unavailable". */
  service: FlowService | null;
}

/**
 * Read the switches and build the lane, once. Off — no key, or
 * MERRYMEN_BITQUERY_LANE=0 — there is no SQLite file, no RPC client and no
 * request. A lane whose file cannot be opened is off too, and says why.
 */
export function startFlowRuntime(o: { env: Record<string, string | undefined>; home: string; rpcUrl: string; log: (line: string) => void }): FlowRuntime {
  const setup = bitqueryLaneSetup(o.env);
  for (const line of setup.lines) o.log(line);
  if (setup.off || !setup.config) return { setup, service: null };
  try {
    const lane = new BitqueryLane({ dir: path.join(o.home, "bitquery-lane"), config: setup.config, log: o.log });
    let client: PublicClient | null = null;
    const rpc = (): PublicClient => (client ??= createPublicClient({ transport: http(o.rpcUrl) }));
    return { setup, service: makeFlowService({ lane, creatorOf: ponsCreatorLookup(rpc) }) };
  } catch (e) {
    o.log(`bitquery lane: off — its store could not be opened (${e instanceof Error ? e.name : "error"})`);
    return { setup, service: null };
  }
}

/**
 * THE PROCESS'S ONE RUNTIME, held here rather than in orchestrator.ts so the
 * passes that answer on X (orchestrator-xpost.ts and its kin, which
 * orchestrator.ts imports) can import `flowFor` from this file without a
 * cycle. Built on first use; the orchestrator builds it at boot so its line
 * lands in the boot log, with the orchestrator's own log prefix.
 *
 * Reads process.env, which is safe for the reason CHILD_SECRET_STRIP exists:
 * in a child the key is gone, so the lane is off and every answer is
 * "unavailable". A child has no reason to import this file, and
 * orchestrator-flow.test.ts pins that index.ts does not.
 */
let runtime: FlowRuntime | null = null;

export const DEFAULT_RPC_MAINNET = "https://rpc.mainnet.chain.robinhood.com";

export function flowRuntimeNow(o: { log?: (line: string) => void } = {}): FlowRuntime {
  runtime ??= startFlowRuntime({
    env: process.env,
    home: merrymenHome(),
    // The same default every other read in the orchestrator uses.
    rpcUrl: process.env.MERRYMEN_RPC_MAINNET ?? DEFAULT_RPC_MAINNET,
    log: o.log ?? ((line) => console.log(`[orchestrator] ${line}`)),
  });
  return runtime;
}

/** Test seam: forget the runtime so the next use reads the environment again. */
export function resetFlowRuntimeForTest(): void {
  runtime = null;
}

/**
 * FLOW FACTS FOR A TOKEN, for the orchestrator's own answers (X replies): DEX
 * buys and sells over 5/15/60 minutes, the venue split, the largest sells, and
 * whether the coin's recorded creator sold — or the word for why not
 * (flow-facts.ts). Spends from the lane's whole day; never throws, never
 * stalls a pass. flowFactLines() turns a result into lines a writer may
 * paraphrase; renderFlowLens() into a labelled block for a Brain lens.
 */
export async function flowFor(token: string): Promise<FlowResult> {
  const service = flowRuntimeNow().service;
  return service ? service.flowFor(token, { purpose: "answer" }) : { ok: false, failure: "unavailable" };
}

/**
 * Answer one child's flow questions on its IPC channel, as decision evidence.
 * A no-op with the lane off or without a connected channel (the channel exists
 * while the Fomo pass is on). The allowlist is read on every request, by the
 * smart account THIS process spawned the child for. Released when it exits.
 */
export function attachFlowBroker(
  service: FlowService | null,
  tenant: string,
  proc: ChildProcess,
  smartAccount: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | null {
  if (!service || proc.connected !== true) return null;
  try {
    const release = serveFlowRequests(childProcessFlowPort(proc), tenant.toLowerCase(), (t) => service.flowFor(t, { purpose: "evidence" }), {
      allowed: () => decisionResearchEnabledFor(smartAccount, env),
      log,
    });
    proc.once("exit", release);
    return release;
  } catch (e) {
    log(`bitquery lane: flow broker not attached (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
}
