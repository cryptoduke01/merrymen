/** Shared wire ABI for the bounded Solana custody program. No deployment is implied. */
import {
  address,
  getProgramDerivedAddress,
  type AccountMeta,
  type Instruction,
} from "@solana/kit";
import { base58Decode, base58Encode } from "./ids";

/** Local test identity only. Production MUST supply an explicitly verified immutable program. */
export const SOLANA_VAULT_LOCAL_TEST_PROGRAM =
  "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU";
/**
 * Released Merrymen vault programs: the program ID and the SHA-256 of its
 * deployed binary, i.e. the ProgramData account's bytes after its 45-byte
 * header up to the account's full size (it equals the .so file's hash only
 * when deployed without extra --max-len space). The owner recovery tool
 * (merrymen solana-recover) signs by default only for a program listed here,
 * after checking that its immutable binary matches. Empty until a release: a
 * release adds one frozen entry, reviewed, and it must match the deployment's
 * MERRYMEN_SOLANA_VAULT_PROGRAM and MERRYMEN_SOLANA_VAULT_PROGRAM_SHA256.
 */
export const SOLANA_VAULT_RELEASES: readonly { readonly programId: string; readonly sha256: string }[] = Object.freeze([]);
export const SOLANA_JUPITER_PROGRAM =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_CLASSIC_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";
export const SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR = Uint8Array.from([
  193, 32, 155, 51, 65, 214, 156, 129,
]);
export const SOLANA_VAULT_MAX_DAILY_OPS = 96;
/** Account layout version 2 adds the owner-signed WSOL input caps. */
export const SOLANA_VAULT_VERSION = 2;
export const SOLANA_VAULT_ACCOUNT_SIZE = 2441;
export const SOLANA_VAULT_DISCRIMINATOR = Uint8Array.from([
  211, 8, 232, 43, 2, 152, 117, 119,
]);
export const SOLANA_SWAP_EVENT_DISCRIMINATOR = Uint8Array.from([
  150, 166, 26, 225, 28, 89, 38, 79,
]);
const DISCRIMINATORS = {
  initialize: [48, 191, 163, 44, 71, 129, 63, 164],
  session: [242, 193, 143, 179, 150, 25, 122, 227],
  revoke: [147, 196, 234, 31, 86, 199, 8, 234],
  breaker: [119, 127, 52, 124, 188, 82, 139, 186],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  withdrawSol: [145, 131, 74, 136, 65, 137, 42, 38],
  execute: [56, 182, 124, 215, 155, 140, 157, 102],
} as const;
export class SolanaVaultValidationError extends Error {
  constructor(message = "Invalid Solana vault data") {
    super(message);
    this.name = "SolanaVaultValidationError";
  }
}
function pubkey(value: string): Uint8Array {
  try {
    const bytes = base58Decode(value);
    if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== value)
      throw new Error();
    return bytes;
  } catch {
    throw new SolanaVaultValidationError("Invalid Solana public key");
  }
}
function int(value: bigint, signed = false): Uint8Array {
  if (
    typeof value !== "bigint" ||
    value < (signed ? -(1n << 63n) : 0n) ||
    value > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
  )
    throw new SolanaVaultValidationError("Invalid Solana integer");
  const out = new Uint8Array(8);
  if (signed) new DataView(out.buffer).setBigInt64(0, value, true);
  else new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new SolanaVaultValidationError("Invalid Solana integer");
  return Uint8Array.of(value & 255, value >>> 8);
}
function concat(...values: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const v of values) {
    out.set(v, offset);
    offset += v.length;
  }
  return out;
}
function meta(value: string, role: 0 | 1 | 2 | 3): AccountMeta {
  pubkey(value);
  return { address: address(value), role };
}
function instruction(
  program: string,
  disc: readonly number[],
  accounts: AccountMeta[],
  ...data: Uint8Array[]
): Instruction {
  pubkey(program);
  return {
    programAddress: address(program),
    accounts,
    data: concat(Uint8Array.from(disc), ...data),
  };
}
export async function deriveSolanaVaultAddress(
  program: string,
  owner: string,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [new TextEncoder().encode("vault"), pubkey(owner)],
    })
  )[0];
}
export async function deriveSolanaSwapAuthority(
  program: string,
  vault: string,
  seq: bigint,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [new TextEncoder().encode("swap"), pubkey(vault), int(seq)],
    })
  )[0];
}
export async function deriveSolanaAta(
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM),
      seeds: [pubkey(owner), pubkey(tokenProgram), pubkey(mint)],
    })
  )[0];
}
export interface SolanaVaultState {
  version: number;
  bump: number;
  owner: string;
  session: string;
  sessionEpoch: bigint;
  seq: bigint;
  expiresAt: bigint;
  perTrade: bigint;
  daily: bigint;
  /** Lamports of WSOL a single sell may put in, and over the rolling 24 hours. */
  perTradeWsol: bigint;
  dailyWsol: bigint;
  maxOps: number;
  paused: boolean;
  debits: { timestamp: bigint; notional: bigint; wsol: bigint }[];
}
export interface SolanaSwapExecutedEvent {
  vault: string;
  owner: string;
  session: string;
  sessionEpoch: bigint;
  seq: bigint;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  amountOut: bigint;
  timestamp: bigint;
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number) {
    if (this.offset + n > this.bytes.length)
      throw new SolanaVaultValidationError();
    const b = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u16() {
    const b = this.take(2);
    return b[0]! + b[1]! * 256;
  }
  u32() {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(
      0,
      true,
    );
  }
  u64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(
      0,
      true,
    );
  }
  i64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(
      0,
      true,
    );
  }
  key() {
    return base58Encode(this.take(32));
  }
  discriminator(expected: Uint8Array) {
    const actual = this.take(8);
    if (actual.some((v, i) => v !== expected[i]))
      throw new SolanaVaultValidationError();
  }
}
export function decodeSolanaVaultAccount(bytes: Uint8Array): SolanaVaultState {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== SOLANA_VAULT_ACCOUNT_SIZE
  )
    throw new SolanaVaultValidationError();
  const r = new Reader(bytes);
  r.discriminator(SOLANA_VAULT_DISCRIMINATOR);
  const version = r.u8(),
    bump = r.u8(),
    owner = r.key(),
    session = r.key(),
    sessionEpoch = r.u64(),
    seq = r.u64(),
    expiresAt = r.i64(),
    perTrade = r.u64(),
    daily = r.u64(),
    perTradeWsol = r.u64(),
    dailyWsol = r.u64(),
    maxOps = r.u16(),
    paused = r.u8(),
    count = r.u32();
  if (
    version !== SOLANA_VAULT_VERSION ||
    paused > 1 ||
    maxOps > SOLANA_VAULT_MAX_DAILY_OPS ||
    count > SOLANA_VAULT_MAX_DAILY_OPS
  )
    throw new SolanaVaultValidationError();
  const debits = Array.from({ length: count }, () => ({
    timestamp: r.i64(),
    notional: r.u64(),
    wsol: r.u64(),
  }));
  // Anchor does not clear old Vec capacity on shrink. Ignore unused allocated bytes.
  return {
    version,
    bump,
    owner,
    session,
    sessionEpoch,
    seq,
    expiresAt,
    perTrade,
    daily,
    perTradeWsol,
    dailyWsol,
    maxOps,
    paused: paused === 1,
    debits,
  };
}
export function decodeSolanaSwapEvent(
  bytes: Uint8Array,
): SolanaSwapExecutedEvent {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 208)
    throw new SolanaVaultValidationError();
  const r = new Reader(bytes);
  r.discriminator(SOLANA_SWAP_EVENT_DISCRIMINATOR);
  return {
    vault: r.key(),
    owner: r.key(),
    session: r.key(),
    sessionEpoch: r.u64(),
    seq: r.u64(),
    inputMint: r.key(),
    outputMint: r.key(),
    amountIn: r.u64(),
    amountOut: r.u64(),
    timestamp: r.i64(),
  };
}
export function buildInitializeSolanaVaultInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
}): Instruction {
  return instruction(p.programAddress, DISCRIMINATORS.initialize, [
    meta(p.vault, 1),
    meta(p.owner, 3),
    meta(SOLANA_SYSTEM_PROGRAM, 0),
  ]);
}
export function buildCreateSolanaSessionInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  session: string;
  perTrade: bigint;
  daily: bigint;
  perTradeWsol: bigint;
  dailyWsol: bigint;
  maxOps: number;
  expiresAt: bigint;
}): Instruction {
  if (
    p.perTrade <= 0n ||
    p.perTrade > p.daily ||
    typeof p.perTradeWsol !== "bigint" ||
    typeof p.dailyWsol !== "bigint" ||
    p.perTradeWsol <= 0n ||
    p.perTradeWsol > p.dailyWsol ||
    p.maxOps < 1 ||
    p.maxOps > SOLANA_VAULT_MAX_DAILY_OPS ||
    p.session === p.owner ||
    p.session === p.vault
  )
    throw new SolanaVaultValidationError("Invalid Solana session limits");
  return instruction(
    p.programAddress,
    DISCRIMINATORS.session,
    [meta(p.vault, 1), meta(p.owner, 2)],
    pubkey(p.session),
    int(p.perTrade),
    int(p.daily),
    int(p.perTradeWsol),
    int(p.dailyWsol),
    u16(p.maxOps),
    int(p.expiresAt, true),
  );
}
export function buildRevokeSolanaSessionsInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
}): Instruction {
  return instruction(p.programAddress, DISCRIMINATORS.revoke, [
    meta(p.vault, 1),
    meta(p.owner, 2),
  ]);
}
export function buildSetSolanaBreakerInstruction(p: {
  programAddress: string;
  vault: string;
  authority: string;
  paused: boolean;
}): Instruction {
  if (typeof p.paused !== "boolean") throw new SolanaVaultValidationError();
  return instruction(
    p.programAddress,
    DISCRIMINATORS.breaker,
    [meta(p.vault, 1), meta(p.authority, 2)],
    Uint8Array.of(Number(p.paused)),
  );
}
export function buildWithdrawSolanaVaultInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  mint: string;
  vaultToken: string;
  ownerToken: string;
  tokenProgram: string;
  amount: bigint;
}): Instruction {
  return instruction(
    p.programAddress,
    DISCRIMINATORS.withdraw,
    [
      meta(p.vault, 1),
      meta(p.owner, 2),
      meta(p.mint, 0),
      meta(p.vaultToken, 1),
      meta(p.ownerToken, 1),
      meta(p.tokenProgram, 0),
    ],
    int(p.amount),
  );
}
export interface ExecuteSolanaSwapParameters {
  programAddress: string;
  vault: string;
  sessionSigner: string;
  feePayer: string;
  inputMint: string;
  outputMint: string;
  vaultInput: string;
  vaultOutput: string;
  swapAuthority: string;
  tempInput: string;
  /**
   * The owner's input-mint ATA, or null to leave it out. The program needs it only to
   * return tokens already sitting in `tempInput` (a donation), and fails closed without it.
   * Null encodes Anchor's absent optional account: the vault program ID, read-only.
   */
  ownerRefund: string | null;
  inputTokenProgram: string;
  outputTokenProgram: string;
  expectedSeq: bigint;
  sessionEpoch: bigint;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  slippageBps: number;
  routeData: Uint8Array;
  /** Jupiter instruction accounts in their original order. No outer signer is forwarded. */
  routeAccounts: readonly { address: string; role: 0 | 1 | 2 | 3 }[];
}
export function buildExecuteSolanaSwapInstruction(
  p: ExecuteSolanaSwapParameters,
): Instruction {
  if (
    p.amountIn <= 0n ||
    p.minOut <= 0n ||
    p.slippageBps > 100 ||
    // The program reads the route's last 19 bytes after an 8-byte discriminator
    // and refuses anything shorter than 32 bytes.
    p.routeData.length < 32 ||
    p.routeData.length > 2048 ||
    p.routeAccounts.length < 11 ||
    p.routeAccounts.length > 64 ||
    p.ownerRefund === p.programAddress
  )
    throw new SolanaVaultValidationError("Invalid Solana swap");
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, p.routeData.length, true);
  const fixed = [
    meta(p.vault, 1),
    meta(p.sessionSigner, 2),
    meta(p.feePayer, 3),
    meta(p.inputMint, 0),
    meta(p.outputMint, 0),
    meta(p.vaultInput, 1),
    meta(p.vaultOutput, 1),
    meta(p.swapAuthority, 0),
    meta(p.tempInput, 1),
    meta(p.inputTokenProgram, 0),
    meta(p.outputTokenProgram, 0),
    meta(SOLANA_JUPITER_PROGRAM, 0),
    meta(SOLANA_ASSOCIATED_TOKEN_PROGRAM, 0),
    meta(SOLANA_SYSTEM_PROGRAM, 0),
    p.ownerRefund === null ? meta(p.programAddress, 0) : meta(p.ownerRefund, 1),
  ];
  const routes = p.routeAccounts.map((a) =>
    meta(a.address, (a.role & 1) as 0 | 1),
  );
  return instruction(
    p.programAddress,
    DISCRIMINATORS.execute,
    [...fixed, ...routes],
    int(p.expectedSeq),
    int(p.sessionEpoch),
    int(p.amountIn),
    int(p.minOut),
    int(p.deadline, true),
    u16(p.slippageBps),
    length,
    p.routeData,
  );
}

/** Owner-only recovery of native SOL above the custody account's rent reserve. */
export function buildWithdrawSolanaNativeInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  amount: bigint;
}): Instruction {
  if (p.amount <= 0n)
    throw new SolanaVaultValidationError("Invalid Solana withdrawal");
  return instruction(
    p.programAddress,
    DISCRIMINATORS.withdrawSol,
    [meta(p.vault, 1), meta(p.owner, 3)],
    int(p.amount),
  );
}
