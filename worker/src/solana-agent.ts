/** Deterministic, opt-in USDG/SOL rebalancer. Both modes use the same admission boundary. */
import { createHash } from "node:crypto";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, validateSolanaAccountLimits, validateSolanaQuote, type SolanaPaperLimits, type SolanaQuote } from "../../packages/core/src/solana";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore, validateSolanaStrategy, type SolanaStrategy } from "../../web/src/lib/solana-binding-store";
import { getSolanaAppRuntime, SOLANA_STATUS_BELOW_BOOK } from "./solana-app-runtime";
import type { Db } from "./db";
import { createSolanaMarket, SolanaMarketError } from "./solana-market";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, SOLANA_REFERENCE_MAX_TOLERANCE_BPS, solanaReferenceToleranceBps } from "./solana-reference-price";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { ensureSolanaTradingSchema, SOLANA_AUTONOMOUS_REQUEST_PREFIX, SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED,
  SOLANA_OPERATOR_HOLD_ALL, solanaAutonomousSchedule, solanaExpiredAttemptAllowance, solanaExpiredAttemptUse, SolanaTradingStoreError,
  type SolanaAccountScope } from "./solana-trading-store";

export interface SolanaRebalanceInput {
  cashRaw: string; wsolRaw: string; solValueUsdgRaw: string; limits: SolanaPaperLimits;
  strategy: SolanaStrategy; mode: "paper" | "live"; revision: number; nowMs: number;
  /** The account's next autonomous attempt index (solanaAutonomousSchedule): each attempt has its own request ID. */
  attempt: number;
}
/** Integer-only sizing against an executable full-position exit quote. */
export function planSolanaRebalance(input: SolanaRebalanceInput) {
  const strategy = validateSolanaStrategy(input.strategy), limits = validateSolanaAccountLimits(input.limits, input.nowMs);
  if (!strategy.enabled) return null;
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("Invalid Solana strategy revision.");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) throw new Error("Invalid Solana strategy attempt.");
  const cash = parseSolanaRawAmount(input.cashRaw, true), held = parseSolanaRawAmount(input.wsolRaw, true), value = parseSolanaRawAmount(input.solValueUsdgRaw, true);
  if ((held === 0n) !== (value === 0n)) throw new Error("A current executable SOL valuation is required.");
  const equity = cash + value;
  if (equity === 0n) return null;
  const target = equity * BigInt(strategy.targetSolBps) / 10_000n, delta = target - value;
  const deviation = delta < 0n ? -delta : delta;
  if (deviation * 10_000n < equity * BigInt(strategy.rebalanceBps) || delta === 0n) return null;
  const notional = [deviation, BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b);
  const buying = delta > 0n;
  let amount = buying ? (notional < cash ? notional : cash) : held * notional / value;
  // A sell never asks for more WSOL input than the owner signed for one trade.
  if (!buying && limits.perTradeWsol !== undefined && amount > BigInt(limits.perTradeWsol)) amount = BigInt(limits.perTradeWsol);
  if (amount === 0n) return null;
  // Never an earlier attempt's ID: a proven-expired request is never re-sent, a new attempt is a new request.
  const requestId = `${SOLANA_AUTONOMOUS_REQUEST_PREFIX}${input.revision}-${input.attempt}`;
  return { ...parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId,
    inputMint: buying ? SOLANA_USDG_MINT : SOLANA_WRAPPED_SOL_MINT, outputMint: buying ? SOLANA_WRAPPED_SOL_MINT : SOLANA_USDG_MINT,
    amountRaw: amount.toString(), slippageBps: 50 }), mode: input.mode };
}
/** Re-quote the actual partial exit; a full-position minimum is not its unit price. */
export async function boundSolanaRebalanceSell(
  intent: NonNullable<ReturnType<typeof planSolanaRebalance>>, cap: bigint, market: SolanaPaperMarket, now: () => number,
) {
  if (intent.inputMint === SOLANA_USDG_MINT) return intent;
  let sized = intent;
  for (let attempt = 0; attempt < 3; attempt++) {
    const paper = parseSolanaSwapIntent({ ...sized, mode: "paper" });
    const quote = await market.quote(paper); validateSolanaQuote(quote, paper, now());
    const quoted = BigInt(quote.outAmount);
    if (quoted <= cap) return sized;
    const reduced = BigInt(sized.amountRaw) * cap * 9990n / (quoted * 10000n);
    if (reduced <= 0n) return null;
    sized = { ...sized, amountRaw: reduced.toString() };
  }
  return null;
}
/**
 * solMarkDust is optional for test runtimes; without it no zero-output mark of live SOL is taken for dust.
 * feePayerCheck is optional too; without it the agent checks no fee payer of its own.
 */
type Runtime = Pick<ReturnType<typeof getSolanaAppRuntime>, "status" | "trade"> & Partial<Pick<ReturnType<typeof getSolanaAppRuntime>, "solMarkDust" | "feePayerCheck">>;
export interface SolanaAgentOptions {
  db: Db; runtime: Runtime; market: SolanaPaperMarket; now?: () => number; postgres?: boolean; signal?: AbortSignal;
  /** Live sells are charged at up to this much above their quote by the reference price; size below the cap by it. */
  referenceToleranceBps?: number;
  /** The runtime's MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE, for the expired-attempt alerts only. Default SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE. */
  expiredAttemptAllowance?: number;
  /** Operator log lines ([alert] and [warn]). Default: stderr. Never carries keys, signed bytes or tenant identities. */
  log?: (line: string) => void;
}
/** While an expired-attempt condition persists for an account, its line is repeated at most this often. */
export const SOLANA_AGENT_ALERT_REPEAT_MS = 10 * 60_000;
/**
 * A stable, opaque name for one account in operator logs: no tenant identity or
 * owner key, but the same account always reads the same, and an operator who
 * knows the account can compute it.
 */
export function solanaAccountRef(scope: SolanaAccountScope): string {
  return createHash("sha256").update(`merrymen-solana-account/v1 ${scope.tenant} ${scope.owner}`).digest("hex").slice(0, 16);
}
/**
 * A live trade, or a signed owner transaction, still pending this long after it was admitted or prepared is
 * stuck: its blockhash expired a minute or two ago, so both providers should have agreed on its outcome by now.
 */
export const SOLANA_PENDING_STUCK_MS = 3 * 60_000;
/** How often the agent reads the shared fee payer itself, beside the reads status makes. */
export const SOLANA_AGENT_FEE_PAYER_CHECK_MS = 10 * 60_000;
/** The heartbeat is written at least this often during a tick; the UI shows the worker offline after 90 s. */
const HEARTBEAT_REFRESH_MS = 30_000;
/**
 * One tenant's tick outcome. waiting: its interval has not passed, so no status
 * read or quote was made. replayed: the attempt was already admitted (by another
 * worker), so nothing new was submitted.
 */
export type SolanaAgentOutcome = "held" | "waiting" | "submitted" | "replayed" | "unavailable";
export function createSolanaAgent(options: SolanaAgentOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const allowance = options.expiredAttemptAllowance ?? SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  /**
   * EXPIRED ATTEMPTS, SAID TO THE OPERATOR (owner decision G2-3: with the
   * default allowance of 0 every proven-expired attempt counts toward the
   * owner's maxOpsPerDay, so a burst of dropped packets can pause automated
   * trading, exits included, for up to 24 hours; the store has no logger).
   * - [alert] when expired attempts used up the account's daily operations: the
   *   agent holds the strategy before trying (dailyOperationsUsed), or admission
   *   refused it for that reason;
   * - [warn] when the expired attempts that count use more than half of them.
   * Each at most once per SOLANA_AGENT_ALERT_REPEAT_MS per account while it
   * persists, and at once again after it clears. Logging never changes an outcome.
   */
  const said = new Map<string, number>();
  const say = (key: string, line: string) => {
    const at = now(), last = said.get(key);
    if (last !== undefined && at >= last && at - last < SOLANA_AGENT_ALERT_REPEAT_MS) return;
    said.set(key, at);
    try { log(line); } catch { /* Logging never changes an outcome. */ }
  };
  type ExpiredUse = Awaited<ReturnType<typeof solanaExpiredAttemptUse>>;
  const report = (scope: SolanaAccountScope, use: ExpiredUse, maxOpsPerDay: number, refused: boolean) => {
    const account = solanaAccountRef(scope);
    const fields = JSON.stringify({ solana: refused ? "alert" : "warn", kind: refused ? "expired-attempts-exhausted" : "expired-attempts-high", account,
      expired: use.expired, counted: use.counted, allowance, operations: use.operations, maxOpsPerDay });
    const remedy = "MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE (a whole number from 0 to 96, default 0) sets how many a day do not count";
    if (refused) return say(`exhausted:${account}`, `[alert] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations, so its automated trades and exits pause until they leave the 24 h window: ${fields} — ${remedy}`);
    said.delete(`exhausted:${account}`);
    if (use.counted * 2 > maxOpsPerDay) say(`high:${account}`, `[warn] Solana proven-expired attempts use more than half of an account's daily operations; at the limit its automated trades and exits pause: ${fields} — ${remedy}`);
    else said.delete(`high:${account}`);
  };
  const expiredUse = async (scope: SolanaAccountScope, maxOpsPerDay: number, refused: boolean) => {
    try { report(scope, await solanaExpiredAttemptUse(options.db, scope, now(), allowance), maxOpsPerDay, refused); } catch {
      if (refused) say(`exhausted:${solanaAccountRef(scope)}`, `[alert] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations: ${
        JSON.stringify({ solana: "alert", kind: "expired-attempts-exhausted", account: solanaAccountRef(scope), allowance, maxOpsPerDay })}`);
    }
  };
  /**
   * Whether admission would refuse every live trade of this account, exits
   * included, for its daily operations, by the store's rolling 24-hour
   * arithmetic: trades (landed, failed or pending) reached maxOpsPerDay, or
   * with the proven-expired attempts beyond the allowance they did (said as the
   * [alert]). Checked before the status read, so such an account costs no RPC
   * read, quote, route or signature each tick while it waits for the window.
   * Only provider load rides on it: admission still enforces the limit itself.
   */
  const dailyOperationsUsed = async (scope: SolanaAccountScope, maxOpsPerDay: number): Promise<boolean> => {
    const use = await solanaExpiredAttemptUse(options.db, scope, now(), allowance);
    if (use.operations + use.counted < maxOpsPerDay) return false;
    if (use.operations < maxOpsPerDay) report(scope, use, maxOpsPerDay, true);
    return true;
  };
  /**
   * A live account whose vault holds less than its book (SOLANA_STATUS_BELOW_BOOK): tokens left it outside
   * Merrymen, and its automated trades and exits stay held until the book matches the vault again. Nothing in
   * the worker books a decrease: an operator finds what moved the tokens and reconciles the book, as the
   * plan of record says (docs/solana-integration.md, "A vault below its book"). Said as an [alert] at most
   * once per SOLANA_AGENT_ALERT_REPEAT_MS per account while it persists, and at once again after it clears.
   */
  const belowBook = (scope: SolanaAccountScope, blockers: readonly string[] | undefined) => {
    const account = solanaAccountRef(scope);
    if (!blockers?.includes(SOLANA_STATUS_BELOW_BOOK)) { said.delete(`below-book:${account}`); return; }
    say(`below-book:${account}`, `[alert] Solana vault below its book: an account's vault holds less USDG or SOL than its recorded trades, so its automated trades `
      + `and exits are held: ${JSON.stringify({ solana: "alert", kind: "vault-below-book", account })} — tokens left the vault outside Merrymen (a recovery-tool or wallet `
      + "withdrawal, say). Nothing reconciles the book by itself: an operator must find what moved the tokens and reconcile the book with the vault "
      + "(docs/solana-integration.md, \"A vault below its book\"). Until then the owner can revoke, and withdraw what the vault holds up to its book");
  };
  /**
   * STUCK, SAID TO THE OPERATOR. After receipt recovery, any live trade admitted, or signed owner transaction
   * prepared, more than SOLANA_PENDING_STUCK_MS ago and still pending: both providers could not read or agree on
   * its outcome. Each holds its account's reservation (no new trade, no in-app owner transaction but a revoke).
   * One [alert] with counts and the oldest age only (no tenant, owner, signature or bytes), at most once per
   * SOLANA_AGENT_ALERT_REPEAT_MS while any is stuck, and at once again after none was. The operator finds which
   * with `npm run solana:resolve -- pending` (listSolanaStuckPending), which reads the same rows by name.
   */
  const stuck = async () => {
    const at = now(), cutoff = at - SOLANA_PENDING_STUCK_MS;
    const trades = await options.db.prepare("SELECT COUNT(*) AS n, MIN(created_at_ms) AS oldest FROM solana_runtime_submissions WHERE status='pending' AND created_at_ms<=?")
      .get(cutoff) as { n: number | string; oldest: number | string | null } | undefined;
    const owners = (await options.db.prepare("SELECT setup_json FROM solana_runtime_setups").all() as Array<{ setup_json: string }>).flatMap(row => {
      try { const setup = JSON.parse(row.setup_json); return setup.signature && setup.status === "pending" && Number.isSafeInteger(setup.preparedAtMs) && setup.preparedAtMs <= cutoff ? [setup.preparedAtMs as number] : []; }
      catch { return []; }
    });
    const tradeCount = Number(trades?.n ?? 0), oldest = [...(trades?.oldest == null ? [] : [Number(trades.oldest)]), ...owners];
    if (!tradeCount && !owners.length) { said.delete("pending-stuck"); return; }
    say("pending-stuck", `[alert] Solana transactions stuck pending: ${JSON.stringify({ solana: "alert", kind: "pending-stuck", trades: tradeCount,
      ownerTransactions: owners.length, oldestAgeMs: at - Math.min(...oldest) })} — both RPC providers could not read or agree on their outcome for over `
      + `${SOLANA_PENDING_STUCK_MS / 60_000} minutes; each holds its account's reservation (no new trade, no in-app owner transaction but a revoke). Check both `
      + "providers; npm run solana:resolve -- pending names each one (tenant, id, age, vault sequence), and show <tenant> <request-id> shows a trade's evidence");
  };
  /**
   * The shared fee payer, read by the agent itself every SOLANA_AGENT_FEE_PAYER_CHECK_MS while any live
   * permission is registered (runtime.feePayerCheck, which says the [alert]s status says, through the same
   * state): a payer that cannot fund exits pages the operator even when no status is read. A check that
   * cannot be made is tried again after the interval and never changes an outcome.
   */
  let feePayerCheckedAtMs: number | undefined;
  const feePayer = async () => {
    const at = now();
    if (!options.runtime.feePayerCheck || (feePayerCheckedAtMs !== undefined && at >= feePayerCheckedAtMs && at - feePayerCheckedAtMs < SOLANA_AGENT_FEE_PAYER_CHECK_MS)) return;
    const registered = await options.db.prepare("SELECT record_json FROM solana_runtime_sessions ORDER BY tenant,owner LIMIT 1").get() as { record_json: string } | undefined;
    if (!registered) return;
    let vault: string | undefined;
    try { const record = JSON.parse(registered.record_json); if (typeof record.vault === "string") vault = record.vault; } catch { /* Sized by the upper bound. */ }
    // At most one check per interval, failed ones included: a provider that is down is not asked every tick.
    feePayerCheckedAtMs = at;
    await options.runtime.feePayerCheck(vault === undefined ? {} : { vault });
  };
  const headroom = BigInt(10_000 - (options.referenceToleranceBps ?? SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS));
  // When each tenant's strategy last found nothing to do (in band), or admission refused it
  // because expired attempts used up its daily operations, by settings revision.
  // Only provider load rides on this: admission spacing is durable in the store.
  const checked = new Map<string, { revision: number; atMs: number }>();
  const admitted = async (scope: SolanaAccountScope, requestId: string) => !!(
    await options.db.prepare("SELECT 1 FROM solana_runtime_autonomous_attempts WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId) ??
    await options.db.prepare("SELECT 1 FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId) ??
    await options.db.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId));
  return {
    async tick() {
      await ensureSolanaTradingSchema(options.db, options.postgres);
      // Refreshed as the tick goes, so a long tick never shows the worker as offline.
      let beatAtMs = now();
      const beat = async (force = false) => {
        const at = now();
        if (!force && at - beatAtMs < HEARTBEAT_REFRESH_MS) return;
        beatAtMs = at;
        await options.db.prepare("INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?) ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms").run(at);
      };
      await beat(true);
      // Disabling a strategy never disables receipt recovery. Confirmation is
      // read-only and must keep working after mode changes or key rotation.
      const unsettled = await options.db.prepare("SELECT DISTINCT tenant,owner FROM solana_runtime_submissions WHERE status='pending'").all() as SolanaAccountScope[];
      const setups = await options.db.prepare("SELECT tenant,owner,setup_json FROM solana_runtime_setups").all() as Array<SolanaAccountScope & { setup_json: string }>;
      const recovered = new Map<string, Awaited<ReturnType<Runtime["status"]>>>();
      for (const scope of [...unsettled, ...setups.filter(item => { try { return JSON.parse(item.setup_json).status === "pending"; } catch { return false; } })]) {
        if (options.signal?.aborted) break;
        if (recovered.has(scope.tenant)) continue;
        try { recovered.set(scope.tenant, await options.runtime.status({ tenant: scope.tenant, owner: scope.owner })); } catch { /* Retry next tick; no replacement transaction. */ }
        await beat();
      }
      // What recovery could not settle, and the fee payer, are said to the operator; neither ever changes an outcome.
      try { await stuck(); } catch { /* Said next tick. */ }
      try { await feePayer(); } catch { /* Checked again after the interval. */ }
      const rows = await options.db.prepare("SELECT tenant,owner,requested_mode,limits_json,strategy_json,revision FROM solana_wallet_bindings WHERE chain=? AND strategy_json IS NOT NULL ORDER BY tenant")
        .all(CHAINS.solana) as Array<{ tenant: string; owner: string; requested_mode: "paper" | "live"; limits_json: string | null; strategy_json: string; revision: number }>;
      // Operator holds are read after receipt recovery, which they never stop.
      const holds = new Set((await options.db.prepare("SELECT scope FROM solana_operator_holds").all() as Array<{ scope: string }>).map(h => h.scope));
      const results: Array<{ owner: string; outcome: SolanaAgentOutcome }> = [];
      for (const row of rows) {
        if (options.signal?.aborted) break;
        await beat();
        const scope: SolanaAccountScope = { tenant: row.tenant, owner: row.owner };
        try {
          const strategy = validateSolanaStrategy(JSON.parse(row.strategy_json));
          if (!strategy.enabled || !row.limits_json) continue;
          if (holds.has(SOLANA_OPERATOR_HOLD_ALL) || holds.has(row.tenant)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          const limits = validateSolanaAccountLimits(JSON.parse(row.limits_json), now());
          // The interval spaces attempts (durably) and checks: until it is due, no status read and no quote.
          const revision = Number(row.revision), intervalMs = strategy.intervalSeconds * 1000, at = now();
          const schedule = await solanaAutonomousSchedule(options.db, scope, strategy.intervalSeconds);
          const last = checked.get(row.tenant);
          if (at < schedule.dueAtMs || (last && last.revision === revision && at - last.atMs < intervalMs)) { results.push({ owner: row.owner, outcome: "waiting" }); continue; }
          const inBand = () => { checked.set(row.tenant, { revision, atMs: at }); results.push({ owner: row.owner, outcome: "held" }); };
          if (row.requested_mode === "live" && await dailyOperationsUsed(scope, limits.maxOpsPerDay)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          // A paper strategy needs only its paper book: no chain reads, no vault verification.
          const status = recovered.get(scope.tenant) ?? await options.runtime.status(scope, row.requested_mode === "paper" ? { liveReads: false } : undefined);
          let cashRaw: string, wsolRaw: string;
          if (row.requested_mode === "paper") {
            if (!status.paper || status.paper.positions.some(p => p.mint !== SOLANA_WRAPPED_SOL_MINT)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            cashRaw = status.paper.cashRaw; wsolRaw = status.paper.positions.find(p => p.mint === SOLANA_WRAPPED_SOL_MINT)?.amountRaw ?? "0";
          } else {
            belowBook(scope, status.live.blockers);
            if (!status.live.balances || !status.live.tradable || status.live.pending.length || (!status.live.ready && !status.live.canExit)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            // The book's amounts, never the chain's: quarantined SOL is not the strategy's to sell.
            cashRaw = status.live.tradable.cashUsdg; wsolRaw = status.live.tradable.wsolRaw;
          }
          let solValueUsdgRaw = "0";
          if (BigInt(wsolRaw) > 0n) {
            const markIntent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "rebalance-mark",
              inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: wsolRaw, slippageBps: 50 });
            let mark: SolanaQuote | null = null;
            try { mark = await options.market.quote(markIntent); }
            catch (error) { if (!(error instanceof SolanaMarketError && error.code === "zero-output")) throw error; }
            if (mark) { validateSolanaQuote(mark, markIntent, now()); solValueUsdgRaw = mark.minOutAmount; }
            // SOL no route buys back (Jupiter's zero-output answer) is dust: nothing to sell and worth
            // zero, as the runtime and the paper book value it at a buy. Planned as no position, so
            // it never stops the strategy. Live, only once Pyth shows it is worth under a cent
            // (the runtime's solMarkDust, the bound its buy check applies): a zero-output answer for
            // more is unusable, and like any other failure makes the tick unavailable, with no route built.
            else if (row.requested_mode === "paper" || await options.runtime.solMarkDust?.(wsolRaw)) wsolRaw = "0";
            else throw new SolanaMarketError("invalid-quote");
          }
          let intent = planSolanaRebalance({ cashRaw, wsolRaw, solValueUsdgRaw, limits, strategy, mode: row.requested_mode, revision, nowMs: now(), attempt: schedule.attempt });
          const cap = [BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b);
          if (intent) intent = await boundSolanaRebalanceSell(intent, row.requested_mode === "live" ? cap * headroom / 10_000n : cap, options.market, now);
          if (!intent) { inBand(); continue; }
          if (row.requested_mode === "live" && !status.live.ready && intent.inputMint === SOLANA_USDG_MINT) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          if (options.signal?.aborted) break;
          // Already admitted under this ID (another worker got there first): a replay submits nothing.
          if (await admitted(scope, intent.requestId)) { results.push({ owner: row.owner, outcome: "replayed" }); continue; }
          try { await options.runtime.trade(scope, { mode: row.requested_mode, intent, autonomousRevision: Number(row.revision), signal: options.signal }); }
          catch (error) {
            // Held by the owner's daily operations, which expired attempts used up (counted by admission after the
            // check above): said as an [alert], and not tried again until the interval passes, as when in band.
            if (row.requested_mode !== "live" || !(error instanceof SolanaTradingStoreError) || error.message !== SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED) throw error;
            await expiredUse(scope, limits.maxOpsPerDay, true);
            inBand(); continue;
          }
          if (row.requested_mode === "live") await expiredUse(scope, limits.maxOpsPerDay, false);
          results.push({ owner: row.owner, outcome: "submitted" });
        } catch { results.push({ owner: row.owner, outcome: "unavailable" }); }
      }
      await beat();
      return results;
    },
  };
}

/** Dedicated sibling worker; Solana addresses never enter the RH worker loop. */
export async function runSolanaAgent(signal: AbortSignal) {
  const db = await getSolanaRuntimeDb();
  // Initialize the shared binding schema without inventing or registering a tenant.
  const bindings = new SqlSolanaBindingStore(async () => db, process.env.DATABASE_URL ? "postgres" : "sqlite");
  await bindings.get("0x0000000000000000000000000000000000000000");
  // A malformed tolerance must not stop receipt recovery: live trades already
  // refuse it in the runtime, so only size with the widest headroom here.
  let referenceToleranceBps = SOLANA_REFERENCE_MAX_TOLERANCE_BPS;
  try { referenceToleranceBps = solanaReferenceToleranceBps(process.env); } catch { /* Refused at trade time. */ }
  // Only for the expired-attempt alerts; a malformed setting refuses every live trade in the runtime anyway.
  let expiredAttemptAllowance = SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  try { expiredAttemptAllowance = solanaExpiredAttemptAllowance(process.env); } catch { /* Refused at trade time. */ }
  const agent = createSolanaAgent({ db, runtime: getSolanaAppRuntime(), market: createSolanaMarket(), postgres: !!process.env.DATABASE_URL, signal,
    referenceToleranceBps, expiredAttemptAllowance });
  while (!signal.aborted) {
    try {
      const results = await agent.tick();
      // Counts only: no credentials, signed bytes or tenant identities in logs.
      if (results.some(r => r.outcome !== "waiting")) process.stdout.write(JSON.stringify({ solana: "tick", submitted: results.filter(r => r.outcome === "submitted").length,
        replayed: results.filter(r => r.outcome === "replayed").length, held: results.filter(r => r.outcome === "held").length,
        waiting: results.filter(r => r.outcome === "waiting").length, unavailable: results.filter(r => r.outcome === "unavailable").length }) + "\n");
    } catch { process.stderr.write("Solana worker storage is unavailable; no new trades were admitted.\n"); }
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); };
      const timer = setTimeout(onAbort, 15_000); signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
