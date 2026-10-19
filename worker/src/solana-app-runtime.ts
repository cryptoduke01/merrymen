/** Authenticated Solana application boundary. Owner keys never enter this module. */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase64EncodedWireTransaction,
  getTransactionDecoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { createHash } from "node:crypto";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Decode } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, requireSolanaLiveSellLimits, validateSolanaPaperLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaSwapIntent } from "../../packages/core/src/solana";
import {
  buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, buildRevokeSolanaSessionsInstruction,
  buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction, buildSetSolanaBreakerInstruction, decodeSolanaVaultAccount, deriveSolanaAta, deriveSolanaVaultAddress,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_LOCAL_TEST_PROGRAM,
  SOLANA_WRAPPED_SOL_MINT,
} from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { createSolanaExecutor, parseSolanaLiveIntent, readSolanaVaultBalances, readSolanaVaultState,
  reconcileSolanaSubmission, SolanaExecutionError, verifySolanaVaultDeployment, type SolanaLiveRecord } from "./solana-executor";
import { createSolanaLiveMarket } from "./solana-live-market";
import { createSolanaLiveRpc, readSolanaQuorum, type SolanaLiveRead, type SolanaLiveRpc } from "./solana-live-rpc";
import { createSolanaMarket } from "./solana-market";
import { createSolanaPaperService, type SolanaPaperMarket } from "./solana-paper-service";
import { readSolanaReferencePrice, solanaReferenceBound, solanaReferenceNotional, solanaReferenceToleranceBps,
  SolanaReferencePriceError } from "./solana-reference-price";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { isSolanaTransactionError } from "./solana-settlement";
import { ensureSolanaTradingSchema, OPERATOR_HOLD, solanaOwnerExpiryProven, solanaQuarantinedWsol, SolanaTradingStore, type SolanaAccountScope,
  type SolanaLiveBook, type SolanaOwnerExpiryProof, type SolanaPreparedSetup } from "./solana-trading-store";

export class SolanaAppRuntimeError extends Error {
  constructor(readonly code: "configuration" | "permission" | "invalid" | "pending", message: string) {
    super(message); this.name = "SolanaAppRuntimeError";
  }
}
function fail(message: string, code: SolanaAppRuntimeError["code"] = "invalid"): never { throw new SolanaAppRuntimeError(code, message); }
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
/** The signature fee per signer. Owner transactions carry one signature and no priority fee. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
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
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAM_DATA_SLICE = 98_304;
/** How long a successful vault deployment check is reused before it runs again. Failures are never reused. */
export const SOLANA_DEPLOYMENT_RECHECK_MS = 10 * 60_000;
/** (program id, binary hash) pairs whose bytes are proven to declare that id. A fact about the bytes, kept for the process. */
const declaredProgramIds = new Set<string>();
/**
 * The audited binary must be built for the configured program id. declare_id!
 * embeds the id's 32 bytes in the executable region; a build for any other id
 * (the local test id, say) fails every instruction with
 * DeclaredProgramIdMismatch, and an immutable deployment can never be fixed.
 * The region read here is hashed again, so a provider cannot answer with other
 * bytes than the ones verifySolanaVaultDeployment checked on every provider.
 */
async function requireDeclaredProgramId(rpc: SolanaLiveRpc, programId: string, binarySha256: string): Promise<void> {
  const cacheKey = `${programId}\n${binarySha256}`;
  if (declaredProgramIds.has(cacheKey)) return;
  const id = base58Decode(programId);
  if (!id || id.length !== 32) fail("The configured Solana vault program is invalid.", "configuration");
  const refused = (): never => fail("The configured Solana vault program could not be read.", "configuration");
  const accountAt = async (read: SolanaLiveRead, key: string, slot: number, dataSlice?: { offset: number; length: number }) => {
    const raw = await read("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed", minContextSlot: slot, ...(dataSlice ? { dataSlice } : {}) }]);
    if (!object(raw) || !object(raw.context) || typeof raw.context.slot !== "number" || raw.context.slot < slot || !object(raw.value)) return refused();
    const value = raw.value;
    if (value.owner !== UPGRADEABLE_LOADER || !Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string") return refused();
    const data = Buffer.from(value.data[0], "base64");
    if (data.toString("base64") !== value.data[0]) return refused();
    return { data, executable: value.executable, space: value.space };
  };
  const region = await rpc.read(async read => {
    const slot = await read("getSlot", [{ commitment: "confirmed" }]);
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 1) return refused();
    const program = await accountAt(read, programId, slot);
    if (program.executable !== true || program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) return refused();
    const dataAddress = getBase58Decoder().decode(program.data.subarray(4));
    const header = await accountAt(read, dataAddress, slot, { offset: 0, length: 45 });
    const space = header.space;
    if (typeof space !== "number" || !Number.isSafeInteger(space) || space <= 45 || space > 2_097_152) return refused();
    const chunks: Buffer[] = [];
    for (let offset = 45; offset < space; offset += PROGRAM_DATA_SLICE) {
      const length = Math.min(PROGRAM_DATA_SLICE, space - offset), chunk = await accountAt(read, dataAddress, slot, { offset, length });
      if (chunk.space !== space || chunk.data.length !== length) return refused();
      chunks.push(chunk.data);
    }
    return Buffer.concat(chunks);
  });
  if (createHash("sha256").update(region).digest("hex") !== binarySha256) refused();
  if (region.indexOf(Buffer.from(id)) < 0) fail("The configured Solana vault binary is built for a different program id. Deploy the build whose declare_id is the configured program.", "configuration");
  declaredProgramIds.add(cacheKey);
}
export interface SolanaAppRuntimeOptions {
  db?: Db; env?: Readonly<Record<string, string | undefined>>; now?: () => number;
  rpc?: SolanaLiveRpc; market?: SolanaPaperMarket;
  /** Operator log lines (fee payer alerts). Default: stderr. Never carries keys, signed bytes or tenant identities. */
  log?: (line: string) => void;
  /**
   * Test harnesses only: accept the local test program id and a binary that does
   * not embed the configured id. It defaults to true only when a test transport
   * is injected (`rpc`), which production never does; getSolanaAppRuntime()
   * always runs the full checks.
   */
  localTestDeployment?: boolean;
}
export function createSolanaAppRuntime(options: SolanaAppRuntimeOptions = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const localTest = options.localTestDeployment ?? options.rpc !== undefined;
  const rpc = () => options.rpc ?? createSolanaLiveRpc({ env });
  const market = () => options.market ?? createSolanaMarket({ env, now });
  async function store(scope: SolanaAccountScope, autonomousRevision?: number, signal?: AbortSignal) {
    const db = options.db ?? await getSolanaRuntimeDb();
    await ensureSolanaTradingSchema(db, !!env.DATABASE_URL);
    const result = new SolanaTradingStore(db, scope, now, autonomousRevision === undefined ? undefined : { autonomousRevision, signal }); await result.binding(); return result;
  }
  function config() {
    const programId = env.MERRYMEN_SOLANA_VAULT_PROGRAM, hash = env.MERRYMEN_SOLANA_VAULT_SHA256;
    if (!programId || !hash || !/^[a-f0-9]{64}$/.test(hash)) fail("An audited immutable Solana vault deployment and its binary hash must be configured.", "configuration");
    try { address(programId); } catch { fail("The configured Solana vault program is invalid.", "configuration"); }
    // The local test build's id is never a live deployment.
    if (programId === SOLANA_VAULT_LOCAL_TEST_PROGRAM && !localTest) fail("The configured Solana vault program is the local test id, which is never used for live trading.", "configuration");
    return { programId, hash };
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
      await verifySolanaVaultDeployment(live, cfg.programId, cfg.hash);
      if (!localTest) await requireDeclaredProgramId(live, cfg.programId, cfg.hash);
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
  function feePayerLow(): bigint {
    const maxFee = parseSolanaRawAmount(env.MERRYMEN_SOLANA_MAX_FEE_LAMPORTS ?? "5000000");
    const raw = env.MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS;
    if (raw === undefined) return maxFee * 4n;
    try { return parseSolanaRawAmount(raw); } catch { return fail("The fee payer warning threshold is misconfigured.", "configuration"); }
  }
  type FeePayerLevel = "ok" | "low" | "buys-blocked" | "exits-blocked";
  let feePayerAlert: { level: FeePayerLevel; atMs: number } | undefined;
  /** One structured line per change of level, repeated every FEE_PAYER_ALERT_REPEAT_MS while it is not ok. */
  function reportFeePayer(level: FeePayerLevel, details: Record<string, string>) {
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
    const quorum = await readSolanaQuorum(live, read => observeOwner(read, s, setup, signature), ownerViewKey);
    if (quorum.agreed && quorum.value.outcome !== "pending") {
      const view = quorum.value;
      if (view.outcome === "expired") { await s.finishSetup(signature, "failed", view.proof.slot, view.proof); return { signature, status: "failed" }; }
      await s.finishSetup(signature, view.outcome, view.slot);
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
  async function prepareOwner(s: SolanaTradingStore, instructions: Instruction[], details: Omit<SolanaPreparedSetup,
    "transactionBase64" | "messageBase64" | "blockhash" | "lastValidBlockHeight" | "preparedAtMs" | "expiresAtMs">, creates: readonly OwnerCreate[] = []) {
    const previous = await s.setup();
    if (previous?.signature && previous.status !== "failed" && previous.status !== "finalized") fail("Refresh the pending owner transaction before preparing another.", "pending");
    const { block, cost } = await rpc().read(async read => {
      const result = await read("getLatestBlockhash", [{ commitment: "confirmed" }]);
      if (!object(result) || !object(result.value) || typeof result.value.blockhash !== "string") fail("Invalid Solana blockhash response.");
      return { block: { blockhash: address(result.value.blockhash) as unknown as Blockhash, lastValidBlockHeight: BigInt(integer(result.value.lastValidBlockHeight)) },
        cost: await ownerCost(read, s.scope.owner, details.vault, creates) };
    });
    // The owner pays: refuse before anything is saved or signed rather than let
    // a transaction that cannot pay its fee sit pending until its blockhash expires.
    const required = cost.rents.reduce((sum, item) => sum + item, cost.base);
    if (cost.held < required) fail(`Your owner wallet holds ${sol(cost.held)} SOL. This transaction needs at least ${sol(required)} SOL: its network fee${cost.rents.some(item => item > 0n) ? ", rent for the token accounts it opens" : ""} and the wallet's own minimum balance. Send SOL to your owner wallet, then prepare it again.`);
    const tx = compileTransaction(setTransactionMessageLifetimeUsingBlockhash(block,
      setTransactionMessageFeePayer(address(s.scope.owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))));
    const transactionBase64 = getBase64EncodedWireTransaction(tx); encoded(transactionBase64);
    const preparedAtMs = now();
    const setup: SolanaPreparedSetup = { ...details, transactionBase64, messageBase64: Buffer.from(tx.messageBytes).toString("base64"),
      blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight.toString(), preparedAtMs, expiresAtMs: preparedAtMs + 60_000 };
    await s.saveSetup(setup);
    return { transactionBase64, blockhash: setup.blockhash, lastValidBlockHeight: setup.lastValidBlockHeight,
      programId: setup.programId, vault: setup.vault, session: setup.session, expiresAtMs: setup.expiresAtMs,
      ownerLamports: cost.held.toString(), requiredLamports: required.toString() };
  }
  async function submitOwner(scope: SolanaAccountScope, input: { signedTransactionBase64: string }, kind: "session" | "owner") {
    const s = await store(scope), setup = await s.setup();
    if (!setup || (kind === "session" ? (setup.kind ?? "session") !== "session" : setup.kind === "session" || !setup.kind)) fail("Prepare this owner transaction before signing it.");
    const transaction = getTransactionDecoder().decode(encoded(input.signedTransactionBase64));
    const signatureBytes = transaction.signatures[address(scope.owner)];
    if (Object.keys(transaction.signatures).length !== 1 || !signatureBytes ||
      Buffer.from(transaction.messageBytes).toString("base64") !== setup.messageBase64 ||
      !ed25519.verify(new Uint8Array(signatureBytes), new Uint8Array(transaction.messageBytes), base58Decode(scope.owner)!, { zip215: false })) fail("The owner signature or reviewed transaction does not match.");
    const signature = getBase58Decoder().decode(signatureBytes);
    if (setup.signature) {
      if (setup.signature !== signature || setup.signedTransactionBase64 !== input.signedTransactionBase64) fail("Another owner transaction is already saved.");
      return ownerStatus(s, setup);
    }
    const signed: SolanaPreparedSetup = { ...setup, signature, signedTransactionBase64: input.signedTransactionBase64, status: "pending" };
    const first = await s.saveSetup(signed);
    if (first) { try { await rpc().send(input.signedTransactionBase64, 1); } catch { /* Durable pending; retry only reconciles. */ } }
    return { signature, status: "pending" as const };
  }
  return {
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
      let feePayerView: { lamports: string; exitMinimumLamports: string; buyMinimumLamports: string; lowLamports: string; level: FeePayerLevel } | null = null;
      let ownerWallet: { lamports: string; revokeLamports: string; withdrawLamports: string } | null = null;
      let recoverable: { nativeLamports: string; unsyncedWsolLamports: string } | null = null;
      try {
        const cfg = config(); programId = cfg.programId; vault = await deriveSolanaVaultAddress(programId, scope.owner);
        if (!liveReads) { if (binding.requestedMode === "live") blockers.push("Live vault state was not read."); }
        else {
          dek(); const feePayer = await getAddressFromPublicKey((await payer()).publicKey);
          if ([scope.owner, vault, session?.session].includes(feePayer)) fail("The network fee payer must be separate from the owner, vault and session.", "configuration");
          await verifyDeployment(cfg);
          const low = feePayerLow(), vaultCash = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
          const ownerCash = await deriveSolanaAta(scope.owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsol = await deriveSolanaAta(scope.owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
          const vaultWsol = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
          const payerState = await rpc().read(async read => {
            const [payerAccount, cashAccount, vaultAccount, wsolAccount] = await readAccounts(read, [feePayer, vaultCash, vault!, vaultWsol]);
            const native = vaultAccount && vaultAccount.owner === cfg.programId ? vaultAccount.lamports - await rentFor(read, vaultAccount.data.length) : 0n;
            if (payerAccount && (payerAccount.owner !== SOLANA_SYSTEM_PROGRAM || payerAccount.executable || payerAccount.data.length))
              fail("The separate network fee payer must be a plain system account.", "configuration");
            // What the executor needs for one swap: both signatures and the rent of the
            // temporary input account it opens (and closes, refunding the payer).
            return { lamports: payerAccount?.lamports ?? 0n,
              exitMinimum: await rentFor(read, CLASSIC_TOKEN_ACCOUNT_SIZE) + SWAP_SIGNATURE_FEES,
              buyMinimum: await rentFor(read, cashAccount ? cashAccount.data.length : TOKEN_2022_ACCOUNT_SIZE_BOUND) + SWAP_SIGNATURE_FEES,
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
          const level: FeePayerLevel = payerState.lamports < payerState.exitMinimum ? "exits-blocked" : payerState.lamports < payerState.buyMinimum ? "buys-blocked"
            : payerState.lamports < low ? "low" : "ok";
          feePayerView = { lamports: payerState.lamports.toString(), exitMinimumLamports: payerState.exitMinimum.toString(),
            buyMinimumLamports: payerState.buyMinimum.toString(), lowLamports: low.toString(), level };
          reportFeePayer(level, { feePayer, ...feePayerView });
          if (level === "exits-blocked") blockers.push(`The shared network fee payer holds ${sol(payerState.lamports)} SOL, below the ${sol(payerState.exitMinimum)} SOL one exit needs. Trading and automated exits are paused until an operator funds it.`);
          else if (level === "buys-blocked") buysOnly(`The shared network fee payer holds ${sol(payerState.lamports)} SOL: enough for exits, not for buys (${sol(payerState.buyMinimum)} SOL). Buying is paused until an operator funds it; exits remain available.`);
          else if (level === "low") warnings.push(`The shared network fee payer is low (${sol(payerState.lamports)} SOL; operators are alerted below ${sol(low)} SOL). Trading continues.`);
          const live = await readSolanaVaultState(rpc(), programId, scope.owner);
          balances = await readSolanaVaultBalances(rpc(), vault, live.slot);
          cashTokenAccount = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
          const book = await s.liveBook();
          // A USDG deposit or anyone's WSOL transfer is booked from finalized state:
          // capital-in for USDG, zero-basis quarantine for WSOL. Neither blocks exits.
          if (book && !shortOfBook(book, balances) && aboveBook(book, balances) && !(await s.pending()).length) {
            const observedAtMs = now();
            const finalized = await readSolanaVaultBalances(rpc(), vault, book.slot, "finalized");
            // Unbooked excess is never traded or valued, so failing to book it now (an
            // owner transaction is pending, say) must not block exits; it retries next read.
            try { if (!shortOfBook(book, finalized) && aboveBook(book, finalized)) await s.reconcileExternalInflows({ ...finalized, observedAtMs, commitment: "finalized" }); }
            catch { /* Retried on the next status read. */ }
          }
          if (!session || session.programId !== programId || session.vault !== vault || live.state.session !== session.session || live.state.sessionEpoch.toString() !== session.sessionEpoch) blockers.push("Register an owner-approved live trading permission.");
          else {
            const storedSeed = await s.sessionSeed(dek());
            if (!storedSeed || await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(seed(storedSeed, "The session cannot be opened."))).publicKey) !== session.session)
              fail("The saved trading permission cannot be opened.", "configuration");
          }
          const currentBook = await s.liveBook();
          if (currentBook?.buyPaused) buysOnly("The buying drawdown breaker is paused; exits remain available.");
          if (currentBook && shortOfBook(currentBook, balances)) blockers.push("Vault balances are below recorded trades; reconcile capital transfers before trading.");
          if (live.state.expiresAt * 1000n <= BigInt(now())) blockers.push("The on-chain trading permission has expired.");
          if (live.state.paused) buysOnly("The on-chain buying breaker is paused; exits remain available.");
        }
      } catch (error) { blockers.push(error instanceof SolanaAppRuntimeError ? error.message : "The configured vault, balances or live permissions could not be verified."); }
      if (!env.MERRYMEN_JUPITER_API_KEY) blockers.push("Configure Jupiter quote access.");
      if (await s.operatorHeld()) blockers.push(OPERATOR_HOLD);
      if (binding.requestedMode !== "live") blockers.push("Live mode is not selected.");
      if (!binding.limits || binding.limits.expiresAtMs <= now()) blockers.push("Save current Solana trading limits.");
      else if (binding.requestedMode === "live" && (binding.limits.perTradeWsol === undefined || binding.limits.dailyWsol === undefined)) blockers.push("Save per-trade and daily SOL sell limits for live trading.");
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
    async preview(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown }) {
      const s = await store(scope), parsed = intent(input.intent, input.mode);
      if (input.mode === "paper") return paperService(s).preview(scope.owner, parsed);
      const cfg = config(); parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: await deriveSolanaVaultAddress(cfg.programId, scope.owner) });
      const quote = await market().quote(parsed); validateSolanaQuote(quote, parsed, now());
      return { intent: { ...parsed, mode: "live" }, quote };
    },
    async trade(scope: SolanaAccountScope, input: { mode: "paper" | "live"; intent: unknown; autonomousRevision?: number; signal?: AbortSignal }) {
      const s = await store(scope, input.autonomousRevision, input.signal), parsed = intent(input.intent, input.mode);
      if (input.mode === "paper") return paperService(s).trade(scope.owner, parsed);
      const prior = await s.get(scope.owner, parsed.requestId);
      if (prior) {
        const expected = parseSolanaLiveIntent({ ...parsed, mode: "live", owner: scope.owner, vault: prior.submission.intent.vault });
        if (JSON.stringify(expected) !== JSON.stringify(prior.submission.intent)) fail("The request ID already belongs to a different live trade.");
        return publicTrade(await reconcileSolanaSubmission(rpc(), s, scope.owner, parsed.requestId, now) ?? prior);
      }
      const cfg = config(), secret = await s.sessionSeed(dek());
      if (!secret) fail("Register an owner-approved live trading permission first.", "permission");
      let toleranceBps: number;
      try { toleranceBps = solanaReferenceToleranceBps(env); } catch { return fail("The independent SOL price tolerance is misconfigured.", "configuration"); }
      const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(seed(secret, "The stored trading permission cannot be opened."));
      const vault = await deriveSolanaVaultAddress(cfg.programId, scope.owner), liveRpc = rpc(), quotes = market();
      const executor = createSolanaExecutor({ programId: cfg.programId, programBinarySha256: cfg.hash,
        sessionKeyPair, feePayerKeyPair: await payer(), rpc: liveRpc, market: createSolanaLiveMarket({ env, rpc: liveRpc, now }),
        journal: s, maxFeeLamports: env.MERRYMEN_SOLANA_MAX_FEE_LAMPORTS ?? "5000000", now, signal: input.signal,
        computeUnitPriceMicroLamports: env.MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS ?? "0",
        assessRisk: async ({ intent: current, quote, slot }) => {
          const observedAtMs = now(), balances = await readSolanaVaultBalances(liveRpc, vault, slot);
          const makeExit = (amountRaw: string, requestId: string) => parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana,
            mode: "paper", requestId, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: current.slippageBps });
          // Equity is the book's: unbooked or quarantined tokens are never valued.
          const tradable = (await tradableIn(s, balances))!;
          const held = BigInt(tradable.wsolRaw), cash = BigInt(tradable.cashUsdg);
          const evidence: Array<{ intent: SolanaSwapIntent; quote: typeof quote }> = [];
          let equity = cash;
          if (held > 0n && current.inputMint === SOLANA_USDG_MINT) { const markIntent = makeExit(tradable.wsolRaw, "live-portfolio-mark");
            const mark = await quotes.quote(markIntent); validateSolanaQuote(mark, markIntent, now()); evidence.push({ intent: markIntent, quote: mark }); equity += BigInt(mark.minOutAmount); }
          // Independent of Jupiter: the build quote's guaranteed output is checked
          // against Pyth SOL/USD, and a sell is charged at least its reference value.
          let reference: ReturnType<typeof solanaReferenceBound>;
          try { reference = solanaReferenceBound(current, await liveRpc.read(read => readSolanaReferencePrice(read, slot, now())), toleranceBps); }
          catch (error) { if (error instanceof SolanaReferencePriceError) throw new SolanaExecutionError("risk"); throw error; }
          const previous = await s.liveBook(), peak = previous ? BigInt(previous.hwmRaw) : equity;
          for (const item of evidence) validateSolanaQuote(item.quote, item.intent, now());
          return { observedAtMs, slot: balances.slot, notionalUsdg: solanaReferenceNotional(current, quote.outAmount, reference).toString(),
            equityUsdg: equity.toString(), peakEquityUsdg: (peak > equity ? peak : equity).toString(), cashUsdg: balances.cashUsdg, wsolRaw: balances.wsolRaw, reference };
        },
      });
      return publicTrade(await executor.execute({ ...parsed, mode: "live", owner: scope.owner, vault }));
    },
    async prepareLive(scope: SolanaAccountScope, input: { limits: SolanaPaperLimits; sessionPublicKey: string }) {
      const s = await store(scope), binding = await s.binding(), limits = validateSolanaPaperLimits(input.limits, now()), cfg = config();
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
      const live = await readSolanaVaultState(rpc(), cfg.programId, scope.owner);
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
     *   when native SOL sits unsynced in the vault's WSOL account, and may take it too;
     * - withdraw-sol { amountRaw }: native lamports from the vault account above
     *   its rent reserve (withdraw_sol), to the owner's wallet.
     */
    async prepareOwnerAction(scope: SolanaAccountScope, input: { action: "revoke" | "withdraw" | "withdraw-sol" | "resume-buys"; mint?: string; amountRaw?: string }) {
      const s = await store(scope), cfg = config();
      if (input.action !== "revoke") await reconcile(s);
      await verifyDeployment(cfg);
      const { vault, state } = await readSolanaVaultState(rpc(), cfg.programId, scope.owner), instructions: Instruction[] = [], creates: OwnerCreate[] = [];
      const details: { syncedWsolRaw?: string } = {};
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
  };
}
let runtime: ReturnType<typeof createSolanaAppRuntime> | undefined;
export function getSolanaAppRuntime() { return runtime ??= createSolanaAppRuntime({ localTestDeployment: false }); }
