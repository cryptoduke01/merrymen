/**
 * WHAT AN ACTIVE AGENT LOOKS UP BEFORE IT ANSWERS A TAG ON X — the research
 * Shogun does in a Telegram group, for a public answer (docs/x-posting.md
 * "Research for answers"). Behind MERRYMEN_XPOST_RESEARCH=1, default off: off,
 * nothing here is called and an answer is written exactly as without it.
 *
 * WHY THIS IS AN orchestrator*.ts FILE. It reads the room's facts, the
 * Telegram groups' text readers, the desk's coin facts and the Fomo service,
 * and hands xpost/ plain words. xpost/ may import none of those, and only
 * orchestrator*.ts outside xpost/ may import xpost/ (xpost/boundary.test.ts).
 *
 * CLASSIFIED BY CODE, NEVER BY THE MODEL. `classifyTag` reads the screened
 * question with the Telegram groups' own readers (publicFactRequest,
 * extractCashtags, isInjection, isPrivateAsk) into one of six intents:
 * capabilities, onboarding, own trades, a coin, the model, or chat. Only a
 * coin costs a paid lookup; own trades read what it already has.
 *
 * ONE BUNDLE PER ANSWER, BOUNDED. At most RESEARCH_BUDGET.maxLookups lookups
 * and RESEARCH_BUDGET.totalMs in all, every read time-boxed; a lookup that
 * fails, is refused by a limiter or a budget, or runs late is simply not a
 * fact. Never a stalled pass, never a retry.
 *
 * WHAT COMES OUT IS WORDS, BUILT BY CODE. Every fact is a fixed phrase picked
 * from a measurement — "the public index shows liquidity is thin", "holders
 * look concentrated", "fomo traders mostly argue it's still early" — with its
 * source in it, screened for digits and the X gate's vocabulary before the
 * model sees it. No number, price, size, P&L, handle, quote, wallet list or
 * address ever leaves this file. The X gate is unchanged and still judges the
 * draft.
 *
 * THE ADDRESS IS A LOOKUP KEY ONLY. A contract address someone tagged is read
 * on the public index and asked of Fomo; it is never shown to the model,
 * never nominated, never written anywhere a trading decision reads, never
 * traded.
 */
import type { Db } from "./db";
import type { AgentFacts } from "./groupchat/facts";
import type { CoinFacts, CoinFactsReader } from "./coin-facts-types";
import { collapseOf } from "./coin-facts-types";
import { createCoinFactsReader, FactsLimiter } from "./desk/facts";
import { resolveByName } from "./desk/evidence";
import { searchPools } from "./desk/gecko";
import type { FomoBroker } from "./fomo/contract";
import type { TokenActivityData, TokenThesesData } from "./fomo/tools";
import type { FomoEnvelope } from "./fomo/types";
import { readPublicProjectDescription } from "./orchestrator-xpost-project";
import { readPeerTheses } from "./peer-theses";
import { extractCashtags, isInjection, isPrivateAsk } from "./telegram/tg-groups/detect";
import { publicCoinReason, publicFactRequest } from "./telegram/tg-groups/facts";
import type { PublicThesis } from "./thesis-policy";
import { vocabularyRefusal } from "./xpost/gate";
import { coinOf, hash32 } from "./xpost/planner";
import { withoutReplyOptOut } from "./xpost/replies";
import type { XPost } from "./xpost/store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHAIN_ID = 4663;

// ── the intent ──────────────────────────────────────────────────────────────

export type TagIntent =
  | { kind: "capabilities" }
  | { kind: "onboarding" }
  /** "what are you trading", "why did you buy pepe": its own calls and posts. `coin` is the label asked about, if any. */
  | { kind: "own-trades"; why: boolean; coin: string | null }
  /** A coin by $ticker, by a coin it traded named in words, or by ONE contract address (a lookup key only). */
  | { kind: "coin"; ticker: string | null; address: string | null }
  | { kind: "model" }
  | { kind: "chat" };

/**
 * "WHAT MODEL ARE YOU ON", "are you chatgpt", "what ai runs you". Read before
 * the private-ask screen, which deflects model questions in a Telegram room;
 * on X the answer is the sherwood tease (writer.ts SHERWOOD_ON_X).
 */
const MODEL_ASK = new RegExp(
  [
    String.raw`\b(?:what|which|wat|whats|what's)\s+(?:kind\s+of\s+|sort\s+of\s+|type\s+of\s+)?(?:model|llm|ai|a\.i\.?|language model|brain|engine)\b`,
    String.raw`\b(?:model|llm|ai|brain)\s+(?:are|r|do|is)\s+(?:you|u|ya)\b`,
    String.raw`\b(?:you|u|ya)\s+(?:run(?:ning)?|built|powered|trained|based)\s+on\b`,
    String.raw`\b(?:runs|powers|built)\s+(?:you|u)\b`,
    String.raw`\b(?:are|r)\s+(?:you|u)\s+(?:a\s+)?(?:gpt|chat\s?gpt|claude|grok|gemini|llama|qwen|deepseek|mistral)\b`,
  ].join("|"),
  "iu",
);

/** A word of the line, for matching a coin it traded named without a $ sign. */
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? []));

/**
 * WHAT THE QUESTION IS, BY CODE. `address` is the one contract address
 * tagCandidate took out of the text; `knownCoins` are the labels of coins it
 * bought lately, so "why'd you buy pepe" and "thoughts on pepe" find their
 * coin without a $ sign. Never a model call, never a network read.
 */
export function classifyTag(text: string, o: { address?: string | null; knownCoins?: readonly string[] } = {}): TagIntent {
  const t = typeof text === "string" ? text : "";
  const address = typeof o.address === "string" && /^0x[0-9a-f]{40}$/.test(o.address) ? o.address : null;
  // An attempt to steer it is answered as chat: nothing is looked up for it.
  if (!t.trim() || isInjection(t)) return { kind: "chat" };
  if (MODEL_ASK.test(t)) return { kind: "model" };
  const asked = publicFactRequest(t);
  if (asked?.kind === "site" && asked.topic === "capabilities") return { kind: "capabilities" };
  if (asked?.kind === "site" && asked.topic === "onboarding") return { kind: "onboarding" };
  const ticker = extractCashtags(t)[0] ?? null;
  const said = words(t);
  const known = (o.knownCoins ?? []).find((c) => c.trim() && c.toLowerCase().split(/\s+/).every((w) => said.has(w))) ?? null;
  // ITS OWN TRADES, the Telegram groups' reading of them: what it traded, why.
  if (asked?.kind === "trades" || (asked?.kind === "site" && (asked.topic === "attempts" || asked.topic === "trades"))) {
    const why = asked.kind === "trades" ? asked.why : asked.topic === "attempts";
    const coin = asked.kind === "trades" && asked.symbol ? asked.symbol : ticker ?? known;
    return { kind: "own-trades", why, coin: coin ?? null };
  }
  // Its wallet, balance, P&L, owner: deflected by the prompt, never looked up.
  if (isPrivateAsk(t)) return { kind: "chat" };
  if (address || ticker || known) return { kind: "coin", ticker: ticker ?? known, address };
  return { kind: "chat" };
}

// ── the budget ──────────────────────────────────────────────────────────────

/**
 * ONE ANSWER'S RESEARCH. Lookups: a name search, the index's coin facts, the
 * creator's description, Fomo's token activity, Fomo's quick theses, onchain
 * flow — six at most, and in practice fewer. The whole bundle, waits
 * included, is over in nine seconds; one read never takes more than four.
 */
export const RESEARCH_BUDGET = Object.freeze({ maxLookups: 6, totalMs: 9_000, readMs: 4_000 });

/**
 * THE INDEX, PER X ACCOUNT: at most this many index lookups (a search, a
 * coin's facts) per X account in ten minutes, and `perHour` across every X
 * account this process answers for (MERRYMEN_XPOST_RESEARCH_PER_HOUR). A
 * lookup past either is not made, and the answer goes without it.
 */
export const X_LOOKUPS_PER_ACCOUNT = 8;
export const DEFAULT_X_LOOKUPS_PER_HOUR = 120;

/** The limiter's key for an X account: X ids are too long for a safe integer, so a hash of one. */
export function xAccountKey(xUserId: string): number {
  return hash32(`x-answer|${xUserId}`);
}

// ── the bundle ──────────────────────────────────────────────────────────────

/**
 * Onchain flow for one coin, the Bitquery lane another change builds. Absent
 * or null: no flow fact. Counts are read by code here, never shown.
 */
export interface FlowFacts {
  window: "1h" | "24h";
  buyers: number | null;
  sellers: number | null;
}
export type FlowReader = (q: { chainId: number; address: string; timeoutMs: number }) => Promise<FlowFacts | null>;

export interface XResearchDeps {
  /** The index's coin facts, on the fleet lane with the per-X-account limiter. Default: built from `fleetHome`. */
  coinFacts?: CoinFactsReader;
  /** A ticker → one Robinhood Chain token address, or null. Default: the desk's pool search, on the same lane. */
  resolveTicker?: (ticker: string, timeoutMs: number) => Promise<string | null>;
  /** The creator's own published description (Pons metadata). Default: readPublicProjectDescription. */
  projectDescription?: (token: string, chainId: number) => Promise<{ description: string } | null>;
  /** The agent's own public theses, as the public feed publishes them. Default: readPeerTheses for its own account. */
  publicTheses?: (shared: Db, agentId: string) => Promise<PublicThesis[]>;
  /** The orchestrator's own Fomo service as a broker for one tenant, or null when Fomo is off. Consulted only with the Fomo switch on. */
  fomo?: (tenant: string) => FomoBroker | null;
  /** Onchain flow (Bitquery), when another change wires it. */
  flow?: FlowReader;
  /** The fleet home, for the Gecko lane (geckoterminal.ts GeckoLane). The orchestrator passes merrymenHome(). */
  fleetHome?: string;
  /** Index lookups per hour across X accounts. Default DEFAULT_X_LOOKUPS_PER_HOUR. */
  lookupsPerHour?: number;
  now?: () => number;
}

export interface ResearchInput {
  shared: Db;
  intent: TagIntent;
  tenant: string;
  xUserId: string;
  facts: AgentFacts;
  /** This X account's own posts (a buy post says what it said when it bought). */
  posts: readonly XPost[];
  /** MERRYMEN_XPOST_FOMO=1: Fomo may be asked. */
  fomo: boolean;
}

export interface ResearchBundle {
  /** Code-built phrases, each with its source in it: digit-free and screened. */
  facts: string[];
  /** Lookups made (the budget counts these). */
  lookups: number;
  /** What happened, by stable word, for the pass's counts. Never a coin, a person or an address. */
  notes: string[];
}

export interface XResearch {
  gather(input: ResearchInput): Promise<ResearchBundle>;
}

/** A phrase the model may be handed: one line, no digit, nothing the X gate's vocabulary would drop the post for. */
export function sayable(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "" && !/\p{N}/u.test(s) && !/[«»{}\n]/.test(s) && !/0x/i.test(s) && vocabularyRefusal(s) === null;
}

/** A promise held to `ms`, or `fallback`. Never throws; its timer never holds a shutdown. */
function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  if (!(ms > 0)) return Promise.resolve(fallback);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

// ── words from measurements ─────────────────────────────────────────────────

/** A coin's index facts, in words. Thresholds are code's; no figure is ever in a phrase. */
export function coinFactPhrases(f: CoinFacts, nowMs: number): string[] {
  const out: string[] = [];
  const liq = f.liquidityUsd;
  if (liq !== null && Number.isFinite(liq)) {
    out.push(liq < 10_000 ? "the public index shows liquidity is thin" : liq < 100_000 ? "the public index shows liquidity is modest" : "the public index shows liquidity is pretty deep");
  }
  const born = f.poolCreatedAtMs;
  if (born !== null && Number.isFinite(born) && born <= nowMs) {
    const age = nowMs - born;
    out.push(age < DAY ? "the public index says it's only hours old" : age < 7 * DAY ? "the public index says it's only days old" : age < 60 * DAY ? "the public index says it's a few weeks old" : "the public index says it's been around a while");
  }
  const h = f.holders;
  if (h && Number.isFinite(h.count)) {
    out.push(h.count < 100 ? "the public index counts only a few holders" : h.count < 1_000 ? "the public index counts a fair number of holders" : "the public index counts a lot of holders");
    if (h.top10Pct !== null && Number.isFinite(h.top10Pct)) {
      if (h.top10Pct >= 60) out.push("holders look concentrated on the public index");
      else if (h.top10Pct <= 30) out.push("holders look fairly spread out on the public index");
    }
  }
  if (f.creatorHoldingPct !== null && Number.isFinite(f.creatorHoldingPct) && f.creatorHoldingPct >= 5) {
    out.push("the public index lists the creator still holding a big chunk");
  }
  const b = f.buyers24h, s = f.sellers24h;
  if (b !== null && s !== null && Number.isFinite(b) && Number.isFinite(s)) {
    if (b + s < 10) out.push("the public index shows it's been quiet lately");
    // "Traders", never "wallets": a wallet is an operations word on X (gate.ts).
    else if (b >= s * 1.5) out.push("the public index shows more traders buying in than heading out lately");
    else if (s >= b * 1.5) out.push("the public index shows more traders heading out than buying in lately");
  }
  if (collapseOf(f)) out.push("the public index shows it's far below its high");
  return out.filter(sayable);
}

/**
 * FOMO'S TALK ABOUT A COIN, in words: which way the theses lean, what they
 * mostly argue, and what the talk is about. From Merrymen's own reading of
 * the theses (stance, cues and topics from fixed tables), never a thesis's
 * words, an author, a handle, a like count or a position. A valuation cue
 * ("undervalued", "overvalued") is advice in other words and is never said.
 */
const CUE_SAID: Readonly<Record<string, string>> = Object.freeze({
  early: "fomo traders mostly argue it's still early",
  "strong community": "fomo traders mostly point to a strong community",
  breakout: "fomo traders mostly like how the chart is setting up",
  listing: "fomo traders are mostly hoping for a listing",
  accumulating: "fomo traders say holders keep adding on dips",
  rug: "fomo traders mostly worry it could collapse",
  honeypot: "fomo traders worry it could be hard to get out of",
  "can't sell": "fomo traders worry it could be hard to get out of",
  "dev sold": "fomo traders are wary of the dev's wallet",
  "exit liquidity": "fomo traders worry late buyers end up holding it",
  unlock: "fomo traders point to token unlocks ahead",
  scam: "fomo traders have trust worries about it",
});
const TOPIC_SAID: Readonly<Record<string, string>> = Object.freeze({
  team: "most of the fomo talk is about the team",
  liquidity: "most of the fomo talk is about liquidity",
  supply: "most of the fomo talk is about supply and holders",
  momentum: "most of the fomo talk is about the chart",
  narrative: "most of the fomo talk is about the story behind it",
  community: "most of the fomo talk is about the community",
});

export function fomoThesesPhrases(d: TokenThesesData | null | undefined): string[] {
  if (!d || !Array.isArray(d.theses)) return [];
  const st = d.stance ?? { supporting: 0, opposing: 0, neutral: 0 };
  const total = st.supporting + st.opposing + st.neutral;
  if (!(total >= 2)) return [];
  const out: string[] = [];
  const lean: "supporting" | "opposing" | null = st.supporting >= st.opposing * 2 && st.supporting >= 2 ? "supporting" : st.opposing >= st.supporting * 2 && st.opposing >= 2 ? "opposing" : null;
  const cues = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const v of d.theses) {
    for (const c of v?.cues ?? []) if (c && (lean === null || c.stance === lean) && Object.hasOwn(CUE_SAID, c.label)) cues.set(c.label, (cues.get(c.label) ?? 0) + 1);
    for (const t of v?.topics ?? []) if (typeof t === "string" && Object.hasOwn(TOPIC_SAID, t)) topics.set(t, (topics.get(t) ?? 0) + 1);
  }
  const top = (m: Map<string, number>): string | null => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const cue = lean ? top(cues) : null;
  if (cue) out.push(CUE_SAID[cue]!);
  else out.push(lean === "supporting" ? "fomo traders mostly argue for it" : lean === "opposing" ? "fomo traders mostly argue against it" : "fomo traders are split on it");
  const topic = top(topics);
  if (topic) out.push(TOPIC_SAID[topic]!);
  return out.filter(sayable);
}

/** Fomo's tape for a coin, in words: who has been buying in or heading out. Counts are read here, never shown. */
export function fomoActivityPhrases(d: TokenActivityData | null | undefined): string[] {
  if (!d) return [];
  const b = d.distinctBuyers, s = d.distinctSellers;
  if (b === null || s === null || !Number.isFinite(b) || !Number.isFinite(s) || b + s < 3) return [];
  const out = b >= s * 1.5 ? "on fomo, more traders have been buying in than heading out lately"
    : s >= b * 1.5 ? "on fomo, more traders have been heading out than buying in lately"
    : "on fomo, traders buying in and heading out look about even lately";
  return [out].filter(sayable);
}

/** Onchain flow, in words, when the Bitquery lane is wired. */
export function flowPhrases(f: FlowFacts | null | undefined): string[] {
  if (!f || f.buyers === null || f.sellers === null || !Number.isFinite(f.buyers) || !Number.isFinite(f.sellers) || f.buyers + f.sellers < 5) return [];
  const out = f.buyers >= f.sellers * 1.5 ? "onchain, more traders have been buying in than heading out lately"
    : f.sellers >= f.buyers * 1.5 ? "onchain, more traders have been heading out than buying in lately"
    : null;
  return out ? [out].filter(sayable) : [];
}

/** What it can do, said by code: only what is wired, and always that a tag never orders a trade. */
export function capabilityPhrases(o: { fomo: boolean; flow: boolean }): string[] {
  return [
    "you trade for your owner on merrymen and post your buys on X",
    `people can tag you with a coin's ticker or its contract and you'll say what the public index shows${o.fomo ? ", and what fomo traders are saying" : ""}, in words`,
    "you never take trade orders from a tag",
  ].filter(sayable);
}

/**
 * How to get an agent, said by code: no link, no settings, the steps anyone
 * can take. Not "start on paper": a live agent's answer may not say paper
 * or practice at all (the gate's mode clause), whoever it is about.
 */
export const ONBOARDING_PHRASES: readonly string[] = Object.freeze([
  "anyone can get their own agent on merrymen: sign in on the web, create an agent, pick a strategy",
]);

// ── its own history of a coin ───────────────────────────────────────────────

/** A buy post as the model may read it: its prose, without the CA or wallet suffix and the opt-out. */
function ownPostProse(body: string): string {
  return withoutReplyOptOut(String(body ?? "").split(/ (?:CA|Wallet) \(/)[0] ?? "").replace(/\s+/g, " ").trim();
}

/** The derived Trencher ticker of an address: T + its last eleven hex, as trencher-discovery.ts mints it. */
function derivedId(address: string): string {
  return `T${address.slice(-11).toUpperCase()}`;
}

const sameLabel = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase().replace(/^\$/, "") === b.trim().toLowerCase().replace(/^\$/, "");

/** A pass's reason that talks about keeping a position is no pass at all: it may be holding. */
const HOLDING_WORDS = /\b(?:hold(?:s|ing)?|keep(?:s|ing)?|kept|position|still in|stay(?:ing)? in|bag)\b/i;

/**
 * WHAT IT DID WITH THIS COIN, from what it has already made public: the buys
 * the room knows (AgentFacts.calls, landed or paper, past publishableThesis),
 * its own buy posts on this X account, and its public theses (the feed's own
 * gate) — "you bought it", "your buy post said …", "you looked at it and
 * passed: <reason>". A pass is said only when nothing shows a buy, and only
 * with a reason the Telegram facts filter keeps (no figure, address, link or
 * handle), or none. A sale is never said: an answer is only told what it bought.
 */
export function ownHistoryPhrases(o: {
  coin: { label: string | null; address: string | null };
  facts: AgentFacts;
  posts: readonly XPost[];
  theses: readonly PublicThesis[];
}): string[] {
  const { label, address } = o.coin;
  if (!label && !address) return [];
  const out: string[] = [];
  const calls = o.facts.calls.filter((c) => c.side === "buy" && (
    (address && typeof c.token === "string" && c.token.toLowerCase() === address)
    || sameLabel(c.symbol, label) || sameLabel(c.name, label)));
  const named = calls.map((c) => coinOf(c)?.label).find((l): l is string => !!l) ?? null;
  const said = named ?? label;
  const posts = o.posts.filter((p) => p.kind === "buy" && p.status === "posted" && (sameLabel(p.coin, said) || sameLabel(p.coin, label)));
  const theses = o.theses.filter((t) => {
    if (address && t.symbol === derivedId(address)) return true;
    return sameLabel(t.symbol, label) || sameLabel(t.displayName ?? null, label) || sameLabel(t.symbol, said) || sameLabel(t.displayName ?? null, said);
  });
  const boughtThesis = theses.find((t) => t.action === "buy" && t.outcome === "landed");
  if (calls.length || posts.length || boughtThesis) {
    const paper = calls[0]?.paper ?? boughtThesis?.paper ?? false;
    out.push(`you bought it lately${paper ? ", on paper" : ""}`);
    const own = calls.map((c) => c.ownWords).find((w): w is string => sayable(w));
    if (own) out.push(`your own words when you bought it: ${own}`);
    const post = posts.map((p) => ownPostProse(p.body)).find(sayable);
    if (post) out.push(`what you posted on X when you bought it: ${post}`);
    const why = publicCoinReason(boughtThesis ? [boughtThesis.reason] : []);
    if (why && sayable(why)) out.push(`your public reason for the buy: ${why}`);
    return out.filter(sayable);
  }
  const pass = theses.find((t) => (t.action === "hold" || t.outcome === "view") && !HOLDING_WORDS.test(`${t.reason ?? ""} ${t.post ?? ""}`));
  if (pass) {
    const why = publicCoinReason([pass.reason]);
    out.push(why && sayable(why) && !HOLDING_WORDS.test(why) ? `you looked at it and passed: ${why}` : "you looked at it and passed");
  }
  return out.filter(sayable);
}

// ── the gatherer ────────────────────────────────────────────────────────────

/** Fomo's envelope data, when the read stood: a refusal, failure or unknown is nothing. */
function dataOf<T>(env: FomoEnvelope | null | undefined): T | null {
  if (!env || !["ok", "partial", "capped", "stale", "empty"].includes(env.status)) return null;
  return (env.data as T | null) ?? null;
}

export function createXResearch(d: XResearchDeps = {}): XResearch {
  const now = d.now ?? Date.now;
  const lane = d.fleetHome ? { fleetHome: d.fleetHome } : undefined;
  const limiter = new FactsLimiter({ now, perChat: X_LOOKUPS_PER_ACCOUNT, chatWindowMs: 10 * MIN, perAgent: d.lookupsPerHour ?? DEFAULT_X_LOOKUPS_PER_HOUR, agentWindowMs: HOUR });
  const coinFacts = d.coinFacts ?? createCoinFactsReader({ now, limiter, ...(lane ? { lane } : {}) });
  const resolveTicker = d.resolveTicker ?? (async (ticker: string, timeoutMs: number): Promise<string | null> => {
    const found = await searchPools(ticker, timeoutMs, undefined, lane);
    if (found.failed) return null;
    const r = resolveByName(ticker, found.pools);
    return typeof r === "object" ? r.token : null;
  });
  const projectDescription = d.projectDescription ?? ((token: string, chainId: number) => readPublicProjectDescription(token, chainId));
  const publicTheses = d.publicTheses ?? ((shared: Db, agentId: string) => readPeerTheses(shared, [agentId as `0x${string}`]));

  return {
    async gather(input): Promise<ResearchBundle> {
      const started = now();
      const left = (): number => RESEARCH_BUDGET.totalMs - (now() - started);
      const notes: string[] = [];
      let lookups = 0;
      /**
       * One lookup, if the bundle has one left and time for it; `fallback`
       * otherwise, and on any failure or lateness. A read of its own public
       * theses (`own`) is time-boxed the same way but is no lookup: it is the
       * shared database, not a provider.
       */
      const look = async <T>(run: (ms: number) => Promise<T>, fallback: T, own = false): Promise<T> => {
        if (!own && lookups >= RESEARCH_BUDGET.maxLookups) {
          notes.push("lookups-spent");
          return fallback;
        }
        const ms = Math.min(RESEARCH_BUDGET.readMs, left());
        if (ms <= 250) {
          notes.push("late");
          return fallback;
        }
        if (!own) lookups++;
        return within(ms, run(ms), fallback);
      };
      const ownTheses = (): Promise<PublicThesis[]> => look(() => publicTheses(input.shared, input.facts.agentId), [] as PublicThesis[], true);
      const i = input.intent;
      const f = input.facts;
      try {
        switch (i.kind) {
          case "capabilities":
            return { facts: capabilityPhrases({ fomo: input.fomo && !!d.fomo, flow: !!d.flow }), lookups, notes };
          case "onboarding":
            return { facts: ONBOARDING_PHRASES.filter(sayable), lookups, notes };
          case "model":
          case "chat":
            return { facts: [], lookups, notes };
          case "own-trades": {
            // Only what it already made public, and no paid read: its newest buy
            // post, or, for a coin it names, that coin's history.
            if (!i.coin) {
              const latest = input.posts.filter((p) => p.kind === "buy" && p.status === "posted").sort((a, b) => b.createdAtMs - a.createdAtMs)
                .map((p) => ownPostProse(p.body)).find(sayable);
              return { facts: latest ? [`what you posted on X about your latest buy: ${latest}`].filter(sayable) : [], lookups, notes };
            }
            const theses = await ownTheses();
            return { facts: ownHistoryPhrases({ coin: { label: i.coin, address: null }, facts: f, posts: input.posts, theses }), lookups, notes };
          }
          case "coin":
            break;
        }
        // ── a coin ──────────────────────────────────────────────────────
        // Its own address first: a coin it bought carries its contract, so a ticker it traded costs no search.
        let address = i.address;
        if (!address && i.ticker) {
          const call = f.calls.find((c) => typeof c.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(c.token) && (sameLabel(c.symbol, i.ticker) || sameLabel(c.name, i.ticker)));
          address = call?.token?.toLowerCase() ?? null;
        }
        if (!address && i.ticker) {
          if (!limiter.take(xAccountKey(input.xUserId))) notes.push("index-busy");
          else address = await look((ms) => resolveTicker(i.ticker!, ms), null);
          if (!address) notes.push("unresolved");
        }
        const theses = await ownTheses();
        const history = ownHistoryPhrases({ coin: { label: i.ticker, address }, facts: f, posts: input.posts, theses });
        if (!address) return { facts: history, lookups, notes };
        const broker = input.fomo && d.fomo ? d.fomo(input.tenant) : null;
        const fomoOpts = (ms: number) => ({
          surface: "x-answer" as const, audience: "group" as const, conversationKey: `x:${input.xUserId}`,
          priority: "interactive" as const, groupId: input.xUserId, timeoutMs: ms,
        });
        // The rest at once, each in its own time box: a slow one costs its fact, never the others.
        const [read, project, activity, talk, flow] = await Promise.all([
          look((ms) => coinFacts({ network: "robinhood", address: address!, chatId: xAccountKey(input.xUserId), timeoutMs: ms, withInfo: true }), null),
          look((ms) => projectDescription(address!, CHAIN_ID), null),
          broker ? look((ms) => broker.call("fomo_get_token_activity", { token: address!, chain: "robinhood", window: "24h", limit: 5 }, fomoOpts(ms)), null) : Promise.resolve(null),
          broker ? look((ms) => broker.call("fomo_get_token_theses", { token: address!, chain: "robinhood", depth: "quick", limit: 10 }, fomoOpts(ms)), null) : Promise.resolve(null),
          d.flow ? look((ms) => d.flow!({ chainId: CHAIN_ID, address: address!, timeoutMs: ms }), null) : Promise.resolve(null),
        ]);
        const out = [...history];
        if (read && read.ok) out.push(...coinFactPhrases(read.facts, now()));
        else notes.push(read ? `index-${read.why}` : "index-unavailable");
        const description = project?.description;
        if (description && sayable(`the project says it's ${description}`)) out.push(`the project says it's ${description.slice(0, 140)}`);
        if (broker) {
          const t = fomoThesesPhrases(dataOf<TokenThesesData>(talk));
          const a = fomoActivityPhrases(dataOf<TokenActivityData>(activity));
          if (!t.length && !a.length) notes.push("fomo-nothing");
          out.push(...t, ...a);
        }
        out.push(...flowPhrases(flow));
        return { facts: out.filter(sayable).slice(0, 8), lookups, notes };
      } catch {
        // Research is an extra: a fault here is an answer without it, never a failed pass.
        notes.push("fault");
        return { facts: [], lookups, notes };
      }
    },
  };
}
