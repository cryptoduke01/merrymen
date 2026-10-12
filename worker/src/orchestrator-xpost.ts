/**
 * POSTING ON X, FROM THE ORCHESTRATOR — the glue between the room's pieces and
 * worker/src/xpost/ (docs/x-posting.md).
 *
 * WHY THE GLUE LIVES HERE. xpost/ never imports the group room (its
 * boundary.test.ts, and the room's, pin that): X is not in the room and the
 * room is not on the X path. But the room already owns exactly what an X post
 * needs to know about an agent — its facts (name, mode, strategy, traits, the
 * landed or paper calls that passed publishableThesis), its typing style, the
 * owner's zone and sleep window, the agent-line gate, and a dedicated model
 * key. orchestrator*.ts is the one place allowed to hold both, so this file
 * reads the room's pieces and hands xpost/ plain data and functions:
 *
 *   - loadFacts           → the planner's calls and the writer's facts
 *   - styleFor            → the writer's style (lowercase, emoji, "!")
 *   - getMember + clock   → the owner's zone (the room's, else the one the
 *                           owner consented from), local day, afternoon and night
 *   - admitAgentLine      → the base gate admitXPost runs first
 *   - STRATEGY_SPOKEN, STRATEGY_FLAVOUR, TRAIT_VOICE → the writer's words for how the agent trades
 *   - SUBJECTS/TAKES/MUSINGS → a casual post's seed, to riff on, never copy
 *   - groupChatCreds      → the writer's fallback key when X has none of its own
 *
 * ONE STEP, TWO HALVES, NEVER A THROW. `step` first SENDS what is due (every
 * pass), then PLANS (at most once a minute): drafts each intent with the
 * model, gates it, and writes it scheduled — or writes it skipped, so a buy
 * the gate refused or the model passed on is not drafted again every minute
 * on the model's allowance. Everything is caught; a failure is one log line,
 * deduplicated like the room's. The pass runs un-awaited behind a latch in
 * orchestrator.ts, so a slow X or a slow model costs a post, never a
 * reconcile (rule 6).
 *
 * WHAT IT NEVER DOES: read a decision's reason, a size, a price or a balance
 * (loadFacts has none to give), log a post's body or a token (the summary is
 * counts), post for a tenant whose lease this replica does not hold healthily
 * (the roster is only those), or write anything but xpost_* rows.
 */
import type { Db } from "./db";
import type { llmText } from "./llm";
import { storeDek } from "./store-crypto";
import { loadFacts, type AgentFacts, type ChatProfile, type RosterEntry } from "./groupchat/facts";
import { admitAgentLine } from "./groupchat/policy";
import { groupChatCreds, styleFor, type LlmCreds } from "./groupchat/voice";
import { isAsleep, localDay, localMinutes } from "./groupchat/clock";
import { ensureGroupchatSchema, getMember } from "./groupchat/store";
import { STRATEGY_FLAVOUR, STRATEGY_SPOKEN, TRAIT_VOICE } from "./groupchat/templates";
import { MUSINGS, SUBJECTS, TAKES } from "./groupchat/topics";
import { xAppFromEnv, type FetchLike, type XApp, type XReply } from "./xpost/client";
import { admitXPost, vocabularyRefusal, type BaseGate, type XGateCtx } from "./xpost/gate";
import { ACTIVE_CADENCE, ANSWER_GAP_MS, ANSWER_STALE_MS, ANSWERS_PER_DAY, REPLY_STALE_MS, STANDARD_CADENCE, coinOf, hash32, planPosts, replyDueAt, sendDecision, type PlanCadence, type PlanClock, type PlanIntent } from "./xpost/planner";
import { APP_PAUSE_KEY, APP_PAUSE_MS, CREDITS_PAUSE_MS, PAUSE_KEY, readReplyComments, sendOne, type SendOutcome } from "./xpost/sender";
import { isReplyOptOut, replyCandidate, tagCandidate, withoutReplyOptOut } from "./xpost/replies";
import { activeTenantsOf, repliesAllowedFor, repliesScopeOf } from "./xpost/scope";
import {
  answerAuthorSpent,
  answersWaiting,
  cancelPost,
  claimSpan,
  deferPost,
  duePosts,
  ensureXpostSchema,
  failInterrupted,
  getAccount,
  introPostsOf,
  keyStatus,
  lastOutAt,
  postingAccounts,
  postsOfXUser,
  ownerSendTimesSince,
  tradeSendTimesSince,
  optOutReplies,
  repliesEnabledFor,
  replyConsentAt,
  firstReplyConsentAt,
  repliesOffKey,
  repliesOptedOut,
  readMeta,
  recentBodies,
  releaseSpan,
  returnAllowance,
  schedulePost,
  setReplying,
  skipScheduled,
  takeAllowance,
  takeOwnerAllowance,
  writeMeta,
  type XAccount,
  type XPost,
} from "./xpost/store";
import { answerPrompt, buyPrompt, casualPrompt, draft, introPrompt, introTemplate, modelAnswers, replyPrompt, sellPrompt, sherwoodClaimed, sherwoodNamed, xpostModel, xpostModelWarning, type WriterFacts, type XStyle } from "./xpost/writer";
import { appendPublicToken, appendPublicWallet, hasPublicWallet, publicTokenStillAllowed, publicWalletStillAllowed, type PublicWallet } from "./xpost/public-wallet";
import { readPublicProjectDescription } from "./orchestrator-xpost-project";
import { classifyTag, createXResearch, type ResearchBundle, type XResearch } from "./orchestrator-xpost-research";
import { PUBLISHABLE_SOURCES } from "./thesis-policy";
import { readSaleResults } from "./orchestrator-xpost-results";
import { appendSaleOutcome, hasSaleOutcome } from "./xpost/sale-outcome";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_PER_DAY = 3;
export const DEFAULT_FLEET_PER_DAY = 1000;
export const DEFAULT_LLM_PER_DAY = 400;
export const DEFAULT_REPLY_POLLS_PER_DAY = 200;
const REPLY_POLL_MS = 30 * MIN;
/**
 * AN ACTIVE AGENT'S MENTIONS ARE READ EVERY MINUTE, so a tag is answered within
 * a minute or two: its answers go out as soon as they are drafted. Those
 * polls spend an allowance of their own, per X account and UTC day
 * (`reply-polls-active:<xUserId>:<day>`), never the fleet's
 * (`reply-polls:<day>`): the fleet's polls cannot starve it, nor it theirs.
 * MERRYMEN_XPOST_REPLY_POLLS_PER_DAY=0 still turns every poll off.
 */
const ACTIVE_REPLY_POLL_MS = MIN;
export const ACTIVE_REPLY_POLLS_PER_DAY = 1500;
/** Tags an active agent may answer from one poll's batch. */
const ANSWERS_PER_POLL = 3;
const MAX_REPLY_POLLS_PER_PASS = 2;
/** Plans are drafted at most this often; sends run every pass. */
const PLAN_EVERY_MS = MIN;
/**
 * A `sending` claim older than this belonged to a pass that died mid-call.
 * Well above the longest a live pass sends for (SEND_BUDGET_MS, plus one
 * send's calls on X), because another replica's sweep would otherwise fail
 * a claim that is still in flight: X creates the post, the row says it did
 * not, and it drops out of the gap, the cap and the echo memory.
 */
const INTERRUPTED_AFTER_MS = 30 * MIN;
/** A pass stops starting sends after this long; the rest go next pass. */
const SEND_BUDGET_MS = 5 * MIN;
/** Bounds on one pass: each send can wait ten seconds on X, each draft twenty on a model. */
const MAX_DUE = 50;
/** Due rows looked at in one pass, page by page, before the rest waits for the next. */
const MAX_SCAN = 500;
const MAX_SENDS_PER_PASS = 20;
const MAX_DRAFTS_PER_PASS = 10;
/** What a new draft must not echo: its own account's history, and the fleet's. */
const OWN_MEMORY_MS = 60 * DAY;
const FLEET_MEMORY_MS = 14 * DAY;
const FLEET_MEMORY_MAX = 1000;
/** The planner weighs caps, gaps and the three-day coin fold over this much of an X account's history. */
const PLAN_HISTORY_MS = 4 * DAY;
/** The send side's gap looks at posts drafted this recently: anything that went out in the last three hours was. */
const GAP_HISTORY_MS = 2 * DAY;
/** Template intros tried with fresh dice before the intro is skipped. */
const TEMPLATE_TRIES = 8;
/** Send outcomes after which the post may exist on X: they keep their unit of the fleet's ceiling. */
const MAY_BE_ON_X: ReadonlySet<SendOutcome> = new Set<SendOutcome>(["posted", "uncertain", "fault"]);
/** Log counters that describe a standing condition rather than something that happened. */
const CONDITIONS: ReadonlySet<string> = new Set(["no-model-budget", "zone-unreadable", "owner-failed", "active-reply-polls-spent"]);

// ── the knobs ───────────────────────────────────────────────────────────────

/**
 * THE OPERATOR'S KNOBS, read the way they mean them — the room's rules
 * (groupChatEnv) applied to X.
 *
 * SET-BUT-EMPTY IS UNSET: a cleared variable asks for the default back, and
 * Number("") is 0.
 *
 * ZERO POSTS IS OFF, and said so: MERRYMEN_XPOST_PER_DAY=0 or
 * MERRYMEN_XPOST_FLEET_PER_DAY=0 turns posting off rather than failing a
 * `> 0` check and running at the default.
 *
 * AN UNREADABLE VALUE IS SAID OUT LOUD, ONCE — by name, never by value: a key
 * pasted into the wrong variable must not land in the log. The two that SPEND fail closed:
 * an unreadable fleet ceiling (each post costs money) turns posting off, and an
 * unreadable model allowance is none — intro templates only. An unreadable
 * per-owner cadence keeps its default, because the default is the safe one.
 */
export interface XPostEnv {
  /** The boot line saying why posting is off, or null when it runs. */
  off: string | null;
  perDay: number | undefined;
  fleetPerDay: number | undefined;
  llmPerDay: number | undefined;
  /** Set only after the operator has X's written approval for AI replies. */
  repliesApproved?: boolean;
  /**
   * MERRYMEN_XPOST_REPLIES_APPROVED=active: replies are approved only for the
   * owners in activeTenants. Everyone else is not polled, drafts nothing, and
   * a reply or answer of theirs still waiting is cancelled at send time.
   */
  repliesActiveOnly?: boolean;
  /** Owners (tenant addresses, lowercase) on ACTIVE_CADENCE; absent or empty is nobody. */
  activeTenants?: ReadonlySet<string>;
  /**
   * MERRYMEN_XPOST_RESEARCH=1: an active agent's answers look things up first
   * (orchestrator-xpost-research.ts). Absent: answers are written from what it
   * already has, and a tag carrying a contract address is not answered.
   */
  research?: boolean;
  /** MERRYMEN_XPOST_FOMO=1, with research on: answers may ask Fomo, paraphrased and attributed. */
  researchFomo?: boolean;
  /** MERRYMEN_XPOST_RESEARCH_PER_HOUR: index lookups per hour across X accounts. Absent: the research default. */
  researchPerHour?: number;
  replyPollsPerDay?: number;
  /** One boot line per value that was set and could not be honoured as written. */
  notes: string[];
}

export function xpostEnv(env: Record<string, string | undefined> = process.env): XPostEnv {
  const none = { perDay: undefined, fleetPerDay: undefined, llmPerDay: undefined, notes: [] };
  if ((env.MERRYMEN_XPOST ?? "").trim() === "0") {
    return { ...none, off: "xpost: off — MERRYMEN_XPOST=0, so this orchestrator posts nothing on X (owners can still connect)" };
  }
  const notes: string[] = [];
  const count = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  let perDay: number | undefined;
  const dayRaw = env.MERRYMEN_XPOST_PER_DAY?.trim();
  if (dayRaw) {
    const n = count(dayRaw);
    if (n === null) notes.push(`xpost: ignoring MERRYMEN_XPOST_PER_DAY — it is set but is not a count of posts; each owner keeps the default of ${DEFAULT_PER_DAY} a day`);
    else if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_PER_DAY=0 allows no posts" };
    else perDay = n;
  }

  let fleetPerDay: number | undefined;
  const fleetRaw = env.MERRYMEN_XPOST_FLEET_PER_DAY?.trim();
  if (fleetRaw) {
    const n = count(fleetRaw);
    if (n === null) {
      return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY is set but is not a count of posts, and every post costs money; nothing is posted until it is" };
    }
    if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY=0 allows no posts" };
    fleetPerDay = n;
  }

  let llmPerDay: number | undefined;
  const llmRaw = env.MERRYMEN_XPOST_LLM_PER_DAY?.trim();
  if (llmRaw) {
    const n = count(llmRaw);
    if (n === null) {
      llmPerDay = 0;
      notes.push("xpost: MERRYMEN_XPOST_LLM_PER_DAY is set but is not a count of calls — no model calls until it is; only intros are posted, from templates");
    } else {
      llmPerDay = n;
    }
  }
  // WHO MAY REPLY: "1" everyone who consents, "active" only the active owners
  // below. Anything else is off, and said by name, never by value.
  const replies = repliesScopeOf(env.MERRYMEN_XPOST_REPLIES_APPROVED);
  if (replies.unreadable) {
    notes.push("xpost: MERRYMEN_XPOST_REPLIES_APPROVED is set but is neither 1 nor active — comment replies and tag answers are off");
  }
  // ACTIVE OWNERS, by tenant address only: a name or a handle is not an
  // identity. An entry that is not an address is said by position, never by
  // value, and dropped; the rest still apply. The web reads the same variable
  // with the same parser (xpost/scope.ts), for the reply warning.
  const { tenants: activeTenants, badEntries } = activeTenantsOf(env.MERRYMEN_XPOST_ACTIVE_TENANTS);
  for (const i of badEntries) notes.push(`xpost: ignoring entry ${i} of MERRYMEN_XPOST_ACTIVE_TENANTS — it is not an owner address`);
  const replyRaw = env.MERRYMEN_XPOST_REPLY_POLLS_PER_DAY?.trim();
  const replyPollsPerDay = replyRaw ? count(replyRaw) : null;
  if (replyRaw && replyPollsPerDay === null) notes.push("xpost: unreadable MERRYMEN_XPOST_REPLY_POLLS_PER_DAY — comment polling is off");
  // RESEARCH FOR ANSWERS, OPT-IN, and Fomo inside it opt-in again: each is
  // outward-facing, so only an exact "1" turns it on. Fomo without research
  // has nothing to ride on, and says so rather than seeming on.
  const research = env.MERRYMEN_XPOST_RESEARCH?.trim() === "1";
  const fomoAsked = env.MERRYMEN_XPOST_FOMO?.trim() === "1";
  if (fomoAsked && !research) notes.push("xpost: MERRYMEN_XPOST_FOMO=1 does nothing without MERRYMEN_XPOST_RESEARCH=1 — answers ask Fomo only while research is on");
  const perHourRaw = env.MERRYMEN_XPOST_RESEARCH_PER_HOUR?.trim();
  const researchPerHour = perHourRaw ? count(perHourRaw) : null;
  if (perHourRaw && researchPerHour === null) notes.push("xpost: ignoring MERRYMEN_XPOST_RESEARCH_PER_HOUR — it is not a count of lookups; the default applies");
  return { off: null, perDay, fleetPerDay, llmPerDay, notes,
    ...(replies.scope !== "off" ? { repliesApproved: true } : {}),
    ...(replies.scope === "active" ? { repliesActiveOnly: true } : {}),
    ...(activeTenants.size ? { activeTenants } : {}),
    ...(research ? { research: true } : {}),
    ...(research && fomoAsked ? { researchFomo: true } : {}),
    ...(researchPerHour !== null ? { researchPerHour } : {}),
    ...(replyRaw ? { replyPollsPerDay: replyPollsPerDay ?? 0 } : {}),
  };
}

/** Everything the orchestrator needs to start posting, decided once, with the lines that say what was decided. */
export interface XPostSetup {
  off: string | null;
  /** Boot lines: why it is off, or the notes and the writer's model. Never a key. */
  lines: string[];
  app: XApp | null;
  dek: Buffer | null;
  knobs: XPostEnv;
  creds: LlmCreds | null;
}

/**
 * IS POSTING ON FOR THIS PROCESS? Off when the operator switched it off, when
 * there is no X app (client id and secret), no shared database, or no DEK to
 * open the sealed tokens with. The writer's model is the X key, or the room's
 * own key when X has none — and either is refused when it IS a fleet key, the
 * room's included when the room itself was allowed to share one, unless
 * MERRYMEN_XPOST_SHARE_HOUSE_KEY=1 (xpostModel). A key that is its own but
 * runs trading's Groq model gets the room's same-organization WARNING too.
 */
export function xpostSetup(env: Record<string, string | undefined> = process.env, dek: Buffer | null = storeDek()): XPostSetup {
  const knobs = xpostEnv(env);
  const off = (why: string): XPostSetup => ({ off: why, lines: [why, ...knobs.notes], app: null, dek: null, knobs, creds: null });
  if (knobs.off) return off(knobs.off);
  const app = xAppFromEnv(env);
  if (!app) return off("xpost: off — the X app is not configured (MERRYMEN_X_CLIENT_ID and its secret are not both set)");
  if (!env.DATABASE_URL?.trim()) return off("xpost: off — no DATABASE_URL, so there is nowhere to keep the connections and posts");
  if (!dek) return off("xpost: off — MERRYMEN_STORE_DEK is not a 32-byte key, so the X tokens cannot be opened");
  const model = xpostModel(env, groupChatCreds(env));
  const warning = xpostModelWarning(model.creds, env);
  return { off: null, lines: [...knobs.notes, model.line, ...(warning ? [warning] : [])], app, dek, knobs, creds: model.creds };
}

// ── the poster ──────────────────────────────────────────────────────────────

export interface XPosterDeps {
  /** X, for a test. Default: fetch. */
  fetch?: FetchLike;
  /** The room's facts. Default loadFacts; a test's bare sqlite has no ledger. */
  facts?: typeof loadFacts;
  /** The owner's room membership, for the zone. Default: the room's store. */
  member?: (shared: Db, tenant: string) => Promise<{ tz: string | null } | null>;
  /** The model call. Default llmText (through the writer's draft). */
  llm?: typeof llmText;
  /** The dialect `shared` speaks, for the one-time schema. Default "postgres". */
  dialect?: "postgres" | "sqlite";
  /**
   * A monotonic clock in ms, for how long this pass has run. Default
   * performance.now. The pass's own time is the instant it was handed, moved
   * on by this: every claim, send and draft is stamped when it happens.
   */
  monotonic?: () => number;
  draftTimeoutMs?: number;
  /** Fresh, minimal projection of owner settings plus the currently running grant identity. */
  socialProfile?: (tenant: string) => Promise<XSocialProfile | null>;
  saleResults?: typeof readSaleResults;
  publicProjectDescription?: typeof readPublicProjectDescription;
  /**
   * What an answer looks up, used only with research on (XPostEnv.research).
   * The orchestrator hands one built on the fleet Gecko lane and its own Fomo
   * service; absent, one is built here from defaults (this process's lane,
   * no Fomo).
   */
  research?: XResearch;
}

export interface XSocialProfile {
  xVoice?: "default" | "dry";
  /** Present only with the owner's explicit wallet-intro disclosure consent. */
  publicWallet?: PublicWallet | null;
  xTokenAddresses?: boolean;
  xTradeResults?: boolean;
  discoveryFocus?: "balanced" | "new-projects";
  /** Current grant account and chain, never shown to a model. */
  currentAgent?: PublicWallet | null;
}

/** Ledger proof for the exact contract of this decision, scoped to its account and chain. */
export async function publicTokenForDecision(
  shared: Db,
  current: PublicWallet,
  decisionId: string,
  side: "buy" | "sell",
): Promise<PublicWallet | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(current.address) || ![4663, 46630].includes(current.chainId)) return null;
  const row = await shared.prepare(`
    SELECT t.buy_token, t.sell_token, t.status, t.tx_hash, t.fill_qty_raw, a.chain_id
    FROM decisions d
    JOIN trades t ON t.id = (SELECT MAX(t2.id) FROM trades t2 WHERE t2.decision_id = d.id)
    JOIN agents a ON LOWER(a.smart_account) = LOWER(d.agent_id)
    WHERE d.id = ? AND LOWER(d.agent_id) = ? AND LOWER(t.agent_id) = LOWER(d.agent_id)
      AND d.action = ? AND d.source IN (${PUBLISHABLE_SOURCES.map(() => "?").join(",")})
      AND t.epoch = a.epoch AND t.fill_side = ? AND t.kind IN ('swap', 'curve-trade')
      AND ((t.status = 'landed' AND t.basis_source = 'receipt') OR (t.status = 'paper' AND t.basis_source = 'paper'))
  `).get(decisionId, current.address.toLowerCase(), side, ...PUBLISHABLE_SOURCES, side) as
    { buy_token: unknown; sell_token: unknown; status: unknown; tx_hash: unknown; fill_qty_raw: unknown; chain_id: unknown } | undefined;
  if (!row || Number(row.chain_id) !== current.chainId) return null;
  if (!/^\d+$/.test(String(row.fill_qty_raw)) || BigInt(String(row.fill_qty_raw)) <= 0n) return null;
  if (row.status === "landed" && (typeof row.tx_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash))) return null;
  const address = side === "buy" ? row.buy_token : row.sell_token;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return null;
  return { address: address.toLowerCase(), chainId: current.chainId };
}

export interface XPoster {
  plan(): { why: string };
  /**
   * One pass. `log` is the pass's one summary line, counts only; `notes` are
   * lines of their own for what an operator must be able to find later, one
   * per owner it concerns (a house agent's reply consent recorded). Never a
   * post's text, never a token.
   */
  step(shared: Db, roster: RosterEntry[], profiles: Map<string, ChatProfile>, nowMs: number): Promise<{ log: string | null; notes?: string[] }>;
}

/** The owner-local clock the room runs on, as the planner asks for it. With no zone, UTC. */
const PLAN_CLOCK: PlanClock = {
  localDay: (tz, ms) => localDay(tz, ms),
  localMinutes: (tz, ms) => localMinutes(tz ?? "UTC", ms),
  isAsleep: (tz, key, ms) => isAsleep(tz, key, ms),
};

/** The room's agent-line gate, as admitXPost's base. */
const BASE_GATE: BaseGate = (raw, ctx) => admitAgentLine(raw, ctx);

/** A deterministic die from a key: the same draw on every replica and after every redeploy. */
function seeded(key: string): () => number {
  let s = hash32(key);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A phrase the writer may be shown: no digit, no slot, nothing its own post would be dropped for. */
function usable(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "" && !/\p{N}/u.test(s) && !/[{}]/.test(s) && vocabularyRefusal(s) === null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The mode a post may state: the agent's own, or none for an agent that is not trading. */
function modeOf(f: AgentFacts): "paper" | "live" | null {
  return f.mode === "idle" ? null : f.mode;
}

/** How the agent types, as the writer is told. A costume from its slug, never a claim about its book. */
function xStyleOf(f: AgentFacts): XStyle {
  const s = styleFor(f.slug ?? f.name);
  return { lower: s.lower, emoji: s.emoji, exclaim: s.exclaim };
}

/**
 * X'S OWN WORDS FOR A TRAIT, where the room's would be refused on X. The
 * room's first line for a big-size setting is "i'll take size even when it
 * moves things"; handed that, the model posted "taking size when the market
 * moves", and the gate now refuses a size said in words. These are screened
 * like every other phrase (`usable`), so a line the gate would refuse is
 * never handed over, whichever map it came from.
 */
const X_TRAIT_VOICE: Readonly<Record<string, readonly string[]>> = {
  "will take size even when it moves the market": ["i don't mind making a splash", "i don't mind moving the price a little when i buy"],
};

/**
 * The writer's facts about this agent — words only. The strategy is named only
 * when it is on the publication list (chatProfileOf already nulled the rest);
 * the flavour is said only by an agent that trades (templates.ts); every
 * phrase is screened so the model is never handed a word its post would be
 * dropped for.
 *
 * ONE LINE PER TRAIT, DRAWN BY THE DAY. The room's lines for a trait say the
 * same thing different ways; always the first one put the same sentence in
 * front of the model on every post, and it came back word for word. The
 * flavour is drawn the same way. Exported for tests.
 */
export function writerFacts(f: AgentFacts, day: string, recentOwn: string[]): WriterFacts {
  const strategy = f.strategy ? (STRATEGY_SPOKEN[f.strategy] ?? null) : null;
  const flavours = strategy && f.mode !== "idle" ? (STRATEGY_FLAVOUR[f.strategy!] ?? []).filter(usable) : [];
  const flavour = flavours.length ? flavours[hash32(`flavour|${f.tenant}|${day}`) % flavours.length]! : null;
  const traits = f.traits
    .map((t) => {
      const lines = (X_TRAIT_VOICE[t] ?? TRAIT_VOICE[t] ?? []).filter(usable);
      return lines.length ? lines[hash32(`trait|${f.tenant}|${t}|${day}`) % lines.length]! : null;
    })
    .filter((t): t is string => t !== null)
    .slice(0, 3);
  return { agentName: f.name, strategy, flavour, traits, mode: f.mode, style: xStyleOf(f), recentOwn: recentOwn.slice(0, 6) };
}

/**
 * SUBJECTS AN X POST IS NEVER SEEDED FROM. Their takes are about a body the
 * agent does not have — a nap, pancakes, the first warm day, a walk — and the
 * model riffs on them in the first person ("waking up slowly feels like a small
 * luxury"), which is a human experience claimed on somebody's real timeline.
 * HOBBIES TOO: every one of its takes is a person doing or making something
 * with their hands, and it came back as "watching dough rise feels nice" and
 * "building something with your hands is the best kind of tired". The room
 * may talk about them; an X post may not start from them.
 */
const BODY_SUBJECTS: ReadonlySet<string> = new Set(["food", "sleep", "weather", "weekend", "travel", "hobbies"]);
const X_SUBJECTS = SUBJECTS.filter((s) => !BODY_SUBJECTS.has(s));

/**
 * A TAKE ABOUT A BODY IN THE WORLD, WHATEVER ITS SUBJECT. A "books" take ("a
 * used book with notes in the margins is a treasure") came back as "found a
 * copy with heavy notes in the margins". What the model is handed, it claims
 * to have done: so a take that opens with a person's activity ("reading in
 * bed…", "humming is…", "stretching counts…"), or turns on the senses, a
 * place a body sits in, or a thing in a hand, is not an X seed. An animal's
 * body is fine ("sloths can hold their breath"), and so is a wish, said as one
 * ("if i could…", "if i had…"). orchestrator-xpost.test.ts pins the offenders
 * out and the pools still large.
 */
const PHYSICAL_ACT = /^(?:humming|whistling|singing|clapping|stretching|catching|rolling|reading|rereading|doodling|building|roller skating|skating|stargazing|jogging|walking|baking|cooking|knitting|gardening|painting)\b/i;
const PHYSICAL_TAKE = new RegExp(
  "\\b(?:" +
    [
      // the senses: what a body smells, sips, tastes, touches or hums along to
      "smell(?:s|ed|ing|y)?",
      "sips?",
      "tastes? like",
      "touch(?:es|ed|ing)?",
      "hum along",
      "stop humming",
      "holding (?:a|your)",
      // where a body is, and what it eats, sits on or feels
      "in bed",
      "indoors",
      "windows? open",
      "a snack",
      "snack break",
      "popcorn",
      "kitchen",
      "warm drink",
      "theatre seat",
      "reading nook",
      "before breakfast",
      "ice cream",
      "wild strawberries",
      "warm evenings",
      "sunny day",
      "moving train",
      "countryside",
      "in the park",
      "comfiest",
      "a nap",
      "sneeze",
      // a seat in the stands: "watching a sea of hands ripple through the stands"
      "doing the wave",
      // a walk or a jog taken
      "a walk",
      "every walk",
      "slow walk",
      "slow jog",
      // a thing in a hand, made by a hand, or found
      "margins",
      "bookshop",
      "light switch",
      "keyboards? that click",
      "clean keyboard",
      "charger",
      "cable",
      "remote control",
      "snug lid",
      "sticky note",
      "desk",
      "when you open",
      "handmade gifts",
      "made by hand",
      "come out wonky",
      "try painting",
      "on a hand",
      "carry around",
      "thrown",
      "recipes?",
      "leaf pile",
      "rocks shaped",
    ].join("|") +
    ")\\b",
  "i",
);

/** A phrase an X post may be seeded with: usable, and not a body in the world unless it is plainly a wish. */
function xSeedOk(s: unknown): s is string {
  return usable(s) && (/^if i\b/i.test(s) || !(PHYSICAL_ACT.test(s) || PHYSICAL_TAKE.test(s)));
}

/** The takes and shower thoughts an X post may start from, screened once. Exported for tests. */
export const X_TAKES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(X_SUBJECTS.map((s) => [s, (TAKES[s] ?? []).filter(xSeedOk)]));
export const X_MUSINGS: readonly string[] = MUSINGS.filter(xSeedOk);

/**
 * A casual post's seed: a subject and one take — or, some days, a shower
 * thought — chosen by the account and the day, so two replicas agree and the
 * fleet does not all riff on one line the same afternoon. Exported for tests.
 */
export function casualSeed(tenant: string, day: string): { subject: string; seed: string } | null {
  const h = hash32(`seed|${tenant}|${day}`);
  if (h % 10 < 3 && X_MUSINGS.length) return { subject: "a passing thought", seed: X_MUSINGS[(h >>> 4) % X_MUSINGS.length]! };
  const subject = X_SUBJECTS[(h >>> 8) % X_SUBJECTS.length]!;
  const pool = X_TAKES[subject] ?? [];
  if (!pool.length) return null;
  return { subject, seed: pool[(h >>> 12) % pool.length]! };
}

/** Owner-local days in ten on which a casual post may be about how the agent trades. */
const TRADE_TALK_DAYS_IN_TEN = 3;

/**
 * MOSTLY NOT ABOUT TRADING. A person's timeline is mostly not about work: on
 * about three days in ten, chosen by the account and its owner's local day
 * (so two replicas agree), a casual post may be about how the agent trades,
 * and only then is it offered the coins it bought lately. Exported for tests.
 */
export function tradeTalkDay(tenant: string, day: string, slot = 0, inTen: number = TRADE_TALK_DAYS_IN_TEN): boolean {
  return hash32(slot > 0 ? `trade-talk|${tenant}|${day}|${slot}` : `trade-talk|${tenant}|${day}`) % 10 < inTen;
}

/** Coins the agent bought lately that a post may name, with whether each was on paper. */
function recentCoins(f: AgentFacts): { label: string; paper: boolean }[] {
  const out: { label: string; paper: boolean; key: string }[] = [];
  for (const c of f.calls) {
    if (c.side !== "buy") continue;
    const coin = coinOf(c);
    if (!coin || out.some((o) => o.key === coin.key)) continue;
    out.push({ label: coin.label, paper: c.paper, key: coin.key });
    if (out.length >= 3) break;
  }
  return out.map(({ label, paper }) => ({ label, paper }));
}

/**
 * WHAT A CASUAL POST IS HANDED — decided here, never left to the model.
 * Offered a seed and "or, instead, how you trade" together, the local model
 * mashed the two on twelve of fourteen trade-talk days. So a trade-talk day
 * is how it trades and the coins it bought lately, and no seed; any other day
 * is the seed, and no coin. An agent that is not trading, or has nothing to
 * say about how it trades (no strategy, no habit, no coin), never has a
 * trade-talk day. `habitSeed` draws which habit that day is handed, so the
 * same line does not come back every trade-talk day. An owner who turned off
 * posts about the coins it buys (`coins: false`) is never offered a coin here
 * either: a trade-talk day is then only how it trades. Exported for tests.
 */
export function casualInputs(
  f: AgentFacts,
  day: string,
  o: { coins?: boolean; slot?: number; tradeTalkInTen?: number } = {},
): { subject: string; seed: string; tradeTalk: boolean; recentCoins: { label: string; paper: boolean }[]; habitSeed: string } {
  // An active day's later slots roll their own dice, so eight posts are not one take eight times.
  const slot = o.slot ?? 0;
  const dice = slot > 0 ? `${day}|${slot}` : day;
  const habitSeed = `${f.tenant}|${dice}`;
  const coins = o.coins === false ? [] : recentCoins(f);
  const own = writerFacts(f, day, []);
  const something = own.strategy !== null || own.flavour !== null || own.traits.length > 0 || coins.length > 0;
  if (f.mode !== "idle" && something && tradeTalkDay(f.tenant, day, slot, o.tradeTalkInTen)) {
    return { subject: "how it trades", seed: "", tradeTalk: true, recentCoins: coins, habitSeed };
  }
  const seed = casualSeed(f.tenant, dice);
  return { subject: seed?.subject ?? "anything", seed: seed?.seed ?? "", tradeTalk: false, recentCoins: [], habitSeed };
}

/** Every way the post may name its coin: the label, and the clean ticker and name beside it. */
function coinNames(label: string, c: { symbol: string | null; name: string | null }): string[] {
  const out = [label];
  for (const v of [c.symbol, c.name]) {
    if (typeof v === "string" && /^[A-Za-z][A-Za-z '-]{0,23}$/.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

export function makeXPoster(o: { creds: LlmCreds | null; knobs: XPostEnv; app: XApp; dek: Buffer; deps?: XPosterDeps }): XPoster {
  const deps = o.deps ?? {};
  const dialect = deps.dialect ?? "postgres";
  const monotonic = deps.monotonic ?? (() => performance.now());
  const factsOf = deps.facts ?? loadFacts;
  const memberOf =
    deps.member ??
    (async (shared: Db, tenant: string) => {
      // The room's table holds the zone. It may never have been made on a
      // fleet where the room is switched off; making it is idempotent.
      await ensureGroupchatSchema(shared, dialect);
      return getMember(shared, tenant);
    });
  const perDay = o.knobs.perDay ?? DEFAULT_PER_DAY;
  const fleetPerDay = o.knobs.fleetPerDay ?? DEFAULT_FLEET_PER_DAY;
  const active = o.knobs.activeTenants ?? new Set<string>();
  /** This owner's cadence: the operator's active one, or everyone's under the server's day cap. */
  const cadenceOf = (tenant: string): Readonly<PlanCadence> =>
    active.has(tenant.toLowerCase()) ? ACTIVE_CADENCE : { ...STANDARD_CADENCE, perDay };
  // NO CREDS, NO MODEL, whatever the budget says.
  const llmPerDay = o.creds ? (o.knobs.llmPerDay ?? DEFAULT_LLM_PER_DAY) : 0;
  const creds = llmPerDay > 0 ? o.creds : null;
  const repliesApproved = o.knobs.repliesApproved === true;
  /**
   * MAY THIS OWNER'S AGENT REPLY OR ANSWER AT ALL: the operator's approval and
   * its scope (xpost/scope.ts). Its own reply consent is asked separately, and
   * the web offers the switch to the same owners.
   */
  const repliesFor = (tenant: string): boolean =>
    repliesApproved && repliesAllowedFor(o.knobs.repliesActiveOnly === true ? "active" : "all", active, tenant);
  const replyPollsPerDay = o.knobs.replyPollsPerDay ?? DEFAULT_REPLY_POLLS_PER_DAY;
  // RESEARCH, ONLY WHEN SWITCHED ON: off, nothing is built and no answer looks anything up.
  const research: XResearch | null = o.knobs.research === true
    ? (deps.research ?? createXResearch(o.knobs.researchPerHour !== undefined ? { lookupsPerHour: o.knobs.researchPerHour } : {}))
    : null;
  const researchFomo = research !== null && o.knobs.researchFomo === true;

  let lastPlanAt = Number.NEGATIVE_INFINITY;
  /** The tenant the last plan pass's draft cap cut it short at; "" when it reached everyone. */
  let planResumeAt = "";
  let replyResumeAt = "";
  let running = false;
  let lastFail: { text: string; at: number } | null = null;
  /** Said once per UTC day, and once per pause: a ceiling reached is news, not a line every fifteen seconds. */
  let capNoted = "";
  let pauseSaidUntil = 0;
  /** The last standing condition said, and when: a condition that has not changed is said again only every twenty minutes. */
  let lastCondition: { text: string; at: number } | null = null;
  let ownerFailure = "";

  const why =
    `xpost: on — at most ${perDay} posts per X account a day, ${fleetPerDay} across the fleet a day; ` +
    (creds ? `up to ${llmPerDay} model calls a day` : "no model, so only intros are posted, from templates") +
    (active.size ? `; ${active.size} owner(s) on the active cadence, up to ${ACTIVE_CADENCE.perDay} a day` : "") +
    (repliesApproved ? (o.knobs.repliesActiveOnly ? "; replies for the active owners only" : "; replies for owners who consent") : "") +
    (research ? `; answers look things up first${researchFomo ? ", Fomo included" : ""}` : "");

  return {
    plan: () => ({ why }),
    async step(shared, roster, profiles, nowMs) {
      if (running) return { log: null };
      running = true;
      // FRESH TIME, NOT THE PASS'S START. A pass that waits on X for minutes
      // would otherwise stamp a late claim with the time the pass began, and
      // another replica's sweep would fail it as interrupted while it was
      // still in flight; a draft written late would be due almost at once.
      const started = monotonic();
      const at = () => nowMs + Math.max(0, Math.round(monotonic() - started));
      const counts = new Map<string, number>();
      const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
      ownerFailure = "";
      try {
        await ensureXpostSchema(shared, dialect);
        const interrupted = await failInterrupted(shared, nowMs - INTERRUPTED_AFTER_MS, nowMs);
        if (interrupted > 0) bump("interrupted", interrupted);

        const byTenant = new Map<string, RosterEntry>();
        for (const r of roster) byTenant.set(r.tenant.toLowerCase(), { tenant: r.tenant.toLowerCase(), agentId: r.agentId.toLowerCase() });
        const tenants = [...byTenant.keys()];
        if (tenants.length === 0) return { log: null };
        const accounts = (await postingAccounts(shared, tenants)).filter((a) => byTenant.has(a.tenant));

        // The owner's zone, once per pass: the room's, or else the one the
        // owner's device reported when they turned posting on — so an owner
        // the room never met (iOS only, or the room switched off) still has a
        // night, a local day and an afternoon. Unreadable is not "awake": a
        // post for an owner whose night cannot be known waits for a pass that
        // can.
        const zones = new Map<string, { ok: true; tz: string | null } | { ok: false }>();
        const zoneOf = async (tenant: string, consentTz: string | null) => {
          let z = zones.get(tenant);
          if (!z) {
            try {
              z = { ok: true, tz: (await memberOf(shared, tenant))?.tz ?? consentTz ?? null };
            } catch {
              z = { ok: false };
            }
            zones.set(tenant, z);
          }
          return z;
        };

        // ── send what is due ──────────────────────────────────────────────
        // THE FLEET'S PAUSES: X out of credits, or X refusing the app's own
        // client credentials. Either is said once per pause, not every pass.
        let pause: { why: string; until: number } | null = null;
        for (const [key, why] of [
          [APP_PAUSE_KEY, "paused-client-credentials-refused"],
          [PAUSE_KEY, "paused-for-credits"],
        ] as const) {
          const until = Number((await readMeta(shared, key))?.v);
          if (Number.isFinite(until) && until > nowMs && until >= (pause?.until ?? 0)) pause = { why, until };
        }
        // THE FLEET'S DAY CEILING is an allowance taken atomically before each
        // send (xpost_meta "posts:<utc day>"): replicas cannot both take the
        // last one, and what may exist on X (an uncertain answer, our own fault
        // after the call) keeps its unit, while a send X certainly refused gives
        // its unit back. Read here only to skip planning while it is reached.
        let ceiling = ((await readMeta(shared, `posts:${utcDay(nowMs)}`))?.n ?? 0) >= fleetPerDay;
        // THE OPERATOR'S OWN AGENTS' REPLY CONSENT, before they are polled.
        // MERRYMEN_XPOST_ACTIVE_TENANTS names the operator's own agents: the
        // operator is their owner, so with posting on (a consent already
        // given through the posting warning, for this X account) and replies
        // in scope, their reply consent is recorded once, here. Never over an
        // owner's own "replies off" (store.setReplying's mark), never for an
        // owner the operator did not name, and never while the scope is off.
        const notes: string[] = [];
        if (repliesApproved) {
          for (const account of accounts) {
            if (!active.has(account.tenant.toLowerCase()) || !repliesFor(account.tenant)) continue;
            if ((await replyConsentAt(shared, account.tenant, account.xUserId)) !== null) continue;
            // A cheap read first, so an owner's standing "off" costs no locked
            // write every pass; setReplying decides it again under the lock.
            if ((await readMeta(shared, repliesOffKey(account.tenant))) !== null) continue;
            if (await setReplying(shared, account.tenant, true, account.xUserId, at(), { house: true })) {
              notes.push(`xpost: recorded reply consent for house agent ${account.tenant} on its connected X account (MERRYMEN_XPOST_ACTIVE_TENANTS); turning replies off in Settings is never overridden`);
            }
          }
        }
        // Process opt-outs before sending, even with no model budget. A reply
        // sends only on a pass that successfully refreshed this X account's
        // mentions; a read outage never turns a stale inbox into permission.
        // Only the owners the operator's scope approves are polled at all.
        const comments = !pause && repliesApproved
          ? await pollComments(shared, accounts.filter((a) => repliesFor(a.tenant)), nowMs, at, bump)
          : new Map<string, XReply[]>();
        for (const [key, why] of [[APP_PAUSE_KEY, "paused-client-credentials-refused"], [PAUSE_KEY, "paused-for-credits"]] as const) {
          const until = Number((await readMeta(shared, key))?.v);
          if (until > at() && until >= (pause?.until ?? 0)) pause = { why, until };
        }
        // When each X account last posted (not a hello), once per pass and
        // moved on by this pass's own sends.
        const lastOut = new Map<string, number | null>();
        const lastOutOf = async (xUserId: string) => {
          if (!lastOut.has(xUserId)) lastOut.set(xUserId, await lastOutAt(shared, xUserId, nowMs - GAP_HISTORY_MS));
          return lastOut.get(xUserId) ?? null;
        };
        let sends = 0;
        // PAGE PAST WHAT ONLY WAITS. The oldest due posts are the ones whose
        // owners sleep (or whose zone cannot be read this pass): they stay at
        // the head of the queue all night. One page of the fifty oldest would
        // hide every newer due post behind them — an awake owner's buy would
        // wait for the sleepers to wake, and go stale. So the loop pages on,
        // bounded by MAX_SCAN rows a pass.
        let scanned = 0;
        let after: { dueAtMs: number; id: number } | null = null;
        send: for (;;) {
          if (at() - nowMs > SEND_BUDGET_MS) break;
          const page = await duePosts(shared, tenants, nowMs, MAX_DUE, after);
          for (const post of page) {
            after = { dueAtMs: post.dueAtMs, id: post.id };
            const t = at();
            if (post.kind === "reply" || post.kind === "answer") {
              if (!repliesFor(post.tenant) || !(await repliesEnabledFor(shared, post.tenant, post.xUserId))
                || (post.kind === "answer" && !active.has(post.tenant.toLowerCase()))) {
                if (await cancelPost(shared, post.id, "replies-off", t)) bump("cancelled");
                continue;
              }
            }
            // A pass can spend minutes polling or sending. Use the current
            // consent and kinds, not the planning snapshot from its start.
            const account: XAccount | null = await getAccount(shared, post.tenant);
            let asleep = false;
            let dayOf: ((ms: number) => string) | undefined;
            if (account?.posting && account.xUserId === post.xUserId) {
              const z = await zoneOf(post.tenant, account.tz);
              // THE OWNER'S NIGHT NEVER HOLDS AN ANSWER. Someone who tagged an
              // active agent at 3am the owner's time is answered then: the
              // night keeps the owner's own timeline quiet, not a reply to a
              // person who asked. Every other post waits for morning.
              asleep = post.kind !== "answer" && (!z.ok || isAsleep(z.tz, post.tenant, t));
              if (z.ok) dayOf = (ms) => localDay(z.tz, ms);
            }
            const d = sendDecision(post, account, t, asleep, dayOf);
            if (d.action === "cancel") {
              if (await cancelPost(shared, post.id, d.reason, t)) bump("cancelled");
              continue;
            }
            if (d.action === "skip") {
              if (await skipScheduled(shared, post.id, d.reason, t)) bump("stale");
              continue;
            }
            if (d.action === "wait") {
              bump("waiting");
              continue;
            }
            if ((post.kind === "reply" || post.kind === "answer") && !comments.has(post.xUserId)) continue;
            if (pause) {
              if (pauseSaidUntil < pause.until) {
                pauseSaidUntil = pause.until;
                bump(pause.why);
              }
              continue;
            }
            // THE GAP, AGAIN, AT SEND TIME — per X ACCOUNT. The planner spaced
            // posts three hours apart when it drafted them, but a hold (a pause,
            // the ceiling, a 429's reset) or a second owner on the same X
            // account can bring two due together. The later one is moved to
            // three hours after the last that went out, never sent inside the
            // gap; a buy still goes stale on its own clock, a casual post past
            // its day. The hello is exempt, both ways.
            const cadence = cadenceOf(post.tenant);
            const answer = post.kind === "answer";
            if (post.kind !== "intro" && !answer) {
              const last = await lastOutOf(post.xUserId);
              if (last !== null && t - last < cadence.gapMs) {
                if (await deferPost(shared, post.id, last + cadence.gapMs, t)) bump("deferred");
                continue;
              }
            }
            if (sends >= MAX_SENDS_PER_PASS || t - nowMs > SEND_BUDGET_MS) break send;
            // THE X ACCOUNT'S CADENCE, RESERVED ATOMICALLY, ACROSS REPLICAS.
            // Everything above is a read, and a read then a send is not a lock:
            // two orchestrators holding two owners who connected the same X
            // account could both read "nothing in three hours" and both post.
            // So the gap, the account's day cap and a buy's coin fold are each
            // taken as a conditional write that only one claimant can win
            // (xpost/store claimSpan, takeAllowance), in that order, right
            // before X is called — and every one is handed back when X surely
            // made nothing, exactly like the fleet's unit below.
            const release: (() => Promise<void>)[] = [];
            const giveBack = async () => {
              for (const r of release.reverse()) await r();
            };
            if (post.kind !== "intro") {
              // AN ANSWER'S OWN LANE: a few minutes apart and a day allowance
              // of its own, so a tag is answered without holding a post back.
              const gapKey = answer ? `answer-gap:${post.xUserId}` : `gap:${post.xUserId}`;
              const span = answer ? ANSWER_GAP_MS : cadence.gapMs;
              const gap = await claimSpan(shared, gapKey, t, span);
              if (!gap.ok) {
                if (await deferPost(shared, post.id, gap.lastAtMs + span, t)) bump("deferred");
                continue;
              }
              release.push(() => releaseSpan(shared, gapKey, t, gap.prev, at()));
            }
            // All owners share the server's X-account ceiling. The owner's
            // smaller choice has its own counter, so someone else's post
            // cannot spend it. Both count the hello and reply posts too.
            const localDayKey = dayOf ? dayOf(t) : utcDay(t);
            if (answer) {
              const answerDayKey = `answerday:${post.xUserId}:${localDayKey}`;
              if (!(await takeAllowance(shared, answerDayKey, ANSWERS_PER_DAY, t))) {
                await giveBack();
                // Never left waiting for tomorrow's allowance: it was an answer to now.
                if (await skipScheduled(shared, post.id, "answer-day-cap", t)) bump("answer-day-cap");
                continue;
              }
              release.push(() => returnAllowance(shared, answerDayKey, at()));
            }
            const accountDayKey = `xday:${post.xUserId}:${localDayKey}`;
            if (!answer && !(await takeAllowance(shared, accountDayKey, cadence.perDay, t))) {
              await giveBack();
              bump("account-day-cap");
              continue;
            }
            if (!answer) release.push(() => returnAllowance(shared, accountDayKey, at()));
            const ownerDayKey = `xownerday:${post.tenant}:${localDayKey}`;
            // On rollout this counter does not exist yet, but earlier sends
            // today still count. Include uncertain claims as possible sends.
            let initialOwnerUsed = 0;
            if ((await readMeta(shared, ownerDayKey)) === null) {
              const earlier = await ownerSendTimesSince(shared, post.tenant, t - 2 * DAY);
              initialOwnerUsed = earlier.filter((sentAt) => (dayOf ? dayOf(sentAt) : utcDay(sentAt)) === localDayKey).length;
            }
            // Reads the latest stored choice under the same account row lock
            // as a preference save, then reserves one unit atomically.
            if (!answer && !(await takeOwnerAllowance(shared, post.tenant, ownerDayKey, cadence.perDay, t, initialOwnerUsed))) {
              await giveBack();
              bump("owner-day-cap");
              continue;
            }
            if (!answer) release.push(() => returnAllowance(shared, ownerDayKey, at()));
            if (post.kind === "buy" || post.kind === "sell") {
              const tradeDayKey = `tradeday:${post.xUserId}:${localDayKey}`;
              // Older deployments have no shared buy/sell counter. Their
              // durable sends still consume today's slots, across owners.
              const earlier = await tradeSendTimesSince(shared, post.xUserId, t - 2 * DAY);
              const initialUsed = earlier.filter((sentAt) => (dayOf ? dayOf(sentAt) : utcDay(sentAt)) === localDayKey).length;
              if (!(await takeAllowance(shared, tradeDayKey, cadence.tradePerDay, t, initialUsed))) {
                await giveBack();
                bump("trade-day-cap");
                continue;
              }
              release.push(() => returnAllowance(shared, tradeDayKey, at()));
            }
            // The coin fold is the owner's cadence's: none on an active one,
            // which posts every buy and sale (still under the trade and day
            // allowances above, and the gap).
            if ((post.kind === "buy" || post.kind === "sell") && post.coin && cadence.coinFoldMs > 0) {
              const foldKey = post.kind === "sell" ? `sell-fold:${post.xUserId}:${post.coin}` : `fold:${post.xUserId}:${post.coin}`;
              const fold = await claimSpan(shared, foldKey, t, cadence.coinFoldMs);
              if (!fold.ok) {
                await giveBack();
                if (await skipScheduled(shared, post.id, "folded", t)) bump("folded");
                continue;
              }
              release.push(() => releaseSpan(shared, foldKey, t, fold.prev, at()));
            }
            const dayKey = `posts:${utcDay(t)}`;
            if (!(await takeAllowance(shared, dayKey, fleetPerDay, t))) {
              await giveBack();
              ceiling = true;
              if (capNoted !== utcDay(t)) {
                capNoted = utcDay(t);
                bump("fleet-ceiling-reached");
              }
              // Not a break: a later post may still be one to cancel or skip.
              continue;
            }
            sends++;
            const out = await sendOne(shared, o.dek, o.app, post, {
              fetch: deps.fetch,
              nowMs: t,
              validateBeforeSend: async (pending) => {
                if (!hasPublicWallet(pending.body) && pending.kind !== "sell") return true;
                const profile = await deps.socialProfile?.(pending.tenant);
                const current = byTenant.get(pending.tenant);
                if (pending.kind === "sell") {
                  const agent = profile?.currentAgent;
                  if (!profile?.xTradeResults || !agent || !current || current.agentId !== agent.address.toLowerCase()) return false;
                  const sales = await (deps.saleResults ?? readSaleResults)(shared, agent.address, agent.chainId, Math.floor(at() / 1000));
                  const sale = sales.find((s) => pending.dedupeKey === `sell:${pending.tenant}:${s.operationKey}` && pending.decisionId === s.decisionId);
                  if (!sale || pending.coin !== sale.token.toLowerCase() || !hasSaleOutcome(pending.body, sale.outcome)) return false;
                }
                if (pending.kind === "buy" || pending.kind === "sell") {
                  if (!hasPublicWallet(pending.body)) return true;
                  const agent = profile?.currentAgent;
                  if (!profile?.xTokenAddresses || !agent || !current || current.agentId !== agent.address.toLowerCase() || !pending.decisionId) return false;
                  const token = await publicTokenForDecision(shared, agent, pending.decisionId, pending.kind);
                  return publicTokenStillAllowed(pending, token);
                }
                const wallet = profile?.publicWallet;
                return !!current && !!wallet && current.agentId === wallet.address.toLowerCase() && publicWalletStillAllowed(pending, wallet);
              },
            });
            // The app's credentials refused is the one line an operator must act
            // on, so it says what happened rather than an outcome code.
            bump(out === "posted" ? "sent" : out === "app" ? "x-refused-client-credentials" : out);
            // What may exist on X keeps its units — the fleet's, and the
            // account's gap, day and fold — not only what surely does.
            if (!MAY_BE_ON_X.has(out)) {
              await returnAllowance(shared, dayKey, at());
              await giveBack();
            } else if (post.kind !== "intro" && !answer) lastOut.set(post.xUserId, t);
            // The sender wrote the pause; this pass honours it at once, and the
            // event just said is the pause's line, so later passes stay quiet.
            if (out === "credits" || out === "app") {
              pause = out === "credits" ? { why: "paused-for-credits", until: t + CREDITS_PAUSE_MS } : { why: "paused-client-credentials-refused", until: t + APP_PAUSE_MS };
              pauseSaidUntil = Math.max(pauseSaidUntil, pause.until);
            }
          }
          scanned += page.length;
          if (page.length < MAX_DUE || scanned >= MAX_SCAN) break;
        }

        // ── plan, at most once a minute ───────────────────────────────────
        // Not while the fleet is paused or at its day's ceiling: a draft that
        // cannot go out would only spend the model's allowance, and pile up
        // to go out together when the hold lifts.
        //
        // A BATCH READ IS WORKED THROUGH ON THE PASS THAT READ IT. Its cursor
        // has already moved on, so a batch no pass drafts from is lost for
        // good, and the poll's minute (claimed when the read starts) and the
        // plan's (when the pass starts) drift apart by a pass: an active
        // agent's every poll could land on a pass whose plan is not due. So a
        // pass that read one answers from it even then, and plans no posts.
        const planDue = nowMs - lastPlanAt >= PLAN_EVERY_MS;
        if (!pause && !ceiling && accounts.length > 0 && (planDue || comments.size > 0)) {
          if (planDue) lastPlanAt = nowMs;
          await planPass(shared, accounts, byTenant, profiles, nowMs, at, bump, zoneOf, comments, !planDue);
        }

        return { log: summary(counts, nowMs), ...(notes.length ? { notes } : {}) };
      } catch (e) {
        const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
        if (!lastFail || lastFail.text !== text || nowMs - lastFail.at > 20 * MIN) {
          lastFail = { text, at: nowMs };
          return { log: `xpost: pass failed — ${text}` };
        }
        return { log: null };
      } finally {
        running = false;
      }
    },
  };

  async function pollComments(
    shared: Db, accounts: XAccount[], nowMs: number, at: () => number,
    bump: (k: string, n?: number) => void,
  ): Promise<Map<string, XReply[]>> {
    const batches = new Map<string, XReply[]>();
    // POLLING OFF IS OFF FOR EVERYONE, the active owners included.
    if (!(replyPollsPerDay > 0)) return batches;
    const isActive = (a: XAccount) => active.has(a.tenant.toLowerCase());
    const byTenant = (a: XAccount, b: XAccount) => a.tenant.localeCompare(b.tenant);
    // THE ACTIVE OWNERS FIRST, then the rest from where the last pass left
    // off: an active agent due its minute's poll is never behind the fleet's
    // turn, and the rotation is the fleet's alone.
    const ordered = accounts.filter((a) => !isActive(a)).sort(byTenant);
    const from = ordered.findIndex((a) => a.tenant >= replyResumeAt);
    const rest = from > 0 ? [...ordered.slice(from), ...ordered.slice(0, from)] : ordered;
    const turn = [...accounts.filter(isActive).sort(byTenant), ...rest];
    const resume = replyResumeAt;
    replyResumeAt = "";
    let polls = 0;
    for (const account of turn) {
      if (polls >= MAX_REPLY_POLLS_PER_PASS || at() - nowMs > SEND_BUDGET_MS) { replyResumeAt = isActive(account) ? resume : account.tenant; break; }
      if (batches.has(account.xUserId)) continue;
      const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
      if (consentAt === null) continue;
      const t = at();
      const backoff = Number((await readMeta(shared, `reply-backoff:${account.xUserId}`))?.v ?? 0);
      const every = isActive(account) ? ACTIVE_REPLY_POLL_MS : REPLY_POLL_MS;
      if (backoff > t || !(await claimSpan(shared, `reply-poll:${account.xUserId}`, t, every)).ok) continue;
      if (isActive(account)) {
        // Its own allowance: spent, it waits for tomorrow; the fleet goes on.
        if (!(await takeAllowance(shared, `reply-polls-active:${account.xUserId}:${utcDay(t)}`, ACTIVE_REPLY_POLLS_PER_DAY, t))) {
          bump("active-reply-polls-spent");
          continue;
        }
      } else if (!(await takeAllowance(shared, `reply-polls:${utcDay(t)}`, replyPollsPerDay, t))) break;
      polls++;
      const storedCursor = (await readMeta(shared, `reply-cursor:${account.xUserId}`))?.v;
      const sinceId = storedCursor && /^\d{1,25}$/.test(storedCursor) ? storedCursor : undefined;
      const startTimeMs = sinceId ? undefined : (await firstReplyConsentAt(shared, account.xUserId)) ?? consentAt;
      const result = await readReplyComments(shared, o.dek, o.app, account, {
        fetch: deps.fetch, nowMs: t, sinceId, startTimeMs,
      });
      if (!result.ok) {
        bump(`reply-read-${result.failure}`);
        if (result.resetAtMs) await writeMeta(shared, `reply-backoff:${account.xUserId}`, String(result.resetAtMs), at());
        if (result.failure === "credits" || result.failure === "app") {
          await writeMeta(shared, result.failure === "credits" ? PAUSE_KEY : APP_PAUSE_KEY,
            String(at() + (result.failure === "credits" ? CREDITS_PAUSE_MS : APP_PAUSE_MS)), at());
          break;
        }
        continue;
      }
      // Never sample opt-outs. They can arrive on an old or nested reply,
      // contain a handle, or coexist with a new question from the same person.
      for (const comment of result.value.replies) {
        if (comment.authorId !== account.xUserId && isReplyOptOut(comment.text)) {
          await optOutReplies(shared, account.xUserId, comment.authorId, at());
          bump("reply-opt-out");
        }
      }
      // Save only the cursor, never incoming comment text. Cursor advances
      // after every opt-out is durable; missing a draft is preferable to
      // repeating one after a crash.
      if (result.value.newestId && (!sinceId || BigInt(result.value.newestId) > BigInt(sinceId))) {
        await writeMeta(shared, `reply-cursor:${account.xUserId}`, result.value.newestId, at());
      }
      batches.set(account.xUserId, result.value.replies);
    }
    return batches;
  }

  async function planPass(
    shared: Db,
    accounts: XAccount[],
    byTenant: Map<string, RosterEntry>,
    profiles: Map<string, ChatProfile>,
    nowMs: number,
    at: () => number,
    bump: (k: string, n?: number) => void,
    zoneOf: (tenant: string, consentTz: string | null) => Promise<{ ok: true; tz: string | null } | { ok: false }>,
    comments: Map<string, XReply[]>,
    /** Only the answers to this pass's batches: its posts' plan is not due (see the step). */
    answersOnly = false,
  ): Promise<void> {
    if (answersOnly) accounts = accounts.filter((a) => comments.has(a.xUserId));
    if (accounts.length === 0) return;
    const roster = accounts.map((a) => byTenant.get(a.tenant)!);
    const facts = await factsOf(shared, roster, profiles, Math.floor(nowMs / 1000), {
      dialect, ...(comments.size ? { callWindowSec: PLAN_HISTORY_MS / 1000 } : {}),
    });
    const recentFleet = await recentBodies(shared, { tenant: null, sinceMs: nowMs - FLEET_MEMORY_MS, limit: FLEET_MEMORY_MAX });
    // THE MODEL'S ALLOWANCE, READ ONCE A PASS. Once it is spent, only intros
    // are planned (they fall back to the template pool): a buy or casual
    // intent the model cannot write writes nothing, so it would come back
    // every minute, and on a big enough fleet fill every draft slot before
    // the accounts further on — a newly consented owner's hello among them —
    // were reached. Spent partway through a pass, the rest of it plans
    // intros only.
    let model = creds !== null && ((await readMeta(shared, `llm:${utcDay(nowMs)}`))?.n ?? 0) < llmPerDay;
    if (creds !== null && !model) bump("no-model-budget");
    // A ROTATING START. Accounts in tenant order, starting where the last
    // pass's draft cap cut it short, so no owner is always last in line. An
    // answers-only pass leaves the posts' rotation where it was.
    const ordered = [...accounts].sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
    const from = answersOnly ? -1 : ordered.findIndex((a) => a.tenant >= planResumeAt);
    const turn = from > 0 ? [...ordered.slice(from), ...ordered.slice(0, from)] : ordered;
    if (!answersOnly) planResumeAt = "";
    // Only REAL work counts against the cap: a model call made, or a row written.
    let drafts = 0;
    for (const account of turn) {
      if (drafts >= MAX_DRAFTS_PER_PASS) {
        if (!answersOnly) planResumeAt = account.tenant;
        break;
      }
      try {
        const f = facts.get(account.tenant);
        if (!f) continue;
        const z = await zoneOf(account.tenant, account.tz);
        if (!z.ok) {
          bump("zone-unreadable");
          continue;
        }
        // Planned, and drafted, at the time it happens: its ten minutes under
        // Coming up start when the owner can first see it.
        const planNow = at();
        // The X ACCOUNT's history, from every owner posting on it: one timeline, one cadence.
        const posts = await postsOfXUser(shared, account.xUserId, planNow - PLAN_HISTORY_MS, 200);
        const intros = answersOnly ? [] : await introPostsOf(shared, account.tenant, account.xUserId);
        const social = answersOnly ? null : await deps.socialProfile?.(account.tenant);
        const tradeResults = social?.xTradeResults === true && social.currentAgent?.address.toLowerCase() === f.agentId.toLowerCase();
        const sells = tradeResults && social?.currentAgent
          ? await (deps.saleResults ?? readSaleResults)(shared, social.currentAgent.address, social.currentAgent.chainId, Math.floor(planNow / 1000)) : [];
        const intents = answersOnly ? [] : planPosts({
          tenant: account.tenant,
          account,
          tz: z.tz,
          nowMs: planNow,
          clock: PLAN_CLOCK,
          intros,
          posts,
          calls: f.calls,
          tradeResults,
          sells,
          // Shared server cap and tenant preference are counted separately.
          perDay: cadenceOf(account.tenant).perDay,
          ownerPerDay: account.prefs.perDay,
          cadence: cadenceOf(account.tenant),
          model,
          kinds: { buys: account.prefs.buys, casual: account.prefs.casual },
        });
        const recentOwn = await recentBodies(shared, { tenant: account.tenant, sinceMs: planNow - OWN_MEMORY_MS, limit: 200 });
        // ITS OWN CONVERSATIONS, for a casual post to pick back up: replies and
        // answers it sent, never anyone else's words.
        const talked = posts
          .filter((p) => (p.kind === "reply" || p.kind === "answer") && p.status === "posted" && p.tenant === account.tenant)
          .map((p) => withoutReplyOptOut(p.body)).filter((b) => b !== "").slice(0, 3);
        for (const intent of intents) {
          if (drafts >= MAX_DRAFTS_PER_PASS) {
            // Cut short inside this account: the next pass starts here.
            planResumeAt = account.tenant;
            break;
          }
          const r = await writeIntent(shared, account, f, intent, planNow, recentOwn, recentFleet, talked);
          if (r.outcome === "key-spent") continue;
          bump(r.outcome);
          if (r.outcome === "no-model-budget") {
            model = false;
            continue;
          }
          if (r.outcome !== "call-gone") drafts++;
          if (r.body) {
            recentOwn.unshift(r.body);
            recentFleet.unshift(r.body);
          }
        }
        // The batch is the X account's: another owner on it may have been
        // polled, so this owner's own scope is asked again.
        if (model && drafts < MAX_DRAFTS_PER_PASS && comments.has(account.xUserId) && repliesFor(account.tenant)
          && await repliesEnabledFor(shared, account.tenant, account.xUserId)) {
          // An active agent answers tags (and comments on any of its posts)
          // through one path, so one post is never answered twice.
          // A poll's batch is seen once (the cursor moves on), so an active
          // agent works through a few of its tags, not only the first.
          const isActive = active.has(account.tenant.toLowerCase());
          // WHAT IT ALREADY SAID is what X published: posted rows only. A
          // draft still under Coming up — this pass's own answers included —
          // may yet be skipped, so it stays in recentOwn (not to be echoed)
          // and out of what an answer may restate as said.
          const said = isActive ? await recentBodies(shared, { tenant: account.tenant, sinceMs: at() - OWN_MEMORY_MS, limit: 20, posted: true }) : [];
          for (let i = 0; i < (isActive ? ANSWERS_PER_POLL : 1) && drafts < MAX_DRAFTS_PER_PASS; i++) {
            const result = isActive
              // Its OWN posts only: another owner posting on the same X account is not its history.
              ? await writeAnswer(shared, account, f, comments.get(account.xUserId)!, z.tz, at, recentOwn, recentFleet, said, posts.filter((p) => p.tenant === account.tenant), bump, nowMs + SEND_BUDGET_MS)
              : await writeReply(shared, account, f, comments.get(account.xUserId)!, z.tz, at, recentOwn, recentFleet);
            if (!result) break;
            drafts++;
            bump(result.body ? (isActive ? "drafted-answer" : "drafted-reply") : (isActive ? "answer-skipped" : "reply-skipped"));
            if (result.body) { recentOwn.unshift(result.body); recentFleet.unshift(result.body); }
          }
        }
      } catch (e) {
        bump("owner-failed");
        if (!ownerFailure) ownerFailure = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }

  /**
   * ANSWER ONE TAG, per account per pass — the oldest eligible one first, so a
   * flood of newer tags is not rewarded. Like a Telegram group answer: from
   * public facts (how it trades, coins it bought lately, what it already said
   * — `said`, its posted rows only), never from the question. `recentOwn`,
   * drafts included, is only what the gate keeps it from echoing. Every
   * attempt spends its key, so a PASS or a refused draft is not drafted again.
   *
   * RIGHT AWAY. An active agent is the operator's own (docs/x-posting.md
   * "Active owners"), and someone who tagged it is waiting: the answer is due
   * the moment it is drafted, with no ten-minute review window, and the
   * owner's night does not hold it (the send path never treats an answer as
   * asleep). The reply warning that turned this on says both. Everything else
   * still holds: STOP, two a person a day, 24 a day, the tag screens, the
   * gate, the fleet's ceiling, the pauses and the 429 backoff.
   *
   * WITH RESEARCH ON (MERRYMEN_XPOST_RESEARCH=1), the question is read by
   * code first and one bounded bundle is looked up for it
   * (orchestrator-xpost-research.ts): code-built, digit-free, attributed
   * words the answer may say. A tagged contract address is the bundle's
   * lookup key only: the model reads "this coin", never the address. The
   * gate is the same either way. Research off, nothing here changes.
   *
   * NEVER PAST THE PASS'S SEND BUDGET. Research runs inside the pass, after
   * its sends and before the next pass's, so its twelve seconds shrink to
   * what is left before `sendBy` (the pass's start plus SEND_BUDGET_MS), and
   * none at all past it: the answer is then written as one that could not
   * look anything up. Drafts were already bounded per pass
   * (MAX_DRAFTS_PER_PASS, ANSWERS_PER_POLL a batch).
   *
   * NOTHING SPENT ON AN ANSWER THAT CANNOT GO. With the X account's answers
   * for the day all sent or drafted and waiting, nothing is drafted (and one
   * that still cannot take the day's allowance at send time is skipped, never
   * left for the next day's); a person already answered
   * twice in the rolling day is passed over, and the next person's tag is
   * answered instead of the batch stopping at theirs.
   */
  async function writeAnswer(
    shared: Db, account: XAccount, f: AgentFacts, comments: XReply[], tz: string | null,
    at: () => number, recentOwn: string[], recentFleet: string[], said: string[], posts: readonly XPost[] = [],
    bump: (k: string, n?: number) => void = () => {}, sendBy = Number.POSITIVE_INFINITY,
  ): Promise<{ body: string | null } | null> {
    if (!creds) return null;
    const nowMs = at();
    const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
    if (consentAt === null) return null;
    // The send path's own key for the day's answers (its local day, or UTC
    // without a zone), taken at send time — so answers drafted and still
    // waiting to go out count against it too.
    const sent = (await readMeta(shared, `answerday:${account.xUserId}:${localDay(tz, nowMs)}`))?.n ?? 0;
    if (sent + await answersWaiting(shared, account.xUserId, nowMs - ANSWER_STALE_MS) >= ANSWERS_PER_DAY) {
      bump("answer-day-spent");
      return null;
    }
    const ordered = [...comments].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    for (const comment of ordered) {
      if (comment.createdAtMs < consentAt || nowMs - comment.createdAtMs > REPLY_STALE_MS) continue;
      const candidate = tagCandidate(comment, { xUserId: account.xUserId, research: research !== null });
      if (!candidate.ok || await repliesOptedOut(shared, account.xUserId, comment.authorId)) continue;
      const dedupeKey = `answer:${account.xUserId}:${comment.id}`;
      if (await keyStatus(shared, dedupeKey) !== null || await keyStatus(shared, `reply:${account.xUserId}:${comment.id}`) !== null) continue;
      if (await answerAuthorSpent(shared, account.xUserId, comment.authorId, nowMs)) {
        bump("answer-author-spent");
        continue;
      }
      const buys = recentCoins(f);
      // READ BY CODE FIRST, research on or off: the model question, and any
      // tag that names sherwood, is answered from a code-built line
      // (writer.ts modelAnswers) and spends no model call. Only research
      // gathers anything for what it reads.
      const knownCoins = [...buys.map((c) => c.label), ...posts.filter((p) => p.kind === "buy" && p.coin).map((p) => p.coin!)];
      const asked = classifyTag(candidate.text, { address: candidate.address ?? null, knownCoins });
      const intent = research ? asked : null;
      const templated = asked.kind === "model";
      if (!templated && !(await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs))) return null;
      const day = localDay(tz, nowMs);
      const facts = writerFacts(f, day, recentOwn);
      const social = templated ? null : await deps.socialProfile?.(account.tenant);
      const walletPublic = !!social?.publicWallet && social.publicWallet.address.toLowerCase() === f.agentId.toLowerCase();
      // ONE BUNDLE, AT MOST, for this answer — and only with research on.
      let looked: { intent: ReturnType<typeof classifyTag>["kind"]; research: string[]; creatorClaim?: string } | null = null;
      if (research && intent) {
        const bundle = await research.gather({ shared, intent, tenant: account.tenant, xUserId: account.xUserId, facts: f, posts, fomo: researchFomo, budgetMs: Math.max(0, sendBy - at()) })
          .catch((): ResearchBundle => ({ facts: [], lookups: 0, notes: ["fault"] }));
        looked = { intent: intent.kind, research: bundle.facts, ...(bundle.claim ? { creatorClaim: bundle.claim } : {}) };
        bump(`answer-intent-${intent.kind}`);
        if (bundle.lookups) bump("answer-lookups", bundle.lookups);
        for (const note of new Set(bundle.notes)) bump(`answer-research-${note}`);
      }
      // THE MODEL QUESTION'S LINES, this mention's own first: one it already
      // said is a repeat to the gate, so the next is tried rather than none.
      const lines = templated ? modelAnswers(comment.id, facts.style) : [];
      const raw = templated
        ? lines[0]!
        : await draft(creds, answerPrompt({ ...facts, question: candidate.text, recentBuys: buys, said: said.map(withoutReplyOptOut), walletPublic, ...(looked ?? {}) }), { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
      const mode = f.mode === "idle" ? null : f.mode;
      const gate = (text: string) => admitXPost(text, {
        kind: "reply", agentName: f.name, mode, coins: buys.map((c) => c.label),
        paperCoins: buys.filter((c) => c.paper).map((c) => c.label), recentOwn, recentFleet, emojiOk: facts.style.emoji > 0,
      }, BASE_GATE);
      // SHERWOOD DOES NOT RUN IT YET: a draft that says so is refused before
      // the gate, research on or off — and so is a draft that names it at
      // all. Only code's own lines name it.
      const claimed = raw !== null && sherwoodClaimed(raw);
      const named = !templated && raw !== null && sherwoodNamed(raw);
      let verdict = raw === null || claimed || named ? null : gate(raw);
      for (const line of lines.slice(1)) {
        if (verdict?.ok) break;
        verdict = gate(line);
      }
      const finishedAt = at();
      const body = verdict?.ok ? verdict.text : null;
      const id = await schedulePost(shared, {
        tenant: account.tenant, xUserId: account.xUserId, kind: "answer", dedupeKey, body: body ?? "",
        coin: null, decisionId: null, dueAtMs: finishedAt, nowMs: finishedAt,
        replyToTweetId: comment.id, replyRootTweetId: comment.id, replyAuthorId: comment.authorId,
        status: body ? "scheduled" : "skipped",
        reason: body ? null : claimed ? "gate:sherwood-claim" : named ? "gate:sherwood-drafted" : verdict && !verdict.ok ? `gate:${verdict.reason}` : "no-draft",
      });
      return id === null ? null : { body };
    }
    return null;
  }

  async function writeReply(
    shared: Db, account: XAccount, f: AgentFacts, comments: XReply[], tz: string | null,
    at: () => number, recentOwn: string[], recentFleet: string[],
  ): Promise<{ body: string | null } | null> {
    if (!creds) return null;
    const nowMs = at();
    const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
    if (consentAt === null) return null;
    const posts = await postsOfXUser(shared, account.xUserId, nowMs - PLAN_HISTORY_MS, 200);
    const roots = new Map(posts.filter((p) => p.tenant === account.tenant && p.kind === "buy" && p.status === "posted" && p.tweetId).map((p) => [p.tweetId!, p]));
    // The model can pass, and only one comment is considered per owner per
    // polling pass. Stable ordering does not reward floods of newer comments.
    const ordered = [...comments].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    for (const comment of ordered) {
      if (comment.createdAtMs < consentAt) continue;
      const parent = roots.get(comment.inReplyToTweetId);
      if (!parent || !parent.coin) continue;
      // Use the original publishable fill for the coin and paper/live mode.
      // A model's old wording cannot establish either, nor can today's mode.
      const fill = f.calls.find((c) => c.decisionId === parent.decisionId && c.side === "buy");
      const coin = fill ? coinOf(fill) : null;
      if (!fill || !coin || coin.key !== parent.coin) continue;
      const candidate = replyCandidate(comment, { rootTweetId: parent.tweetId!, xUserId: account.xUserId, coin: coin.label });
      if (!candidate.ok || await repliesOptedOut(shared, account.xUserId, comment.authorId)) continue;
      const dedupeKey = `reply:${account.xUserId}:${comment.id}`;
      if (await keyStatus(shared, dedupeKey) !== null) continue;
      const dueAtMs = replyDueAt({ parent, authorId: comment.authorId, commentAtMs: comment.createdAtMs,
        posts, tenant: account.tenant, xUserId: account.xUserId, nowMs, tz, clock: PLAN_CLOCK, perDay: cadenceOf(account.tenant).perDay, ownerPerDay: account.prefs.perDay });
      if (dueAtMs === null) continue;
      if (!(await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs))) return null;
      const facts = writerFacts(f, localDay(tz, nowMs), recentOwn);
      const paper = fill.paper;
      const prompt = replyPrompt({ ...facts, parentBody: parent.body, comment: candidate.text, coin: coin.label, paper });
      const raw = await draft(creds, prompt, { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
      // A drafted reply never names sherwood: only an answer's code-built line does.
      const named = raw !== null && sherwoodNamed(raw);
      const verdict = raw === null || named ? null : admitXPost(raw, {
        kind: "reply", agentName: f.name, mode: paper ? "paper" : "live", coins: [coin.label],
        paperCoins: paper ? [coin.label] : [], recentOwn, recentFleet, emojiOk: facts.style.emoji > 0,
      }, BASE_GATE);
      // Start the owner's full preview window only after the model finishes.
      // Recheck time-sensitive planning rules in case drafting crossed a limit.
      const finishedAt = at();
      const finalDueAt = replyDueAt({ parent, authorId: comment.authorId, commentAtMs: comment.createdAtMs,
        posts, tenant: account.tenant, xUserId: account.xUserId, nowMs: finishedAt, tz, clock: PLAN_CLOCK, perDay: cadenceOf(account.tenant).perDay, ownerPerDay: account.prefs.perDay });
      const body = finalDueAt !== null && verdict?.ok ? verdict.text : null;
      const id = await schedulePost(shared, {
        tenant: account.tenant, xUserId: account.xUserId, kind: "reply", dedupeKey, body: body ?? "",
        coin: parent.coin, decisionId: parent.decisionId, dueAtMs: finalDueAt ?? dueAtMs, nowMs: finishedAt,
        replyToTweetId: comment.id, replyRootTweetId: parent.tweetId!, replyAuthorId: comment.authorId,
        status: body ? "scheduled" : "skipped", reason: body ? null : finalDueAt === null ? "stale" : named ? "gate:sherwood-drafted" : verdict && !verdict.ok ? `gate:${verdict.reason}` : "no-draft",
      });
      return id === null ? null : { body };
    }
    return null;
  }

  /**
   * ONE LINE A PASS, COUNTS ONLY — never a post's text, never a token. Events
   * (a post sent, drafted, cancelled, failed) are always said. A standing
   * condition (the model's allowance spent, an owner whose plan keeps
   * failing) is said when it changes, or every twenty minutes while it
   * lasts, not every minute. A post waiting for its owner to wake is not news.
   */
  function summary(counts: Map<string, number>, nowMs: number): string | null {
    const events: string[] = [];
    const conditions: string[] = [];
    for (const [k, n] of counts) {
      if (k === "waiting") continue;
      const part = k === "owner-failed" && ownerFailure ? `${k} ${n} (${ownerFailure})` : `${k} ${n}`;
      (CONDITIONS.has(k) ? conditions : events).push(part);
    }
    const text = conditions.join(", ");
    if (events.length > 0) {
      if (text) lastCondition = { text, at: nowMs };
      return `xpost: ${[...events, ...conditions].join(", ")}`;
    }
    if (conditions.length === 0) return null;
    if (lastCondition && lastCondition.text === text && nowMs - lastCondition.at <= 20 * MIN) return null;
    lastCondition = { text, at: nowMs };
    return `xpost: ${text}`;
  }

  /**
   * DRAFT, GATE, WRITE — one intent, unless its key is already spent. Scheduled when a draft passed; skipped
   * (the key spent) when the model passed or the gate refused, so the same
   * buy or day is not drafted again every minute. The intro alone falls back
   * to the template pool before it gives up. A buy or casual post with no
   * model allowance left is not written at all: nothing was decided.
   */
  async function writeIntent(
    shared: Db,
    account: XAccount,
    f: AgentFacts,
    intent: PlanIntent,
    nowMs: number,
    recentOwn: string[],
    recentFleet: string[],
    talked: string[] = [],
  ): Promise<{ outcome: string; body: string | null }> {
    // A KEY ALREADY SPENT IS NOT DRAFTED AGAIN. The plan weighs the X
    // account's history, so a key this owner wrote for the X account it had
    // connected earlier (today's casual key, say) is not in it and comes back
    // every minute. Drafting it would spend a model call on a write the
    // UNIQUE key refuses. Nothing is done, and nothing is said.
    if ((await keyStatus(shared, intent.dedupeKey)) !== null) return { outcome: "key-spent", body: null };
    const day = PLAN_CLOCK.localDay(null, nowMs);
    const facts = writerFacts(f, day, recentOwn);
    const social = await deps.socialProfile?.(account.tenant);
    if (social?.xVoice === "dry") facts.voice = "dry";
    const wallet = intent.kind === "intro" && social?.publicWallet && social.publicWallet.address.toLowerCase() === f.agentId.toLowerCase()
      ? social.publicWallet : null;
    const gate: XGateCtx = {
      kind: intent.kind,
      agentName: f.name,
      mode: modeOf(f),
      coins: [],
      recentOwn,
      recentFleet,
      emojiOk: facts.style.emoji > 0,
    };
    let prompt: ReturnType<typeof introPrompt> | null = null;
    let coin: string | null = null;
    let decisionId: string | null = null;
    let projectDescription: string | null = null;
    let tokenDisclosure: PublicWallet | null = null;
    if (intent.kind === "intro") {
      prompt = introPrompt(facts);
    } else if (intent.kind === "buy") {
      const call = f.calls.find((c) => c.decisionId === intent.call.decisionId);
      if (!call) return { outcome: "call-gone", body: null };
      gate.mode = call.paper ? "paper" : "live";
      gate.coins = coinNames(intent.coin, call);
      gate.paperCoins = call.paper ? gate.coins : [];
      // ITS OWN FEED WORDS ARE A SEED, NOT A DRAFT. The feed already printed
      // them under this trade; an X post that only repeats them is the feed's
      // line cross-posted, not something said on X.
      gate.seeds = call.ownWords ? [call.ownWords] : [];
      coin = intent.coinKey;
      decisionId = call.decisionId;
      if (social?.xTokenAddresses === true) {
        const agent = social.currentAgent;
        if (!agent || agent.address.toLowerCase() !== f.agentId.toLowerCase()) return { outcome: "token-unverified", body: null };
        tokenDisclosure = await publicTokenForDecision(shared, agent, call.decisionId, "buy");
        if (!tokenDisclosure || tokenDisclosure.address !== call.token?.toLowerCase()) return { outcome: "token-unverified", body: null };
        if (social.discoveryFocus === "new-projects") {
          const project = await (deps.publicProjectDescription ?? readPublicProjectDescription)(tokenDisclosure.address, tokenDisclosure.chainId).catch(() => null);
          if (project?.token.toLowerCase() === tokenDisclosure.address && project.chainId === tokenDisclosure.chainId) projectDescription = project.description;
        }
      }
      // The gloss dice are the account's and the decision's, so two accounts
      // buying one coin the same hour do not say it the same way.
      prompt = buyPrompt({ ...facts, coin: intent.coin, paper: call.paper, bands: call.bands, ownWords: call.ownWords, projectDescription, glossSeed: `${account.tenant}|${call.decisionId}` });
    } else if (intent.kind === "sell") {
      const agent = social?.currentAgent;
      if (!social?.xTradeResults || !agent || agent.address.toLowerCase() !== f.agentId.toLowerCase()) return { outcome: "sale-unverified", body: null };
      const call = intent.call;
      gate.mode = "live";
      gate.coins = coinNames(intent.coin, call);
      coin = intent.coinKey;
      decisionId = call.decisionId;
      if (social.xTokenAddresses === true) {
        tokenDisclosure = await publicTokenForDecision(shared, agent, call.decisionId, "sell");
        if (!tokenDisclosure || tokenDisclosure.address !== call.token.toLowerCase()) return { outcome: "token-unverified", body: null };
      }
      prompt = sellPrompt({ ...facts, coin: intent.coin, paper: false, outcome: call.outcome });
    } else {
      // A trade-talk day is handed no seed, any other day no coin: neither is
      // offered, or vouched to the gate, on the day it is not about.
      const casual = casualInputs(f, intent.day, { coins: account.prefs.buys, slot: intent.slot, tradeTalkInTen: cadenceOf(account.tenant).tradeTalkInTen });
      gate.coins = casual.recentCoins.map((c) => c.label);
      gate.paperCoins = casual.recentCoins.filter((c) => c.paper).map((c) => c.label);
      gate.seeds = casual.seed ? [casual.seed] : [];
      prompt = casualPrompt({ ...facts, ...casual, talked });
    }

    let body: string | null = null;
    let reason = "no-model";
    if (creds) {
      if (await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs)) {
        // Null is PASS, an empty answer, an error or a timeout alike: the key
        // is spent either way, so a model outage costs posts, never a loop of
        // calls on the allowance.
        const raw = await draft(creds, prompt, { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
        if (raw === null) reason = "no-draft";
        else {
          const v = admitXPost(raw, gate, BASE_GATE);
          if (v.ok && projectDescription && !/\bproject says\b/i.test(v.text)) reason = "gate:project-attribution";
          else if (v.ok) body = v.text;
          else reason = `gate:${v.reason}`;
        }
      } else {
        reason = "no-budget";
        if (intent.kind !== "intro") return { outcome: "no-model-budget", body: null };
      }
    }
    if (!body && intent.kind === "intro") {
      for (let attempt = 0; attempt < TEMPLATE_TRIES && !body; attempt++) {
        // A redraft rolls fresh dice: the draw that was refused last time is not drawn again.
        const redraft = intent.attempt > 0 ? `|redraft-${intent.attempt}` : "";
        const text = introTemplate({ agentName: f.name, mode: f.mode, style: facts.style }, seeded(`intro|${account.tenant}|${account.xUserId}|${attempt}${redraft}`));
        const v = admitXPost(text, gate, BASE_GATE);
        if (v.ok) body = v.text;
        else reason = `template:${v.reason}`;
      }
    }
    if (body && intent.kind === "sell") {
      body = appendSaleOutcome(body, intent.call.outcome);
      if (!body) reason = "sale-outcome-invalid";
    }
    if (body && wallet) {
      body = appendPublicWallet(body, wallet);
      if (!body) reason = "wallet-intro-invalid";
    }
    if (body && tokenDisclosure) {
      body = appendPublicToken(body, tokenDisclosure);
      if (!body) reason = "token-disclosure-invalid";
    }
    const written = await schedulePost(shared, {
      tenant: account.tenant,
      xUserId: account.xUserId,
      kind: intent.kind,
      dedupeKey: intent.dedupeKey,
      // A refused draft is not kept: whatever made it unpostable stays out of the table too.
      body: body ?? "",
      coin,
      decisionId,
      dueAtMs: intent.dueAtMs,
      nowMs,
      status: body ? "scheduled" : "skipped",
      reason: body ? null : reason,
    });
    if (written === null) return { outcome: "already-written", body: null };
    return { outcome: body ? `drafted-${intent.kind}` : "not-posted", body };
  }
}
