/**
 * FLOW FACTS — what an on-chain indexer can honestly be quoted as saying about
 * the DEX trades in one coin over the last hour, and nothing more.
 *
 * Pure and vendor-neutral. The orchestrator's Bitquery lane
 * (venues/bitquery-lane.ts) produces these; children receive them over IPC
 * (flow-broker.ts); X answers and, later, a Brain lens read them. None of those
 * consumers needs to know which indexer answered, so none of them is told: a
 * brand in a prompt is an invitation to recall whatever the model believes
 * about it, and a brand in a persisted decision is a migration waiting to
 * happen when the supplier changes (research-boundary.test.ts, the same rule).
 *
 * WHAT THESE ARE NOT. Not a price, not a forecast, not a signal, and never an
 * input to equity, P&L, sizing, a cap or a guard. A third party's count of
 * trades is a reason to look harder at a coin, the way a crowd outside a shop
 * is: it says nothing about whether the crowd is right, or whether it is one
 * person in many coats. Separate wallets are not proven separate people.
 *
 * UNKNOWN IS NEVER ZERO. Every number is `number | null`. A null is an
 * aggregate the indexer did not return; a 0 is the indexer saying "none". The
 * two have different remedies and must not be rendered alike.
 */

/** The trailing windows every flow reading covers, in minutes. Fixed: callers cannot widen them. */
export const FLOW_WINDOWS = [5, 15, 60] as const;
export type FlowWindowMin = (typeof FLOW_WINDOWS)[number];

/**
 * Why a reading is not here. The vocabulary the market feeds already use
 * (trencher-brain.ts, venues/fleet-feed-cache.ts), so one log grep covers them:
 *
 *   unavailable        the lane is off, unreachable, or this caller may not ask
 *   budget             our own knob refused it: daily points, rate or a busy lane
 *   provider-cooldown  the provider refused recently (429 and friends); waiting it out
 *   timeout            no answer in time; the call may still have been billed
 *   network            the request never got a response
 *   invalid-body       a response arrived but was not a usable answer
 *   invalid-shape      an answer arrived in a shape this code does not read
 *   invalid-request    the caller asked about something that is not a token
 *   http-NNN           the provider answered with that status
 */
export type FlowFailure =
  | "unavailable"
  | "budget"
  | "provider-cooldown"
  | "timeout"
  | "network"
  | "invalid-body"
  | "invalid-shape"
  | "invalid-request"
  | `http-${number}`;

const FAILURE_SHAPE = /^(?:unavailable|budget|provider-cooldown|timeout|network|invalid-body|invalid-shape|invalid-request|http-[1-5]\d\d)$/;

export function isFlowFailure(v: unknown): v is FlowFailure {
  return typeof v === "string" && FAILURE_SHAPE.test(v);
}

/** One trailing window of a coin's DEX tape. */
export interface FlowWindow {
  minutes: FlowWindowMin;
  buyUsd: number | null;
  sellUsd: number | null;
  buys: number | null;
  sells: number | null;
  /** Distinct addresses that bought. Harder to fake than a count, still not people. */
  buyers: number | null;
  sellers: number | null;
}

/** One venue's share of the last hour. `protocol` is the indexer's own slug, sanitised. */
export interface FlowVenue {
  protocol: string;
  family: string | null;
  buyUsd: number | null;
  sellUsd: number | null;
  buys: number | null;
  sells: number | null;
}

/** One of the largest single sells in the last hour. No wallet, no hash: a size and a time. */
export interface FlowSell {
  usd: number;
  /** Unix seconds. */
  at: number;
  protocol: string | null;
}

/**
 * Did the coin's creator sell, as far as the indexer can tell?
 *
 *   not-derivable  no creator is known for this coin from a trusted on-chain
 *                  source (only Pons-template coins publish one), so nothing
 *                  was asked. Not "the creator did not sell".
 *   unavailable    a creator is known but the read failed.
 *   read           the indexer answered for the window.
 *
 * The creator's address is never part of a fact: it is resolved and used on
 * the orchestrator and goes no further.
 */
export type CreatorFlow =
  | { state: "not-derivable" }
  | { state: "unavailable"; failure: FlowFailure }
  | {
      state: "read";
      windowMin: number;
      /** DEX sells by the creator's own address. */
      sells: number | null;
      sellUsd: number | null;
      /** Token transfers OUT of the creator's address of any kind: a sell, a move to another wallet, a pool. */
      transfersOut: number | null;
      transferOutUsd: number | null;
    };

export interface FlowFacts {
  token: `0x${string}`;
  /** When the indexer was asked (ms). A cached answer keeps its original time. */
  observedAt: number;
  windows: FlowWindow[];
  venues: FlowVenue[];
  largestSells: FlowSell[];
  creator: CreatorFlow;
}

export type FlowResult = { ok: true; facts: FlowFacts } | { ok: false; failure: FlowFailure };

// ── bounds ──────────────────────────────────────────────────────────────────

export const FLOW_LIMITS = Object.freeze({
  venues: 8,
  largestSells: 10,
  protocolChars: 32,
  /** A USD figure past this is an indexer artefact, not a memecoin's hour. */
  maxUsd: 1e12,
  maxCount: 1e9,
});

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** A finite, non-negative number from a number or a numeric string, or null. Integers when `int`. */
export function flowNumber(v: unknown, int = false): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  if (int) return Number.isSafeInteger(n) && n <= FLOW_LIMITS.maxCount ? n : null;
  return n <= FLOW_LIMITS.maxUsd ? n : null;
}

/** An indexer slug made safe to show and to put in a prompt: a known alphabet, capped, or null. */
export function flowSlug(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, FLOW_LIMITS.protocolChars);
  return s.length > 0 ? s : null;
}

// ── validation (the child's side of the wire trusts nothing) ───────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * A wire number: null, or a JSON number in range. Stricter than flowNumber on
 * purpose — the lane already turned the provider's strings into numbers, so a
 * string here is not a format quirk, it is a reading nobody parsed.
 */
const nullable = (v: unknown, int: boolean): number | null | undefined =>
  v === null ? null : typeof v === "number" ? flowNumber(v, int) ?? undefined : undefined;

function windowOf(v: unknown): FlowWindow | null {
  if (!isRec(v) || !FLOW_WINDOWS.includes(v.minutes as FlowWindowMin)) return null;
  const out: Partial<FlowWindow> = { minutes: v.minutes as FlowWindowMin };
  for (const [k, int] of [["buyUsd", false], ["sellUsd", false], ["buys", true], ["sells", true], ["buyers", true], ["sellers", true]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out as FlowWindow;
}

function venueOf(v: unknown): FlowVenue | null {
  if (!isRec(v)) return null;
  const protocol = flowSlug(v.protocol);
  if (!protocol || protocol !== v.protocol) return null;
  const family = v.family === null ? null : flowSlug(v.family);
  if (family !== v.family) return null;
  const out: FlowVenue = { protocol, family, buyUsd: null, sellUsd: null, buys: null, sells: null };
  for (const [k, int] of [["buyUsd", false], ["sellUsd", false], ["buys", true], ["sells", true]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out;
}

/** A positive safe integer clock reading (seconds or ms), or null. Not a count, so not count-capped. */
const timeOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

function sellOf(v: unknown): FlowSell | null {
  if (!isRec(v)) return null;
  const usd = typeof v.usd === "number" ? flowNumber(v.usd) : null;
  const at = timeOf(v.at);
  const protocol = v.protocol === null ? null : flowSlug(v.protocol);
  if (usd === null || at === null || protocol !== v.protocol) return null;
  return { usd, at, protocol };
}

function creatorOf(v: unknown): CreatorFlow | null {
  if (!isRec(v)) return null;
  if (v.state === "not-derivable") return { state: "not-derivable" };
  if (v.state === "unavailable") return isFlowFailure(v.failure) ? { state: "unavailable", failure: v.failure } : null;
  if (v.state !== "read") return null;
  const windowMin = typeof v.windowMin === "number" ? flowNumber(v.windowMin, true) : null;
  if (windowMin === null || windowMin <= 0 || windowMin > 24 * 60) return null;
  const out = { state: "read" as const, windowMin, sells: null, sellUsd: null, transfersOut: null, transferOutUsd: null } as Extract<CreatorFlow, { state: "read" }>;
  for (const [k, int] of [["sells", true], ["sellUsd", false], ["transfersOut", true], ["transferOutUsd", false]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out;
}

/**
 * A FlowFacts from untrusted JSON (the IPC wire), or null. Strict: a field in
 * the wrong shape rejects the whole reading rather than being defaulted,
 * because a defaulted count is a fabricated one.
 */
export function flowFactsOf(v: unknown): FlowFacts | null {
  if (!isRec(v) || typeof v.token !== "string" || !ADDRESS.test(v.token)) return null;
  const observedAt = timeOf(v.observedAt);
  if (observedAt === null) return null;
  if (!Array.isArray(v.windows) || v.windows.length !== FLOW_WINDOWS.length) return null;
  const windows = v.windows.map(windowOf);
  if (windows.some((w, i) => w === null || w.minutes !== FLOW_WINDOWS[i])) return null;
  if (!Array.isArray(v.venues) || v.venues.length > FLOW_LIMITS.venues) return null;
  const venues = v.venues.map(venueOf);
  if (venues.some((x) => x === null)) return null;
  if (!Array.isArray(v.largestSells) || v.largestSells.length > FLOW_LIMITS.largestSells) return null;
  const largestSells = v.largestSells.map(sellOf);
  if (largestSells.some((x) => x === null)) return null;
  const creator = creatorOf(v.creator);
  if (!creator) return null;
  return {
    token: v.token as `0x${string}`,
    observedAt,
    windows: windows as FlowWindow[],
    venues: venues as FlowVenue[],
    largestSells: largestSells as FlowSell[],
    creator,
  };
}

/** A FlowResult from untrusted JSON, or null. */
export function flowResultOf(v: unknown): FlowResult | null {
  if (!isRec(v)) return null;
  if (v.ok === false) return isFlowFailure(v.failure) ? { ok: false, failure: v.failure } : null;
  if (v.ok !== true) return null;
  const facts = flowFactsOf(v.facts);
  return facts ? { ok: true, facts } : null;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** The Brain lens key this block is meant to be sent under, once Brain registers it. */
export const ONCHAIN_FLOW_LENS = "onchain-flow";

/** Hard ceiling, matching brain-material.ts, coin-builder.ts and fomo/lens.ts. */
const LENS_MAX = 1200;

const ATTRIBUTION =
  "Source: an on-chain indexer's record of DEX trades in this coin, aggregated by Merrymen. Indexer data, not a forecast.";
const NOT_LINE =
  "WHAT THIS IS NOT: a price, a prediction or a reason to trade. Distinct addresses are not proven distinct people; a null is unknown, never zero.";

/** Nothing in a rendered block may look like an address or a hash. */
const ADDRESSY = /0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{32,}/;

/** True when the indexer reported no trades at all in the widest window. */
function silentHour(f: FlowFacts): boolean {
  const hour = f.windows.find((w) => w.minutes === 60);
  return !hour || ((hour.buys ?? 0) === 0 && (hour.sells ?? 0) === 0 && (hour.buyUsd ?? 0) === 0 && (hour.sellUsd ?? 0) === 0);
}

/** Whole dollars from $100 (either sign), cents below: precision a reader can use, not noise. */
const round = (n: number | null): number | null => (n === null ? null : Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

function creatorJson(c: CreatorFlow): Record<string, unknown> {
  if (c.state === "read") {
    return { state: "read", windowMin: c.windowMin, dexSells: c.sells, dexSellUsd: round(c.sellUsd), transfersOut: c.transfersOut, transferOutUsd: round(c.transferOutUsd) };
  }
  return c.state === "unavailable" ? { state: "unknown" } : { state: "not-derivable" };
}

/**
 * The block a Brain lens would carry: attribution first, then one compact JSON
 * object, then what it is not. Null — never a sentence — when there is nothing
 * honest to say: a failed read, an hour with no indexed trades (absence is not
 * a verdict: it can be an indexer gap as easily as a dead coin), or anything
 * address-shaped in the output.
 *
 * NOT WIRED YET, ON PURPOSE. Brain accepts a lens only once services/brain
 * registers its key (schemas.py LENS_KEYS, analyst.py) and advertises it on
 * /health; see docs/bitquery-lane.md "Where it plugs in".
 */
export function renderFlowLens(r: FlowResult, now: number = Date.now()): string | null {
  if (!r.ok) return null;
  const f = r.facts;
  if (silentHour(f)) return null;
  const windows: Record<string, unknown> = {};
  for (const w of f.windows) {
    windows[`${w.minutes}m`] = {
      buyUsd: round(w.buyUsd),
      sellUsd: round(w.sellUsd),
      netUsd: w.buyUsd === null || w.sellUsd === null ? null : round(w.buyUsd - w.sellUsd),
      buys: w.buys,
      sells: w.sells,
      buyers: w.buyers,
      sellers: w.sellers,
    };
  }
  const body: Record<string, unknown> = {
    ageSec: Math.max(0, Math.round((now - f.observedAt) / 1000)),
    windows,
    venues60m: f.venues.slice(0, 4).map((v) => ({ venue: v.protocol, buyUsd: round(v.buyUsd), sellUsd: round(v.sellUsd), trades: v.buys === null || v.sells === null ? null : v.buys + v.sells })),
    largestSellsUsd60m: f.largestSells.slice(0, 3).map((s) => round(s.usd)),
    creator: creatorJson(f.creator),
  };
  let json = JSON.stringify(body);
  const room = LENS_MAX - ATTRIBUTION.length - NOT_LINE.length - 2;
  if (json.length > room) {
    // Venues go first, then sells: the windows and the creator are the reading.
    body.venues60m = [];
    json = JSON.stringify(body);
    if (json.length > room) {
      body.largestSellsUsd60m = [];
      json = JSON.stringify(body);
    }
  }
  const text = `${ATTRIBUTION}\n${json}\n${NOT_LINE}`;
  if (text.length > LENS_MAX || ADDRESSY.test(text)) return null;
  return text;
}

function usdText(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Plain facts an X answer may paraphrase, each one short and self-contained,
 * or an empty list when there is nothing honest to say (the lens's rules).
 *
 * WHAT NEVER APPEARS: an address, a hash, a wallet list, a tenant's size or
 * P&L — the reading is a public coin's public tape, and that is all it may be.
 * Every line says where it came from, so a writer that keeps one line keeps
 * its attribution with it.
 */
export function flowFactLines(r: FlowResult): string[] {
  if (!r.ok) return [];
  const f = r.facts;
  if (silentHour(f)) return [];
  const lines: string[] = [];
  for (const w of f.windows) {
    if (w.minutes === 5) continue;
    if (w.buyUsd === null || w.sellUsd === null) continue;
    const who = w.buyers !== null && w.sellers !== null ? ` (${w.buyers} buyers, ${w.sellers} sellers)` : "";
    lines.push(`on-chain DEX data, last ${w.minutes}m: ${usdText(w.buyUsd)} bought vs ${usdText(w.sellUsd)} sold${who}`);
  }
  const big = f.largestSells[0];
  if (big) lines.push(`on-chain DEX data: biggest single sell in the last hour was about ${usdText(big.usd)}`);
  const c = f.creator;
  if (c.state === "read" && c.sells !== null && c.transfersOut !== null) {
    lines.push(
      c.sells > 0
        ? `on-chain data: the creator's wallet sold in the last ${c.windowMin}m`
        : c.transfersOut > 0
          ? `on-chain data: the creator's wallet moved tokens out in the last ${c.windowMin}m, with no DEX sell indexed`
          : `on-chain data: no creator-wallet sells or transfers out indexed in the last ${c.windowMin}m`,
    );
  }
  return lines.filter((l) => !ADDRESSY.test(l));
}
