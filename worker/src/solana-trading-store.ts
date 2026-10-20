/** Tenant-bound Solana paper books and live broadcast journal, on SQLite or Postgres. */
import { CHAINS, SOLANA_USDG_MINT, canonicalId } from "../../packages/core/src/ids";
import { SOLANA_MAX_OPS_PER_DAY, parseSolanaRawAmount, parseSolanaSwapIntent, requireSolanaLiveSellLimits, solanaPaperAgentId, validateSolanaAccountLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaQuote } from "../../packages/core/src/solana";
import { SOLANA_SYSTEM_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { openSecret, sealSecret } from "./store-crypto";
import { applySolanaPaperCommit, applySolanaPaperWriteOff, solanaPaperIntentFingerprint, type SolanaPaperBook,
  type SolanaPaperCommit, type SolanaPaperReceipt, type SolanaPaperSnapshot, type SolanaPaperWriteOffRecord } from "./solana-paper-store";
import type { SolanaPaperLedger } from "./solana-paper-service";
import type { SolanaLiveJournal, SolanaLiveRecord, SolanaLiveSettlement, SolanaSignedSubmission } from "./solana-executor";
import { solanaReferenceNotional, verifySolanaReferenceBound, type SolanaPythGeneration, type SolanaReferenceBound } from "./solana-reference-price";

export interface SolanaAccountScope { tenant: string; owner: string }
export class SolanaTradingStoreError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaTradingStoreError"; }
}
export interface SolanaTradingBinding extends SolanaAccountScope {
  requestedMode: "paper" | "live"; limits: SolanaPaperLimits | null; revision: number;
}
export interface SolanaRegisteredSession {
  programId: string; vault: string; session: string; sessionEpoch: string;
  registrationSignature: string; registeredAtMs: number;
}
export interface SolanaLiveBook {
  hwmRaw: string; cashRaw: string; wsolRaw: string;
  costBasisUsdgRaw: string; realizedPnlUsdgRaw: string; networkFeesLamports: string;
  unresolvedFeeCount?: number; reservedUnknownFeeLamports?: string;
  slot: number; updatedAtMs: number;
  buyPaused?: boolean;
  /**
   * WSOL that reached the vault outside recorded trades (anyone can send it).
   * Zero cost basis, never traded, and excluded from equity, P&L and the
   * high-water mark. The owner can withdraw it; withdrawals spend it first.
   */
  quarantinedWsolRaw?: string;
}
/** The WSOL the session may trade: the recorded position, never quarantined WSOL. */
export function solanaQuarantinedWsol(book: Pick<SolanaLiveBook, "quarantinedWsolRaw">): bigint { return BigInt(book.quarantinedWsolRaw ?? "0"); }
export interface SolanaOwnerExpiryProof {
  reason: "blockhash-expired"; blockHeight: string; vaultSequence: string | null; sessionEpoch: string | null; slot: number;
}
export interface SolanaPreparedSetup {
  transactionBase64: string; messageBase64: string; blockhash: string; lastValidBlockHeight: string;
  programId: string; vault: string; session: string; limits: SolanaPaperLimits;
  preparedAtMs: number; expiresAtMs: number; signature?: string; signedTransactionBase64?: string;
  kind?: "session" | "revoke" | "withdraw" | "withdraw-sol" | "resume-buys";
  /** withdraw: the token and amount; withdraw-sol: the lamports taken from the vault account above its rent reserve. */
  mint?: string; amountRaw?: string;
  /**
   * WSOL withdraw only: native lamports that sat unsynced in the vault's WSOL
   * account at prepare time (finalized read). The same transaction runs
   * SyncNative first, so at least this much became WSOL; it is booked as
   * zero-basis quarantine only as far as the withdrawal needs it.
   */
  syncedWsolRaw?: string;
  /**
   * WSOL withdraw only: what the withdrawn amount was worth when prepared. Checked
   * fresh when the unsigned setup is saved; the signed save keeps that copy.
   * Without it, a WSOL withdrawal leaves the high-water mark where it was.
   */
  withdrawValuation?: SolanaWithdrawValuation;
  status?: "pending" | "finalized" | "failed";
  /**
   * Finalized only: the slot of the finalized transaction, as both providers
   * agreed. A permission is activated from a vault read no earlier than this.
   * Absent on setups finalized before it was recorded.
   */
  finalizedSlot?: number;
  expiryProof?: SolanaOwnerExpiryProof;
  priorSequence?: string; priorSessionEpoch?: string; priorVaultExisted?: boolean;
}
/**
 * An executable WSOL→USDG exit quote for the withdrawal amount and the
 * independent Pyth bound for the same amount, both read when it was prepared.
 */
export interface SolanaWithdrawValuation { quote: SolanaQuote; reference: SolanaReferenceBound }
/**
 * The lower of the two: neither Jupiter nor the reference can raise it alone, so
 * the high-water mark never drops by more than the withdrawn WSOL was worth.
 * Null when either is missing, malformed, stale or for another amount, or the
 * reference is not from `generation` (default: SOLANA_PYTH_DEFAULT_GENERATION).
 */
export function solanaWithdrawValueUsdg(valuation: SolanaWithdrawValuation | undefined, amountRaw: string | undefined, nowMs: number,
  generation?: () => SolanaPythGeneration): bigint | null {
  if (!valuation || typeof valuation !== "object") return null;
  try {
    const intent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "withdraw-valuation",
      inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: valuation.quote?.slippageBps });
    validateSolanaQuote(valuation.quote, intent, nowMs);
    const bound = verifySolanaReferenceBound(valuation.reference, intent, nowMs, generation?.());
    const quoted = parseSolanaRawAmount(valuation.quote.minOutAmount), reference = parseSolanaRawAmount(bound.referenceOut);
    return quoted < reference ? quoted : reference;
  } catch { return null; }
}
/** A valuation saveSetup already checked; one that cannot be read never blocks booking the withdrawal. */
function storedWithdrawValue(valuation: SolanaWithdrawValuation | undefined): bigint | null {
  if (!valuation) return null;
  try {
    const quoted = parseSolanaRawAmount(valuation.quote.minOutAmount), reference = parseSolanaRawAmount(valuation.reference.referenceOut);
    return quoted < reference ? quoted : reference;
  } catch { return null; }
}
const DAY = 86_400_000;
/**
 * Whether finalized vault state after a blockhash expired proves this owner
 * transaction never ran. Each kind is judged only by state it must change:
 * - revoke always increments the session epoch;
 * - session (with any vault initialization in the same transaction) always
 *   increments the epoch, and the epoch of a vault that does not exist is 0;
 * - withdraw and withdraw-sol increment the sequence, and admission refuses
 *   session trades while one is prepared or pending, so nothing else can advance it;
 * - resume-buys changes neither; a wrong "failed" only leaves the off-chain
 *   breaker paused, which is the conservative direction.
 */
export function solanaOwnerExpiryProven(setup: Pick<SolanaPreparedSetup, "kind" | "priorVaultExisted" | "priorSequence" | "priorSessionEpoch">,
  vaultSequence: string | null, sessionEpoch: string | null): boolean {
  if (setup.priorVaultExisted === undefined || setup.priorSequence === undefined || setup.priorSessionEpoch === undefined) return false;
  if (setup.priorVaultExisted && (vaultSequence === null || sessionEpoch === null)) return false;
  if ((vaultSequence === null) !== (sessionEpoch === null)) return false;
  switch (setup.kind ?? "session") {
    case "revoke": return setup.priorVaultExisted && sessionEpoch === setup.priorSessionEpoch;
    case "session": return (sessionEpoch ?? "0") === setup.priorSessionEpoch;
    case "withdraw": case "withdraw-sol": return setup.priorVaultExisted && vaultSequence === setup.priorSequence;
    case "resume-buys": return setup.priorVaultExisted;
    default: return false;
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_runtime_worker_heartbeat (
 worker TEXT PRIMARY KEY, last_seen_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_runtime_paper_books (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, book_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_paper_trades (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL, notional_raw TEXT NOT NULL, receipt_json TEXT NOT NULL,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE INDEX IF NOT EXISTS solana_runtime_paper_window ON solana_runtime_paper_trades(tenant,owner,created_at_ms);
CREATE TABLE IF NOT EXISTS solana_runtime_sessions (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, record_json TEXT NOT NULL, sealed_seed TEXT NOT NULL,
 PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_setups (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, setup_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_live_books (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, book_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_cashflows (
 evidence_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
 mint TEXT NOT NULL, amount_raw TEXT NOT NULL, created_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_runtime_submissions (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, vault TEXT NOT NULL,
 sequence TEXT NOT NULL, signature TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','finalized','failed','expired')),
 created_at_ms BIGINT NOT NULL, notional_raw TEXT NOT NULL, submission_json TEXT NOT NULL, settlement_json TEXT,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS solana_runtime_live_sequence ON solana_runtime_submissions(vault,sequence) WHERE status IN ('pending','finalized');
CREATE UNIQUE INDEX IF NOT EXISTS solana_runtime_live_pending ON solana_runtime_submissions(vault) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS solana_runtime_live_window ON solana_runtime_submissions(tenant,owner,created_at_ms);
CREATE TABLE IF NOT EXISTS solana_runtime_autonomous_attempts (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, attempted_at_ms BIGINT NOT NULL,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE INDEX IF NOT EXISTS solana_runtime_autonomous_window ON solana_runtime_autonomous_attempts(tenant,owner,attempted_at_ms);
CREATE TABLE IF NOT EXISTS solana_operator_holds (
 scope TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at_ms BIGINT NOT NULL
);
`;
/** An operator hold stops every new Solana trade for a tenant, or for everyone ('*'). Owner actions stay open. */
export const SOLANA_OPERATOR_HOLD_ALL = "*";
export async function solanaOperatorHeld(db: Db, tenant: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM solana_operator_holds WHERE scope IN (?,?)").get(tenant, SOLANA_OPERATOR_HOLD_ALL);
}
function refuse(message: string): never { throw new SolanaTradingStoreError(message); }
/** Request IDs the autonomous strategy owns: rebalance-<settings revision>-<attempt>. Manual trades may not use them. */
export const SOLANA_AUTONOMOUS_REQUEST_PREFIX = "rebalance-";
export interface SolanaAutonomousSchedule {
  /** Autonomous attempts admitted so far, proven-expired ones included: the next attempt's index, never reused. */
  attempt: number;
  /** When the next attempt may be admitted: one interval after the last that was not proven expired (0 if none). */
  dueAtMs: number;
}
/**
 * The autonomous strategy's durable schedule for one account. intervalSeconds is
 * a minimum spacing between admitted attempts, whatever process admitted them. A
 * proven-expired attempt never landed, so a fresh one may follow it at once.
 */
export async function solanaAutonomousSchedule(db: Db, scope: SolanaAccountScope, intervalSeconds: number): Promise<SolanaAutonomousSchedule> {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) refuse("Invalid autonomous Solana strategy interval.");
  const row = await db.prepare(`SELECT COUNT(*) AS attempts,
      MAX(CASE WHEN s.status IS NULL OR s.status <> 'expired' THEN a.attempted_at_ms END) AS last_at
    FROM solana_runtime_autonomous_attempts a
    LEFT JOIN solana_runtime_submissions s ON s.tenant=a.tenant AND s.owner=a.owner AND s.request_id=a.request_id
    WHERE a.tenant=? AND a.owner=?`).get(scope.tenant, scope.owner) as { attempts: number | string; last_at: number | string | null } | undefined;
  const attempt = Number(row?.attempts ?? 0), last = row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at);
  if (!Number.isSafeInteger(attempt) || attempt < 0 || (last !== null && !Number.isSafeInteger(last))) refuse("Invalid stored Solana data.");
  return { attempt, dueAtMs: last === null ? 0 : last + intervalSeconds * 1000 };
}
export const OPERATOR_HOLD = "An operator hold stops Solana trading for this account. Owner withdrawals and revocation still work.";
/**
 * EXPIRED-ATTEMPT ALLOWANCE (owner decision, audit G2-3).
 *
 * A live trade whose blockhash expired before it landed is proven never to have
 * run (both providers agree, see reconcileSolanaSubmission): it moved no tokens,
 * paid no fee, and the vault program never counted it. Off-chain it still was a
 * transaction the session key signed. This setting says how many such proven-
 * expired attempts per rolling 24 hours do NOT count toward the owner's
 * maxOpsPerDay; every one beyond it counts like any signed transaction.
 *
 * - 0 (the default): every signed transaction counts, so the session key signs
 *   at most maxOpsPerDay a day, exactly the number the owner set. A burst of
 *   dropped packets can use up the day's operations and pause trading and
 *   automated exits until they leave the window; the owner's own withdrawals
 *   and revoke never count and stay available.
 * - N > 0: up to N dropped attempts a day are retried without using up the
 *   owner's operations, so at most maxOpsPerDay + N signed a day, and at most
 *   maxOpsPerDay of them can land. N is one setting for every account.
 *
 * The old rule gave each account a separate budget of expired attempts the
 * size of its own maxOpsPerDay: about 2 x maxOpsPerDay signed a day. No single
 * N reproduces that for every account. N equal to one account's maxOpsPerDay
 * approximates it for that account only, and is looser for accounts with
 * fewer operations. N = 96 (the program's daily maximum) is the MOST
 * permissive setting, not the old behaviour: with maxOpsPerDay 10 it lets
 * over 100 transactions be signed a day, against about 20 under the old rule.
 *
 * Set with MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: a whole number from 0 to 96.
 */
export const SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE = 0;
/** Names no setting, like the other configuration refusals an owner may see. */
export const SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED = "The Solana expired-attempt allowance setting is misconfigured: it must be a whole number from 0 to 96. Live trading and exits stay refused until an operator fixes it.";
/** The configured allowance, or the default when it is unset. Anything else is refused (fail closed). */
export function solanaExpiredAttemptAllowance(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE;
  if (value === undefined) return SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  if (!/^(0|[1-9][0-9]?)$/.test(value) || Number(value) > SOLANA_MAX_OPS_PER_DAY) refuse(SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED);
  return Number(value);
}
/** recordSigned's refusal when proven-expired attempts beyond the allowance have used up the owner's daily operations. */
export const SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED = "Too many Solana transactions expired without landing in the last 24 hours: they count toward the daily operation limit. Trading resumes as they leave the window.";
/**
 * How proven-expired attempts use one account's daily operations at `nowMs`, by
 * the same rolling 24-hour window and arithmetic recordSigned admits by:
 * `counted` of the `expired` attempts count toward maxOpsPerDay (those beyond
 * the allowance), next to `operations` that landed, failed or are pending.
 * For status blockers and operator alerts; admission never reads it, and counts
 * the same rows itself under its lock.
 */
export async function solanaExpiredAttemptUse(db: Db, scope: SolanaAccountScope, nowMs: number, allowance: number): Promise<{ expired: number; counted: number; operations: number }> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(allowance) || allowance < 0) refuse("Invalid Solana expired-attempt query.");
  const rows = await db.prepare("SELECT status FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?").all(scope.tenant, scope.owner, nowMs - DAY) as Array<{ status: string }>;
  const expired = rows.filter(r => r.status === "expired").length;
  return { expired, counted: Math.max(0, expired - allowance), operations: rows.length - expired };
}
function clock(now: () => number): number { const n = now(); if (!Number.isSafeInteger(n) || n < 0) refuse("Invalid Solana runtime clock."); return n; }
function key(value: string): void { if (canonicalId(CHAINS.solana, "account", value) !== value) refuse("Invalid Solana account key."); }
function raw(value: string, zero = true): bigint { return parseSolanaRawAmount(value, zero); }
function rowJson<T>(row: unknown, column: string): T | null {
  if (!row) return null;
  const data = (row as Record<string, unknown>)[column];
  if (typeof data !== "string") refuse("Invalid stored Solana data.");
  return JSON.parse(data) as T;
}
function record(row: unknown): SolanaLiveRecord | null {
  if (!row) return null;
  const r = row as { submission_json: string; status: SolanaLiveRecord["status"]; settlement_json: string | null };
  return { submission: JSON.parse(r.submission_json), status: r.status, ...(r.settlement_json ? { settlement: JSON.parse(r.settlement_json) } : {}) };
}
const ready = new WeakMap<Db, Promise<void>>();
export async function ensureSolanaTradingSchema(db: Db, postgres = false): Promise<void> {
  let promise = ready.get(db);
  if (!promise) {
    promise = (postgres ? db.tx(async tx => { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_984); await tx.exec(SCHEMA); }) : db.exec(SCHEMA))
      .catch(error => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}

/** The scope comes from an authenticated wallet binding, never request owner fields. */
export class SolanaTradingStore implements SolanaLiveJournal {
  constructor(readonly db: Db, readonly scope: SolanaAccountScope, private readonly now: () => number = Date.now,
    private readonly admission?: { autonomousRevision: number; signal?: AbortSignal },
    /** The Pyth generation stored reference bounds must come from: the app runtime's MERRYMEN_SOLANA_PYTH_GENERATION, read at each check. Default: SOLANA_PYTH_DEFAULT_GENERATION. */
    private readonly pythGeneration?: () => SolanaPythGeneration) {
    if (!/^0x[0-9a-f]{40}$/.test(scope.tenant)) refuse("Invalid authenticated Solana tenant.");
    solanaPaperAgentId(scope.owner);
  }
  private checkAdmissionSignal(): void {
    if (this.admission?.signal?.aborted) refuse("Solana trading admission stopped during shutdown.");
  }
  private async autonomousIn(db: Db, binding: SolanaTradingBinding): Promise<bigint | null> {
    this.checkAdmissionSignal();
    if (!this.admission) return null;
    if (!Number.isSafeInteger(this.admission.autonomousRevision) || this.admission.autonomousRevision < 0 ||
        binding.revision !== this.admission.autonomousRevision) refuse("The autonomous Solana strategy changed before admission.");
    const row = await db.prepare("SELECT strategy_json FROM solana_wallet_bindings WHERE tenant=? AND owner=? AND chain=?")
      .get(this.scope.tenant, this.scope.owner, CHAINS.solana) as { strategy_json: string | null } | undefined;
    const strategy = row?.strategy_json ? JSON.parse(row.strategy_json) : null;
    if (strategy?.enabled !== true) refuse("The autonomous Solana strategy is no longer enabled.");
    // The interval is a durable minimum spacing, checked under the same lock that admits.
    const { dueAtMs } = await solanaAutonomousSchedule(db, this.scope, strategy.intervalSeconds);
    if (clock(this.now) < dueAtMs) refuse("The autonomous Solana strategy is not due yet: its interval has not passed since the last attempt.");
    return raw(strategy.tradeUsdgRaw, false);
  }
  /** Manual trades never take the strategy's request IDs, so its next attempt can never collide with one. */
  private checkRequestOwner(requestId: string): void {
    if (!this.admission && requestId.startsWith(SOLANA_AUTONOMOUS_REQUEST_PREFIX)) refuse("Request IDs starting with rebalance- belong to the autonomous strategy.");
  }
  /** An admitted autonomous trade records its attempt in the same transaction. */
  private async recordAttemptIn(db: Db, requestId: string, now: number): Promise<void> {
    if (this.admission) await db.prepare("INSERT INTO solana_runtime_autonomous_attempts(tenant,owner,request_id,attempted_at_ms) VALUES(?,?,?,?)")
      .run(this.scope.tenant, this.scope.owner, requestId, now);
  }
  private owner(owner: string): void { if (owner !== this.scope.owner) refuse("Solana owner does not match the authenticated account."); }
  private async bindingIn(db: Db, lock: boolean): Promise<SolanaTradingBinding> {
    const { tenant, owner } = this.scope;
    // A first statement write acquires both SQLite's writer lock and Postgres's
    // row lock. Settings changes take this same row lock, fencing admission.
    if (lock) {
      const locked = await db.prepare("UPDATE solana_wallet_bindings SET revision=revision WHERE tenant=? AND owner=? AND chain=?")
        .run(tenant, owner, CHAINS.solana);
      if (locked.changes !== 1) refuse("The authenticated Solana wallet binding is missing.");
    }
    const row = await db.prepare("SELECT requested_mode,limits_json,revision FROM solana_wallet_bindings WHERE tenant=? AND owner=? AND chain=?")
      .get(tenant, owner, CHAINS.solana) as { requested_mode: "paper" | "live"; limits_json: string | null; revision: number | string } | undefined;
    if (!row || !["paper", "live"].includes(row.requested_mode)) refuse("The authenticated Solana wallet binding is missing.");
    return { tenant, owner, requestedMode: row.requested_mode, limits: row.limits_json ? JSON.parse(row.limits_json) : null, revision: Number(row.revision) };
  }
  binding(): Promise<SolanaTradingBinding> { return this.bindingIn(this.db, false); }
  async createPaper(initialCashRaw: string, limits: SolanaPaperLimits): Promise<SolanaPaperSnapshot> {
    raw(initialCashRaw, false);
    return this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
      const now = clock(this.now), policy = validateSolanaAccountLimits(limits, now);
      if (!binding.limits || JSON.stringify(validateSolanaAccountLimits(binding.limits, now)) !== JSON.stringify(policy)) {
        refuse("The Solana trading limits changed before paper book creation. Refresh and try again.");
      }
      const { tenant, owner } = this.scope;
      const existing = await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner);
      if (existing) refuse("This Solana paper book already exists and cannot be refilled or reset.");
      const book: SolanaPaperBook = { owner, agentId: solanaPaperAgentId(owner), chain: CHAINS.solana, mode: "paper", version: 0,
        initialCashRaw, cashRaw: initialCashRaw, hwmRaw: initialCashRaw, realizedPnlRaw: "0", limits: policy,
        positions: [], createdAtMs: now, updatedAtMs: now };
      await tx.prepare("INSERT INTO solana_runtime_paper_books(tenant,owner,book_json) VALUES(?,?,?)").run(tenant, owner, JSON.stringify(book));
      return { ...book, trades: [] };
    });
  }
  /** The tenant's paper book with its latest trades, read in one statement on `db` (a transaction's, to read its own write). */
  private async paperSnapshotIn(db: Db, binding: SolanaTradingBinding): Promise<SolanaPaperSnapshot | null> {
    const rows = await db.prepare(`SELECT b.book_json,t.receipt_json FROM solana_runtime_paper_books b
      LEFT JOIN solana_runtime_paper_trades t ON t.tenant=b.tenant AND t.owner=b.owner
      WHERE b.tenant=? AND b.owner=? ORDER BY t.created_at_ms DESC,t.request_id DESC LIMIT 100`).all(this.scope.tenant, this.scope.owner) as Array<{ book_json: string; receipt_json: string | null }>;
    if (!rows.length) return null;
    return { ...JSON.parse(rows[0]!.book_json), ...(binding.limits ? { limits: binding.limits } : {}), trades: rows.filter(r => r.receipt_json !== null).map(r => JSON.parse(r.receipt_json!)) } as SolanaPaperSnapshot;
  }
  paper(): SolanaPaperLedger {
    const { tenant, owner } = this.scope;
    return {
      get: async requested => {
        this.owner(requested);
        return this.paperSnapshotIn(this.db, await this.binding());
      },
      findTrade: async (requested, id) => {
        this.owner(requested); await this.binding();
        return rowJson<SolanaPaperReceipt>(await this.db.prepare("SELECT receipt_json FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, id), "receipt_json");
      },
      commit: async input => {
        this.owner(input.owner);
        const fingerprint = solanaPaperIntentFingerprint(input.intent);
        return this.db.tx(async tx => {
          const binding = await this.bindingIn(tx, true);
          const prior = await tx.prepare("SELECT fingerprint,receipt_json FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, input.intent.requestId) as { fingerprint: string; receipt_json: string } | undefined;
          if (prior) { if (prior.fingerprint !== fingerprint) refuse("The Solana request ID belongs to another intent."); return JSON.parse(prior.receipt_json) as SolanaPaperReceipt; }
          if (await solanaOperatorHeld(tx, tenant)) refuse(OPERATOR_HOLD);
          this.checkRequestOwner(input.intent.requestId);
          const strategyCap = await this.autonomousIn(tx, binding);
          if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
          const now = clock(this.now);
          const book = rowJson<SolanaPaperBook>(await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
          if (!book) refuse("Create a Solana paper book first.");
          if (!binding.limits) refuse("Save the current Solana trading limits first.");
          book.limits = validateSolanaAccountLimits(binding.limits, now);
          const recent = await tx.prepare("SELECT notional_raw FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND created_at_ms>?").all(tenant, owner, now - DAY) as Array<{ notional_raw: string }>;
          const result = applySolanaPaperCommit(book, input, recent.map(r => r.notional_raw), now);
          if (strategyCap !== null && raw(result.receipt.notionalUsdgRaw, false) > strategyCap) refuse("The autonomous Solana strategy trade limit would be exceeded.");
          this.checkAdmissionSignal();
          await tx.prepare("INSERT INTO solana_runtime_paper_trades(tenant,owner,request_id,fingerprint,created_at_ms,notional_raw,receipt_json) VALUES(?,?,?,?,?,?,?)")
            .run(tenant, owner, input.intent.requestId, fingerprint, now, result.receipt.notionalUsdgRaw, JSON.stringify(result.receipt));
          await this.recordAttemptIn(tx, input.intent.requestId, now);
          await tx.prepare("UPDATE solana_runtime_paper_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(result.book), tenant, owner);
          return result.receipt;
        });
      },
      /**
       * The owner's write-off of one dust lot in the tenant's book, under the
       * same transaction and binding row lock as commit, with a post-lock clock.
       * applySolanaPaperWriteOff checks the owner, the expected version, the
       * whole lot and the market's zero-output evidence (fresh at this clock);
       * the update is compare-and-set on the book row read under the lock. A
       * retry after it committed finds a new version (or no lot) and is
       * refused, so a write-off never applies twice. Owner-only: a store
       * admitting for the autonomous strategy refuses before it locks. An
       * operator hold does not stop it: it is no trade, and moves no cash.
       */
      writeOff: async input => {
        this.owner(input.owner);
        if (this.admission) refuse("The autonomous Solana strategy cannot write off paper positions.");
        return this.db.tx(async tx => {
          const binding = await this.bindingIn(tx, true);
          if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
          const now = clock(this.now);
          const row = await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner) as { book_json: string } | undefined;
          const book = rowJson<SolanaPaperBook>(row, "book_json");
          if (!row || !book) refuse("Create a Solana paper book first.");
          const result: { book: SolanaPaperBook; record: SolanaPaperWriteOffRecord } = applySolanaPaperWriteOff(book, input, now);
          const updated = await tx.prepare("UPDATE solana_runtime_paper_books SET book_json=? WHERE tenant=? AND owner=? AND book_json=?")
            .run(JSON.stringify(result.book), tenant, owner, row.book_json);
          if (updated.changes !== 1) refuse("The Solana paper book changed during the write-off. Refresh and try again.");
          const snapshot = await this.paperSnapshotIn(tx, binding);
          if (!snapshot) refuse("Create a Solana paper book first.");
          return { ...snapshot, writtenOff: result.record };
        });
      },
    };
  }
  async operatorHeld(): Promise<boolean> { return solanaOperatorHeld(this.db, this.scope.tenant); }
  async liveBook(): Promise<SolanaLiveBook | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "book_json");
  }
  /**
   * Book inflows that arrived outside recorded trades, from a fresh finalized
   * snapshot: USDG as owner capital (raising the high-water mark), WSOL as
   * zero-basis quarantine. A balance below the book is never reconciled here.
   * Caller obtains this snapshot from finalized RPC; never accept request JSON here.
   */
  async reconcileExternalInflows(snapshot: { cashUsdg: string; wsolRaw: string; slot: number; observedAtMs: number; commitment: "finalized" }): Promise<void> {
    await this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope, now = clock(this.now);
      if (snapshot.commitment !== "finalized" || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 1 ||
          !Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs > now || now - snapshot.observedAtMs >= 30_000) refuse("A fresh finalized Solana balance snapshot is required.");
      const cash = raw(snapshot.cashUsdg), wsol = raw(snapshot.wsolRaw);
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault IN (SELECT vault FROM solana_runtime_submissions WHERE tenant=? AND owner=?) AND status='pending'").get(tenant, owner)) refuse("Resolve pending Solana trades before reconciling deposits.");
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (setup?.signature && setup.status !== "finalized" && setup.status !== "failed") refuse("Resolve the pending owner transaction before reconciling deposits.");
      const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!book) return;
      const recordedWsol = raw(book.wsolRaw) + solanaQuarantinedWsol(book);
      if (snapshot.slot < book.slot || now < book.updatedAtMs || cash < raw(book.cashRaw) || wsol < recordedWsol) refuse("Only finalized inflows can be reconciled automatically; a vault balance is below the recorded book.");
      const deposit = cash - raw(book.cashRaw), donated = wsol - recordedWsol;
      if (deposit === 0n && donated === 0n) return;
      const flow = async (evidenceId: string, kind: "deposit" | "quarantine", mint: string, amount: bigint) => {
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .run(evidenceId, tenant, owner, kind, mint, amount.toString(), now);
        if (inserted.changes !== 1) refuse("Inflow evidence was already used with different accounting state.");
      };
      if (deposit > 0n) {
        const hwm = raw(book.hwmRaw) + deposit; raw(hwm.toString());
        await flow(`deposit:${owner}:${snapshot.slot}:${snapshot.cashUsdg}`, "deposit", SOLANA_USDG_MINT, deposit);
        book.cashRaw = cash.toString(); book.hwmRaw = hwm.toString();
      }
      // Unsolicited WSOL is held aside at zero basis: never traded, valued or added to the high-water mark.
      if (donated > 0n) {
        await flow(`quarantine:${owner}:${snapshot.slot}:${snapshot.wsolRaw}`, "quarantine", SOLANA_WRAPPED_SOL_MINT, donated);
        book.quarantinedWsolRaw = (solanaQuarantinedWsol(book) + donated).toString(); raw(book.quarantinedWsolRaw);
      }
      book.slot = snapshot.slot; book.updatedAtMs = now;
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
    });
  }
  async session(): Promise<SolanaRegisteredSession | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "record_json");
  }
  async sessionSeed(dek: Buffer): Promise<string | null> {
    const session = await this.session(); if (!session) return null;
    const row = await this.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner) as { sealed_seed: string };
    const prefix = this.seedPrefix(session);
    const plain = openSecret(row.sealed_seed, dek);
    if (!plain.startsWith(prefix)) refuse("The encrypted session does not match this Solana account.");
    return plain.slice(prefix.length);
  }
  private seedPrefix(session: SolanaRegisteredSession): string {
    return `solana-session/v1 ${this.scope.tenant} ${this.scope.owner} ${session.programId} ${session.vault} ${session.session} ${session.sessionEpoch}\n`;
  }
  async registerSession(session: SolanaRegisteredSession, seed: string, dek: Buffer): Promise<void> {
    for (const value of [session.programId, session.vault, session.session]) key(value);
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?")
        .get(this.scope.tenant, this.scope.owner), "setup_json");
      if (!setup || (setup.kind ?? "session") !== "session" || setup.status !== "finalized" ||
          setup.signature !== session.registrationSignature || setup.programId !== session.programId ||
          setup.vault !== session.vault || setup.session !== session.session) refuse("Register only the exact finalized owner-approved session.");
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending'").get(this.scope.tenant, this.scope.owner)) refuse("Resolve the pending Solana trade before replacing its session.");
      await tx.prepare(`INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET record_json=excluded.record_json,sealed_seed=excluded.sealed_seed`)
        .run(this.scope.tenant, this.scope.owner, JSON.stringify(session), sealSecret(this.seedPrefix(session) + seed, dek));
      await tx.prepare("DELETE FROM solana_runtime_setups WHERE tenant=? AND owner=?")
        .run(this.scope.tenant, this.scope.owner);
    });
  }
  async pending(): Promise<SolanaLiveRecord[]> {
    await this.binding();
    const rows = await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending' ORDER BY created_at_ms").all(this.scope.tenant, this.scope.owner);
    return rows.map(r => record(r)!);
  }
  async history(): Promise<SolanaLiveRecord[]> {
    await this.binding();
    return (await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? ORDER BY created_at_ms DESC,request_id DESC LIMIT 100")
      .all(this.scope.tenant, this.scope.owner)).map(r => record(r)!);
  }
  async get(owner: string, requestId: string): Promise<SolanaLiveRecord | null> {
    this.owner(owner); await this.binding();
    return record(await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(this.scope.tenant, owner, requestId));
  }
  /** `admission.expiredAttemptAllowance`: see SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE (the default when omitted). */
  async recordSigned(s: SolanaSignedSubmission, admission: { expiredAttemptAllowance?: number } = {}): Promise<boolean> {
    this.owner(s.intent.owner);
    const allowance = admission.expiredAttemptAllowance ?? SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
    if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > SOLANA_MAX_OPS_PER_DAY) refuse(SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED);
    let drawdownRefused = false;
    const accepted = await this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope;
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, s.intent.requestId)) return false;
      if (await solanaOperatorHeld(tx, tenant)) refuse(OPERATOR_HOLD);
      this.checkRequestOwner(s.intent.requestId);
      const strategyCap = await this.autonomousIn(tx, binding);
      if (binding.requestedMode !== "live" || !binding.limits) refuse("Live Solana trading has not been enabled for this account.");
      const ownerSetup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (ownerSetup?.signature && ownerSetup.status !== "finalized" && ownerSetup.status !== "failed") refuse("Resolve the pending owner transaction before trading.");
      const now = clock(this.now), limits = validateSolanaAccountLimits(binding.limits, now);
      // A prepared withdrawal's expiry is proven by an unchanged sequence, so no
      // trade may advance it between preparing and signing either.
      if ((ownerSetup?.kind === "withdraw" || ownerSetup?.kind === "withdraw-sol") && !ownerSetup.signature && now < ownerSetup.expiresAtMs) refuse("Finish or let lapse the prepared owner withdrawal before trading.");
      const session = rowJson<SolanaRegisteredSession>(await tx.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(tenant, owner), "record_json");
      if (!session || s.programId !== session.programId || s.intent.vault !== session.vault || s.session !== session.session || s.sessionEpoch !== session.sessionEpoch) refuse("The Solana session changed before submission.");
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault=? AND status='pending'").get(session.vault)) return false;
      if (s.intent.mode !== "live" || s.intent.chain !== CHAINS.solana || s.intent.kind !== "spl-swap") refuse("Invalid live Solana intent.");
      const { owner: _owner, vault: _vault, ...paperIntent } = s.intent;
      validateSolanaQuote(s.quote, { ...paperIntent, mode: "paper" }, now);
      if (![s.preparedAtMs, s.risk.observedAtMs, s.safetyObservedAtMs].every(t => Number.isSafeInteger(t) && t <= now && now - t < 30_000)) refuse("Solana risk evidence expired before durable admission.");
      if (![s.risk.slot, s.minContextSlot].every(t => Number.isSafeInteger(t) && t > 0) || s.risk.slot < s.minContextSlot) refuse("Solana risk evidence is not from the current account read.");
      const buying = s.intent.inputMint === SOLANA_USDG_MINT;
      if ((buying ? s.intent.outputMint : s.intent.inputMint) !== SOLANA_WRAPPED_SOL_MINT) refuse("This live vault supports USDG and wrapped SOL only.");
      // Re-check the independent price bound from the persisted evidence: the
      // signed minimum may not be below its floor, and a sell is charged at least
      // its reference value however low it was quoted.
      let reference: SolanaReferenceBound;
      try { reference = verifySolanaReferenceBound(s.risk.reference, s.intent, now, this.pythGeneration?.()); } catch { refuse("The independent SOL price evidence is missing, stale or altered."); }
      if (reference.reference.slot < s.minContextSlot || s.minOutAmount !== s.quote.minOutAmount ||
          raw(s.minOutAmount, false) < raw(reference.minOutFloor, false)) refuse("The guaranteed output is below the independent SOL price floor.");
      const notional = solanaReferenceNotional(s.intent, s.quote.outAmount, reference);
      if (strategyCap !== null && notional > strategyCap) refuse("The autonomous Solana strategy trade limit would be exceeded.");
      let sellLimits: ReturnType<typeof requireSolanaLiveSellLimits>;
      try { sellLimits = requireSolanaLiveSellLimits(limits); } catch { refuse("Save per-trade and daily SOL sell limits before live trading."); }
      const sold = buying ? 0n : raw(s.intent.amountRaw, false);
      if (sold > sellLimits.perTradeWsol) refuse("The Solana per-trade SOL sell limit would be exceeded.");
      if (raw(s.risk.notionalUsdg, false) !== notional || notional > raw(limits.perTradeUsdg, false)) refuse("The Solana per-trade limit would be exceeded.");
      if (raw(s.feeLamports) + raw(s.rentLamports) > raw(s.maxFeeLamports, false)) refuse("The Solana fee and rent budget would be exceeded.");
      const recent = await tx.prepare("SELECT notional_raw,status,submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?").all(tenant, owner, now - DAY) as Array<{ notional_raw: string; status: string; submission_json: string }>;
      // Failed transactions landed, spent network fees and consume an operation;
      // a pending one counts until finalized evidence proves what it did. Token
      // notional is released only after canonical failure or expiry evidence.
      const operations = recent.filter(r => r.status !== "expired"), dropped = recent.length - operations.length;
      const counted = recent.filter(r => !["failed", "expired"].includes(r.status));
      if (operations.length >= limits.maxOpsPerDay || counted.reduce((n, r) => n + BigInt(r.notional_raw), 0n) + notional > raw(limits.dailyUsdg, false)) refuse("The Solana rolling daily limit would be exceeded.");
      // A proven expiry never landed and the program never counted it, but the
      // session key signed it: only the configured allowance of them leaves the
      // owner's operation count (by default none), so at most maxOpsPerDay plus
      // the allowance are ever signed in 24 hours.
      if (operations.length + Math.max(0, dropped - allowance) >= limits.maxOpsPerDay) {
        refuse(SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED);
      }
      const soldToday = counted.reduce((n, r) => {
        const prior = (JSON.parse(r.submission_json) as SolanaSignedSubmission).intent;
        return prior.inputMint === SOLANA_WRAPPED_SOL_MINT ? n + raw(prior.amountRaw, false) : n;
      }, 0n);
      if (sold > 0n && soldToday + sold > sellLimits.dailyWsol) refuse("The Solana rolling daily SOL sell limit would be exceeded.");
      let book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      const equity = raw(s.risk.equityUsdg), peak = raw(s.risk.peakEquityUsdg), cash = raw(s.risk.cashUsdg), wsol = raw(s.risk.wsolRaw);
      // Only a shortfall against the book stops trading. Anyone can send tokens to
      // a vault, so an excess is never traded or valued: it waits to be booked as
      // a deposit or quarantine, and admission sizes against the book alone.
      if (book && (cash < raw(book.cashRaw) || wsol < raw(book.wsolRaw) + solanaQuarantinedWsol(book))) refuse("Vault balances are below the recorded book. Reconcile owner transfers before trading again.");
      if (book && (now < book.updatedAtMs || s.risk.slot < book.slot)) refuse("Solana portfolio evidence moved backwards.");
      const hwm = [book ? raw(book.hwmRaw) : 0n, peak, equity].reduce((a, b) => a > b ? a : b);
      const tradable = buying ? (book ? raw(book.cashRaw) : cash) : (book ? raw(book.wsolRaw) : 0n);
      if (tradable < raw(s.intent.amountRaw, false)) refuse(buying ? "Insufficient real Solana vault balance." : "The sale exceeds the recorded SOL position; quarantined SOL is not traded.");
      // A first book on a vault that already holds WSOL starts with it quarantined: its cost basis is unknown.
      if (!book) book = { hwmRaw: hwm.toString(), cashRaw: cash.toString(), wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: s.risk.slot, updatedAtMs: now,
        ...(wsol > 0n ? { quarantinedWsolRaw: wsol.toString() } : {}) };
      else book.hwmRaw = hwm.toString();
      if (buying && (book.buyPaused || hwm === 0n || (hwm - equity) * 10_000n >= hwm * BigInt(limits.maxDrawdownBps))) {
        // This refusal must commit the breaker. Throwing inside this transaction
        // would roll the pause back and silently re-arm the next price rebound.
        book.buyPaused = true; book.updatedAtMs = now;
        await tx.prepare(`INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)
          ON CONFLICT(tenant,owner) DO UPDATE SET book_json=excluded.book_json`).run(tenant, owner, JSON.stringify(book));
        drawdownRefused = true; return false;
      }
      this.checkAdmissionSignal();
      const inserted = await tx.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
        VALUES(?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT DO NOTHING`).run(tenant, owner, s.intent.requestId, s.intent.vault, s.vaultSequence, s.signature, now, notional.toString(), JSON.stringify(s));
      if (inserted.changes !== 1) return false;
      await this.recordAttemptIn(tx, s.intent.requestId, now);
      await tx.prepare(`INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET book_json=excluded.book_json`).run(tenant, owner, JSON.stringify(book));
      return true;
    });
    if (drawdownRefused) refuse("The persisted Solana drawdown breaker blocks additional buys until owner review.");
    return accepted;
  }
  async settle(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement): Promise<void> {
    await this.settleWith(owner, requestId, signature, settlement, null);
  }
  /**
   * settle, for an operator's recorded decision (solana-resolve.ts): the same
   * checks, and in the same transaction that books the trade, the decision
   * `resolutionId` (a row of solana_operator_resolutions, still open) is
   * marked booked. A decision is therefore marked booked if and only if it
   * booked the trade, whatever crashes or lost replies come between. Returns
   * false, marking nothing, when the trade is already booked with the same
   * evidence (by the worker's automatic settlement or another run). A decision
   * that cannot be marked books nothing.
   */
  async settleResolution(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement, resolutionId: string): Promise<boolean> {
    if (!resolutionId) refuse("The operator resolution to book this settlement is not open.");
    return this.settleWith(owner, requestId, signature, settlement, resolutionId);
  }
  private async settleWith(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement, resolutionId: string | null): Promise<boolean> {
    this.owner(owner);
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant } = this.scope;
      const prior = record(await tx.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, requestId));
      if (!prior || prior.submission.signature !== signature || settlement.signature !== signature) refuse("Solana settlement does not match the reserved transaction.");
      if (prior.status !== "pending") {
        if (JSON.stringify({ ...prior.settlement, finalizedAtMs: 0 }) !== JSON.stringify({ ...settlement, finalizedAtMs: 0 })) refuse("Solana settlement already exists with different evidence.");
        return false;
      }
      if (!["finalized", "failed", "expired"].includes(settlement.status) || !Number.isSafeInteger(settlement.slot) || settlement.slot < prior.submission.minContextSlot) refuse("Invalid finalized Solana settlement.");
      const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!book) refuse("The Solana live accounting book is missing.");
      const input = raw(settlement.amountIn), output = raw(settlement.amountOut);
      if (settlement.status === "expired") {
        const proof = settlement.expiryProof;
        if (settlement.feeLamports !== null || input !== 0n || output !== 0n || !proof ||
            proof.vaultSequence !== prior.submission.vaultSequence || raw(proof.sessionEpoch) < raw(prior.submission.sessionEpoch) ||
            !(proof.reason === "session-revoked" && raw(proof.sessionEpoch) > raw(prior.submission.sessionEpoch) ||
              proof.reason === "blockhash-expired" && raw(proof.blockHeight) > raw(prior.submission.lastValidBlockHeight))) refuse("Invalid Solana expiry evidence.");
        book.unresolvedFeeCount = (book.unresolvedFeeCount ?? 0) + 1;
        book.reservedUnknownFeeLamports = (raw(book.reservedUnknownFeeLamports ?? "0") + raw(prior.submission.feeLamports)).toString();
      } else {
        const fee = raw(settlement.feeLamports);
        if (fee > raw(prior.submission.feeLamports) || fee > raw(prior.submission.maxFeeLamports)) refuse("Finalized Solana fees exceed the reserved budget.");
        book.networkFeesLamports = (raw(book.networkFeesLamports) + fee).toString();
      }
      if (settlement.status === "finalized") {
        if (input === 0n || input > raw(prior.submission.intent.amountRaw) || output < raw(prior.submission.minOutAmount)) refuse("Solana settlement violates the reserved swap bounds.");
        if (prior.submission.intent.inputMint === SOLANA_USDG_MINT) {
          book.cashRaw = (raw(book.cashRaw) - input).toString(); book.wsolRaw = (raw(book.wsolRaw) + output).toString();
          book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) + input).toString();
        } else {
          const held = raw(book.wsolRaw); if (input > held || held === 0n) refuse("Solana settlement exceeds the recorded position.");
          const basis = input === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * input / held;
          book.wsolRaw = (held - input).toString(); book.cashRaw = (raw(book.cashRaw) + output).toString();
          book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - basis).toString();
          book.realizedPnlUsdgRaw = (BigInt(book.realizedPnlUsdgRaw) + output - basis).toString();
        }
        raw(book.cashRaw); raw(book.wsolRaw);
        if (raw(book.cashRaw) > raw(book.hwmRaw)) book.hwmRaw = book.cashRaw;
      } else if (input !== 0n || output !== 0n) refuse("A failed Solana transaction cannot book token movements.");
      book.slot = settlement.slot; book.updatedAtMs = clock(this.now);
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
      await tx.prepare("UPDATE solana_runtime_submissions SET status=?,settlement_json=? WHERE tenant=? AND owner=? AND request_id=? AND status='pending'")
        .run(settlement.status, JSON.stringify(settlement), tenant, owner, requestId);
      if (resolutionId !== null) {
        // Who booked it is part of the booking: no mark, no booking (the transaction rolls back).
        const marked = await tx.prepare(`UPDATE solana_operator_resolutions SET booked_at_ms=? WHERE id=? AND tenant=? AND owner=? AND request_id=? AND signature=?
          AND booked_at_ms IS NULL AND refusal IS NULL`).run(clock(this.now), resolutionId, tenant, owner, requestId, signature);
        if (marked.changes !== 1) refuse("The operator resolution to book this settlement is not open.");
      }
      return true;
    });
  }
  async setup(): Promise<SolanaPreparedSetup | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
  }
  async saveSetup(setup: SolanaPreparedSetup): Promise<boolean> {
    return this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      const previous = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
      if (previous?.signature && previous.status !== "finalized" && previous.status !== "failed") {
        if (previous.signature === setup.signature && previous.signedTransactionBase64 === setup.signedTransactionBase64) return false;
        refuse("Resolve the previously submitted Solana setup before creating another.");
      }
      if (setup.signature) {
        if (!previous || previous.messageBase64 !== setup.messageBase64 || previous.preparedAtMs !== setup.preparedAtMs) refuse("The prepared owner transaction changed. Review and sign again.");
        if (clock(this.now) >= previous.expiresAtMs) refuse("The prepared owner transaction expired before submission.");
        if ((setup.kind ?? "session") === "session" && (binding.requestedMode !== "live" || JSON.stringify(binding.limits) !== JSON.stringify(setup.limits))) refuse("The live permission settings changed. Review and sign again.");
      }
      // A WSOL withdrawal's valuation is checked once, fresh, as prepared; the signed
      // save keeps that checked copy, whatever it is handed. A bad one is dropped,
      // never a reason to block the owner's withdrawal.
      const { withdrawValuation: offered, ...plain } = setup;
      const valuation = setup.kind !== "withdraw" || setup.mint !== SOLANA_WRAPPED_SOL_MINT ? undefined
        : setup.signature ? previous?.withdrawValuation
        : solanaWithdrawValueUsdg(offered, setup.amountRaw, clock(this.now), this.pythGeneration) !== null ? offered : undefined;
      setup = valuation ? { ...plain, withdrawValuation: structuredClone(valuation) } : plain;
      // A session's limits become the on-chain permission: never more operations than
      // the program allows, never a permission longer than Merrymen grants.
      if ((setup.kind ?? "session") === "session") validateSolanaAccountLimits(setup.limits, clock(this.now));
      if (setup.kind !== "revoke" && await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending'").get(this.scope.tenant, this.scope.owner)) refuse("Resolve the pending Solana trade before an owner transaction.");
      if (setup.kind === "withdraw" || setup.kind === "withdraw-sol") {
        if (setup.priorSequence === undefined) refuse("Prepare the withdrawal again.");
        const trades = await tx.prepare("SELECT sequence,status FROM solana_runtime_submissions WHERE vault=? AND status IN ('pending','finalized')").all(setup.vault) as Array<{ sequence: string; status: string }>;
        // Its sequence was read before this lock; a trade at or after it means the read is stale.
        if (trades.some(t => t.status === "pending" || raw(t.sequence) >= raw(setup.priorSequence!))) refuse("The vault changed while the withdrawal was prepared. Prepare it again.");
      }
      await tx.prepare(`INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET setup_json=excluded.setup_json`).run(this.scope.tenant, this.scope.owner, JSON.stringify(setup));
      return true;
    });
  }
  async finishSetup(signature: string, status: "finalized" | "failed", finalizedSlot?: number, expiryProof?: SolanaOwnerExpiryProof): Promise<void> {
    await this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
      if (!setup || setup.signature !== signature) refuse("Owner confirmation does not match the saved transaction.");
      if (setup.status === "finalized" || setup.status === "failed") {
        if (setup.status !== status) refuse("Finalized owner transaction outcomes cannot be changed.");
        if (JSON.stringify(setup.expiryProof ?? null) !== JSON.stringify(expiryProof ?? null)) refuse("Finalized owner expiry evidence cannot be changed.");
        return;
      }
      if (expiryProof) {
        if (status !== "failed" || expiryProof.reason !== "blockhash-expired" || raw(expiryProof.blockHeight) <= raw(setup.lastValidBlockHeight) ||
            !Number.isSafeInteger(expiryProof.slot) || expiryProof.slot < 1 || finalizedSlot !== expiryProof.slot ||
            !solanaOwnerExpiryProven(setup, expiryProof.vaultSequence, expiryProof.sessionEpoch)) refuse("Invalid owner transaction expiry evidence.");
        setup.expiryProof = structuredClone(expiryProof);
      }
      if (status === "finalized" && setup.kind === "resume-buys") {
        const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?")
          .get(this.scope.tenant, this.scope.owner), "book_json");
        if (book) {
          book.buyPaused = false;
          await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?")
            .run(JSON.stringify(book), this.scope.tenant, this.scope.owner);
        }
      }
      if (status === "finalized" && setup.kind === "withdraw") {
        if (!setup.mint || !setup.amountRaw || ![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(setup.mint)) refuse("Invalid finalized withdrawal accounting.");
        const amount = raw(setup.amountRaw, false), { tenant, owner } = this.scope;
        const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
        if (book) {
          // The book may already be past this withdrawal's slot. While a signed
          // withdrawal is pending nothing moves book.slot (trades and inflow booking
          // refuse), but it can be past it when the bytes are saved: they landed before
          // the server saved them (a wallet that also broadcasts) while a finalized
          // inflow read after them was booked, or one provider answered that read with
          // an inflated slot. Refusing then wedged the setup pending forever, blocking
          // trading and every owner transaction. The withdrawal is real (both
          // providers agreed on its receipt and its vault effect) and its evidence id
          // books it once, so it is booked anyway and book.slot never moves back. If
          // that inflow read already saw it, the book now sits below the chain by the
          // amount, and the next finalized inflow read books that back.
          if (!Number.isSafeInteger(finalizedSlot) || finalizedSlot! < 1) refuse("Finalized withdrawal slot is required for durable accounting.");
          if (setup.mint === SOLANA_USDG_MINT) {
            if (amount > raw(book.cashRaw)) refuse("Finalized withdrawal exceeds the recorded cash balance.");
            book.cashRaw = (raw(book.cashRaw) - amount).toString();
            const peak = raw(book.hwmRaw); book.hwmRaw = (peak > amount ? peak - amount : 0n).toString();
          } else {
            const held = raw(book.wsolRaw);
            let aside = solanaQuarantinedWsol(book);
            // Native lamports this transaction synced into WSOL (SyncNative) join the
            // zero-basis quarantine, only as far as the withdrawal needs them and never
            // past what prepare measured. Any a later read already booked is not added again.
            const synced = raw(setup.syncedWsolRaw ?? "0"), over = amount > held + aside ? amount - held - aside : 0n;
            if (over > synced) refuse("Finalized withdrawal exceeds the recorded SOL position.");
            if (over > 0n) {
              const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'quarantine',?,?,?) ON CONFLICT DO NOTHING")
                .run(`sync:${signature}`, tenant, owner, SOLANA_WRAPPED_SOL_MINT, over.toString(), clock(this.now));
              if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
              aside += over;
            }
            // Quarantined WSOL leaves first: zero basis, no effect on the position or the high-water mark.
            const fromAside = amount < aside ? amount : aside, fromPosition = amount - fromAside;
            if (aside > 0n) book.quarantinedWsolRaw = (aside - fromAside).toString();
            if (fromPosition > 0n) {
              const basis = fromPosition === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * fromPosition / held;
              book.wsolRaw = (held - fromPosition).toString(); book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - basis).toString();
              // Capital out, as for USDG: the high-water mark drops by what the withdrawn
              // position was worth when prepared (its share of the valuation, floor 0).
              // Without a valuation it stays put, the conservative direction.
              const value = storedWithdrawValue(setup.withdrawValuation);
              if (value !== null) {
                const out = value * fromPosition / amount, peak = raw(book.hwmRaw);
                book.hwmRaw = (peak > out ? peak - out : 0n).toString();
              }
            }
            // No fabricated sale proceeds or P&L.
          }
          book.updatedAtMs = clock(this.now); book.slot = Math.max(book.slot, finalizedSlot!);
          const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw',?,?,?) ON CONFLICT DO NOTHING")
            .run(signature, tenant, owner, setup.mint, amount.toString(), book.updatedAtMs);
          if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
          await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
        }
      }
      if (status === "finalized" && setup.kind === "withdraw-sol") {
        // Native SOL in the vault account is never part of the book; keep the evidence once.
        if (!setup.amountRaw || setup.mint !== undefined) refuse("Invalid finalized withdrawal accounting.");
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw-sol',?,?,?) ON CONFLICT DO NOTHING")
          .run(signature, this.scope.tenant, this.scope.owner, SOLANA_SYSTEM_PROGRAM, raw(setup.amountRaw, false).toString(), clock(this.now));
        if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
      }
      setup.status = status;
      if (status === "finalized" && Number.isSafeInteger(finalizedSlot) && finalizedSlot! > 0) setup.finalizedSlot = finalizedSlot;
      await tx.prepare("UPDATE solana_runtime_setups SET setup_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(setup), this.scope.tenant, this.scope.owner);
    });
  }
}
