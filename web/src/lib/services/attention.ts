/**
 * What needs the owner, across their agents, in one read.
 *
 * Built for an assistant that checks in by itself every few hours (Claude
 * Duet's periodic checks and morning brief, a scheduled task, a cron) and has
 * to decide whether to interrupt the owner. So every item carries:
 *
 *  - a SEVERITY with one fixed meaning (SEVERITY_MEANING), so two clients
 *    never disagree about what is urgent;
 *  - a stable KEY, the same on every read while the condition and its
 *    severity hold. A client that hands back the keys it already reported is
 *    told which items are new and which have resolved, so it can stay quiet
 *    about what the owner has heard and say so when something is fixed. A
 *    severity that rises (a permission three days from expiry, then one) is a
 *    new key, so it is news again;
 *  - STARTED_AT, when the condition began or crossed into its severity, or
 *    null when no record says (a live blocker is a current fact on the
 *    agent's row, with no time). Never a guess.
 *
 * NOT A SECOND OPINION. Every condition here is one another surface already
 * reports, read the same way:
 *   status, live blocker, worker liveness ..... agent-status.ts readAgentStatus
 *   what a blocker means and who fixes it ..... live-blocker.ts blockerAdvice
 *   permission expiry .......................... the signed grant (OwnedAgent.expiresAt)
 *   kill switch, breaker, provider failure .... the events the risk_halt and
 *                                                provider_failure alerts read
 *                                                (notify.ts classifyAlertEvent)
 *   spending and trade-count caps .............. rejected trades, daily-cap / ops-cap
 *
 * NO RISK LIMIT IS OFFERED AS A FIX. A tripped breaker or a reached cap is the
 * signed permission doing its job: the item says what it holds back and that
 * selling is not blocked, and has no what_to_do.
 *
 * READ-ONLY. Nothing here expires a proposal, follows a trade or marks an
 * alert sent: a check every few hours must not change what it checks.
 */
import type { Db } from "../../../../worker/src/db";
import { classifyAlertEvent, DELIVERY_ERROR_TEXT, PROVIDER_TEXT } from "../../../../worker/src/mcp/notify";
import { blockerAdvice } from "../live-blocker";
import { readAgentStatus } from "./agent-status";
import type { SettingsView } from "./settings-view";

export type Severity = "act_now" | "today" | "fyi";
export const SEVERITIES: readonly Severity[] = ["act_now", "today", "fyi"];

export const SEVERITY_MEANING: Readonly<Record<Severity, string>> = Object.freeze({
  act_now: "Trading has stopped or stops within a day and the owner can fix it, or the drawdown breaker has tripped.",
  today: "Needs the owner within the day, or a fault they should know about that Merrymen has to fix.",
  fyi: "Explains a quiet agent. Nothing has to be done; it can wait for a daily brief.",
});

export type AttentionKind =
  | "no-permission" | "permission-expired" | "permission-expiring" | "live-blocker" | "breaker" | "worker-stale"
  | "arm-error" | "killed" | "daily-cap" | "ops-cap" | "provider-failure" | "proposal-waiting" | "alerts-failing";

export interface AttentionItem {
  /** `<kind>:<agent slug or ->:<what distinguishes this occurrence>`; stable while the condition and severity hold. */
  key: string;
  severity: Severity;
  kind: AttentionKind;
  agent: string | null;
  title: string;
  detail: string;
  owner_can_fix: boolean;
  what_to_do: string | null;
  link: string | null;
  started_at: number | null;
  ends_at: number | null;
}

/** Fixed pages on the configured issuer; null when no issuer is configured. */
export interface AttentionLinks {
  grant: string | null;
  deposit: string | null;
  settings: string | null;
}

export const KEY_RE = /^[a-z][a-z-]{1,23}:[0-9a-z-]{1,16}:[0-9a-z_.-]{1,64}$/;

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
/** Events read per agent for the kill switch, breaker and provider failures. */
export const ATTENTION_EVENTS_MAX = 2_000;
/** How far back events and refusals are read. */
export const ATTENTION_LOOKBACK_SEC = DAY;
/** An expired permission is act_now this long after it lapsed, then fyi: a stopped agent is not news for ever. */
const EXPIRED_LOUD_SEC = 3 * DAY;
/** A cap refusal newer than this means the cap is holding buys now. */
const CAP_CURRENT_SEC = 2 * HOUR;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_ACCOUNTS = 32;

const EXPIRY_TIERS: ReadonlyArray<{ within: number; severity: Severity; tag: string }> = [
  { within: DAY, severity: "act_now", tag: "24h" },
  { within: 3 * DAY, severity: "today", tag: "72h" },
  { within: 7 * DAY, severity: "fyi", tag: "7d" },
];

const RENEW = "Re-sign the trading permission in Merrymen (Wallet & permissions). Renewal revokes the old permission on chain and costs network fees.";

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** "40 min", "9 h", "3 days": for titles, rounded the way a person says it. */
export function inWords(sec: number): string {
  if (sec < HOUR) return `${Math.max(1, Math.round(sec / MINUTE))} min`;
  if (sec < 2 * DAY) return `${Math.round(sec / HOUR)} h`;
  return `${Math.floor(sec / DAY)} days`;
}

/**
 * When a condition the worker restates every tick began: walk back from the
 * newest sighting while sightings stay within `gap` of each other. Null when
 * the run reaches the oldest row read and an older row could still belong to
 * it (the read was cut, or stopped within `gap` of its floor).
 */
export function runStart(newestFirst: readonly number[], gap: number, floor: number, truncated: boolean): number | null {
  if (!newestFirst.length) return null;
  let start = newestFirst[0]!;
  for (let i = 1; i < newestFirst.length; i++) {
    const at = newestFirst[i]!;
    if (start - at > gap) return start;
    start = at;
  }
  return truncated || start - floor <= gap ? null : start;
}

function accountList(accounts: readonly string[]): string[] {
  return [...new Set(accounts.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a)))].slice(0, MAX_ACCOUNTS);
}

/** Permission items: none signed, expired, or inside an expiry tier. */
export function permissionItems(slug: string, account: string | null, expiresAt: number | null, now: number, links: AttentionLinks): AttentionItem[] {
  if (!account) {
    return [{
      key: `no-permission:${slug}:none`, severity: "today", kind: "no-permission", agent: slug,
      title: "No trading permission signed yet",
      detail: "The agent cannot run until the owner signs a trading permission with their own wallet.",
      owner_can_fix: true, what_to_do: "Sign a trading permission in Merrymen to start the agent.", link: links.grant,
      started_at: null, ends_at: null,
    }];
  }
  if (expiresAt === null) return [];
  if (expiresAt <= now) {
    const loud = now - expiresAt <= EXPIRED_LOUD_SEC;
    return [{
      key: `permission-expired:${slug}:${expiresAt}${loud ? "" : "-old"}`, severity: loud ? "act_now" : "fyi", kind: "permission-expired", agent: slug,
      title: loud ? "Trading permission expired" : `Trading permission expired ${inWords(now - expiresAt)} ago`,
      detail: `The trading permission expired at ${iso(expiresAt)}, so the agent cannot trade. Funds stay in the owner's smart account.`,
      owner_can_fix: true, what_to_do: RENEW, link: links.grant,
      started_at: loud ? expiresAt : expiresAt + EXPIRED_LOUD_SEC, ends_at: null,
    }];
  }
  const left = expiresAt - now;
  const tier = EXPIRY_TIERS.find((t) => left <= t.within);
  if (!tier) return [];
  return [{
    key: `permission-expiring:${slug}:${expiresAt}-${tier.tag}`, severity: tier.severity, kind: "permission-expiring", agent: slug,
    title: `Trading permission expires in ${inWords(left)}`,
    detail: `The trading permission expires at ${iso(expiresAt)}. After that the agent stops trading until a new one is signed.`,
    owner_can_fix: true, what_to_do: `${RENEW} Do it before ${iso(expiresAt)} to keep the agent running.`, link: links.grant,
    started_at: expiresAt - tier.within, ends_at: expiresAt,
  }];
}

const FUNDING_TODO: Readonly<Record<string, string>> = {
  "no-gas": "Send a small amount of ETH to the agent's account on Robinhood Chain; the deposit page shows the address. A few dollars covers many trades.",
  "no-cash": "Send USDG to the agent's account on Robinhood Chain; the deposit page shows the address.",
};

const BLOCKER_TITLE: Readonly<Record<string, string>> = {
  "no-gas": "The agent has no ETH for network fees",
  "no-cash": "The agent has no USDG to trade with",
  "dead-policy": "The trading permission cannot reach the chain",
  "wrong-chain": "The trading permission is for another network",
  "grant-too-wide": "The trading permission is too large to install",
  "no-executor": "Nothing can be submitted to the chain",
};

const PROVIDER_TITLE: Readonly<Record<keyof typeof PROVIDER_TEXT, string>> = {
  market: "Market data could not be read",
  brain: "The decision service is unreachable",
  model: "The AI model provider is failing",
};

export interface AgentAttentionInput {
  slug: string;
  /** The current smart account; null before the first signed permission. */
  account: string | null;
  /** Every account the agent has held (older ledger rows live under these). */
  accounts: readonly string[];
  expiresAt: number | null;
  settings: SettingsView | null;
  now: number;
  links: AttentionLinks;
}

/**
 * Everything about one agent that needs its owner, and the agent's name as its
 * worker reports it (owner-chosen text: the caller sanitises it). THROWS when
 * the ledger cannot be read.
 */
export async function readAgentAttention(db: Db, input: AgentAttentionInput): Promise<{ name: string | null; items: AttentionItem[] }> {
  const { slug, account, now, links } = input;
  const items = permissionItems(slug, account, input.expiresAt, now, links);
  if (!account) return { name: input.settings?.agentName ?? null, items };

  const status = await readAgentStatus(db, account, input.settings, now);
  const fresh = status.freshness;
  // A condition the worker restates every tick is current while its newest
  // sighting is younger than two heartbeat windows (never under half an hour),
  // and a run of sightings is one occurrence while they are no further apart
  // than an hour, or two heartbeat windows when that is longer.
  const currentSec = Math.max(30 * MINUTE, 2 * fresh.fresh_within_s);
  const gapSec = Math.max(HOUR, 2 * fresh.fresh_within_s);
  const floor = now - ATTENTION_LOOKBACK_SEC;
  const ids = accountList(input.accounts.length ? input.accounts : [account]);
  const inList = ids.map(() => "?").join(", ");

  const events = ids.length ? (await db.prepare(
    `SELECT message, created_at FROM events WHERE lower(agent_id) IN (${inList}) AND level IN ('warn', 'err') AND created_at >= ?
      ORDER BY created_at DESC LIMIT ${ATTENTION_EVENTS_MAX}`,
  ).all(...ids, floor)) as Array<{ message: string; created_at: number }> : [];
  const truncated = events.length >= ATTENTION_EVENTS_MAX;
  const seen: Record<"kill" | "breaker" | "market" | "brain" | "model", number[]> = { kill: [], breaker: [], market: [], brain: [], model: [] };
  for (const ev of events) {
    const kind = classifyAlertEvent(String(ev.message ?? ""));
    if (kind) seen[kind].push(Number(ev.created_at));
  }

  if (status.status === "killed") {
    const at = seen.kill[0] ?? null;
    items.push({
      key: `killed:${slug}:${at ?? "open"}`, severity: "fyi", kind: "killed", agent: slug,
      title: "Kill switch is on",
      detail: "The trading key was removed, so the agent can sign nothing. Funds stay in the owner's smart account.",
      owner_can_fix: true, what_to_do: "Sign a new trading permission in Merrymen when the agent should trade again.", link: links.grant,
      started_at: at, ends_at: null,
    });
  }
  if (status.status === "error") {
    items.push({
      key: `arm-error:${slug}:open`, severity: "today", kind: "arm-error", agent: slug,
      title: "The agent could not arm its trading key",
      detail: "The worker reports that it could not arm the trading key, so nothing is signed. This is Merrymen's to fix, not the owner's.",
      owner_can_fix: false, what_to_do: null, link: null, started_at: null, ends_at: null,
    });
  }
  const running = status.status === "active" || status.status === "armed";
  if (running && fresh.worker_fresh === false && fresh.heartbeat_at !== null) {
    items.push({
      key: `worker-stale:${slug}:${fresh.heartbeat_at}`, severity: "today", kind: "worker-stale", agent: slug,
      title: "The agent's worker stopped reporting",
      detail: `The worker has not reported since ${iso(fresh.heartbeat_at)}, so the agent may not be trading or running its exits. Merrymen restarts workers; the owner cannot fix this from here.`,
      owner_can_fix: false, what_to_do: null, link: null,
      started_at: fresh.heartbeat_at + fresh.fresh_within_s, ends_at: null,
    });
  }

  const b = status.live_blocker;
  const advice = b ? blockerAdvice(b.rule) : null;
  // A deliberate state (live trading off, a key arming on the next pass) is not a fault and needs nobody.
  if (b && (advice?.fault ?? true)) {
    const funding = advice?.funding === true;
    const resign = advice?.resign === true;
    items.push({
      key: `live-blocker:${slug}:${b.rule.toLowerCase().replace(/[^0-9a-z_.-]/g, "-").slice(0, 40) || "unknown"}`,
      severity: funding || resign ? "act_now" : "today", kind: "live-blocker", agent: slug,
      title: BLOCKER_TITLE[b.rule] ?? "Live trading is blocked",
      detail: !funding && !resign && advice ? advice.say : b.text,
      owner_can_fix: funding || resign,
      what_to_do: funding ? FUNDING_TODO[b.rule] ?? advice!.say : resign ? advice!.say : null,
      link: funding ? links.deposit : resign ? links.grant : null,
      started_at: null, ends_at: null,
    });
  }

  if (seen.breaker.length && now - seen.breaker[0]! <= currentSec) {
    const start = runStart(seen.breaker, gapSec, floor, truncated);
    items.push({
      key: `breaker:${slug}:${start ?? "open"}`, severity: "act_now", kind: "breaker", agent: slug,
      title: "Drawdown breaker tripped",
      detail: "The book is below the drawdown limit in the signed permission, so buys are refused until it recovers. Selling is never blocked.",
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }

  const providers = (["market", "brain", "model"] as const)
    .filter((k) => seen[k].length && now - seen[k][0]! <= currentSec)
    .sort((x, y) => seen[y][0]! - seen[x][0]!);
  const provider = providers[0];
  if (provider) {
    const start = runStart(seen[provider], gapSec, floor, truncated);
    items.push({
      key: `provider-failure:${slug}:${provider}-${start ?? "open"}`, severity: "fyi", kind: "provider-failure", agent: slug,
      title: PROVIDER_TITLE[provider],
      detail: `${PROVIDER_TEXT[provider]} This is Merrymen's to fix; the owner has nothing to do.`,
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }

  const caps = ids.length ? (await db.prepare(
    `SELECT reject_rule AS rule, MIN(created_at) AS first, MAX(created_at) AS last FROM trades
      WHERE lower(agent_id) IN (${inList}) AND status = 'rejected' AND reject_rule IN ('daily-cap', 'ops-cap') AND created_at >= ?
      GROUP BY reject_rule`,
  ).all(...ids, floor)) as Array<{ rule: string; first: number; last: number }> : [];
  for (const c of caps) {
    const first = Number(c.first), last = Number(c.last);
    if (now - last > CAP_CURRENT_SEC) continue;
    // The first refusal read is the start only when the read could not have cut an earlier one off.
    const start = first - floor > CAP_CURRENT_SEC ? first : null;
    const daily = c.rule === "daily-cap";
    items.push({
      key: `${daily ? "daily-cap" : "ops-cap"}:${slug}:${start ?? "open"}`, severity: "fyi", kind: daily ? "daily-cap" : "ops-cap", agent: slug,
      title: daily ? "Daily spending cap reached" : "Daily trade count reached",
      detail: daily
        ? "Buys past the daily spending cap sealed in the signed permission are refused until the trailing 24-hour window rolls. Selling is never blocked."
        : "Operations past the daily count sealed in the signed permission are refused until the trailing 24-hour window rolls.",
      owner_can_fix: false, what_to_do: null, link: null, started_at: start, ends_at: null,
    });
  }
  return { name: status.name, items };
}

const PROPOSAL_TITLE: Readonly<Record<string, string>> = {
  trade: "A trade proposal is waiting for approval",
  settings: "A settings change is waiting for approval",
  agent_draft: "An agent setup is waiting for review",
  post: "A post is waiting for approval",
};

/** One item per proposal still waiting for the owner. The caller filters to what the connection may see. */
export function proposalItems(rows: ReadonlyArray<{ id: string; kind: string; agent_slug: string | null; created_at: number; expires_at: number; approval_url: string | null }>): AttentionItem[] {
  return rows.map((r) => ({
    key: `proposal-waiting:${r.agent_slug ?? "-"}:${r.id.toLowerCase()}`, severity: "today" as const, kind: "proposal-waiting" as const, agent: r.agent_slug,
    title: PROPOSAL_TITLE[r.kind] ?? "A proposal is waiting for approval",
    detail: `Nothing happens unless the owner approves it in Merrymen. It expires at ${iso(r.expires_at)}.`,
    owner_can_fix: true, what_to_do: "Open the approval page to review it, then approve or decline.", link: r.approval_url,
    started_at: r.created_at, ends_at: r.expires_at,
  }));
}

/** One item when alert messages to the owner's Telegram died in the lookback. */
export function deliveryItems(dead: { count: number; first: number; lastErrorCode: string | null } | null, links: AttentionLinks): AttentionItem[] {
  if (!dead || dead.count <= 0) return [];
  const why = dead.lastErrorCode ? DELIVERY_ERROR_TEXT[dead.lastErrorCode] ?? null : null;
  return [{
    key: `alerts-failing:-:${dead.first}`, severity: "fyi", kind: "alerts-failing", agent: null,
    title: "Telegram alerts are not being delivered",
    detail: `${dead.count} alert message(s) in the last 24 hours could not be delivered${why ? `: ${why}` : "."}`,
    owner_can_fix: true, what_to_do: "Check the Telegram link in Merrymen Settings.", link: links.settings,
    started_at: dead.first, ends_at: null,
  }];
}

/** Most severe first; within a severity, new before already reported, then the most recent start first. */
export function rankItems<T extends AttentionItem & { new: boolean }>(items: readonly T[]): T[] {
  const order = (s: Severity) => SEVERITIES.indexOf(s);
  return [...items].sort((a, b) =>
    order(a.severity) - order(b.severity)
    || Number(b.new) - Number(a.new)
    || (b.started_at ?? 0) - (a.started_at ?? 0)
    || a.key.localeCompare(b.key));
}
