/**
 * Owner-run recovery of a Solana custody vault, independent of the Merrymen
 * server: no database, no session, no environment hash, no worker. The owner
 * signs with their own exported key; only signed transactions leave this
 * process, and only to the mainnet RPC the owner names.
 *
 * The procedure is the one the program allows (contracts/solana, lib.rs):
 *   1. revoke_all alone, finalized before anything else. A session still
 *      trading would otherwise race the withdrawal and roll it back.
 *   2. From finalized balances: create the owner's token accounts if missing,
 *      sync the vault's native WSOL, withdraw all USDG, all WSOL and the vault
 *      account's SOL above its rent reserve.
 * Funds can only move vault -> owner. A repeated or overlapping run cannot
 * move more than the vault holds: a stale amount fails the whole transaction.
 * About 0.0165 SOL of vault and vault token account rent stays locked, since
 * the program has no close instruction.
 *
 * The program is trusted only once verified. The owner is the fee payer, so
 * the owner key is a writable signer inside every instruction of the program
 * it signs for: a look-alike program could move the owner's SOL and the
 * tokens in the owner USDG and WSOL accounts that step 2 passes writable.
 * --send therefore signs only for a released program (SOLANA_VAULT_RELEASES,
 * verified by default) or, with --unlisted-program, for one whose immutable
 * binary matches the owner's --program-sha256, after a warning and a pause.
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes, createTransactionMessage, getAddressFromPublicKey,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signTransaction, type Blockhash, type Instruction,
} from "@solana/kit";
import { base58Decode, base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import {
  buildRevokeSolanaSessionsInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  decodeSolanaVaultAccount, deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_WRAPPED_SOL_MINT, type SolanaVaultState,
} from "../../packages/core/src/solana-live";
import { verifySolanaVaultDeployment } from "./solana-executor";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { SolanaRpcError } from "./solana-rpc";

/** Fixed messages only: never key material, RPC URLs or provider text. */
export class SolanaRecoverError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaRecoverError"; }
}
function fail(message: string): never { throw new SolanaRecoverError(message); }

/** Pubkey::default(), which revoke_all writes as the session. */
const NO_SESSION = SOLANA_SYSTEM_PROGRAM;
const SYNC_NATIVE = 17;
const CREATE_IDEMPOTENT = 1;
export const SOLANA_RECOVER_KEY_MAX_BYTES = 4096;

/** A released Merrymen vault program and the SHA-256 of its deployed binary (ProgramData bytes after the 45-byte header). */
export interface SolanaVaultRelease { readonly programId: string; readonly sha256: string }
/**
 * Released vault programs, verified by default. Empty until the program is
 * deployed: until then --send needs --program-sha256 and --unlisted-program.
 * A release adds its program ID and reviewed binary hash here.
 */
export const SOLANA_VAULT_RELEASES: readonly SolanaVaultRelease[] = Object.freeze([]);
/** Pause after the unlisted-program warning, before anything is signed. */
export const SOLANA_RECOVER_UNLISTED_DELAY_MS = 15_000;

export interface SolanaRecoveryProgramTrust { listed: boolean; sha256?: string }
/**
 * Decides, before any RPC call or signature, which binary the program must
 * match. A released program is checked against its released hash. Signing
 * for any other program needs the owner's --program-sha256 and the explicit
 * --unlisted-program; a plan only reads, so it may name any program.
 */
export function solanaRecoveryProgramTrust(options: { programId: string; send: boolean; programSha256?: string;
  allowUnlistedProgram?: boolean; releases?: readonly SolanaVaultRelease[] }): SolanaRecoveryProgramTrust {
  canonical(options.programId, "program ID");
  const releases = options.releases ?? SOLANA_VAULT_RELEASES;
  const release = releases.find((r) => r.programId === options.programId);
  if (release) {
    if (options.programSha256 !== undefined && options.programSha256 !== release.sha256) {
      fail("--program-sha256 differs from the released binary of this program. Nothing was signed or sent.");
    }
    return { listed: true, sha256: release.sha256 };
  }
  if (options.send && (options.programSha256 === undefined || !options.allowUnlistedProgram)) {
    fail(`Program ${options.programId} is not a released Merrymen vault program${releases.length ? "" : " (none is released yet)"}. `
      + "Nothing was signed or sent. The owner key signs every instruction of the program you name, so a look-alike program could take "
      + "the SOL in this wallet and the tokens in its USDG and WSOL accounts. If someone sent you this command, stop: Merrymen never asks for it. "
      + "To recover from a program you deployed or audited yourself, add --program-sha256 with its binary hash and --unlisted-program.");
  }
  return { listed: false, sha256: options.programSha256 };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("The Solana RPC returned malformed data.");
  return value;
}
function canonical(value: string, what: string): string {
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== value) fail(`The ${what} must be a canonical Solana public key.`);
  return value;
}

/**
 * The owner's exported secret key: a base58 64-byte secret key (wallet
 * export), a base58 32-byte seed, or a solana-keygen JSON array. The key is
 * imported as a non-extractable signer and every intermediate copy is zeroed.
 */
export async function readSolanaOwnerKey(text: string): Promise<{ keyPair: CryptoKeyPair; owner: string }> {
  const invalid = () => fail("The key input does not contain a Solana secret key.");
  if (typeof text !== "string" || Buffer.byteLength(text) > SOLANA_RECOVER_KEY_MAX_BYTES) return invalid();
  const trimmed = text.trim();
  let bytes: Uint8Array | null = null;
  try {
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return invalid();
      bytes = Uint8Array.from(parsed as number[]);
      parsed.fill(0);
    } else if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(trimmed)) {
      bytes = base58Decode(trimmed);
    }
    if (!bytes || (bytes.length !== 64 && bytes.length !== 32)) return invalid();
    // A 64-byte key carries its public half; kit checks it signs for that key.
    const keyPair = bytes.length === 64 ? await createKeyPairFromBytes(bytes) : await createKeyPairFromPrivateKeyBytes(bytes);
    return { keyPair, owner: await getAddressFromPublicKey(keyPair.publicKey) };
  } catch (error) {
    if (error instanceof SolanaRecoverError) throw error;
    return invalid();
  } finally {
    bytes?.fill(0);
  }
}

interface RawAccount { owner: string; executable: boolean; lamports: bigint; data: Buffer }
function rawAccount(value: unknown): RawAccount | null {
  if (value === null) return null;
  if (!object(value) || typeof value.owner !== "string" || typeof value.executable !== "boolean" ||
    !Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string") fail("The Solana RPC returned malformed account data.");
  const data = Buffer.from(value.data[0], "base64");
  if (data.toString("base64") !== value.data[0]) fail("The Solana RPC returned malformed account data.");
  return { owner: value.owner, executable: value.executable, lamports: BigInt(integer(value.lamports)), data };
}
/** The SPL token account fields recovery needs, checked against the expected mint and authority. */
function tokenAccount(raw: RawAccount, program: string, mint: string, authority: string) {
  const data = raw.data;
  if (raw.owner !== program || raw.executable || data.length < 165 ||
    base58Encode(data.subarray(0, 32)) !== mint || base58Encode(data.subarray(32, 64)) !== authority) {
    fail("A vault token account does not match its expected mint and owner.");
  }
  const state = data[108];
  if (state !== 1 && state !== 2) fail("A vault token account is not initialized.");
  const nativeTag = data.readUInt32LE(109);
  if (nativeTag > 1) fail("A vault token account is malformed.");
  return { amount: data.readBigUInt64LE(64), frozen: state === 2, nativeReserve: nativeTag === 1 ? data.readBigUInt64LE(113) : null };
}

export interface SolanaRecoveryState {
  owner: string;
  programId: string;
  vault: string;
  slot: number;
  commitment: "confirmed" | "finalized";
  vaultState: SolanaVaultState;
  /** True while a session key is set: it can still trade until revoked. */
  sessionActive: boolean;
  usdg: { vaultAccount: string; ownerAccount: string; exists: boolean; frozen: boolean; amountRaw: bigint; ownerAccountExists: boolean };
  /** WSOL withdrawable after SyncNative: account lamports above its rent-exempt reserve. */
  wsol: { vaultAccount: string; ownerAccount: string; exists: boolean; frozen: boolean; amountRaw: bigint; unsyncedRaw: bigint; ownerAccountExists: boolean };
  /** Native SOL in the vault account above the rent reserve withdraw_sol keeps. */
  sol: { lamports: bigint; reserve: bigint; excess: bigint };
  ownerLamports: bigint;
}

/** One consistent read of the vault, its token accounts and the owner's, at a single slot. */
export async function readSolanaRecoveryState(rpc: SolanaLiveRpc, programId: string, owner: string,
  commitment: "confirmed" | "finalized", minContextSlot = 1): Promise<SolanaRecoveryState> {
  canonical(programId, "program ID"); canonical(owner, "owner");
  const vault = await deriveSolanaVaultAddress(programId, owner);
  const [vaultUsdg, vaultWsol, ownerUsdg, ownerWsol] = await Promise.all([
    deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM),
    deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM),
  ]);
  return rpc.read(async (read: SolanaLiveRead) => {
    const slot = integer(await read("getSlot", [{ commitment, minContextSlot }]));
    if (slot < minContextSlot) fail("The Solana RPC is behind the last recovery step; try again shortly.");
    const result = await read("getMultipleAccounts", [[vault, vaultUsdg, vaultWsol, owner, ownerUsdg, ownerWsol],
      { encoding: "base64", commitment, minContextSlot: slot }]);
    if (!object(result) || !object(result.context) || integer(result.context.slot) < slot || !Array.isArray(result.value) || result.value.length !== 6) {
      fail("The Solana RPC returned malformed account data.");
    }
    const [vaultRaw, usdgRaw, wsolRaw, ownerRaw, ownerUsdgRaw, ownerWsolRaw] = result.value.map(rawAccount);
    if (!vaultRaw) fail(`No Merrymen vault exists for owner ${owner} under program ${programId}. Check the program ID shown next to your vault.`);
    if (vaultRaw.owner !== programId || vaultRaw.executable) fail("The vault address is not an account of the given program.");
    let vaultState: SolanaVaultState;
    try { vaultState = decodeSolanaVaultAccount(new Uint8Array(vaultRaw.data)); }
    catch { return fail("The vault account is not a Merrymen vault this tool understands."); }
    if (vaultState.owner !== owner) fail("The vault belongs to a different owner.");
    const reserve = BigInt(integer(await read("getMinimumBalanceForRentExemption", [vaultRaw.data.length, { commitment }])));
    const usdg = usdgRaw ? tokenAccount(usdgRaw, TOKEN_2022_PROGRAM, SOLANA_USDG_MINT, vault) : null;
    const wsol = wsolRaw ? tokenAccount(wsolRaw, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT, vault) : null;
    if (wsol && wsol.nativeReserve === null) fail("The vault's WSOL account is not a native SOL account.");
    const wsolWithdrawable = wsol && wsolRaw!.lamports > wsol.nativeReserve! ? wsolRaw!.lamports - wsol.nativeReserve! : 0n;
    if (wsol && wsolWithdrawable < wsol.amount) fail("The vault's WSOL account is malformed.");
    return {
      owner, programId, vault, slot: integer(result.context.slot), commitment, vaultState,
      sessionActive: vaultState.session !== NO_SESSION,
      usdg: { vaultAccount: vaultUsdg, ownerAccount: ownerUsdg, exists: !!usdg, frozen: !!usdg?.frozen, amountRaw: usdg?.amount ?? 0n, ownerAccountExists: !!ownerUsdgRaw },
      wsol: { vaultAccount: vaultWsol, ownerAccount: ownerWsol, exists: !!wsol, frozen: !!wsol?.frozen, amountRaw: wsolWithdrawable,
        unsyncedRaw: wsol ? wsolWithdrawable - wsol.amount : 0n, ownerAccountExists: !!ownerWsolRaw },
      sol: { lamports: vaultRaw.lamports, reserve, excess: vaultRaw.lamports > reserve ? vaultRaw.lamports - reserve : 0n },
      ownerLamports: ownerRaw?.lamports ?? 0n,
    };
  });
}

/** Step 1: revoke_all alone, or nothing when no session key is set. */
export function solanaRecoveryRevokeInstructions(state: SolanaRecoveryState): Instruction[] {
  return state.sessionActive ? [buildRevokeSolanaSessionsInstruction({ programAddress: state.programId, vault: state.vault, owner: state.owner })] : [];
}

function createOwnerAta(owner: string, ata: string, mint: string, tokenProgram: string): Instruction {
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(CREATE_IDEMPOTENT), accounts: [
    { address: address(owner), role: 3 }, { address: address(ata), role: 1 }, { address: address(owner), role: 0 },
    { address: address(mint), role: 0 }, { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(tokenProgram), role: 0 },
  ] };
}

export interface SolanaRecoveryWithdrawal { usdgRaw: bigint; wsolRaw: bigint; solLamports: bigint; skipped: string[] }
/** What step 2 withdraws from a state: every unit a withdrawal can move. */
export function solanaRecoveryWithdrawal(state: SolanaRecoveryState): SolanaRecoveryWithdrawal {
  const skipped: string[] = [];
  if (state.usdg.frozen) skipped.push("USDG: the vault's USDG account is frozen by the issuer, so it cannot be withdrawn.");
  if (state.wsol.frozen) skipped.push("WSOL: the vault's WSOL account is frozen, so it cannot be withdrawn.");
  return {
    usdgRaw: state.usdg.frozen ? 0n : state.usdg.amountRaw,
    wsolRaw: state.wsol.frozen ? 0n : state.wsol.amountRaw,
    solLamports: state.sol.excess, skipped,
  };
}

/** Step 2 instructions, built only from packages/core vault builders plus ATA and SyncNative. */
export function solanaRecoveryWithdrawInstructions(state: SolanaRecoveryState): Instruction[] {
  const plan = solanaRecoveryWithdrawal(state);
  const { programId, vault, owner } = state;
  const instructions: Instruction[] = [];
  if (plan.usdgRaw > 0n) {
    instructions.push(createOwnerAta(owner, state.usdg.ownerAccount, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
      buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: SOLANA_USDG_MINT,
        vaultToken: state.usdg.vaultAccount, ownerToken: state.usdg.ownerAccount, tokenProgram: TOKEN_2022_PROGRAM, amount: plan.usdgRaw }));
  }
  if (plan.wsolRaw > 0n) {
    instructions.push(createOwnerAta(owner, state.wsol.ownerAccount, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM));
    // Anyone may sync a native account: lamports sent to it become its token amount.
    if (state.wsol.unsyncedRaw > 0n) {
      instructions.push({ programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), data: Uint8Array.of(SYNC_NATIVE),
        accounts: [{ address: address(state.wsol.vaultAccount), role: 1 }] });
    }
    instructions.push(buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: SOLANA_WRAPPED_SOL_MINT,
      vaultToken: state.wsol.vaultAccount, ownerToken: state.wsol.ownerAccount, tokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, amount: plan.wsolRaw }));
  }
  if (plan.solLamports > 0n) instructions.push(buildWithdrawSolanaNativeInstruction({ programAddress: programId, vault, owner, amount: plan.solLamports }));
  return instructions;
}

export function formatSolanaUnits(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals), whole = raw / unit, fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function when(unixSeconds: bigint): string {
  const ms = Number(unixSeconds) * 1000;
  return unixSeconds > 0n && Number.isSafeInteger(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : `at unix time ${unixSeconds}`;
}

/** A human-readable plan. Public data only: addresses, balances and the steps. */
export function describeSolanaRecovery(state: SolanaRecoveryState, sending: boolean): string[] {
  const plan = solanaRecoveryWithdrawal(state);
  const { vaultState } = state;
  const lines = [
    sending ? "Solana vault recovery: sending (each step waits for finalization)." : "Solana vault recovery: PLAN ONLY. Nothing was signed or sent; add --send to submit.",
    "Network:   mainnet-beta (genesis verified on the RPC you supplied)",
    `Owner:     ${state.owner}`,
    `Program:   ${state.programId}   (compare it with the program shown next to your vault in Merrymen)`,
    `Vault:     ${state.vault}`,
    vaultState.session === NO_SESSION ? "Session:   none (already revoked)"
      : `Session:   ${vaultState.session}, expires ${when(vaultState.expiresAt)}${vaultState.paused ? ", buys paused" : ""}`,
    `Balances (${state.commitment}, slot ${state.slot}):`,
    `  USDG       ${formatSolanaUnits(state.usdg.amountRaw, 6)}${state.usdg.exists ? "" : " (no vault USDG account)"}${state.usdg.frozen ? " (frozen)" : ""}`,
    `  WSOL       ${formatSolanaUnits(state.wsol.amountRaw, 9)}${state.wsol.exists ? "" : " (no vault WSOL account)"}${state.wsol.unsyncedRaw > 0n ? ` (includes ${formatSolanaUnits(state.wsol.unsyncedRaw, 9)} unsynced)` : ""}`,
    `  SOL        ${formatSolanaUnits(state.sol.excess, 9)} above the vault account's rent reserve`,
    `  Owner SOL  ${formatSolanaUnits(state.ownerLamports, 9)} (pays the fees)`,
    "Steps:",
    state.sessionActive ? "  1. revoke_all: stops every session key at once. Sent alone and finalized before step 2."
      : "  1. revoke_all: not needed, no session key is set.",
  ];
  const parts = [plan.usdgRaw > 0n && `${formatSolanaUnits(plan.usdgRaw, 6)} USDG`, plan.wsolRaw > 0n && `${formatSolanaUnits(plan.wsolRaw, 9)} WSOL`,
    plan.solLamports > 0n && `${formatSolanaUnits(plan.solLamports, 9)} SOL`].filter(Boolean);
  lines.push(parts.length ? `  2. withdraw ${parts.join(", ")} to the owner${state.sessionActive ? " (re-read from finalized balances after step 1)" : ""}.`
    : "  2. nothing to withdraw.");
  if (parts.length) lines.push(`     Destinations: owner ${state.owner}, USDG account ${state.usdg.ownerAccount}, WSOL account ${state.wsol.ownerAccount}.`);
  if (plan.wsolRaw > 0n) lines.push("     WSOL arrives wrapped. Keep the owner WSOL account open if an agent may sell to it again.");
  for (const note of plan.skipped) lines.push(`  Note: ${note}`);
  if (state.ownerLamports < 10_000_000n) lines.push("  Note: the owner wallet holds under 0.01 SOL. Fees and any new token account (about 0.002 SOL each) are paid from it.");
  lines.push("  About 0.0165 SOL of rent stays in the vault accounts: the program has no close instruction.");
  return lines;
}

interface Block { blockhash: Blockhash; lastValidBlockHeight: bigint; slot: number }
async function latestBlock(rpc: SolanaLiveRpc): Promise<Block> {
  return rpc.read(async (read) => {
    const result = await read("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (!object(result) || !object(result.context) || !object(result.value) || typeof result.value.blockhash !== "string") fail("The Solana RPC returned a malformed blockhash.");
    canonical(result.value.blockhash, "blockhash");
    return { blockhash: result.value.blockhash as Blockhash, lastValidBlockHeight: BigInt(integer(result.value.lastValidBlockHeight)), slot: integer(result.context.slot) };
  });
}

export interface SolanaRecoveryIo {
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Total time to wait for one transaction to finalize or provably expire. */
  maxWaitMs?: number;
  pollMs?: number;
}
type Outcome = { signature: string; status: "finalized"; slot: number };

/** Sign one owner transaction, send it once, and wait until it is finalized or provably expired. */
async function sendAndFinalize(rpc: SolanaLiveRpc, keyPair: CryptoKeyPair, owner: string, instructions: Instruction[], label: string, io: SolanaRecoveryIo): Promise<Outcome> {
  const block = await latestBlock(rpc);
  const compiled = compileTransaction(setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight },
    setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))));
  const signed = await signTransaction([keyPair], compiled);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  if (Buffer.from(wire, "base64").length > 1232) fail("The recovery transaction is too large.");
  io.log(`${label}: sending ${signature}`);
  // Sent once, with preflight simulation. No automatic resend: an unknown
  // outcome is resolved by reading the chain, never by signing again here.
  let sent: string;
  try { sent = await rpc.send(wire, block.slot); }
  catch (error) {
    if (!(error instanceof SolanaRpcError)) throw error;
    fail(`${label} was not confirmed as submitted (${signature}): the RPC refused it, for example in its simulation, or its answer `
      + "could not be read. Nothing after it was sent. Wait about two minutes, then run the command again: it re-reads the chain before sending anything.");
  }
  if (sent !== signature) fail("The Solana RPC answered with a different signature. Check an explorer before running again.");
  const deadline = Date.now() + (io.maxWaitMs ?? 150_000);
  for (;;) {
    type Status = { kind: "failed" } | { kind: "finalized"; slot: number } | { kind: "waiting"; expired: boolean };
    const status = await rpc.read(async (read): Promise<Status> => {
      // Finalized height FIRST: once it is past the lifetime, every block that
      // could hold the transaction is final, so a later empty status proves it
      // never landed.
      const height = BigInt(integer(await read("getBlockHeight", [{ commitment: "finalized" }])));
      const result = await read("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (!object(result) || !Array.isArray(result.value) || result.value.length !== 1) fail("The Solana RPC returned a malformed status.");
      const state = result.value[0];
      if (state !== null && !object(state)) fail("The Solana RPC returned a malformed status.");
      if (state && state.err !== null && state.err !== undefined) return { kind: "failed" };
      if (state && state.confirmationStatus === "finalized") return { kind: "finalized", slot: integer(state.slot) };
      return { kind: "waiting", expired: state === null && height > block.lastValidBlockHeight };
    });
    if (status.kind === "failed") fail(`${label} failed on chain (${signature}). Nothing after it was sent. Review the plan and run again.`);
    if (status.kind === "finalized") { io.log(`${label}: finalized in slot ${status.slot}.`); return { signature, status: "finalized", slot: status.slot }; }
    if (status.expired) fail(`${label} expired without landing (${signature}). Nothing after it was sent. Run the command again.`);
    if (Date.now() > deadline) fail(`${label} is not finalized yet (${signature}). Check an explorer, then run the command again; it re-reads the chain first.`);
    await io.sleep(io.pollMs ?? 2_000);
  }
}

export interface SolanaRecoveryOptions {
  rpc: SolanaLiveRpc;
  programId: string;
  /** Public key for a plan; the key's own address when sending. */
  owner: string;
  keyPair?: CryptoKeyPair;
  send: boolean;
  /** The immutable program binary's SHA-256. A released program is checked against its own hash. */
  programSha256?: string;
  /** Sign for a program that is not a listed release, once its binary matches programSha256. */
  allowUnlistedProgram?: boolean;
  /** Released programs; defaults to SOLANA_VAULT_RELEASES. */
  releases?: readonly SolanaVaultRelease[];
}
export interface SolanaRecoveryResult {
  sent: boolean;
  plan: SolanaRecoveryState;
  revoke?: Outcome;
  withdraw?: Outcome;
  final?: SolanaRecoveryState;
}

export async function runSolanaRecovery(options: SolanaRecoveryOptions, io: SolanaRecoveryIo): Promise<SolanaRecoveryResult> {
  const { rpc, programId, owner } = options;
  canonical(programId, "program ID"); canonical(owner, "owner");
  if (options.send && !options.keyPair) fail("Sending needs the owner's key (--key-file).");
  // Before any RPC call: nothing is signed for a program that is not verified.
  const trust = solanaRecoveryProgramTrust(options);
  if (trust.sha256 !== undefined) {
    // Immutable (no upgrade authority) and hash-matched, so it cannot change before the sends.
    try { await verifySolanaVaultDeployment(rpc, programId, trust.sha256); }
    catch (error) {
      if (error instanceof SolanaRpcError) throw error;
      fail(trust.listed ? "The program at that address is not the immutable released binary. Nothing was signed or sent."
        : "The program at that address is not the immutable binary with the given SHA-256. Nothing was signed or sent.");
    }
    io.log(trust.listed ? "Program binary verified: the released Merrymen vault program, immutable, SHA-256 matches."
      : "Program binary verified against the given SHA-256 (immutable). It is NOT a released Merrymen vault program.");
  } else {
    io.log("Program binary NOT VERIFIED: not a released Merrymen vault program and no --program-sha256 given. This plan only reads; --send refuses it.");
  }
  const plan = await readSolanaRecoveryState(rpc, programId, owner, "confirmed");
  for (const line of describeSolanaRecovery(plan, options.send)) io.log(line);
  if (!options.send) return { sent: false, plan };
  if (plan.ownerLamports === 0n) fail(`The owner wallet has no SOL for fees. Send a little SOL (0.01 is plenty) to ${owner} and run again.`);
  if (!trust.listed) {
    io.log(`WARNING: ${programId} is not a released Merrymen vault program. Your key is about to sign instructions of this program,`);
    io.log("which can take the SOL in this wallet and the tokens in its USDG and WSOL accounts. Merrymen support never asks you to");
    io.log(`use --unlisted-program. Continue only if you deployed or audited this program yourself. Press Ctrl+C now to stop;`);
    io.log(`signing starts in ${SOLANA_RECOVER_UNLISTED_DELAY_MS / 1000} seconds.`);
    await io.sleep(SOLANA_RECOVER_UNLISTED_DELAY_MS);
  }

  const result: SolanaRecoveryResult = { sent: true, plan };
  // The plan's confirmed slot may be ahead of the finalized tip, and an RPC
  // refuses a finalized read below its minContextSlot; only a finalized
  // signature's slot is a safe floor.
  let minSlot = 1;
  const revoke = solanaRecoveryRevokeInstructions(plan);
  if (revoke.length) {
    result.revoke = await sendAndFinalize(rpc, options.keyPair!, owner, revoke, "Step 1 (revoke_all)", io);
    minSlot = result.revoke.slot;
  }
  // Amounts come only from finalized state after the revoke: no session can
  // move funds any more, and balances can only grow from here.
  const settled = await readSolanaRecoveryState(rpc, programId, owner, "finalized", minSlot);
  if (settled.sessionActive) fail("A session key is still set after revoke_all finalized. Nothing was withdrawn; run the command again.");
  const withdraw = solanaRecoveryWithdrawInstructions(settled);
  if (withdraw.length) {
    const amounts = solanaRecoveryWithdrawal(settled);
    io.log(`Step 2 (withdraw): ${formatSolanaUnits(amounts.usdgRaw, 6)} USDG, ${formatSolanaUnits(amounts.wsolRaw, 9)} WSOL, ${formatSolanaUnits(amounts.solLamports, 9)} SOL, from finalized slot ${settled.slot}.`);
    result.withdraw = await sendAndFinalize(rpc, options.keyPair!, owner, withdraw, "Step 2 (withdraw)", io);
    minSlot = result.withdraw.slot;
  } else io.log("Step 2 (withdraw): nothing left to withdraw.");
  result.final = await readSolanaRecoveryState(rpc, programId, owner, "finalized", minSlot);
  const left = solanaRecoveryWithdrawal(result.final);
  io.log(`Done. Left in the vault: ${formatSolanaUnits(left.usdgRaw, 6)} USDG, ${formatSolanaUnits(left.wsolRaw, 9)} WSOL, ${formatSolanaUnits(left.solLamports, 9)} SOL above rent.`);
  return result;
}
