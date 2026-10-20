/** Authenticated Solana application boundary. Owner keys never enter this module. */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction,
  getTransactionDecoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Decode, canonicalId } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, parseSolanaTradeRequest, requireSolanaLiveSellLimits, SolanaPaperValidationError, validateSolanaAccountLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaQuote, type SolanaSwapIntent, type SolanaTradeRequest } from "../../packages/core/src/solana";
import {
  buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, buildRevokeSolanaSessionsInstruction,
  buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction, buildSetSolanaBreakerInstruction, decodeSolanaVaultAccount, deriveSolanaAta, deriveSolanaVaultAddress,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_LOCAL_TEST_PROGRAM,
  SOLANA_WRAPPED_SOL_MINT,
} from "../../packages/core/src/solana-live";
import { solanaVaultReleaseRefusal } from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { createSolanaExecutor, parseSolanaLiveIntent, readSolanaOwnerRefundBlocks, type SolanaOwnerRefundBlock, readSolanaVaultBalances, readSolanaVaultBalancesQuorum, readSolanaVaultBalancesWith,
  readSolanaVaultState, readSolanaVaultStateWith, reconcileSolanaSubmission, SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE, solanaComputeBudgetInstructions, SolanaExecutionError, solanaCaughtUp, solanaQuorumSlot, verifySolanaVaultDeployment,
  type SolanaLiveJournal, type SolanaLiveRecord } from "./solana-executor";
import { createSolanaLiveMarket } from "./solana-live-market";
import { createSolanaLiveRpc, readSolanaEachProvider, readSolanaPriorityFee, readSolanaQuorum, type SolanaLiveRead, type SolanaLiveRpc } from "./solana-live-rpc";
import { createSolanaMarket, SolanaMarketError, solanaJupiterApiKey } from "./solana-market";
import { createSolanaPaperService, type SolanaPaperMarket } from "./solana-paper-service";
import { readSolanaReferencePrice, requireSolanaPythGeneration, solanaLowestReferenceBound, solanaMarkDust, solanaPythGeneration, solanaReferenceBound, solanaReferenceNotional, solanaReferenceToleranceBps,
  solanaStrictestReferenceBound, type SolanaPythGeneration, type SolanaReferencePrice,
  SolanaReferencePriceError, SOLANA_REFERENCE_ALERT_REPEAT_MS, SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, SOLANA_REFERENCE_MAX_TOLERANCE_BPS,
  SOLANA_REFERENCE_MIN_TOLERANCE_BPS } from "./solana-reference-price";
import { SolanaRpcError } from "./solana-rpc";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { isSolanaTransactionError } from "./solana-settlement";
import { ensureSolanaTradingSchema, OPERATOR_HOLD, SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED, solanaExpiredAttemptAllowance, solanaExpiredAttemptUse, solanaOwnerExpiryProven, solanaQuarantinedWsol, SolanaTradingStore, SolanaTradingStoreError, type SolanaAccountScope,
  type SolanaLiveBook, type SolanaOwnerExpiryProof, type SolanaPreparedSetup, type SolanaWithdrawValuation } from "./solana-trading-store";

/**
 * Codes:
 * - configuration, permission, invalid: refusals.
 * - pending: retry later.
 * - outcome-unknown: a failure to read or book the outcome of an owner
 *   transaction that is already saved (and was broadcast). Its outcome is
 *   unknown, never refused: the web answers it as the unknown-outcome 503
 *   whatever the message (vault effect missing, unreadable account data...).
 * - not-saved: THIS request saved and sent nothing: the submitted owner bytes
 *   were refused before anything was written, and resubmitting them cannot
 *   help. It says nothing about earlier requests. The same bytes may have been
 *   saved, broadcast and even finalized by an earlier submission, after which
 *   a new prepare replaced that setup, so they no longer match it and are
 *   refused here. The page must keep deciding retries from whether it sent the
 *   bytes itself and from the server's record (outcomeAfterRefusal), never
 *   from notSaved alone, and must never tell the owner that bytes it already
 *   sent were not sent.
 */
export class SolanaAppRuntimeError extends Error {
  constructor(readonly code: "configuration" | "permission" | "invalid" | "pending" | "outcome-unknown" | "not-saved", message: string) {
    super(message); this.name = "SolanaAppRuntimeError";
  }
}
function fail(message: string, code: SolanaAppRuntimeError["code"] = "invalid"): never { throw new SolanaAppRuntimeError(code, message); }
/** A signed permission whose saved limits stopped validating after it was prepared (they expired inside the prepare window). */
export const LIMITS_NO_LONGER_VALID = "The saved trading limits are no longer valid: they expired or changed before this permission was submitted. Nothing was saved or sent. Save current limits, then prepare the permission again.";
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("Invalid Solana confirmation data."); return value;
}
function encoded(value: string, max = 1232): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value) fail("Invalid encoded Solana transaction.");
  return bytes;
}
function seed(value: string | undefined, message: string): Buffer {
  if (!value) return fail(message, "configuration");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) return fail(message, "configuration");
  return bytes;
}
function publicTrade(record: SolanaLiveRecord) {
  const { intent, signature, preparedAtMs, minOutAmount, quotedOutAmount } = record.submission;
  return { mode: "live" as const, requestId: intent.requestId, intent, signature, status: record.status,
    preparedAtMs, minOutAmount, quotedOutAmount, settlement: record.settlement ?? null };
}
/**
 * What status tells the owner when no independent fallback RPC provider is
 * configured. Like every configuration refusal an owner may see, it names no
 * setting: SolanaRpcError("invalid-fallback") names the deployment variable,
 * which stays in operator tools (check:solana-rpc, the worker's own errors).
 */
/**
 * The status blocker while the account's trades in the last 24 hours (landed,
 * failed or pending) reached its maxOpsPerDay: admission refuses every live
 * trade, exits included, until the oldest leaves the window.
 * SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED is the blocker when proven-expired attempts
 * beyond the allowance are what used the day's operations up.
 */
export const SOLANA_STATUS_DAILY_OPERATIONS_USED = "This account made its maximum number of trades for the last 24 hours. Trading and automated exits resume as they leave the window.";
export const SOLANA_STATUS_NO_FALLBACK = "Live trading needs a second, independent RPC provider; an operator must configure one.";
/**
 * The status warning while MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS cannot be
 * read. The threshold is a warning level only, so it refuses nothing: the fee
 * payer is called low below four times the fee cap meanwhile, and operators
 * get an [alert] (solana fee-payer-threshold misconfigured).
 */
export const SOLANA_STATUS_FEE_PAYER_THRESHOLD_MISCONFIGURED = "The fee payer warning threshold setting is misconfigured; operators are alerted below four times the fee cap until it is fixed. Trading and exits continue.";
/**
 * The status blocker while the vault's balances were read from a bank older
 * than the book's own slot (a lagging provider): such a read cannot show a
 * shortfall, so it is never said as SOLANA_STATUS_BELOW_BOOK, and trading
 * still waits (admission refuses evidence older than the book too).
 */
export const SOLANA_STATUS_BEHIND_BOOK = "Vault balances were read from before the latest recorded trade; trading waits for a current read.";
/**
 * A failed live status read as the owner sees it. This module's own refusals,
 * and the two RPC problems only an operator can fix (no independent fallback
 * provider, or a transport without two providers), are shown by fixed text
 * that names no setting; SolanaRpcError never carries provider content.
 * Anything else is generic.
 */
function statusBlocker(error: unknown): string {
  if (error instanceof SolanaAppRuntimeError) return error.message;
  if (error instanceof SolanaRpcError && error.code === "invalid-fallback") return SOLANA_STATUS_NO_FALLBACK;
  if (error instanceof SolanaRpcError && error.code === "no-quorum") return error.message;
  return "The configured vault, balances or live permissions could not be verified.";
}
/**
 * What the owner is told when a donation waits for an owner token account that
 * is closed or unsafe, with the remedy for why (SolanaOwnerRefundProblem).
 * Withdrawing opens a missing account, so it is offered only for that one: the
 * vault's Withdraw does not check the owner's account, so withdrawing into one
 * with a delegate succeeds, leaves the swap blocked, and puts the tokens where
 * the delegate can move them.
 */
function refundBlocker({ mint, problem }: SolanaOwnerRefundBlock): string {
  const token = mint === SOLANA_USDG_MINT ? "USDG" : "wrapped SOL", until = problem === "frozen" ? "while it stays frozen" : "until then";
  const stopped = mint === SOLANA_USDG_MINT ? `Buying is paused ${until}; exits remain available.` : `Selling and automated exits are refused ${until}.`;
  const waiting = `Someone sent ${token} to your vault's next swap account. The vault returns it to your own ${token} token account, which`;
  switch (problem) {
    case "missing": return `${waiting} does not exist (it was closed or never opened). Reopen your ${token} token account in your wallet, or withdraw a little ${token} here, which opens it. ${stopped}`;
    case "delegated": return `${waiting} is not safe to use: it has a delegate approved to move its tokens, or a close authority. Revoke the delegate and remove the close authority `
      + `in your wallet. Withdrawing here does not fix this, and ${token} withdrawn into that account could be moved by its delegate. ${stopped}`;
    case "frozen": return `${waiting} is frozen. That cannot be fixed from here: only the token's issuer can unfreeze it. ${stopped}`;
    default: return `${waiting} is not a token account the vault can use. Check that account in your wallet. ${stopped}`;
  }
}
/**
 * The status blocker while a vault balance is below its book, and what the owner
 * can do about it: a withdrawal made outside Merrymen is recorded from its own
 * transaction (recordExternalWithdrawals); anything else stays held.
 */
export const SOLANA_STATUS_BELOW_BOOK = "Vault balances are below recorded trades. If you withdrew from the vault outside Merrymen, with your owner key in another wallet or tool, record those withdrawals under Owner controls; until the records match the vault, trading and automated exits stay held.";
/** Chain balances at or above the book: an excess waits to be booked, a shortfall stops trading. */
function shortOfBook(book: SolanaLiveBook, chain: { cashUsdg: string; wsolRaw: string }): boolean {
  return BigInt(chain.cashUsdg) < BigInt(book.cashRaw) || BigInt(chain.wsolRaw) < BigInt(book.wsolRaw) + solanaQuarantinedWsol(book);
}
function aboveBook(book: SolanaLiveBook, chain: { cashUsdg: string; wsolRaw: string }): boolean {
  return BigInt(chain.cashUsdg) > BigInt(book.cashRaw) || BigInt(chain.wsolRaw) > BigInt(book.wsolRaw) + solanaQuarantinedWsol(book);
}
function tokenProgram(mint: string): string {
  if (mint === SOLANA_USDG_MINT) return TOKEN_2022_PROGRAM;
  if (mint === SOLANA_WRAPPED_SOL_MINT) return SOLANA_CLASSIC_TOKEN_PROGRAM;
  return fail("Live Solana trading currently supports USDG and wrapped SOL.");
}
/** The two signatures (fee payer and session) every swap pays for. */
const SWAP_SIGNATURE_FEES = 10_000n;
/** A classic token account, like the temporary WSOL account an exit opens and closes. */
const CLASSIC_TOKEN_ACCOUNT_SIZE = 165;
/** Upper bound for a Token-2022 USDG token account whose size cannot be read yet (before the vault's own exists). */
const TOKEN_2022_ACCOUNT_SIZE_BOUND = 300;
/** The signature fee per signer. Owner transactions carry one signature, plus a bounded priority fee when one can be set. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
/**
 * The most priority fee an owner transaction (revoke, withdrawal, permission)
 * ever carries: 0.001 SOL. The owner pays it, so it is also bounded by what the
 * owner wallet holds beyond the transaction's own needs. The browser's
 * permission check (web/src/terminal/SolanaPermission.tsx) enforces the same cap.
 */
export const SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/** Compute units an owner transaction reserves above its simulation: room to open one more token account meanwhile. */
const OWNER_COMPUTE_HEADROOM = 40_000;
/**
 * What the runtime gives each instruction (other than ComputeBudget) of a
 * transaction that sets no compute-unit limit, which is how owner transactions
 * went before they carried a priority fee.
 */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
/**
 * The compute-unit limit an owner transaction signs: its simulation plus
 * headroom, but never below what it would get with no limit at all (the
 * runtime default for its instructions), and never above MAX_COMPUTE_UNITS.
 *
 * The simulation comes from one provider. A provider that under-reports it (a
 * bug, or a hostile one answering 1 unit) must not make a revoke or withdrawal
 * run out of compute on chain, the owner paying the fee each time. The floor
 * makes a priority fee never shrink the budget the transaction had without
 * one; its price is derived from these units, so the total fee stays within
 * the owner's cap whatever the limit (ownerPriority).
 */
export function solanaOwnerComputeUnitLimit(simulatedUnits: number, instructionCount: number): number {
  const simulated = Math.ceil(simulatedUnits * 1.2) + OWNER_COMPUTE_HEADROOM;
  const floor = DEFAULT_UNITS_PER_INSTRUCTION * instructionCount;
  return Math.min(MAX_COMPUTE_UNITS, Math.max(simulated, floor));
}
/**
 * How long preparing an owner transaction waits for its priority-fee reads
 * (simulation and recent fees) before sending it without a priority fee.
 */
export const SOLANA_OWNER_FEE_READ_MS = 3_000;
const MAX_COMPUTE_UNITS = 1_400_000;
/** A WSOL withdrawal is valued as the agent marks and exits SOL: an exit quote at this slippage. */
const WITHDRAW_VALUATION_SLIPPAGE_BPS = 50;
/** An unchanged fee payer alert is logged again after this long. */
const FEE_PAYER_ALERT_REPEAT_MS = 10 * 60_000;
/** Lamports as SOL, exact, for owner- and operator-facing text. */
function sol(lamports: bigint): string {
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${lamports / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}
type ChainAccount = { owner: string; executable: boolean; lamports: bigint; data: Buffer } | null;
function chainAccount(raw: unknown): ChainAccount {
  if (raw === null) return null;
  if (!object(raw) || typeof raw.owner !== "string" || typeof raw.executable !== "boolean" || !Array.isArray(raw.data) || raw.data[1] !== "base64"
    || typeof raw.data[0] !== "string" || typeof raw.lamports !== "number" || !Number.isSafeInteger(raw.lamports) || raw.lamports < 0) return fail("Invalid Solana account data.");
  const data = Buffer.from(raw.data[0], "base64");
  if (data.toString("base64") !== raw.data[0]) return fail("Invalid Solana account data.");
  return { owner: raw.owner, executable: raw.executable, lamports: BigInt(raw.lamports), data };
}
/** Lamports an account can pay fees with: only a plain system account can be a fee payer. */
function payable(account: ChainAccount): bigint {
  return account && account.owner === SOLANA_SYSTEM_PROGRAM && !account.executable && account.data.length === 0 ? account.lamports : 0n;
}
/**
 * Native lamports in a WSOL token account beyond its rent reserve and token
 * amount: SOL sent straight to it without SyncNative. Not a valid native WSOL
 * account of `holder`: 0.
 */
function unsyncedWsolLamports(account: ChainAccount, holder: string): bigint {
  const data = account?.data;
  if (!account || !data || account.owner !== SOLANA_CLASSIC_TOKEN_PROGRAM || account.executable || data.length < 165 || data[108] !== 1 || data.readUInt32LE(109) !== 1
    || getBase58Decoder().decode(data.subarray(0, 32)) !== SOLANA_WRAPPED_SOL_MINT || getBase58Decoder().decode(data.subarray(32, 64)) !== holder) return 0n;
  const excess = account.lamports - data.readBigUInt64LE(113) - data.readBigUInt64LE(64);
  return excess > 0n ? excess : 0n;
}
/** The classic token program's permissionless SyncNative: unsynced lamports become WSOL. */
function syncNative(tokenAccount: string): Instruction {
  return { programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), accounts: [{ address: address(tokenAccount), role: 1 }], data: Uint8Array.of(17) };
}
/** Confirmed accounts in one call; a missing account is null. */
async function readAccounts(read: SolanaLiveRead, keys: readonly string[]): Promise<ChainAccount[]> {
  const result = await read("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
  if (!object(result) || !object(result.context) || !Array.isArray(result.value) || result.value.length !== keys.length) return fail("Invalid Solana account data.");
  return result.value.map(chainAccount);
}
async function createAta(owner: string, authority: string, mint: string): Promise<Instruction> {
  const program = tokenProgram(mint);
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(1), accounts: [
    { address: address(owner), role: 3 }, { address: address(await deriveSolanaAta(authority, mint, program)), role: 1 },
    { address: address(authority), role: 0 }, { address: address(mint), role: 0 },
    { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(program), role: 0 },
  ] };
}
/** How long a successful vault deployment check is reused before it runs again. Failures are never reused. */
export const SOLANA_DEPLOYMENT_RECHECK_MS = 10 * 60_000;
export interface SolanaAppRuntimeOptions {
  db?: Db; env?: Readonly<Record<string, string | undefined>>; now?: () => number;
  rpc?: SolanaLiveRpc; market?: SolanaPaperMarket;
  /** Operator log lines (fee payer alerts). Default: stderr. Never carries keys, signed bytes or tenant identities. */
  log?: (line: string) => void;
  /**
   * Test harnesses only: accept the local test program id, and let status and
   * owner actions accept a binary that does not embed the configured id (the
   * executor still refuses one before signing a trade). It defaults to true only
   * when a test transport is injected (`rpc`), which production never does;
   * getSolanaAppRuntime() always runs the full checks.
   */
  localTestDeployment?: boolean;
  /** Test harnesses only: the released vault programs config() holds a live deployment to. Default SOLANA_VAULT_RELEASES. */
  vaultReleases?: readonly { readonly programId: string; readonly sha256: string }[];
  /** How long an owner transaction waits for its best-effort priority-fee reads. Default SOLANA_OWNER_FEE_READ_MS. */
  ownerFeeReadMs?: number;
}
export function createSolanaAppRuntime(options: SolanaAppRuntimeOptions = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const localTest = options.localTestDeployment ?? options.rpc !== undefined;
  const ownerFeeReadMs = options.ownerFeeReadMs ?? SOLANA_OWNER_FEE_READ_MS;
  const rpc = () => options.rpc ?? createSolanaLiveRpc({ env });
  const market = () => options.market ?? createSolanaMarket({ env, now });
  async function store(scope: SolanaAccountScope, autonomousRevision?: number, signal?: AbortSignal) {
    const db = options.db ?? await getSolanaRuntimeDb();
    await ensureSolanaTradingSchema(db, !!env.DATABASE_URL);
    const result = new SolanaTradingStore(db, scope, now, autonomousRevision === undefined ? undefined : { autonomousRevision, signal },
      () => solanaPythGeneration(env)); await result.binding(); return result;
  }
  /** The configured deployment, every check but the release pin's (config() adds it). Only status() uses it alone. */
  function configured() {
    const programId = env.MERRYMEN_SOLANA_VAULT_PROGRAM, hash = env.MERRYMEN_SOLANA_VAULT_SHA256;
    if (!programId || !hash || !/^[a-f0-9]{64}$/.test(hash)) fail("An audited immutable Solana vault deployment and its binary hash must be configured.", "configuration");
    try { address(programId); } catch { fail("The configured Solana vault program is invalid.", "configuration"); }
    // The local test build's id is never a live deployment.
    if (programId === SOLANA_VAULT_LOCAL_TEST_PROGRAM && !localTest) fail("The configured Solana vault program is the local test id, which is never used for live trading.", "configuration");
    return { programId, hash };
  }
  function config() {
    const { programId, hash } = configured();
    // Once a release is pinned (SOLANA_VAULT_RELEASES), only a listed program with its released
    // binary hash, the one the owner recovery tool trusts, is a live deployment. Before any RPC.
    const unreleased = localTest ? null : solanaVaultReleaseRefusal(programId, hash, options.vaultReleases);
    if (unreleased) fail(unreleased, "configuration");
    return { programId, hash };
  }
  /**
   * Swap compute-unit price bounds, in micro-lamports.
   * MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS is the minimum (default 0;
   * it used to be the fixed price, so it keeps working alone).
   * MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS is the maximum, by
   * default the larger of SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE and the minimum.
   * A maximum set below the minimum, or an unreadable value, is refused here as
   * configuration (a status blocker), never as a fee refusal at an exit.
   */
  function computeUnitPrices(): { minimum: string; maximum: string } {
    const read = (value: string | undefined, fallback: bigint): bigint => {
      if (value === undefined) return fallback;
      try { return parseSolanaRawAmount(value, true); } catch { return fail("The Solana compute-unit price settings are misconfigured: each must be a whole number of micro-lamports.", "configuration"); }
    };
    const minimum = read(env.MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS, 0n);
    const maximum = read(env.MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      minimum > SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE ? minimum : SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE);
    if (maximum < minimum) fail("The Solana compute-unit price settings are misconfigured: the maximum is below the minimum. Live trading and exits stay refused until an operator fixes them.", "configuration");
    return { minimum: minimum.toString(), maximum: maximum.toString() };
  }
  /**
   * Proven-expired attempts a day that do not count toward the owner's
   * maxOpsPerDay (MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE, default 0: every
   * signed transaction counts). See SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE.
   * A value that is not a whole number from 0 to 96 is configuration.
   */
  function expiredAttemptAllowance(): number {
    try { return solanaExpiredAttemptAllowance(env); } catch (error) {
      if (error instanceof SolanaTradingStoreError) return fail(error.message, "configuration");
      throw error;
    }
  }
  // The last successful deployment check, and one in flight so concurrent callers share it.
  let verified: { key: string; atMs: number } | undefined;
  let verifying: { key: string; done: Promise<void> } | undefined;
  /**
   * The immutable audited deployment on every provider, built for the configured
   * id. Upgrade authority None means the bytes can never change or close, so a
   * success is reused for SOLANA_DEPLOYMENT_RECHECK_MS, keyed by the provider
   * pair, program id and hash: any configuration change checks again. A failure
   * is never remembered; the next call checks again.
   */
  async function verifyDeployment(cfg: { programId: string; hash: string }): Promise<void> {
    const live = rpc(), key = JSON.stringify([live.providerKey ?? null, cfg.programId, cfg.hash, localTest]), at = now();
    if (verified?.key === key && at >= verified.atMs && at - verified.atMs < SOLANA_DEPLOYMENT_RECHECK_MS) return;
    verified = undefined; // Expired, or the configuration changed: only a fresh success counts.
    if (verifying?.key === key) return verifying.done;
    const done = (async () => {
      // The audited binary must be built for the configured id: declare_id! embeds its
      // 32 bytes, and a build for any other id (the local test id, say) fails every
      // instruction, which an immutable deployment can never fix. The executor
      // refuses such a binary too; here the owner hears why before any setup.
      const { declaresProgramId } = await verifySolanaVaultDeployment(live, cfg.programId, cfg.hash);
      if (!localTest && !declaresProgramId) fail("The configured Solana vault binary is built for a different program id. Deploy the build whose declare_id is the configured program.", "configuration");
      verified = { key, atMs: at };
    })();
    verifying = { key, done };
    try { await done; } finally { if (verifying?.done === done) verifying = undefined; }
  }
  function dek() { return seed(env.MERRYMEN_STORE_DEK, "Configure a 32-byte encryption key before registering live trading."); }
  async function payer() {
    return createKeyPairFromPrivateKeyBytes(seed(env.MERRYMEN_SOLANA_FEE_PAYER_SEED, "Configure the separate Solana network fee payer before live trading."));
  }
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  /**
   * MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS, or a configuration refusal that
   * also says an [alert] to the operator, at most once a minute per process: an
   * unreadable tolerance refuses every live trade, exits included, as a bad
   * Pyth generation does (which requireSolanaPythGeneration alerts on). The
   * line names the setting and its range, never the value.
   */
  let toleranceAlertAtMs: number | undefined;
  function referenceToleranceBps(): number {
    try { return solanaReferenceToleranceBps(env); } catch {
      const at = now();
      if (toleranceAlertAtMs === undefined || at < toleranceAlertAtMs || at - toleranceAlertAtMs >= SOLANA_REFERENCE_ALERT_REPEAT_MS) {
        toleranceAlertAtMs = at;
        try {
          log(`[alert] solana-reference-tolerance misconfigured: MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS must be a whole number from ${SOLANA_REFERENCE_MIN_TOLERANCE_BPS} `
            + `to ${SOLANA_REFERENCE_MAX_TOLERANCE_BPS} (unset is ${SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS}); no live Solana trade, exits included, is admitted until it is fixed`);
        } catch { /* Logging never changes an outcome. */ }
      }
      return fail("The independent SOL price tolerance is misconfigured.", "configuration");
    }
  }
  /**
   * Why admission (recordSigned) would refuse every live trade, exits included,
   * for the account's daily operations, by its own rolling 24-hour arithmetic:
   * operations that landed, failed or are pending reached maxOpsPerDay, or with
   * the proven-expired attempts beyond the allowance they did. Null when neither.
   * An unreadable allowance is already a configuration blocker, so it adds nothing.
   */
  async function dailyOperationsUsed(s: SolanaTradingStore, maxOpsPerDay: number): Promise<string | null> {
    let allowance: number;
    try { allowance = solanaExpiredAttemptAllowance(env); } catch { return null; }
    const use = await solanaExpiredAttemptUse(s.db, s.scope, now(), allowance);
    if (use.operations >= maxOpsPerDay) return SOLANA_STATUS_DAILY_OPERATIONS_USED;
    return use.operations + use.counted >= maxOpsPerDay ? SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED : null;
  }
  /**
   * Whether MERRYMEN_JUPITER_API_KEY is one every Jupiter request accepts
   * (solanaJupiterApiKey). A key that is set but unusable also says an [alert]
   * to the operator, at most once a minute per process: every quote and live
   * route, exits included, is refused as configuration until it is fixed. The line names the
   * setting and its rule, never the value. An unset or empty key is not configured yet.
   */
  let jupiterKeyAlertAtMs: number | undefined;
  function jupiterKeyUsable(): boolean {
    try { solanaJupiterApiKey(env); return true; } catch {
      const at = now();
      if (env.MERRYMEN_JUPITER_API_KEY && (jupiterKeyAlertAtMs === undefined || at < jupiterKeyAlertAtMs || at - jupiterKeyAlertAtMs >= SOLANA_REFERENCE_ALERT_REPEAT_MS)) {
        jupiterKeyAlertAtMs = at;
        try {
          log("[alert] solana-jupiter-key misconfigured: MERRYMEN_JUPITER_API_KEY must be 1 to 1024 printable ASCII characters with no spaces; "
            + "no Solana quote or live route, exits included, is made until it is fixed");
        } catch { /* Logging never changes an outcome. */ }
      }
      return false;
    }
  }
  // Rent-exempt minimums by account size. They change only by feature activation; reread every window.
  const rents = new Map<number, { lamports: bigint; atMs: number }>();
  async function rentFor(read: SolanaLiveRead, size: number): Promise<bigint> {
    const at = now(), hit = rents.get(size);
    if (hit && at >= hit.atMs && at - hit.atMs < SOLANA_DEPLOYMENT_RECHECK_MS) return hit.lamports;
    const value = await read("getMinimumBalanceForRentExemption", [size, { commitment: "confirmed" }]);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("Invalid Solana rent data.");
    rents.set(size, { lamports: BigInt(value), atMs: at });
    return BigInt(value);
  }
  /**
   * The shared fee payer's warning level. Below the low watermark it is only a
   * warning; below what one buy needs, buying pauses; below what one exit needs,
   * every tenant's exits stop. The executor itself refuses anything the payer
   * cannot fund, so these levels never block a trade it would sign.
   */
  const DEFAULT_MAX_FEE_LAMPORTS = 5_000_000n;
  /**
   * The network fee and rent cap per live trade, in lamports
   * (MERRYMEN_SOLANA_MAX_FEE_LAMPORTS, default 5,000,000). An unreadable value
   * is configuration: a status blocker, and a refusal before anything is signed.
   */
  function maxFeeLamports(): bigint {
    try { return parseSolanaRawAmount(env.MERRYMEN_SOLANA_MAX_FEE_LAMPORTS ?? DEFAULT_MAX_FEE_LAMPORTS.toString()); }
    catch { return fail("The Solana network fee limit setting is misconfigured: it must be a whole number of lamports above zero. Live trading and exits stay refused until an operator fixes it.", "configuration"); }
  }
  /**
   * Where the shared fee payer is called low: MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS,
   * by default four times the fee cap. A warning level only, so a value that
   * cannot be read refuses nothing (it once halted every tenant's automated
   * exits): it falls back to four times the fee cap (the default cap when that
   * cannot be read either, which is its own blocker), `misconfigured` says so,
   * and an [alert] names the setting, never the value, at most once per
   * FEE_PAYER_ALERT_REPEAT_MS per process. `shown`: the threshold status shows,
   * null while it rests on a setting that cannot be read.
   */
  let thresholdAlertAtMs: number | undefined;
  function feePayerLow(): { lamports: bigint; shown: bigint | null; misconfigured: boolean } {
    let maxFee: bigint | null = null;
    try { maxFee = maxFeeLamports(); } catch { /* Its own blocker; the default cap sizes the warning level. */ }
    const fallback = (maxFee ?? DEFAULT_MAX_FEE_LAMPORTS) * 4n, raw = env.MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS;
    if (raw === undefined) return { lamports: fallback, shown: maxFee === null ? null : fallback, misconfigured: false };
    try { const lamports = parseSolanaRawAmount(raw); return { lamports, shown: lamports, misconfigured: false }; } catch {
      const at = now();
      if (thresholdAlertAtMs === undefined || at < thresholdAlertAtMs || at - thresholdAlertAtMs >= FEE_PAYER_ALERT_REPEAT_MS) {
        thresholdAlertAtMs = at;
        try {
          log("[alert] solana fee-payer-threshold misconfigured: MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS must be a whole number of lamports above zero (unset is four times "
            + "the fee cap); until it is fixed the fee payer is called low below four times the fee cap. Trading and exits continue");
        } catch { /* Logging never changes an outcome. */ }
      }
      return { lamports: fallback, shown: null, misconfigured: true };
    }
  }
  type FeePayerLevel = "ok" | "low" | "buys-blocked" | "exits-blocked";
  /** What one swap needs from the shared fee payer, against what it holds. */
  type FeePayerState = { lamports: bigint; exitMinimum: bigint; buyMinimum: bigint };
  function feePayerLevel(state: FeePayerState, alertBelow: bigint): FeePayerLevel {
    return state.lamports < state.exitMinimum ? "exits-blocked" : state.lamports < state.buyMinimum ? "buys-blocked" : state.lamports < alertBelow ? "low" : "ok";
  }
  /**
   * The shared fee payer's balance and what one swap needs: both signatures and
   * the rent of the temporary input account it opens (and closes, refunding the
   * payer); a buy's is a USDG account, sized from `cashAccount` (a vault's
   * own) or, before any exists, the upper bound. It pays a priority fee only
   * from what it holds beyond that, at no less than
   * MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS (default 0).
   */
  async function feePayerState(read: SolanaLiveRead, payerAccount: ChainAccount, cashAccount: ChainAccount): Promise<FeePayerState> {
    if (payerAccount && (payerAccount.owner !== SOLANA_SYSTEM_PROGRAM || payerAccount.executable || payerAccount.data.length))
      fail("The separate network fee payer must be a plain system account.", "configuration");
    return { lamports: payerAccount?.lamports ?? 0n, exitMinimum: await rentFor(read, CLASSIC_TOKEN_ACCOUNT_SIZE) + SWAP_SIGNATURE_FEES,
      buyMinimum: await rentFor(read, cashAccount ? cashAccount.data.length : TOKEN_2022_ACCOUNT_SIZE_BOUND) + SWAP_SIGNATURE_FEES };
  }
  let feePayerAlert: { level: FeePayerLevel; atMs: number } | undefined;
  /** One structured line per change of level, repeated every FEE_PAYER_ALERT_REPEAT_MS while it is not ok. */
  function reportFeePayer(level: FeePayerLevel, details: Record<string, string | null>) {
    const at = now(), last = feePayerAlert;
    if (level === "ok") {
      if (last && last.level !== "ok") log(JSON.stringify({ solana: "fee-payer-ok", ...details }));
      feePayerAlert = { level, atMs: at }; return;
    }
    if (last && last.level === level && at >= last.atMs && at - last.atMs < FEE_PAYER_ALERT_REPEAT_MS) return;
    feePayerAlert = { level, atMs: at };
    const what = level === "low" ? "is low" : level === "buys-blocked" ? "cannot fund buys" : "cannot fund exits: every tenant's exits are blocked";
    log(`[alert] Solana fee payer ${what}: ${JSON.stringify({ solana: "alert", kind: `fee-payer-${level}`, ...details })}`);
  }
  function paperService(s: SolanaTradingStore) { return createSolanaPaperService(s.paper(), market(), now, { owner: s.scope.owner }); }
  function intent(raw: unknown, mode: "paper" | "live"): SolanaSwapIntent {
    if (!object(raw) || raw.mode !== mode || Object.hasOwn(raw, "owner") || Object.hasOwn(raw, "vault")) fail("Invalid Solana trade request.");
    return parseSolanaSwapIntent({ ...raw, mode: "paper" });
  }
  /** A trade's intent and, optionally, the owner's floor: the previewed quote's minOutAmount (parseSolanaTradeRequest). */
  function tradeRequest(raw: unknown, mode: "paper" | "live"): SolanaTradeRequest {
    if (!object(raw) || raw.mode !== mode || Object.hasOwn(raw, "owner") || Object.hasOwn(raw, "vault")) fail("Invalid Solana trade request.");
    return parseSolanaTradeRequest({ ...raw, mode: "paper" });
  }
  /** What the session may trade: the book once it exists; before that, chain cash and no SOL. */
  async function tradableIn(s: SolanaTradingStore, balances: { cashUsdg: string; wsolRaw: string } | null) {
    const book = await s.liveBook();
    if (book) return { cashUsdg: book.cashRaw, wsolRaw: book.wsolRaw, quarantinedWsolRaw: solanaQuarantinedWsol(book).toString() };
    return balances ? { cashUsdg: balances.cashUsdg, wsolRaw: "0", quarantinedWsolRaw: balances.wsolRaw } : null;
  }
  async function reconcile(s: SolanaTradingStore) {
    for (const pending of await s.pending()) {
      await reconcileSolanaSubmission(rpc(), s, s.scope.owner, pending.submission.intent.requestId, now);
    }
  }
  type OwnerView =
    | { outcome: "pending"; seen: boolean; canLand: boolean }
    | { outcome: "finalized" | "failed"; slot: number; err: string }
    | { outcome: "expired"; proof: SolanaOwnerExpiryProof };
  /** A successful owner transaction always leaves this mark on the vault. Without it the receipt is not believed. */
  async function requireOwnerEffect(read: SolanaLiveRead, s: SolanaTradingStore, setup: SolanaPreparedSetup, slot: number) {
    const mismatch = (): never => fail("Owner confirmation does not match the vault state.");
    const found = await read("getAccountInfo", [setup.vault, { encoding: "base64", commitment: "finalized", minContextSlot: slot }]);
    if (!object(found) || !object(found.context) || integer(found.context.slot) < slot || !object(found.value) || found.value.owner !== setup.programId
      || found.value.executable !== false || !Array.isArray(found.value.data) || found.value.data[1] !== "base64" || typeof found.value.data[0] !== "string") return mismatch();
    const current = decodeSolanaVaultAccount(encoded(found.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE));
    if (current.owner !== s.scope.owner) return mismatch();
    const kind = setup.kind ?? "session";
    // A session or revoke always moves the epoch; either withdrawal always moves the sequence.
    if ((kind === "session" || kind === "revoke") && (setup.priorSessionEpoch === undefined || current.sessionEpoch <= BigInt(setup.priorSessionEpoch))) mismatch();
    if ((kind === "withdraw" || kind === "withdraw-sol") && (setup.priorSequence === undefined || current.seq <= BigInt(setup.priorSequence))) mismatch();
  }
  /**
   * No receipt: proven never run only when this provider's finalized bank is past
   * lastValidBlockHeight and the vault read at or after that bank's slot still
   * shows the prior state. The slot and height come from ONE bank (getEpochInfo):
   * separate getBlockHeight and getSlot calls can reach different nodes behind
   * one URL and pair a current height with a stale slot, whose vault snapshot
   * predates a transaction that did run.
   */
  async function ownerExpiry(read: SolanaLiveRead, s: SolanaTradingStore, setup: SolanaPreparedSetup, seen: boolean): Promise<OwnerView> {
    const info = await read("getEpochInfo", [{ commitment: "finalized" }]);
    if (!object(info)) fail("Invalid owner expiry evidence.");
    const proofSlot = integer(info.absoluteSlot), blockHeight = integer(info.blockHeight);
    if (BigInt(blockHeight) <= BigInt(setup.lastValidBlockHeight)) return { outcome: "pending", seen, canLand: true };
    const pending: OwnerView = { outcome: "pending", seen, canLand: false };
    if (setup.priorVaultExisted === undefined || setup.priorSequence === undefined || setup.priorSessionEpoch === undefined) return pending;
    if (proofSlot < 1) fail("Invalid owner expiry evidence.");
    const snapshot = await read("getAccountInfo", [setup.vault, { encoding: "base64", commitment: "finalized", minContextSlot: proofSlot }]);
    if (!object(snapshot) || !object(snapshot.context) || integer(snapshot.context.slot) < proofSlot || !Object.hasOwn(snapshot, "value")) fail("Invalid owner expiry evidence.");
    let sequence: string | null = null, epoch: string | null = null;
    if (snapshot.value !== null) {
      if (!object(snapshot.value) || snapshot.value.owner !== setup.programId || snapshot.value.executable !== false || !Array.isArray(snapshot.value.data)
        || snapshot.value.data[1] !== "base64" || typeof snapshot.value.data[0] !== "string") return pending;
      const current = decodeSolanaVaultAccount(encoded(snapshot.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE));
      if (current.owner !== s.scope.owner) return pending;
      sequence = current.seq.toString(); epoch = current.sessionEpoch.toString();
    } else if (setup.priorVaultExisted) return pending;
    // Only state this kind of transaction must have changed proves it never ran.
    // Trades advance the sequence independently, so a revoke or session is
    // proven by its epoch alone, never wedged by a trade that landed meanwhile.
    if (!solanaOwnerExpiryProven(setup, sequence, epoch)) return pending;
    return { outcome: "expired", proof: { reason: "blockhash-expired", blockHeight: String(blockHeight), vaultSequence: sequence, sessionEpoch: epoch, slot: integer(snapshot.context.slot) } };
  }
  /** One provider's view of a submitted owner transaction. */
  async function observeOwner(read: SolanaLiveRead, s: SolanaTradingStore, setup: SolanaPreparedSetup, signature: string): Promise<OwnerView> {
    const statuses = await read("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    if (!object(statuses) || !Array.isArray(statuses.value) || statuses.value.length !== 1) fail("Invalid owner transaction confirmation.");
    const state = statuses.value[0];
    if (state !== null && !object(state)) fail("Invalid owner transaction confirmation.");
    const tx = await read("getTransaction", [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
    if (!object(state) || state.confirmationStatus !== "finalized") return tx !== null ? { outcome: "pending", seen: true, canLand: false } : ownerExpiry(read, s, setup, state !== null);
    if (tx === null) return { outcome: "pending", seen: true, canLand: false };
    if (!object(tx) || tx.version !== 0 || !object(tx.meta) || !Object.hasOwn(tx.meta, "err") || !Object.hasOwn(state, "err")
      || !isSolanaTransactionError(tx.meta.err) || !isSolanaTransactionError(state.err)
      || JSON.stringify(tx.meta.err) !== JSON.stringify(state.err)
      || !Array.isArray(tx.transaction) || tx.transaction[1] !== "base64" || typeof tx.transaction[0] !== "string"
      || tx.transaction[0] !== setup.signedTransactionBase64 || integer(tx.slot) !== integer(state.slot)) fail("Owner confirmation does not match the saved transaction.");
    // A failed receipt is terminal too; neither path may mint a new signature.
    if ((tx.meta.err === null) !== (state.err === null)) fail("Owner transaction confirmations disagree.");
    const slot = integer(tx.slot);
    if (tx.meta.err === null) await requireOwnerEffect(read, s, setup, slot);
    return { outcome: tx.meta.err === null ? "finalized" : "failed", slot, err: JSON.stringify(tx.meta.err) };
  }
  /** What both providers must agree on. Each provider's own expiry height and slot may differ. */
  function ownerViewKey(view: OwnerView): string {
    return view.outcome === "pending" ? "pending" : view.outcome === "expired" ? "expired" : JSON.stringify([view.outcome, view.slot, view.err]);
  }
  /**
   * Finishes an owner transaction (revoke, withdrawal, session, resume-buys) only
   * when both independent providers derive the same outcome (readSolanaQuorum):
   * a provider that withholds the bytes and reports them finalized, or forges an
   * expiry, leaves it pending. While neither provider has seen it and its
   * blockhash can still land, the saved bytes are sent again: never re-signed,
   * so they still land at most once.
   */
  async function ownerStatus(s: SolanaTradingStore, setup: SolanaPreparedSetup): Promise<{ signature: string; status: "pending" | "finalized" | "failed" }> {
    if (!setup.signature || !setup.signedTransactionBase64) fail("The owner transaction has not been submitted.");
    const signature = setup.signature, signed = setup.signedTransactionBase64;
    if (setup.status === "finalized" || setup.status === "failed") return { signature, status: setup.status };
    const live = rpc();
    // These bytes are saved and were broadcast: an answer about them that cannot
    // be used, or an outcome the book cannot record yet, leaves the outcome
    // unknown. It is "outcome-unknown" (retry), never "invalid": nothing was refused.
    const unknown: (error: unknown) => never = error => {
      if ((error instanceof SolanaAppRuntimeError && error.code === "invalid") || error instanceof SolanaTradingStoreError) throw new SolanaAppRuntimeError("outcome-unknown", error.message);
      throw error;
    };
    const quorum = await readSolanaQuorum(live, read => observeOwner(read, s, setup, signature), ownerViewKey).catch(unknown);
    if (quorum.agreed && quorum.value.outcome !== "pending") {
      const view = quorum.value;
      if (view.outcome === "expired") { await s.finishSetup(signature, "failed", view.proof.slot, view.proof).catch(unknown); return { signature, status: "failed" }; }
      await s.finishSetup(signature, view.outcome, view.slot).catch(unknown);
      return { signature, status: view.outcome };
    }
    if (quorum.values.every(view => view.outcome === "pending" && !view.seen && view.canLand)) {
      try { await live.send(signed, 1, undefined, { untilMs: 0 }); } catch { /* Still pending; the next read tries again. */ }
    }
    return { signature, status: "pending" };
  }
  /** An account an owner transaction creates if it is missing, paid by the owner. "usdg": a USDG (Token-2022) token account. */
  type OwnerCreate = { address: string; size: number | "usdg" };
  /**
   * What the owner wallet must hold to send an owner transaction (it is the fee
   * payer): `base` is the signature fee plus the wallet's own rent-exempt
   * minimum, since a fee payer may not be left with a non-zero balance below
   * it; `rents[i]` is the rent of creates[i] if it does not exist yet, else 0.
   * A USDG account's size is read from an existing one (they share the mint's
   * extensions), with an upper bound before any exists.
   */
  async function ownerCost(read: SolanaLiveRead, owner: string, vault: string, creates: readonly OwnerCreate[]) {
    const usdg = [await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM)];
    const accounts = await readAccounts(read, [owner, ...usdg, ...creates.map(item => item.address)]);
    const usdgSize = accounts[1]?.data.length ?? accounts[2]?.data.length ?? TOKEN_2022_ACCOUNT_SIZE_BOUND;
    const base = LAMPORTS_PER_SIGNATURE + await rentFor(read, 0), rents: bigint[] = [];
    for (const [index, item] of creates.entries()) rents.push(accounts[3 + index] === null ? await rentFor(read, item.size === "usdg" ? usdgSize : item.size) : 0n);
    return { held: payable(accounts[0]!), base, rents };
  }
  /**
   * A bounded priority fee for an owner transaction, so a revoke or withdrawal
   * still lands under congestion: the compute units its simulation used (plus
   * headroom, and never below the runtime default: solanaOwnerComputeUnitLimit),
   * priced at recent fees on the accounts it writes, never above
   * SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS in total nor above what the owner
   * holds beyond the transaction's own needs (`spare`). Best effort: when the
   * simulation or the fee estimate cannot be read, the owner has nothing to
   * spare, or the reads take longer than ownerFeeReadMs, the transaction goes
   * without one, exactly as before. Never a refusal.
   *
   * These reads run in their own read session, after the blockhash and cost
   * session, and under their own short deadline: inside that session a slow
   * simulation would hit its hard deadline (withSolanaReadDeadline) and fail
   * the owner's revoke or withdrawal itself.
   */
  async function ownerPriority(live: SolanaLiveRpc, compile: (instructions: Instruction[]) => ReturnType<typeof compileTransaction>,
    owner: string, instructions: Instruction[], spare: bigint): Promise<{ units: number; price: bigint; fee: bigint } | null> {
    const fundable = spare < SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS ? spare : SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS;
    if (fundable < 1n) return null;
    let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
    const estimate = (async () => live.read(async read => {
      // Once the deadline passed nothing more is asked (a failover session included).
      const bounded: SolanaLiveRead = (method, params) => { if (abandoned) throw new Error("abandoned"); return read(method, params); };
      const probe = getBase64EncodedWireTransaction(compile([...solanaComputeBudgetInstructions(MAX_COMPUTE_UNITS, 0n), ...instructions]));
      if (Buffer.from(probe, "base64").length > 1232) return null;
      const sim = await bounded("simulateTransaction", [probe, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false }]);
      if (!object(sim) || !object(sim.value) || sim.value.err !== null) return null;
      const consumed = sim.value.unitsConsumed;
      if (typeof consumed !== "number" || !Number.isSafeInteger(consumed) || consumed < 1 || consumed > MAX_COMPUTE_UNITS) return null;
      // `instructions` never holds a ComputeBudget instruction: those are added here.
      const units = solanaOwnerComputeUnitLimit(consumed, instructions.length);
      const writable = [...new Set([owner, ...instructions.flatMap(ix => (ix.accounts ?? []).filter(meta => (meta.role & 1) === 1).map(meta => String(meta.address)))])];
      const price = await readSolanaPriorityFee(bounded, writable, { minimum: 0n, maximum: fundable * 1_000_000n / BigInt(units) });
      if (price < 1n) return null;
      return { units, price, fee: (price * BigInt(units) + 999_999n) / 1_000_000n };
    }))();
    estimate.catch(() => undefined);
    try {
      return await Promise.race([estimate, new Promise<null>(resolve => { timer = setTimeout(resolve, ownerFeeReadMs, null); })]);
    } catch { return null; }
    finally { abandoned = true; clearTimeout(timer); }
  }
  async function prepareOwner(s: SolanaTradingStore, instructions: Instruction[], details: Omit<SolanaPreparedSetup,
    "transactionBase64" | "messageBase64" | "blockhash" | "lastValidBlockHeight" | "preparedAtMs" | "expiresAtMs">, creates: readonly OwnerCreate[] = []) {
    const previous = await s.setup();
    // One owner transaction at a time, a revocation included (owner decision, 2026-10-20): the
    // saved record is what its outcome is booked from, so it is never replaced while it may
    // still land. A revoke waits for it to finalize or provably expire. When the record stays
    // pending (providers disagree, its reads fail), the page says the server cannot settle it
    // and, where it shows the recovery card, points to `merrymen solana-recover`, which revokes
    // with the owner's own key (SolanaOwnerActions). Trading is held meanwhile (status blocker).
    // The alternative, a second slot or a setup history so a revoke can be prepared beside
    // it, is not built.
    if (previous?.signature && previous.status !== "failed" && previous.status !== "finalized") fail("Refresh the pending owner transaction before preparing another.", "pending");
    const owner = s.scope.owner, live = rpc();
    const { block, cost } = await live.read(async read => {
      const result = await read("getLatestBlockhash", [{ commitment: "confirmed" }]);
      if (!object(result) || !object(result.value) || typeof result.value.blockhash !== "string") fail("Invalid Solana blockhash response.");
      return { block: { blockhash: address(result.value.blockhash) as unknown as Blockhash, lastValidBlockHeight: BigInt(integer(result.value.lastValidBlockHeight)) },
        cost: await ownerCost(read, owner, details.vault, creates) };
    });
    const compile = (list: Instruction[]) => compileTransaction(setTransactionMessageLifetimeUsingBlockhash(block,
      setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(list, createTransactionMessage({ version: 0 })))));
    const required = cost.rents.reduce((sum, item) => sum + item, cost.base);
    // The owner pays: refuse before anything is saved or signed rather than let
    // a transaction that cannot pay its fee sit pending until its blockhash expires.
    // The priority fee never causes a refusal: it fits in what the owner can spare.
    if (cost.held < required) fail(`Your owner wallet holds ${sol(cost.held)} SOL. This transaction needs at least ${sol(required)} SOL: its network fee${cost.rents.some(item => item > 0n) ? ", rent for the token accounts it opens" : ""} and the wallet's own minimum balance. Send SOL to your owner wallet, then prepare it again.`);
    let priority = cost.held > required ? await ownerPriority(live, compile, owner, instructions, cost.held - required) : null;
    let tx = compile(priority ? [...solanaComputeBudgetInstructions(priority.units, priority.price), ...instructions] : instructions);
    if (priority && Buffer.from(getBase64EncodedWireTransaction(tx), "base64").length > 1232) { tx = compile(instructions); priority = null; }
    const transactionBase64 = getBase64EncodedWireTransaction(tx); encoded(transactionBase64);
    const preparedAtMs = now();
    const setup: SolanaPreparedSetup = { ...details, transactionBase64, messageBase64: Buffer.from(tx.messageBytes).toString("base64"),
      blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight.toString(), preparedAtMs, expiresAtMs: preparedAtMs + 60_000 };
    await s.saveSetup(setup);
    return { transactionBase64, blockhash: setup.blockhash, lastValidBlockHeight: setup.lastValidBlockHeight,
      programId: setup.programId, vault: setup.vault, session: setup.session, expiresAtMs: setup.expiresAtMs,
      ownerLamports: cost.held.toString(), requiredLamports: (required + (priority?.fee ?? 0n)).toString(),
      priorityFeeLamports: (priority?.fee ?? 0n).toString(), computeUnitLimit: priority?.units ?? null };
  }
  /**
   * The Pyth SOL/USD price as EVERY provider serves it, each read at or after
   * its own fresh confirmed slot. A refusal from either provider refuses the
   * whole read: a lying or broken provider can withhold a price, never choose
   * it. Callers take the stricter or the lower of the answers, whichever is
   * conservative for them. (A trade reads it beside its balances, at the
   * prepared slot: assessRisk.)
   */
  async function referencePrices(live: SolanaLiveRpc, generation: SolanaPythGeneration): Promise<SolanaReferencePrice[]> {
    return readSolanaEachProvider(live, async read =>
      readSolanaReferencePrice(read, integer(await read("getSlot", [{ commitment: "confirmed" }])), now(), { generation }));
  }
  /**
   * What withdrawing `amountRaw` of WSOL is worth now: an executable WSOL→USDG
   * exit quote (the slippage the agent marks and exits with) and the independent
   * Pyth bound for the same amount, read at a fresh slot from every provider
   * (the lowest of their bounds is kept). The store keeps the lower of quote and
   * bound, so no one source can lower the high-water mark by more than the SOL
   * was worth. Anything unreadable or invalid returns undefined: the withdrawal
   * still prepares and the high-water mark stays put, the conservative
   * direction. Never a reason to block the owner.
   */
  async function wsolWithdrawValuation(amountRaw: string): Promise<SolanaWithdrawValuation | undefined> {
    try {
      const exit = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "withdraw-valuation",
        inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: WITHDRAW_VALUATION_SLIPPAGE_BPS });
      const toleranceBps = referenceToleranceBps(), generation = requireSolanaPythGeneration(env, now());
      const quote = await market().quote(exit); validateSolanaQuote(quote, exit, now());
      const prices = await referencePrices(rpc(), generation);
      return { quote, reference: solanaLowestReferenceBound(prices.map(price => solanaReferenceBound(exit, price, toleranceBps))) };
    } catch { return undefined; }
  }
  async function submitOwner(scope: SolanaAccountScope, input: { signedTransactionBase64: string }, kind: "session" | "owner") {
    const s = await store(scope), setup = await s.setup();
    // Until saveSetup succeeds this request records and sends nothing: every refusal
    // is "not-saved". Bytes an earlier request saved and sent, whose setup a later
    // prepare replaced, are refused this way too (see SolanaAppRuntimeError).
    const notSaved: (message: string) => never = message => fail(message, "not-saved");
    if (!setup || (kind === "session" ? (setup.kind ?? "session") !== "session" : setup.kind === "session" || !setup.kind)) notSaved("Prepare this owner transaction before signing it.");
    let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
    try { transaction = getTransactionDecoder().decode(encoded(input.signedTransactionBase64)); } catch { return notSaved("Invalid encoded Solana transaction."); }
    const signatureBytes = transaction.signatures[address(scope.owner)];
    if (Object.keys(transaction.signatures).length !== 1 || !signatureBytes ||
      Buffer.from(transaction.messageBytes).toString("base64") !== setup.messageBase64 ||
      !ed25519.verify(new Uint8Array(signatureBytes), new Uint8Array(transaction.messageBytes), base58Decode(scope.owner)!, { zip215: false })) notSaved("The owner signature or reviewed transaction does not match.");
    const signature = getBase58Decoder().decode(signatureBytes);
    if (setup.signature) {
      if (setup.signature !== signature || setup.signedTransactionBase64 !== input.signedTransactionBase64) notSaved("Another owner transaction is already saved.");
      return ownerStatus(s, setup);
    }
    const signed: SolanaPreparedSetup = { ...setup, signature, signedTransactionBase64: input.signedTransactionBase64, status: "pending" };
    // The store refuses (expired, changed settings, a pending trade) before it writes anything.
    // Its limit check (validateSolanaAccountLimits) refuses the same way, before the
    // write: saved limits that expired inside the prepare window, say. A database
    // error is neither: the write may have committed, so it is never "not-saved".
    const first = await s.saveSetup(signed).catch((error: unknown) => error instanceof SolanaTradingStoreError ? notSaved(error.message)
      : error instanceof SolanaPaperValidationError ? notSaved(LIMITS_NO_LONGER_VALID) : Promise.reject(error));
    if (first) { try { await rpc().send(input.signedTransactionBase64, 1); } catch { /* Durable pending; retry only reconciles. */ } }
    return { signature, status: "pending" as const };
  }
  return {
    /**
     * The shared fee payer's level for the worker's periodic check (the agent's,
     * every SOLANA_AGENT_FEE_PAYER_CHECK_MS), read and judged as status reads and
     * judges it and said through the same [alert]s (one line per change of level,
     * repeated every ten minutes while it is not ok): a payer that cannot fund
     * exits pages the operator even while no status is read. `vault`: a
     * registered vault whose USDG account sizes a buy, as status sizes it (every
     * vault's is the same size); without one, the upper bound. Throws while live
     * trading is not configured: there is nothing to check.
     */
    async feePayerCheck(input: { vault?: string } = {}): Promise<FeePayerLevel> {
      config();
      const feePayer = await getAddressFromPublicKey((await payer()).publicKey);
      const vaultCash = input.vault === undefined ? null : await deriveSolanaAta(address(input.vault), SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
      const low = feePayerLow();
      const state = await rpc().read(async read => {
        const [payerAccount, cashAccount] = await readAccounts(read, vaultCash === null ? [feePayer] : [feePayer, vaultCash]);
        return feePayerState(read, payerAccount ?? null, cashAccount ?? null);
      });
      const level = feePayerLevel(state, low.lamports);
      reportFeePayer(level, { feePayer, lamports: state.lamports.toString(), exitMinimumLamports: state.exitMinimum.toString(),
        buyMinimumLamports: state.buyMinimum.toString(), lowLamports: low.shown === null ? null : low.shown.toString(), level });
      return level;
    },
    /**
     * The account's paper and live state. Chain reads happen only for a live
     * binding or an account that already has live state (a session, a live book,
     * an owner transaction or a pending trade); a paper-only account costs no RPC.
     * `liveReads: false` skips them (the worker's paper strategies); a live
     * binding read that way is never shown as ready.
     */
    async status(scope: SolanaAccountScope, statusOptions: { liveReads?: boolean } = {}) {
      const s = await store(scope), binding = await s.binding(), blockers: string[] = [], warnings: string[] = [];
      // Blockers that stop buying but leave exits open.
      const exitSafe = new Set<string>();
      const buysOnly = (message: string) => { blockers.push(message); exitSafe.add(message); };
      const liveReads = statusOptions.liveReads ?? (binding.requestedMode === "live" || !!(await s.session()) || !!(await s.liveBook())
        || !!(await s.setup()) || (await s.pending()).length > 0);
      if (liveReads) {
        try { await reconcile(s); } catch { blockers.push("Pending trade confirmation is unavailable; its reservation remains held."); }
        const setup = await s.setup();
        if (setup?.signature && setup.status !== "finalized" && setup.status !== "failed") {
          try { await ownerStatus(s, setup); } catch { blockers.push("Owner transaction confirmation is unavailable."); }
        }
      }
      const session = await s.session();
      let programId: string | null = null, vault: string | null = null, cashTokenAccount: string | null = null;
      let balances: { slot: number; cashUsdg: string; wsolRaw: string } | null = null;
      let feePayerView: { lamports: string; exitMinimumLamports: string; buyMinimumLamports: string; lowLamports: string | null; level: FeePayerLevel } | null = null;
      let ownerWallet: { lamports: string; revokeLamports: string; withdrawLamports: string } | null = null;
      let recoverable: { nativeLamports: string; unsyncedWsolLamports: string } | null = null;
      try {
        // A program the release pin refuses is still shown with the owner's vault on it (the recovery
        // card's read-only plan needs its id); config() then refuses it as configuration, before any RPC.
        programId = configured().programId; vault = await deriveSolanaVaultAddress(programId, scope.owner);
        const cfg = config();
        // Misconfigured swap prices refuse trading and exits (a full blocker), but the
        // vault, fee payer, owner wallet and recoverable SOL are still read and shown.
        try { computeUnitPrices(); } catch (error) { blockers.push(statusBlocker(error)); }
        try { expiredAttemptAllowance(); } catch (error) { blockers.push(statusBlocker(error)); }
        // So is an unreadable fee cap, which trade() refuses: a blocker, while the fee payer is still read and shown.
        // The warning threshold refuses nothing: one that cannot be read is a warning and an [alert], and the fee
        // payer is called low below four times the fee cap meanwhile (feePayerLow).
        try { maxFeeLamports(); } catch (error) { blockers.push(statusBlocker(error)); }
        const low = feePayerLow(), alertBelow = low.lamports;
        if (low.misconfigured) warnings.push(SOLANA_STATUS_FEE_PAYER_THRESHOLD_MISCONFIGURED);
        if (!liveReads) { if (binding.requestedMode === "live") blockers.push("Live vault state was not read."); }
        else {
          dek(); const feePayer = await getAddressFromPublicKey((await payer()).publicKey);
          if ([scope.owner, vault, session?.session].includes(feePayer)) fail("The network fee payer must be separate from the owner, vault and session.", "configuration");
          await verifyDeployment(cfg);
          const vaultCash = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
          const ownerCash = await deriveSolanaAta(scope.owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsol = await deriveSolanaAta(scope.owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
          const vaultWsol = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
          const payerState = await rpc().read(async read => {
            const [payerAccount, cashAccount, vaultAccount, wsolAccount] = await readAccounts(read, [feePayer, vaultCash, vault!, vaultWsol]);
            const native = vaultAccount && vaultAccount.owner === cfg.programId ? vaultAccount.lamports - await rentFor(read, vaultAccount.data.length) : 0n;
            // What the executor needs for one swap (feePayerState).
            return { ...await feePayerState(read, payerAccount ?? null, cashAccount ?? null),
              // What the owner needs to revoke (no account opened) or withdraw (may open its own token account).
              owner: await ownerCost(read, scope.owner, vault!, [{ address: ownerCash, size: "usdg" }, { address: ownerWsol, size: CLASSIC_TOKEN_ACCOUNT_SIZE }]),
              // Owner-recoverable SOL outside the book: withdraw-sol, and the SyncNative a WSOL withdrawal runs.
              recoverable: { nativeLamports: (native > 0n ? native : 0n).toString(), unsyncedWsolLamports: unsyncedWsolLamports(wsolAccount ?? null, vault!).toString() } };
          });
          recoverable = payerState.recoverable;
          const revokeNeeds = payerState.owner.base, withdrawNeeds = payerState.owner.rents.reduce((most, item) => item > most ? item : most, 0n) + payerState.owner.base;
          ownerWallet = { lamports: payerState.owner.held.toString(), revokeLamports: revokeNeeds.toString(), withdrawLamports: withdrawNeeds.toString() };
          if (payerState.owner.held < revokeNeeds) warnings.push(`Your owner wallet holds ${sol(payerState.owner.held)} SOL, too little to revoke or withdraw (at least ${sol(revokeNeeds)} SOL to revoke, up to ${sol(withdrawNeeds)} SOL to withdraw). Keep some SOL there so you can act in an emergency.`);
          else if (payerState.owner.held < withdrawNeeds) warnings.push(`Your owner wallet holds ${sol(payerState.owner.held)} SOL: enough to revoke, but a withdrawal may need up to ${sol(withdrawNeeds)} SOL to open your token account. Keep some SOL there so you can act in an emergency.`);
          const level = feePayerLevel(payerState, alertBelow);
          feePayerView = { lamports: payerState.lamports.toString(), exitMinimumLamports: payerState.exitMinimum.toString(),
            buyMinimumLamports: payerState.buyMinimum.toString(), lowLamports: low.shown === null ? null : low.shown.toString(), level };
          reportFeePayer(level, { feePayer, ...feePayerView });
          if (level === "exits-blocked") blockers.push(`The shared network fee payer holds ${sol(payerState.lamports)} SOL, below the ${sol(payerState.exitMinimum)} SOL one exit needs. Trading and automated exits are paused until an operator funds it.`);
          else if (level === "buys-blocked") buysOnly(`The shared network fee payer holds ${sol(payerState.lamports)} SOL: enough for exits, not for buys (${sol(payerState.buyMinimum)} SOL). Buying is paused until an operator funds it; exits remain available.`);
          else if (level === "low") warnings.push(`The shared network fee payer is low (${sol(payerState.lamports)} SOL; operators are alerted below ${sol(alertBelow)} SOL). Trading continues.`);
          const live = await readSolanaVaultState(rpc(), programId, scope.owner);
          balances = await readSolanaVaultBalances(rpc(), vault, live.slot);
          cashTokenAccount = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
          const book = await s.liveBook();
          // A USDG deposit or anyone's WSOL transfer is booked from finalized state:
          // capital-in for USDG, zero-basis quarantine for WSOL. Neither blocks exits.
          if (book && !shortOfBook(book, balances) && aboveBook(book, balances) && !(await s.pending()).length) {
            // Booked only from finalized balances every provider reports, at the lowest slot any answered at
            // (readSolanaVaultBalancesQuorum): one provider can neither invent a deposit nor persist an inflated
            // book slot. Unbooked excess is never traded or valued, so failing to read or book it now (the
            // providers disagree, an owner transaction is pending, say) must not block exits; it retries next read.
            try {
              const observedAtMs = now(), finalized = await readSolanaVaultBalancesQuorum(rpc(), vault, book.slot, "finalized");
              if (!shortOfBook(book, finalized) && aboveBook(book, finalized)) await s.reconcileExternalInflows({ ...finalized, observedAtMs, commitment: "finalized" });
            } catch { /* Retried on the next status read. */ }
          }
          if (!session || session.programId !== programId || session.vault !== vault || live.state.session !== session.session || live.state.sessionEpoch.toString() !== session.sessionEpoch) blockers.push("Register an owner-approved live trading permission.");
          else {
            const storedSeed = await s.sessionSeed(dek());
            if (!storedSeed || await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(seed(storedSeed, "The session cannot be opened."))).publicKey) !== session.session)
              fail("The saved trading permission cannot be opened.", "configuration");
          }
          const currentBook = await s.liveBook();
          if (currentBook?.buyPaused) buysOnly("The buying drawdown breaker is paused; exits remain available.");
          // Below the book only once nothing of the app's own is still settling: a trade or owner withdrawal that
          // landed leaves the vault short of its book until both providers' finalized receipts book it, and its own
          // blocker ("awaiting final confirmation", below) holds trading and exits meanwhile. Saying that tokens left
          // outside Merrymen then (and the agent's [alert]) would send an operator to reconcile a trade that is about
          // to book itself. Balances read from before the book's own slot (a lagging provider) show no shortfall either.
          const owned = await s.setup(), settling = (await s.pending()).length > 0 || (!!owned?.signature && owned.status !== "finalized" && owned.status !== "failed");
          if (currentBook && shortOfBook(currentBook, balances) && !settling) {
            blockers.push(balances.slot < currentBook.slot ? SOLANA_STATUS_BEHIND_BOOK : SOLANA_STATUS_BELOW_BOOK);
          }
          if (live.state.expiresAt * 1000n <= BigInt(now())) blockers.push("The on-chain trading permission has expired.");
          if (live.state.paused) buysOnly("The on-chain buying breaker is paused; exits remain available.");
          // A donation in the next swap's temporary input account goes back to the
          // owner's own token account for that mint during the swap; while that
          // account is closed or unsafe the executor refuses every swap from that
          // mint (owner-refund). USDG is the buy side, WSOL the sell and exit side.
          for (const block of await readSolanaOwnerRefundBlocks(rpc(), programId, vault, scope.owner, live.state.seq, live.slot)) {
            if (block.mint === SOLANA_USDG_MINT) buysOnly(refundBlocker(block)); else blockers.push(refundBlocker(block));
          }
        }
      } catch (error) { blockers.push(statusBlocker(error)); }
      // The builder's own key rule: a key every live route would refuse (blank, too long,
      // unprintable) blocks trades and exits as a missing one does, and pages the operator.
      if (!jupiterKeyUsable()) blockers.push("Configure Jupiter quote access.");
      if (await s.operatorHeld()) blockers.push(OPERATOR_HOLD);
      // trade() refuses every live trade, exits too, while either reference setting is invalid. The generation
      // check also says the [alert], so an agent held by this blocker still pages the operator.
      try { referenceToleranceBps(); } catch { blockers.push("The independent SOL price tolerance is misconfigured."); }
      try { requireSolanaPythGeneration(env, now()); } catch { blockers.push("The independent SOL price source (Pyth generation) is misconfigured."); }
      if (binding.requestedMode !== "live") blockers.push("Live mode is not selected.");
      if (!binding.limits || binding.limits.expiresAtMs <= now()) blockers.push("Save current Solana trading limits.");
      else if (binding.requestedMode === "live" && (binding.limits.perTradeWsol === undefined || binding.limits.dailyWsol === undefined)) blockers.push("Save per-trade and daily SOL sell limits for live trading.");
      if (binding.requestedMode === "live" && binding.limits && binding.limits.expiresAtMs > now()) {
        const used = await dailyOperationsUsed(s, binding.limits.maxOpsPerDay);
        if (used) blockers.push(used);
      }
      const pending = (await s.pending()).map(publicTrade);
      if (pending.length) blockers.push("A live trade is awaiting final confirmation.");
      const ownerTransaction = await s.setup();
      if (ownerTransaction?.signature && ownerTransaction.status === "pending") blockers.push("An owner transaction is awaiting final confirmation.");
      const heartbeat = await s.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number | string } | undefined;
      const lastSeenAtMs = heartbeat ? Number(heartbeat.last_seen_at_ms) : null;
      return { chain: CHAINS.solana, owner: scope.owner, requestedMode: binding.requestedMode,
        automation: { workerOnline: lastSeenAtMs !== null && lastSeenAtMs <= now() && now() - lastSeenAtMs < 90_000, lastSeenAtMs },
        paper: await s.paper().get(scope.owner), limits: binding.limits,
        live: { ready: blockers.length === 0, canExit: blockers.every(item => exitSafe.has(item)), blockers, warnings, feePayer: feePayerView, ownerWallet, recoverable, programId, vault, cashTokenAccount, session: session?.session ?? null,
          balances, tradable: await tradableIn(s, balances), book: await s.liveBook(), pending, history: (await s.history()).map(publicTrade),
          ownerTransaction: ownerTransaction?.signature ? { signature: ownerTransaction.signature, status: ownerTransaction.status, kind: ownerTransaction.kind } : null } };
    },
    async setupPaper(scope: SolanaAccountScope, input: { initialCashRaw: string; limits: SolanaPaperLimits }) {
      const s = await store(scope), binding = await s.binding();
      if (binding.requestedMode !== "paper" || !binding.limits || JSON.stringify(binding.limits) !== JSON.stringify(input.limits)) fail("Save paper mode and its limits before creating the book.", "permission");
      return s.createPaper(input.initialCashRaw, input.limits);
    },
    /**
     * The owner's write-off of one dust lot in the hosted paper book: the whole
     * lot is quoted back to USDG first, and only the market's zero-output answer
     * qualifies it (createSolanaPaperService.writeOff). The trading store then
     * applies it under the tenant book lock. Answers the book after it and the
     * write-off record. An owner not in paper mode is refused before the paid
     * quote; the store checks the mode again under the lock.
     */
    async writeOffPaper(scope: SolanaAccountScope, input: { mint: string }) {
      if (!object(input) || typeof input.mint !== "string" || canonicalId(CHAINS.solana, "token", input.mint) !== input.mint) fail("Invalid Solana token mint.");
      const s = await store(scope);
      if ((await s.binding()).requestedMode !== "paper") fail("Paper trading is not the selected Solana mode.", "permission");
      const { writtenOff, ...paper } = await paperService(s).writeOff(scope.owner, input.mint);
      return { paper, writtenOff };
    },
    async preview(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown }) {
      const s = await store(scope), parsed = intent(input.intent, input.mode);
      if (input.mode === "paper") return paperService(s).preview(scope.owner, parsed);
      const cfg = config(); parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: await deriveSolanaVaultAddress(cfg.programId, scope.owner) });
      const quote = await market().quote(parsed); validateSolanaQuote(quote, parsed, now());
      return { intent: { ...parsed, mode: "live" }, quote };
    },
    async trade(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown; autonomousRevision?: number; signal?: AbortSignal }) {
      const s = await store(scope, input.autonomousRevision, input.signal), { intent: parsed, minOutAmount } = tradeRequest(input.intent, input.mode);
      // The owner's floor gates a new admission only; a recorded request is returned whatever floor a retry carries.
      if (input.mode === "paper") return paperService(s).trade(scope.owner, parsed, { minOutAmount });
      const prior = await s.get(scope.owner, parsed.requestId);
      if (prior) {
        const expected = parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: prior.submission.intent.vault });
        if (JSON.stringify(expected) !== JSON.stringify(prior.submission.intent)) fail("The request ID already belongs to a different live trade.");
        return publicTrade(await reconcileSolanaSubmission(rpc(), s, scope.owner, parsed.requestId, now) ?? prior);
      }
      const cfg = config(), prices = computeUnitPrices(), maxFee = maxFeeLamports(), secret = await s.sessionSeed(dek());
      if (!secret) fail("Register an owner-approved live trading permission first.", "permission");
      // Refused as configuration before anything is signed; the store counts with it at admission.
      const expiredAllowance = expiredAttemptAllowance();
      const toleranceBps = referenceToleranceBps();
      // Admission re-checks the bound against this runtime's tolerance, never the one the evidence names.
      const journal: SolanaLiveJournal = { get: (owner, requestId) => s.get(owner, requestId), settle: (...args) => s.settle(...args),
        recordSigned: submission => s.recordSigned(submission, { expiredAttemptAllowance: expiredAllowance, referenceToleranceBps: toleranceBps }) };
      // One generation, from this runtime's env, for the read, the executor's check and the store's admission check.
      // Both settings are checked only after a recorded request was returned above: a bad one never blocks its replay.
      let pythGeneration: SolanaPythGeneration;
      try { pythGeneration = requireSolanaPythGeneration(env, now()); } catch { return fail("The independent SOL price source (Pyth generation) is misconfigured.", "configuration"); }
      const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(seed(secret, "The stored trading permission cannot be opened."));
      const vault = await deriveSolanaVaultAddress(cfg.programId, scope.owner), liveRpc = rpc(), quotes = market();
      // The vault is read no earlier than the book and the latest owner transaction seen to finalize: a lagging
      // provider cannot hand the executor a sequence a withdrawal already consumed (withdraw-sol moves no book slot).
      // That setup is the only record of its slot, and the owner's next prepare replaces it; assessRisk below
      // therefore also asks every provider for the vault's sequence, so one lagging provider alone signs nothing.
      const bookNow = await s.liveBook(), ownerNow = await s.setup();
      const minSnapshotSlot = Math.max(bookNow?.slot ?? 1, ownerNow?.status === "finalized" && Number.isSafeInteger(ownerNow.finalizedSlot) && ownerNow.finalizedSlot! > 0 ? ownerNow.finalizedSlot! : 1);
      const executor = createSolanaExecutor({ programId: cfg.programId, programBinarySha256: cfg.hash, pythGeneration, referenceToleranceBps: toleranceBps, minSnapshotSlot,
        sessionKeyPair, feePayerKeyPair: await payer(), rpc: liveRpc, market: createSolanaLiveMarket({ env, rpc: liveRpc, now }),
        journal, maxFeeLamports: maxFee.toString(), now, signal: input.signal,
        computeUnitPriceMicroLamports: prices.minimum, maxComputeUnitPriceMicroLamports: prices.maximum,
        assessRisk: async ({ intent: current, quote, slot, vaultState }) => {
          const observedAtMs = now();
          // Every provider, each at or after the prepared slot, in one session apiece: the vault's balances,
          // which must agree (one provider cannot show a phantom balance), the slot admission may persist
          // (the lowest any answered at, never one provider's own: solanaQuorumSlot), and the Pyth price that
          // bounds this trade, of which the stricter is used. Either provider's refusal refuses the trade.
          let views: Array<{ slot: number; fresh: number; cashUsdg: string; wsolRaw: string; price: SolanaReferencePrice; seq: bigint; sessionEpoch: bigint }>;
          try {
            // The prepared slot is the primary's (or the quote's): a provider a slot or two behind is asked again briefly.
            views = await readSolanaEachProvider(liveRpc, read => solanaCaughtUp(async () => {
              const held = await readSolanaVaultBalancesWith(read, vault, slot);
              const { seq, sessionEpoch } = await readSolanaVaultStateWith(read, cfg.programId, vault, scope.owner, slot);
              const price = await readSolanaReferencePrice(read, slot, now(), { generation: pythGeneration });
              return { ...held, seq, sessionEpoch, price, fresh: integer(await read("getSlot", [{ commitment: "confirmed" }])) };
            }));
          }
          catch (error) { if (error instanceof SolanaReferencePriceError) throw new SolanaExecutionError("risk"); throw error; }
          if (views.some(view => view.cashUsdg !== views[0]!.cashUsdg || view.wsolRaw !== views[0]!.wsolRaw)) throw new SolanaExecutionError("invalid-state");
          // The swap is signed against the snapshot's sequence and session epoch, read from one provider. Any provider
          // showing the vault otherwise at or after the prepared slot means that read was stale (an owner withdrawal
          // consumed the sequence, audit live-M1 trigger b) or the vault moved since: the signed bytes could never
          // run and would sit pending for an operator. Refused before anything is signed; the next attempt reads afresh.
          if (views.some(view => view.seq !== vaultState.seq || view.sessionEpoch !== vaultState.sessionEpoch)) throw new SolanaExecutionError("invalid-state");
          const balances = { slot: solanaQuorumSlot(views), cashUsdg: views[0]!.cashUsdg, wsolRaw: views[0]!.wsolRaw };
          const makeExit = (amountRaw: string, requestId: string) => parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana,
            mode: "paper", requestId, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: current.slippageBps });
          // Equity is the book's: unbooked or quarantined tokens are never valued.
          const tradable = (await tradableIn(s, balances))!;
          const held = BigInt(tradable.wsolRaw), cash = BigInt(tradable.cashUsdg);
          const evidence: Array<{ intent: SolanaSwapIntent; quote: typeof quote }> = [];
          let equity = cash, zeroMark = false;
          if (held > 0n && current.inputMint === SOLANA_USDG_MINT) { const markIntent = makeExit(tradable.wsolRaw, "live-portfolio-mark");
            // SOL that no route buys back (Jupiter's zero-output answer) is valued at zero, as the
            // paper book values it, once Pyth shows it is dust (below): never a reason to refuse
            // every buy as "too small". Any other failure still refuses.
            let mark: SolanaQuote | null = null;
            try { mark = await quotes.quote(markIntent); }
            catch (error) { if (!(error instanceof SolanaMarketError && error.code === "zero-output")) throw error; zeroMark = true; }
            if (mark) { validateSolanaQuote(mark, markIntent, now()); evidence.push({ intent: markIntent, quote: mark }); equity += BigInt(mark.minOutAmount); } }
          // Independent of Jupiter: the build quote's guaranteed output is checked
          // against Pyth SOL/USD, and a sell is charged at least its reference value.
          let reference: ReturnType<typeof solanaReferenceBound>;
          try {
            // A zero-output mark for SOL worth a cent or more at Pyth is not dust: valued at zero it would
            // trip the persisted drawdown breaker on one anomalous answer. Refused as an unusable mark
            // instead, like any other mark failure, for this buy only (SOLANA_MARK_DUST_MAX_USDG_RAW).
            // Dust only at every provider's price.
            if (zeroMark && !views.every(view => solanaMarkDust(held, view.price))) throw new SolanaMarketError("invalid-quote");
            reference = solanaStrictestReferenceBound(views.map(view => solanaReferenceBound(current, view.price, toleranceBps)));
          }
          catch (error) { if (error instanceof SolanaReferencePriceError) throw new SolanaExecutionError("risk"); throw error; }
          const previous = await s.liveBook(), peak = previous ? BigInt(previous.hwmRaw) : equity;
          for (const item of evidence) validateSolanaQuote(item.quote, item.intent, now());
          return { observedAtMs, slot: balances.slot, notionalUsdg: solanaReferenceNotional(current, quote.outAmount, reference).toString(),
            equityUsdg: equity.toString(), peakEquityUsdg: (peak > equity ? peak : equity).toString(), cashUsdg: balances.cashUsdg, wsolRaw: balances.wsolRaw, reference };
        },
      });
      return publicTrade(await executor.execute({ ...parsed, mode: "live", owner: scope.owner, vault }, { minOutAmount }));
    },
    async prepareLive(scope: SolanaAccountScope, input: { limits: SolanaPaperLimits; sessionPublicKey: string }) {
      const s = await store(scope), binding = await s.binding(), limits = validateSolanaAccountLimits(input.limits, now()), cfg = config();
      dek(); const feePayer = await getAddressFromPublicKey((await payer()).publicKey), session = address(input.sessionPublicKey);
      const vault = await deriveSolanaVaultAddress(cfg.programId, scope.owner);
      if (binding.requestedMode !== "live" || JSON.stringify(binding.limits) !== JSON.stringify(limits)) fail("Save the reviewed live trading limits first.", "permission");
      let sell: ReturnType<typeof requireSolanaLiveSellLimits>;
      try { sell = requireSolanaLiveSellLimits(limits); } catch { return fail("Save per-trade and daily SOL sell limits before registering live trading.", "permission"); }
      if (new Set([scope.owner, session, vault, feePayer]).size !== 4) fail("Owner, session, vault and fee payer must be separate accounts.");
      await verifyDeployment(cfg);
      const prior = await rpc().read(async read => {
        const slot = integer(await read("getSlot", [{ commitment: "confirmed" }]));
        const found = await read("getAccountInfo", [vault, { encoding: "base64", commitment: "confirmed", minContextSlot: slot }]);
        if (!object(found) || !object(found.context) || integer(found.context.slot) < slot || !Object.hasOwn(found, "value")) fail("The vault account could not be read.");
        if (found.value === null) return null;
        if (!object(found.value) || found.value.owner !== cfg.programId || !Array.isArray(found.value.data) || typeof found.value.data[0] !== "string" || found.value.data[1] !== "base64"
          || decodeSolanaVaultAccount(encoded(found.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE)).owner !== scope.owner) fail("The vault account does not match this owner.");
        return decodeSolanaVaultAccount(encoded(found.value.data[0], SOLANA_VAULT_ACCOUNT_SIZE));
      });
      const instructions: Instruction[] = [];
      if (!prior) instructions.push(buildInitializeSolanaVaultInstruction({ programAddress: cfg.programId, vault, owner: scope.owner }));
      instructions.push(await createAta(scope.owner, vault, SOLANA_USDG_MINT), await createAta(scope.owner, vault, SOLANA_WRAPPED_SOL_MINT),
        await createAta(scope.owner, scope.owner, SOLANA_USDG_MINT), await createAta(scope.owner, scope.owner, SOLANA_WRAPPED_SOL_MINT),
        buildCreateSolanaSessionInstruction({ programAddress: cfg.programId, vault, owner: scope.owner, session,
          perTrade: BigInt(limits.perTradeUsdg), daily: BigInt(limits.dailyUsdg), perTradeWsol: sell.perTradeWsol, dailyWsol: sell.dailyWsol,
          maxOps: limits.maxOpsPerDay, expiresAt: BigInt(Math.floor(limits.expiresAtMs / 1000)) }));
      const [vaultCash, vaultWsol, ownerCash, ownerWsol] = await Promise.all([deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
        deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM), deriveSolanaAta(scope.owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
        deriveSolanaAta(scope.owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM)]);
      return prepareOwner(s, instructions, { kind: "session", programId: cfg.programId, vault, session, limits,
        priorVaultExisted: prior !== null, priorSequence: prior?.seq.toString() ?? "0", priorSessionEpoch: prior?.sessionEpoch.toString() ?? "0" },
      [{ address: vault, size: SOLANA_VAULT_ACCOUNT_SIZE }, { address: vaultCash, size: "usdg" }, { address: vaultWsol, size: CLASSIC_TOKEN_ACCOUNT_SIZE },
        { address: ownerCash, size: "usdg" }, { address: ownerWsol, size: CLASSIC_TOKEN_ACCOUNT_SIZE }]);
    },
    submitSetup: (scope: SolanaAccountScope, input: { signedTransactionBase64: string }) => submitOwner(scope, input, "session"),
    async activateLive(scope: SolanaAccountScope, input: { signature: string; sessionSecretKey: string }) {
      const s = await store(scope), cfg = config(), keyPair = await createKeyPairFromPrivateKeyBytes(seed(input.sessionSecretKey, "Invalid session seed."));
      const session = await getAddressFromPublicKey(keyPair.publicKey), previous = await s.session();
      if (previous?.registrationSignature === input.signature && previous.session === session) return { registered: true, session, vault: previous.vault };
      const setup = await s.setup();
      if (!setup || (setup.kind ?? "session") !== "session" || setup.signature !== input.signature || setup.session !== session || setup.programId !== cfg.programId) fail("The signed permission does not match this session key.");
      const status = await ownerStatus(s, setup);
      if (status.status !== "finalized") fail(status.status === "failed" ? "The permission transaction failed. Prepare a new permission." : "The permission is awaiting final confirmation.", "pending");
      await verifyDeployment(cfg);
      // Read no earlier than the slot the registration finalized at: an RPC behind
      // it would show the vault before the permission and refuse a valid one. Such
      // an RPC errors instead (retry). Setups finalized before the slot was kept
      // read as before.
      const registeredAt = (await s.setup())?.finalizedSlot;
      const live = await readSolanaVaultState(rpc(), cfg.programId, scope.owner, registeredAt);
      if (live.vault !== setup.vault || live.state.session !== session || live.state.perTrade !== BigInt(setup.limits.perTradeUsdg)
        || live.state.daily !== BigInt(setup.limits.dailyUsdg) || live.state.maxOps !== setup.limits.maxOpsPerDay
        || live.state.perTradeWsol !== BigInt(setup.limits.perTradeWsol ?? "0") || live.state.dailyWsol !== BigInt(setup.limits.dailyWsol ?? "0")
        || live.state.expiresAt !== BigInt(Math.floor(setup.limits.expiresAtMs / 1000)) || live.state.expiresAt * 1000n <= BigInt(now())) fail("The current vault permission does not match the signed limits.");
      await s.registerSession({ programId: cfg.programId, vault: setup.vault, session, sessionEpoch: live.state.sessionEpoch.toString(),
        registrationSignature: input.signature, registeredAtMs: now() }, input.sessionSecretKey, dek());
      return { registered: true, session, vault: setup.vault };
    },
    /**
     * Owner recovery transactions, signed by the owner (also the fee payer):
     * - revoke, resume-buys;
     * - withdraw { mint, amountRaw }: USDG or WSOL to the owner's token account,
     *   bounded by the reconciled book. A WSOL withdrawal first runs SyncNative
     *   when native SOL sits unsynced in the vault's WSOL account, and may take it too.
     *   It also carries what the WSOL was worth when prepared, when that can be read,
     *   so the high-water mark drops by it once the withdrawal lands;
     * - withdraw-sol { amountRaw }: native lamports from the vault account above
     *   its rent reserve (withdraw_sol), to the owner's wallet.
     */
    async prepareOwnerAction(scope: SolanaAccountScope, input: { action: "revoke" | "withdraw" | "withdraw-sol" | "resume-buys"; mint?: string; amountRaw?: string }) {
      const s = await store(scope), cfg = config();
      if (input.action !== "revoke") await reconcile(s);
      await verifyDeployment(cfg);
      const { vault, state } = await readSolanaVaultState(rpc(), cfg.programId, scope.owner), instructions: Instruction[] = [], creates: OwnerCreate[] = [];
      const details: { syncedWsolRaw?: string; withdrawValuation?: SolanaWithdrawValuation } = {};
      if (input.action === "revoke") instructions.push(buildRevokeSolanaSessionsInstruction({ programAddress: cfg.programId, vault, owner: scope.owner }));
      else if (input.action === "resume-buys") instructions.push(buildSetSolanaBreakerInstruction({ programAddress: cfg.programId, vault, authority: scope.owner, paused: false }));
      else if (input.action === "withdraw" && input.mint && input.amountRaw) {
        const program = tokenProgram(input.mint), amount = parseSolanaRawAmount(input.amountRaw);
        let book = await s.liveBook();
        // Native SOL sent straight to the vault's WSOL account is the owner's too:
        // SyncNative (permissionless) turns it into WSOL inside this transaction.
        let synced = 0n;
        if (input.mint === SOLANA_WRAPPED_SOL_MINT) {
          const wsolAccount = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
          synced = await rpc().read(async read => {
            const found = await read("getAccountInfo", [wsolAccount, { encoding: "base64", commitment: "finalized", minContextSlot: book?.slot ?? 1 }]);
            if (!object(found) || !object(found.context) || !Object.hasOwn(found, "value")) fail("The vault's wrapped SOL account could not be read.");
            return unsyncedWsolLamports(chainAccount(found.value), vault);
          });
          if (synced > 0n) { instructions.push(syncNative(wsolAccount)); details.syncedWsolRaw = synced.toString(); }
        }
        if (book) {
          const observedAtMs = now();
          const finalized = await readSolanaVaultBalances(rpc(), vault, book.slot, "finalized");
          // Book any inflow first, so a stranger's WSOL can be withdrawn instead of blocking the owner.
          if (aboveBook(book, finalized)) await s.reconcileExternalInflows({ ...finalized, observedAtMs, commitment: "finalized" });
          book = (await s.liveBook())!;
          const available = input.mint === SOLANA_USDG_MINT ? BigInt(book.cashRaw) : BigInt(book.wsolRaw) + solanaQuarantinedWsol(book) + synced;
          if (amount > available) fail("The withdrawal exceeds the reconciled vault balance.");
          // Capital out: what the withdrawn WSOL is worth lowers the high-water mark
          // when it lands, as a USDG withdrawal does, so withdrawing is never a
          // drawdown. Only the booked position can move it: quarantine leaves first, at no value.
          if (input.mint === SOLANA_WRAPPED_SOL_MINT && BigInt(book.wsolRaw) > 0n && amount > solanaQuarantinedWsol(book)) {
            const valuation = await wsolWithdrawValuation(input.amountRaw);
            if (valuation) details.withdrawValuation = valuation;
          }
        }
        const ownerToken = await deriveSolanaAta(scope.owner, input.mint, program);
        creates.push({ address: ownerToken, size: input.mint === SOLANA_USDG_MINT ? "usdg" : CLASSIC_TOKEN_ACCOUNT_SIZE });
        instructions.push(await createAta(scope.owner, scope.owner, input.mint), buildWithdrawSolanaVaultInstruction({ programAddress: cfg.programId, vault, owner: scope.owner,
          mint: input.mint, tokenProgram: program, vaultToken: await deriveSolanaAta(vault, input.mint, program), ownerToken, amount }));
      } else if (input.action === "withdraw-sol" && input.mint === undefined && input.amountRaw) {
        const amount = parseSolanaRawAmount(input.amountRaw);
        // Native SOL is never booked; the program allows anything above the vault account's own rent reserve.
        const available = await rpc().read(async read => {
          const found = await read("getAccountInfo", [vault, { encoding: "base64", commitment: "finalized" }]);
          if (!object(found) || !object(found.context)) fail("The vault account could not be read.");
          const account = chainAccount(found.value);
          if (!account || account.owner !== cfg.programId) fail("The vault account could not be read.");
          const excess = account.lamports - await rentFor(read, account.data.length);
          return excess > 0n ? excess : 0n;
        });
        if (amount > available) fail(`The withdrawal exceeds the vault's native SOL above its rent reserve (${sol(available)} SOL).`);
        instructions.push(buildWithdrawSolanaNativeInstruction({ programAddress: cfg.programId, vault, owner: scope.owner, amount }));
      } else fail("Choose a supported owner action and a positive withdrawal amount.");
      // Owner recovery remains available with expired/revoked worker permission.
      const limits = { perTradeUsdg: state.perTrade.toString(), dailyUsdg: state.daily.toString(), maxOpsPerDay: state.maxOps,
        maxDrawdownBps: 1, expiresAtMs: Number(state.expiresAt * 1000n) };
      return prepareOwner(s, instructions, { kind: input.action, programId: cfg.programId, vault, session: state.session, limits,
        priorVaultExisted: true, priorSequence: state.seq.toString(), priorSessionEpoch: state.sessionEpoch.toString(),
        ...(input.action === "withdraw" ? { mint: input.mint, amountRaw: input.amountRaw, ...details } : input.action === "withdraw-sol" ? { amountRaw: input.amountRaw } : {}) }, creates);
    },
    submitOwnerAction: (scope: SolanaAccountScope, input: { signedTransactionBase64: string }) => submitOwner(scope, input, "owner"),
    /**
     * Whether `wsolRaw` of held SOL is dust a zero-output mark may value at zero
     * (solanaMarkDust): worth under SOLANA_MARK_DUST_MAX_USDG_RAW at the
     * independent Pyth SOL/USD price as every provider serves it, read now in this
     * runtime's generation, as a live buy's risk check reads it. False whenever that cannot be shown (a
     * bad setting, a price that cannot be read or proven): the agent then stops
     * the tick as for any other mark failure, and builds no route.
     */
    async solMarkDust(wsolRaw: string): Promise<boolean> {
      try {
        const amount = parseSolanaRawAmount(wsolRaw), generation = requireSolanaPythGeneration(env, now());
        // Dust only at every provider's price: one provider's low price cannot make real SOL worthless.
        return (await referencePrices(rpc(), generation)).every(price => solanaMarkDust(amount, price));
      } catch { return false; }
    },
  };
}
let runtime: ReturnType<typeof createSolanaAppRuntime> | undefined;
export function getSolanaAppRuntime() { return runtime ??= createSolanaAppRuntime({ localTestDeployment: false }); }
