/**
 * SOLANA LIVE ROLLOUT: WHICH TENANTS MAY GO LIVE, AND THE PLATFORM'S CAPS ON
 * WHAT A LIVE PERMISSION MAY ALLOW.
 *
 * Robinhood Chain is rolled out a few tenants at a time (MERRYMEN_FLEET_ROLLOUT,
 * worker/src/fleet-rollout.ts) and its on-chain vault caps spending at 25 USDG
 * a day. Solana's own switch, MERRYMEN_SOLANA, is all or nothing: with it on,
 * any bound tenant could register a live permission with whatever limits it
 * signs (up to 96 operations a day and 168 hours). These settings add the same
 * kind of gate on top of it, read by the app runtime from its own env, so the
 * web and the Solana worker decide alike:
 *
 *   MERRYMEN_SOLANA_LIVE_TENANTS   0x<40 hex>[,0x<40 hex>...]: the tenants that
 *                                  may open new live permissions and buy. Unset
 *                                  or empty: nobody (paper stays open to all).
 *   MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG   default 10 (USDG)
 *   MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG       default 25 (USDG, the RH vault's daily cap)
 *   MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL   default 0.1 (SOL)
 *   MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL       default 0.25 (SOL)
 *
 * ONLY EVER STOPS NEW LIVE PERMISSIONS AND BUYS. A tenant off the list, or any
 * tenant while a setting cannot be read, cannot save live mode for the first
 * time, prepare, submit or activate a permission, or buy. Its owner can always
 * sell back to USDG within the permission already registered, revoke, withdraw,
 * record outside withdrawals, use paper and read status: a tenant taken off the
 * list after going live is exits-only, as Robinhood's exits-only level is.
 *
 * Caps bound new permissions: live limits above one are refused where they are
 * saved and where the permission is prepared, so a signed on-chain session can
 * never exceed them. A session registered above a cap lowered since keeps its
 * exits; its buys are refused before anything is signed until the owner
 * registers a new permission within the caps.
 *
 * MALFORMED REFUSES, IT NEVER GUESSES, as for MERRYMEN_FLEET_ROLLOUT: an entry
 * that does not parse is named by its position, never repeated (the value names
 * other tenants), and the runtime turns the refusal into a configuration
 * refusal of new permissions and buys, with an [alert] for the operator.
 */
import { displaySolanaAmount, solanaUnits } from "../../web/src/lib/solana-amounts";
import { SOLANA_LIVE_MIN_TRADE_USDG_RAW } from "../../packages/core/src/solana";

export const SOLANA_LIVE_TENANTS_ENV = "MERRYMEN_SOLANA_LIVE_TENANTS";
/** The same bound as MERRYMEN_FLEET_ROLLOUT's: far beyond any cohort, small enough to review as a diff. */
export const SOLANA_LIVE_MAX_TENANTS = 512;
export type SolanaLiveCapField = "perTradeUsdg" | "dailyUsdg" | "perTradeWsol" | "dailyWsol";
/** Raw amounts: micro-USDG for the USDG caps, lamports for the SOL caps. */
export type SolanaLiveCaps = Record<SolanaLiveCapField, string>;
const FIELDS: readonly SolanaLiveCapField[] = ["perTradeUsdg", "dailyUsdg", "perTradeWsol", "dailyWsol"];
export const SOLANA_LIVE_CAP_ENV: Readonly<Record<SolanaLiveCapField, string>> = {
  perTradeUsdg: "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", dailyUsdg: "MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG",
  perTradeWsol: "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL", dailyWsol: "MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL",
};
/** 10 USDG per trade, 25 USDG a day (the Robinhood vault's daily cap), 0.1 SOL sold per trade, 0.25 SOL sold a day. */
export const SOLANA_LIVE_CAP_DEFAULTS: Readonly<SolanaLiveCaps> = { perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" };
const DECIMALS: Readonly<Record<SolanaLiveCapField, number>> = { perTradeUsdg: 6, dailyUsdg: 6, perTradeWsol: 9, dailyWsol: 9 };
/** What the owner calls each limit: the page's own field labels. */
const LABELS: Readonly<Record<SolanaLiveCapField, string>> = { perTradeUsdg: "USDG per trade", dailyUsdg: "USDG per 24 hours",
  perTradeWsol: "SOL sold per trade", dailyWsol: "SOL sold per 24 hours" };

/** A setting this module cannot read. Its message names the setting and never its value. Operator-facing. */
export class SolanaLiveRolloutError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaLiveRolloutError"; }
}
type Env = Readonly<Record<string, string | undefined>>;
const ENTRY = /^0x[0-9a-fA-F]{40}$/;

/**
 * The tenants MERRYMEN_SOLANA_LIVE_TENANTS names, lowercased. Unset, empty or
 * only spaces: none. Entries are separated by commas, with spaces around them
 * ignored; each must be a whole 0x tenant id (0x and 40 hex digits, either
 * case). An empty entry (a stray comma), anything else, or more than
 * SOLANA_LIVE_MAX_TENANTS entries throws SolanaLiveRolloutError naming the
 * entry's position. Naming a tenant twice is harmless and allowed.
 */
export function solanaLiveTenants(env: Env): ReadonlySet<string> {
  const raw = env[SOLANA_LIVE_TENANTS_ENV];
  if (raw === undefined || raw.trim() === "") return new Set();
  const entries = raw.split(",").map(entry => entry.trim());
  if (entries.length > SOLANA_LIVE_MAX_TENANTS) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_TENANTS_ENV} names more than ${SOLANA_LIVE_MAX_TENANTS} tenants`);
  const tenants = new Set<string>();
  entries.forEach((entry, i) => {
    // The position, never the text: the value names other tenants, and an entry that does not parse is not repeated into a log.
    if (!ENTRY.test(entry)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_TENANTS_ENV} entry ${i + 1} is ${entry ? "not a tenant id (0x and 40 hex digits)" : "empty"}`);
    tenants.add(entry.toLowerCase());
  });
  return tenants;
}

/**
 * The live caps in force: each setting's decimal amount (USDG or SOL) as a raw
 * amount, parsed exactly by solanaUnits, or its default when unset or empty.
 * Throws SolanaLiveRolloutError for a value that is not a positive decimal with
 * at most 6 (USDG) or 9 (SOL) decimal places, one beyond what the program
 * stores (u64 base units), a per-trade cap above its daily cap (the program
 * refuses such limits), or a USDG per-trade cap below the 1 USDG live minimum
 * (no live limits could then be saved at all).
 */
export function solanaLiveCaps(env: Env): SolanaLiveCaps {
  const caps = { ...SOLANA_LIVE_CAP_DEFAULTS };
  for (const field of FIELDS) {
    const name = SOLANA_LIVE_CAP_ENV[field], raw = env[name];
    if (raw === undefined || raw === "") continue;
    try { caps[field] = solanaUnits(raw, DECIMALS[field]); }
    catch {
      throw new SolanaLiveRolloutError(`${name} must be a positive amount in ${field.endsWith("Usdg") ? "USDG with at most 6" : "SOL with at most 9"} decimal places `
        + `that fits the vault program (unset is ${displaySolanaAmount(SOLANA_LIVE_CAP_DEFAULTS[field], DECIMALS[field])})`);
    }
  }
  if (BigInt(caps.perTradeUsdg) > BigInt(caps.dailyUsdg)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeUsdg} must not exceed ${SOLANA_LIVE_CAP_ENV.dailyUsdg}`);
  if (BigInt(caps.perTradeWsol) > BigInt(caps.dailyWsol)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeWsol} must not exceed ${SOLANA_LIVE_CAP_ENV.dailyWsol}`);
  if (BigInt(caps.perTradeUsdg) < SOLANA_LIVE_MIN_TRADE_USDG_RAW) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeUsdg} must be at least the 1 USDG live minimum`);
  return caps;
}

/** The limits a live permission carries (or would), as raw amounts. Missing SOL limits are not compared. */
export type SolanaLiveCappedLimits = { perTradeUsdg: string | bigint; dailyUsdg: string | bigint; perTradeWsol?: string | bigint; dailyWsol?: string | bigint };
/** Which of `limits` are above `caps`, in the page's order. */
export function solanaLiveCapsExceeded(limits: SolanaLiveCappedLimits, caps: SolanaLiveCaps): SolanaLiveCapField[] {
  return FIELDS.filter(field => limits[field] !== undefined && BigInt(limits[field]) > BigInt(caps[field]));
}
function amount(caps: SolanaLiveCaps, field: SolanaLiveCapField): string {
  return `${displaySolanaAmount(caps[field], DECIMALS[field])} ${field.endsWith("Usdg") ? "USDG" : "SOL"}`;
}
/** The caps, in the owner's words: "at most 10 USDG per trade, 25 USDG per 24 hours, 0.1 SOL sold per trade and 0.25 SOL sold per 24 hours". */
export function solanaLiveCapsText(caps: SolanaLiveCaps): string {
  const parts = FIELDS.map(field => `${amount(caps, field)}${LABELS[field].replace(/^(USDG|SOL)/, "")}`);
  return `at most ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
/**
 * The owner-facing refusal of live limits above the caps, naming each cap
 * exceeded and all of them, or null when none is. `when`: where it was refused,
 * which says what was not done.
 */
export function solanaLiveCapRefusal(limits: SolanaLiveCappedLimits, caps: SolanaLiveCaps, when: "save" | "register"): string | null {
  const over = solanaLiveCapsExceeded(limits, caps);
  if (!over.length) return null;
  const named = over.map(field => `${LABELS[field]} is above this platform's live cap of ${amount(caps, field)}`).join("; ");
  return `${named.charAt(0).toUpperCase()}${named.slice(1)}. Live limits here are ${solanaLiveCapsText(caps)}. `
    + (when === "save" ? "Lower them and save again. Nothing was saved." : "Save live limits within them, then register. Nothing was prepared.");
}
/** The status blocker, and a buy's refusal, while the registered permission allows more than the caps. */
export function solanaLiveSessionAboveCaps(caps: SolanaLiveCaps): string {
  return `Your registered live permission allows more than this platform's live caps (${solanaLiveCapsText(caps)}). Buying is paused until you register a new `
    + "permission within them; exits, revoke and withdraw still work.";
}
/** The status warning while the saved live limits, not yet registered, are above the caps: registering them would be refused. */
export function solanaLiveSavedAboveCaps(caps: SolanaLiveCaps): string {
  return `Your saved live limits are above this platform's live caps (${solanaLiveCapsText(caps)}): save limits within them before registering a new permission.`;
}
