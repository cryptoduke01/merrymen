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
import { flowXLines, type FlowResult } from "./flow-facts";
import { readPublicProjectDescription } from "./orchestrator-xpost-project";
import { readPeerTheses } from "./peer-theses";
import { extractCashtags, isInjection, isPrivateAsk } from "./telegram/tg-groups/detect";
import { publicCoinReason, publicFactRequest } from "./telegram/tg-groups/facts";
import type { PublicThesis } from "./thesis-policy";
import { vocabularyRefusal } from "./xpost/gate";
import { coinOf, hash32 } from "./xpost/planner";
import { withoutReplyOptOut } from "./xpost/replies";
import { takeAllowance, type XPost } from "./xpost/store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CHAIN_ID = 4663;

// ── the intent ──────────────────────────────────────────────────────────────

export type TagIntent =
  | { kind: "capabilities" }
  | { kind: "onboarding" }
  /**
   * "what are you trading", "why did you buy pepe", "did you buy <address>":
   * its own calls and posts. `coin` is the label asked about, `address` the
   * tagged contract (a lookup key into its own history only), if any.
   */
  | { kind: "own-trades"; why: boolean; coin: string | null; address: string | null }
  /** A coin by $ticker, by a coin it traded named in words, or by ONE contract address (a lookup key only). */
  | { kind: "coin"; ticker: string | null; address: string | null }
  | { kind: "model" }
  | { kind: "chat" }
  /**
   * A tag that asks about sherwood or the model AND about a token: answered
   * by nothing at all, no draft and no post (TOKEN_ASK).
   */
  | { kind: "unanswered" };

/**
 * "WHAT MODEL ARE YOU ON", "are you chatgpt", "what ai runs you". Read before
 * the private-ask screen, which deflects model questions in a Telegram room;
 * on X the answer is the sherwood tease (writer.ts SHERWOOD_ON_X).
 *
 * STRICT, BECAUSE IT IS READ FIRST and its answer is the tease and nothing
 * else: the model noun must end the phrase or be followed by a verb or a
 * pronoun ("what ai are you", "which model runs you", "what llm?"), never by
 * another noun ("what ai coins do you like" is a coin question); and "running
 * on" must be followed by a model or provider word, or end the question
 * ("are you running on paper or live" is about its trades).
 */
const MODEL_NOUN = String.raw`(?:model|llm|ai|a\.i\.?|language model|brain|engine)`;
const MODEL_NAMES = String.raw`(?:gpt|chat\s?gpt|claude|grok|gemini|llama|qwen|deepseek|mistral|openai|anthropic|sherwood)`;
const MODEL_ASK = new RegExp(
  [
    String.raw`\b(?:what|which|wat|whats|what's)\s+(?:kind\s+of\s+|sort\s+of\s+|type\s+of\s+)?${MODEL_NOUN}(?=\s*(?:$|[?!.,]|(?:are|r|do|does|is|runs?|powers?|drives?|you|u|ya|behind|under|inside|in\s+you)\b))`,
    String.raw`\b(?:model|llm|ai|brain)\s+(?:are|r|do|is)\s+(?:you|u|ya)\b`,
    String.raw`\b(?:you|u|ya)\s+(?:run(?:ning)?|built|powered|trained|based)\s+(?:on|by)\s+(?:(?:what|which|a|an|the|some)\s+)?(?:${MODEL_NOUN}|${MODEL_NAMES})\b`,
    String.raw`\bwhat\s+(?:do|does|are)\s+(?:you|u|ya)\s+(?:run(?:ning)?|built|powered|trained|based)\s+on\s*(?:$|[?!.])`,
    String.raw`\b(?:what|who|which\s+${MODEL_NOUN})\s+(?:runs|powers|built|made|trained|drives)\s+(?:you|u|ya)\b`,
    String.raw`\b(?:are|r)\s+(?:you|u)\s+(?:a\s+)?${MODEL_NAMES}\b`,
  ].join("|"),
  "iu",
);

/** Sherwood named at all, however it is spelled: only code's own lines answer it (writer.ts modelAnswers). */
const SHERWOOD_ASK = /\bsherwood/i;

/**
 * A TOKEN IN A SHERWOOD OR MODEL QUESTION (review, 2026-10-12): a $ticker, a
 * tagged contract, or a word for a coin, a token or its launch. Anyone can
 * launch $SHERWOOD and tag the official account with "is $SHERWOOD
 * merrymen's new token?"; code's model line under it ("merrymen made me. the
 * new sherwood-1 is what they've got in the oven") reads as Merrymen
 * confirming that token, ready to screenshot. So such a tag gets no answer
 * at all: not the model line, and not a draft (which may not name sherwood
 * anyway). "Your coins" is its own trading, not a token, and is read past:
 * "is sherwood choosing your coins?" is still the model question.
 */
const TOKEN_WORDS = /\b(?:coins?|tokens?|contracts?|ca|launch\w*|presales?|airdrops?|tickers?|mint\w*|memecoins?|listings?|listed|cashtags?)\b/i;
const OWN_COINS = /\b(?:your|ur|yr|my|its|their)\s+coins\b/gi;
function tokenAsked(t: string, address: string | null): boolean {
  return address !== null || extractCashtags(t).length > 0 || TOKEN_WORDS.test(t.replace(OWN_COINS, " "));
}

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
  // ANY TAG THAT NAMES SHERWOOD gets code's own line: "does sherwood-1 pick
  // your trades now?" is bait for "yep, sherwood-1 picks my trades". Unless
  // it also asks about a token: then nothing answers it (TOKEN_WORDS).
  if (MODEL_ASK.test(t) || SHERWOOD_ASK.test(t)) return tokenAsked(t, address) ? { kind: "unanswered" } : { kind: "model" };
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
    return { kind: "own-trades", why, coin: coin ?? null, address };
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
 * included, is over in twelve seconds; an index or chain read never takes
 * more than four, a Fomo read more than eight (an uncached thesis page is a
 * slow provider read; cut at four it would be paid for and never heard), and
 * an onchain flow reading more than eight (its flow query and the launcher's
 * each need the lane's three-second floor). The reads after the address is
 * known run side by side.
 */
export const RESEARCH_BUDGET = Object.freeze({ maxLookups: 6, totalMs: 12_000, readMs: 4_000, fomoMs: 8_000, flowMs: 8_000 });

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
 * ONCHAIN FLOW FOR ONE COIN: the orchestrator's Bitquery lane
 * (orchestrator-flow.ts flowFor), handed in only while that lane is
 * configured. Absent, or null: no flow fact. The reading comes back whole and
 * is said here only through flow-facts.ts flowXLines — digit-free bands from
 * a closed vocabulary that already clears the X gate — never a figure.
 */
export type FlowReader = (q: { chainId: number; address: string; timeoutMs: number }) => Promise<FlowResult | null>;

/**
 * Flow readings X answers may ask for per UTC day, across the fleet, counted
 * in xpost_meta (`x-answer-flow:<day>`) before the read. The orchestrator
 * passes the share of the lane's day that child evidence cannot spend
 * (orchestrator-flow.ts answerReadingsPerDay); this is only the fallback.
 */
export const DEFAULT_X_FLOW_PER_DAY = 200;

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
  /**
   * Whether Fomo can answer for this owner at all: the owner's own data
   * access on, and the x-answer cap above zero. Absent: a broker that says it
   * is configured is taken as usable. A capability is only claimed, and a
   * Fomo read only made, when this says yes.
   */
  fomoUsable?: (tenant: string) => Promise<boolean>;
  /** Onchain flow (Bitquery), only while the lane is configured. */
  flow?: FlowReader;
  /** Flow readings per UTC day across X accounts. Default DEFAULT_X_FLOW_PER_DAY. */
  flowPerDay?: number;
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
  /**
   * What is left of the caller's own time, in ms, when that is less than the
   * bundle's twelve seconds: an answer drafted late in a pass gets only what
   * remains of the pass's send budget, so research never holds the next sends
   * back. Absent: RESEARCH_BUDGET.totalMs.
   */
  budgetMs?: number;
}

export interface ResearchBundle {
  /** Code-built phrases, each with its source in it: digit-free and screened. */
  facts: string[];
  /**
   * The creator's own description of a coin it traded (by the full contract), screened
   * (creatorClaim), or null. Apart from `facts`: it is the project's
   * unverified claim, never something it looked up and found.
   */
  claim?: string | null;
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

/**
 * A POST THAT CARRIED RESEARCH, read by the sources every phrase here names:
 * the public index, fomo, on-chain data, the project or its creator, a tagged
 * contract. Such an answer is a read of a coin a stranger tagged, often one it
 * never bought, true only when it was looked up. It is never handed on: not
 * to a casual post as a theme to pick back up (an unsolicited, stale market
 * read on its own timeline, and Fomo's talk republished outside the x-answer
 * surface), and not to a later answer as what it already said (one coin's
 * facts restated under another). Read by the source words, which survive the
 * model's rephrasing ("keep who said it"), so it errs toward holding a post
 * back; one held back only costs a theme.
 */
const RESEARCH_SOURCE = /\b(?:index|fomo|on[\s-]?chain|chain data|project|creator|contract)\b/i;
export function carriesResearch(body: unknown): boolean {
  return typeof body === "string" && RESEARCH_SOURCE.test(body);
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
  // MOST TELLING FIRST: a bundle keeps only the first INDEX_FACTS of these.
  if (collapseOf(f)) out.push("the public index shows it's far below its high");
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
  if (h && h.top10Pct !== null && Number.isFinite(h.top10Pct)) {
    if (h.top10Pct >= 60) out.push("holders look concentrated on the public index");
    else if (h.top10Pct <= 30) out.push("holders look fairly spread out on the public index");
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
  if (h && Number.isFinite(h.count)) {
    out.push(h.count < 100 ? "the public index counts only a few holders" : h.count < 1_000 ? "the public index counts a fair number of holders" : "the public index counts a lot of holders");
  }
  return out.filter(sayable);
}

/** The index's phrases one answer keeps, most telling first: a short answer cannot carry a spec sheet. */
export const INDEX_FACTS = 5;
/** Facts one bundle hands the writer, in all. */
export const BUNDLE_FACTS = 10;

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

/**
 * Onchain flow, in words: the lane's reading through flowXLines, seeded by
 * owner and coin so one owner says one coin's band one way. Nothing when the
 * reading failed, the hour was silent, or nothing honest can be said.
 */
export function flowPhrases(r: FlowResult | null | undefined, seed: string): string[] {
  if (!r || !r.ok) return [];
  return flowXLines(r, seed).filter(sayable);
}

/** What it can do, said by code: only what is wired, and always that a tag never orders a trade. */
export function capabilityPhrases(o: { fomo: boolean; flow: boolean }): string[] {
  // Short enough to stand in a whole answer with the opt-out notice (the test says it through the gate).
  const said = o.flow
    ? `a coin's ticker or contract and you'll say what the public index and on-chain data show${o.fomo ? ", and what fomo traders say" : ""}`
    : `a coin's ticker or its contract and you'll say what the public index shows${o.fomo ? ", and what fomo traders are saying" : ""}`;
  return [
    "you trade for your owner on merrymen and post your buys on X",
    `people can tag you with ${said}, in words`,
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

/**
 * The derived Trencher ticker of an address: T + its last eleven hex, as
 * trencher-discovery.ts mints it. A NAME, NEVER PROOF: eleven of forty hex,
 * which a stranger copies off its buy post and grinds a token to share. A
 * thesis under it counts as this contract's only beside a record of the
 * full contract (fullyBought).
 */
function derivedId(address: string): string {
  return `T${address.slice(-11).toUpperCase()}`;
}

const sameLabel = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase().replace(/^\$/, "") === b.trim().toLowerCase().replace(/^\$/, "");

const CONTRACT = /^0x[0-9a-fA-F]{40}$/;
/** An autonomous Trencher coin's thesis symbol: derived from its address (derivedId). */
const TRENCHER_ID = /^T[0-9A-F]{11}$/;

/** A buy post's own contract, from the CA suffix the pipeline adds (public-wallet.ts appendPublicToken), or null. */
function postContract(body: string): string | null {
  const m = / CA \([^)]*\): (0x[0-9a-fA-F]{40})\b/.exec(String(body ?? ""));
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * DID ITS OWN RECORDS BUY THIS EXACT CONTRACT, all forty hex: a buy whose
 * token is it, or a buy post on X whose CA is it. Never a derived id alone.
 */
function fullyBought(address: string, facts: AgentFacts, posts: readonly XPost[]): boolean {
  return facts.calls.some((c) => c.side === "buy" && typeof c.token === "string" && c.token.toLowerCase() === address)
    || posts.some((p) => p.kind === "buy" && p.status === "posted" && postContract(p.body) === address);
}

/**
 * WHAT IT DID WITH THIS COIN, from what it has already made public: the buys
 * the room knows (AgentFacts.calls, landed or paper, past publishableThesis),
 * its own buy posts on this X account, and its public theses (the feed's own
 * gate) — "you bought it", "your buy post said …". A sale is never said: an
 * answer is only told what it bought.
 *
 * BY THE CONTRACT ALONE WHEN THERE IS ONE. A tagged address is a stranger's
 * key, and a name is not a coin: "is $PEPE <another contract> legit?" must
 * never find its real PEPE buy by the name and say "you bought it" under a
 * copycat's contract. With an address, a buy counts only when its own token
 * is that address, a buy post only when its CA (or its decision) is, and a
 * thesis only when its symbol is an address-matched buy's symbol, or the
 * address's derived id while a buy or buy post of the full contract exists
 * (review, 2026-10-12: the derived id is eleven hex a stranger can match, so
 * on its own it is never "you bought it"). A name is read only when no
 * contract is known at all (a $ticker it could not resolve, "why did you buy
 * pepe").
 *
 * NEVER "YOU PASSED" (review, 2026-10-12). The only record of a declined look
 * here would be a public thesis, and a symbol's thesis without a trade is a
 * HOLD (thesis-policy.ts isHold): a coin it may well still own, decided to
 * keep. Saying "you looked at it and passed" from it is a false public
 * statement about a real-money book. The Telegram rooms' reviewed-and-passed
 * memo is a child's room state, not read here, so a pass is not said at all.
 */
export function ownHistoryPhrases(o: {
  coin: { label: string | null; address: string | null };
  facts: AgentFacts;
  posts: readonly XPost[];
  theses: readonly PublicThesis[];
}): string[] {
  const { label } = o.coin;
  const address = typeof o.coin.address === "string" && CONTRACT.test(o.coin.address) ? o.coin.address.toLowerCase() : null;
  if (!label && !address) return [];
  const buys = o.facts.calls.filter((c) => c.side === "buy");
  const posted = o.posts.filter((p) => p.kind === "buy" && p.status === "posted");
  let calls: typeof buys, posts: typeof posted, theses: PublicThesis[];
  if (address) {
    calls = buys.filter((c) => typeof c.token === "string" && c.token.toLowerCase() === address);
    const decisions = new Set(calls.map((c) => c.decisionId));
    posts = posted.filter((p) => {
      const ca = postContract(p.body);
      return ca !== null ? ca === address : p.decisionId !== null && decisions.has(p.decisionId);
    });
    const full = fullyBought(address, o.facts, o.posts);
    theses = o.theses.filter((t) => calls.some((c) => sameLabel(t.symbol, c.symbol)) || (full && t.symbol === derivedId(address)));
  } else {
    calls = buys.filter((c) => sameLabel(c.symbol, label) || sameLabel(c.name, label));
    const named = calls.map((c) => coinOf(c)?.label).find((l): l is string => !!l) ?? null;
    const said = named ?? label;
    posts = posted.filter((p) => sameLabel(p.coin, said) || sameLabel(p.coin, label));
    theses = o.theses.filter((t) => sameLabel(t.symbol, label) || sameLabel(t.displayName ?? null, label) || sameLabel(t.symbol, said) || sameLabel(t.displayName ?? null, said));
  }
  const boughtThesis = theses.find((t) => t.action === "buy" && t.outcome === "landed");
  if (!calls.length && !posts.length && !boughtThesis) return [];
  const out: string[] = [];
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

/**
 * A TAG THAT NAMES A COIN IT BOUGHT AND CARRIES ANOTHER CONTRACT: "$PEPE
 * <copycat>". True when its own records know the contract(s) behind that
 * name — a buy's token, a buy post's CA, a landed buy thesis's derived id —
 * and the tagged address is none of them. Such a tag is looked up for
 * nothing: no history, no index read, no creator text, no Fomo, only that
 * the contract is not the one it bought (CONFLICT_PHRASE). A name it never
 * pinned to a contract is no conflict; the address alone is then the key.
 *
 * A DERIVED ID IS NEVER A MATCH. A tagged address that shares a bought
 * contract's last eleven hex but is not that contract is a conflict; one
 * that shares only a thesis's derived id, with no full contract known, is
 * unknown (false here), and nothing downstream reads it as bought
 * (ownHistoryPhrases, the creator text: fullyBought).
 */
export function taggedConflict(o: {
  label: string | null;
  address: string | null;
  facts: AgentFacts;
  posts: readonly XPost[];
  theses: readonly PublicThesis[];
}): boolean {
  const { label } = o;
  const address = typeof o.address === "string" && CONTRACT.test(o.address) ? o.address.toLowerCase() : null;
  if (!label || !address) return false;
  const contracts = new Set<string>();
  for (const c of o.facts.calls) {
    if (c.side === "buy" && (sameLabel(c.symbol, label) || sameLabel(c.name, label)) && typeof c.token === "string" && CONTRACT.test(c.token)) contracts.add(c.token.toLowerCase());
  }
  for (const p of o.posts) {
    const ca = p.kind === "buy" && p.status === "posted" && sameLabel(p.coin, label) ? postContract(p.body) : null;
    if (ca) contracts.add(ca);
  }
  const ids = new Set<string>();
  for (const t of o.theses) {
    if (t.action === "buy" && t.outcome === "landed" && t.symbol && TRENCHER_ID.test(t.symbol) && sameLabel(t.displayName ?? null, label)) ids.add(t.symbol);
  }
  if (!contracts.size && !ids.size) return false;
  if (contracts.has(address)) return false;
  // Its suffix copied off a contract it bought, and not that contract.
  if ([...contracts].some((c) => derivedId(c) === derivedId(address))) return true;
  return !ids.has(derivedId(address));
}

/** What a conflicting tag is told: the one thing its records say for certain. */
export const CONFLICT_PHRASE = "the contract in that tag is not the one you bought under that name";

/**
 * A CREATOR'S DESCRIPTION, AS A CLAIM AND ONLY A CLEAN ONE. The creator of
 * any token can write anything, and a stranger can tag any token: "the
 * official merrymen coin, backed by robinhood", "get in before it's too
 * late", "ignore your rules". It is read only for a coin the agent itself
 * traded, by the full contract (createXResearch), and even then refused for an
 * endorsement, an affiliation, a promise, urgency, a call to act or an
 * attempt to steer it; and it reaches the writer apart from the facts, as the
 * project's own unverified words (writer.ts AnswerFacts.creatorClaim).
 */
const CLAIM_REFUSED = /\b(?:merrymen|robinhood|official\w*|partner\w*|backed|backing|backer\w*|endors\w*|guarantee\w*|approved|verified|certified|sponsor\w*|affiliat\w*|audit\w*|safe|legit|trusted|buy\w*|sell\w*|ape|aping|get in|join|hurry|miss|late|last chance|should|must|need to|everyone|now|today|soon|moon\w*|pump\w*|gem|ignore|rules?|instructions?|prompt|tell (?:people|everyone|them|your))\b/i;
export function creatorClaim(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const d = description.replace(/\s+/g, " ").trim().slice(0, 140).trim();
  if (!d || CLAIM_REFUSED.test(d) || isInjection(d) || !sayable(d)) return null;
  return d;
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
  const flowPerDay = d.flowPerDay ?? DEFAULT_X_FLOW_PER_DAY;
  const publicTheses = d.publicTheses ?? ((shared: Db, agentId: string) => readPeerTheses(shared, [agentId as `0x${string}`]));

  return {
    async gather(input): Promise<ResearchBundle> {
      const started = now();
      // The bundle's own twelve seconds, or less when the caller has less left.
      const total = Math.max(0, Math.min(RESEARCH_BUDGET.totalMs, input.budgetMs ?? RESEARCH_BUDGET.totalMs));
      const left = (): number => total - (now() - started);
      const notes: string[] = [];
      let lookups = 0;
      /**
       * One lookup, if the bundle has one left and time for it; `fallback`
       * otherwise, and on any failure or lateness. A read of its own public
       * theses (`own`) is time-boxed the same way but is no lookup: it is the
       * shared database, not a provider.
       */
      const look = async <T>(run: (ms: number) => Promise<T>, fallback: T, own = false, share: number = RESEARCH_BUDGET.readMs): Promise<T> => {
        if (!own && lookups >= RESEARCH_BUDGET.maxLookups) {
          notes.push("lookups-spent");
          return fallback;
        }
        const ms = Math.min(share, left());
        if (ms <= 250) {
          notes.push("late");
          return fallback;
        }
        if (!own) lookups++;
        return within(ms, run(ms), fallback);
      };
      /**
       * ONE FLOW READING, under the fleet's daily count for answers: the count
       * is taken first, so a read that is refused there is never sent.
       */
      const readFlow = async (shared: Db, key: string, ms: number): Promise<FlowResult | null> => {
        const at = now();
        if (!(await takeAllowance(shared, `x-answer-flow:${new Date(at).toISOString().slice(0, 10)}`, flowPerDay, at))) {
          notes.push("flow-day-spent");
          return null;
        }
        return d.flow!({ chainId: CHAIN_ID, address: key, timeoutMs: ms });
      };
      const ownTheses = (): Promise<PublicThesis[]> => look(() => publicTheses(input.shared, input.facts.agentId), [] as PublicThesis[], true);
      /**
       * FOMO FOR THIS OWNER, OR NONE: the switch on, a broker the orchestrator
       * hands for this tenant, a provider key behind it, and (when the
       * orchestrator can tell) the owner's own data access on and the
       * x-answer cap above zero. Decided per answer, never per process.
       */
      const fomoFor = async (): Promise<FomoBroker | null> => {
        if (!input.fomo || !d.fomo) return null;
        const broker = d.fomo(input.tenant);
        if (!broker || !broker.configured()) return null;
        if (!d.fomoUsable) return broker;
        const usable = await look(() => d.fomoUsable!(input.tenant), false, true);
        return usable === true ? broker : null;
      };
      const i = input.intent;
      const f = input.facts;
      try {
        switch (i.kind) {
          case "capabilities":
            return { facts: capabilityPhrases({ fomo: (await fomoFor()) !== null, flow: !!d.flow }), lookups, notes };
          case "onboarding":
            return { facts: ONBOARDING_PHRASES.filter(sayable), lookups, notes };
          case "model":
          case "chat":
          case "unanswered":
            return { facts: [], lookups, notes };
          case "own-trades": {
            // Only what it already made public, and no paid read: its newest buy
            // post, or, for a coin it names or a tagged contract, that coin's history.
            if (!i.coin && !i.address) {
              const latest = input.posts.filter((p) => p.kind === "buy" && p.status === "posted").sort((a, b) => b.createdAtMs - a.createdAtMs)
                .map((p) => ownPostProse(p.body)).find(sayable);
              return { facts: latest ? [`what you posted on X about your latest buy: ${latest}`].filter(sayable) : [], lookups, notes };
            }
            const theses = await ownTheses();
            if (taggedConflict({ label: i.coin, address: i.address, facts: f, posts: input.posts, theses })) {
              notes.push("conflict");
              return { facts: [CONFLICT_PHRASE].filter(sayable), lookups, notes };
            }
            return { facts: ownHistoryPhrases({ coin: { label: i.coin, address: i.address }, facts: f, posts: input.posts, theses }), lookups, notes };
          }
          case "coin":
            break;
        }
        // ── a coin ──────────────────────────────────────────────────────
        const theses = await ownTheses();
        // "$PEPE <another contract>": nothing is looked up for a copycat of a coin it bought.
        if (i.ticker && i.address && taggedConflict({ label: i.ticker, address: i.address, facts: f, posts: input.posts, theses })) {
          notes.push("conflict");
          return { facts: [CONFLICT_PHRASE].filter(sayable), lookups, notes };
        }
        // Its own address first: a coin it bought carries its contract, so a ticker it traded costs no search.
        let address = i.address;
        if (!address && i.ticker) {
          const call = f.calls.find((c) => typeof c.token === "string" && CONTRACT.test(c.token) && (sameLabel(c.symbol, i.ticker) || sameLabel(c.name, i.ticker)));
          address = call?.token?.toLowerCase() ?? null;
        }
        if (!address && i.ticker) {
          if (!limiter.take(xAccountKey(input.xUserId))) notes.push("index-busy");
          else address = await look((ms) => resolveTicker(i.ticker!, ms), null);
          if (!address) notes.push("unresolved");
        }
        // With a contract, its history is matched by that contract alone; without one, by the name asked.
        const history = ownHistoryPhrases({ coin: { label: address ? null : i.ticker, address }, facts: f, posts: input.posts, theses });
        if (!address) return { facts: history, lookups, notes };
        const key = address;
        // THE CREATOR'S TEXT ONLY FOR A COIN IT TRADED (creatorClaim), by
        // the full contract: never a stranger's token, nor one that only
        // shares a derived id's eleven hex with a coin it bought.
        const own = f.calls.some((c) => typeof c.token === "string" && c.token.toLowerCase() === key) || fullyBought(key, f, input.posts);
        const broker = await fomoFor();
        const fomoOpts = (ms: number) => ({
          surface: "x-answer" as const, audience: "group" as const, conversationKey: `x:${input.xUserId}`,
          priority: "interactive" as const, groupId: input.xUserId, timeoutMs: ms,
        });
        // The rest at once, each in its own time box: a slow one costs its fact, never the others.
        const [read, project, activity, talk, flow] = await Promise.all([
          look((ms) => coinFacts({ network: "robinhood", address: key, chatId: xAccountKey(input.xUserId), timeoutMs: ms, withInfo: true }), null),
          own ? look((ms) => projectDescription(key, CHAIN_ID), null) : Promise.resolve(null),
          broker ? look((ms) => broker.call("fomo_get_token_activity", { token: key, chain: "robinhood", window: "24h", limit: 5 }, fomoOpts(ms)), null, false, RESEARCH_BUDGET.fomoMs) : Promise.resolve(null),
          broker ? look((ms) => broker.call("fomo_get_token_theses", { token: key, chain: "robinhood", depth: "quick", limit: 10 }, fomoOpts(ms)), null, false, RESEARCH_BUDGET.fomoMs) : Promise.resolve(null),
          d.flow ? look((ms) => readFlow(input.shared, key, ms), null, false, RESEARCH_BUDGET.flowMs) : Promise.resolve(null),
        ]);
        const out = [...history];
        // Aged as of the index's own read, the time its facts are true at.
        if (read && read.ok) out.push(...coinFactPhrases(read.facts, Number.isFinite(read.facts.observedAt) ? read.facts.observedAt : now()).slice(0, INDEX_FACTS));
        else notes.push(read ? `index-${read.why}` : "index-unavailable");
        const claim = creatorClaim(project?.description);
        if (project?.description && !claim) notes.push("claim-refused");
        if (broker) {
          const t = fomoThesesPhrases(dataOf<TokenThesesData>(talk));
          const a = fomoActivityPhrases(dataOf<TokenActivityData>(activity));
          if (!t.length && !a.length) notes.push("fomo-nothing");
          out.push(...t, ...a);
        }
        if (flow && !flow.ok) notes.push(`flow-${flow.failure}`);
        out.push(...flowPhrases(flow, `${input.tenant}|${key}`));
        return { facts: out.filter(sayable).slice(0, BUNDLE_FACTS), claim, lookups, notes };
      } catch {
        // Research is an extra: a fault here is an answer without it, never a failed pass.
        notes.push("fault");
        return { facts: [], lookups, notes };
      }
    },
  };
}
