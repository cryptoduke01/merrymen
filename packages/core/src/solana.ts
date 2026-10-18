/**
 * The Solana paper boundary. These values describe simulated ExactIn swaps;
 * they confer no wallet authority and cannot select a live execution mode.
 * Amounts are SPL base units, kept as strings at the wire and bigint in math.
 */
import { CHAINS, SOLANA_USDG_MINT, canonicalId } from "./ids";

export const SOLANA_SLIPPAGE_BPS_MAX = 100;
export const SOLANA_QUOTE_MAX_AGE_MS = 30_000;
const U64_MAX = 18_446_744_073_709_551_615n;

/** Safe to show at a CLI boundary; messages never interpolate caller values. */
export class SolanaPaperValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaPaperValidationError";
  }
}

export interface SolanaPaperLimits {
  /** Integer micro-USDG (six decimals), not display dollars. */
  perTradeUsdg: string;
  /** Integer micro-USDG over the paper book's rolling 24-hour window. */
  dailyUsdg: string;
  maxOpsPerDay: number;
  maxDrawdownBps: number;
  expiresAtMs: number;
}

export interface SolanaSwapIntent {
  kind: "spl-swap";
  chain: typeof CHAINS.solana;
  mode: "paper";
  /** Unique within the owner's book; the durable ledger enforces replay safety. */
  requestId: string;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
}

/** A provider-normalized ExactIn quote, never a transaction or fill receipt. */
export interface SolanaQuote {
  source: "jupiter";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  slippageBps: number;
  contextSlot: number;
  quotedAtMs: number;
  expiresAtMs: number;
}

export interface SolanaMint {
  address: string;
  program: string;
  decimals: number;
  slot: number;
  observedAtMs: number;
  buyBlockedReasons: readonly string[];
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SolanaPaperValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new SolanaPaperValidationError(`${label} has missing or unsupported fields`);
  }
  return input;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SolanaPaperValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function publicKey(value: unknown, label: string): string {
  // canonicalId deliberately trims UI input; execution boundaries do not.
  if (typeof value !== "string" || value.length > 44 || canonicalId(CHAINS.solana, "account", value) !== value) {
    throw new SolanaPaperValidationError(`${label} must be a canonical Solana public key`);
  }
  return value;
}

/** Bounded before BigInt parsing; numbers, fractions, signs and leading zeros fail. */
export function parseSolanaRawAmount(value: unknown, allowZero = false): bigint {
  if (typeof value !== "string" || value.length > 20 || value.trim() !== value || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SolanaPaperValidationError("Solana raw amount must be a canonical integer string");
  }
  const amount = BigInt(value);
  if (amount > U64_MAX || (!allowZero && amount === 0n)) {
    throw new SolanaPaperValidationError(`Solana raw amount must be ${allowZero ? "nonnegative" : "positive"} and fit u64`);
  }
  return amount;
}

export function parseSolanaSwapIntent(value: unknown): SolanaSwapIntent {
  const input = record(value, ["kind", "chain", "mode", "requestId", "inputMint", "outputMint", "amountRaw", "slippageBps"], "Solana swap intent");
  if (input.kind !== "spl-swap" || input.chain !== CHAINS.solana || input.mode !== "paper") {
    throw new SolanaPaperValidationError("Solana swaps require spl-swap, Solana mainnet and paper mode");
  }
  if (typeof input.requestId !== "string" || input.requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.requestId) || input.requestId.trim() !== input.requestId) {
    throw new SolanaPaperValidationError("Solana requestId must contain 1–128 ASCII letters, digits, hyphens or underscores, starting with a letter or digit");
  }
  const inputMint = publicKey(input.inputMint, "inputMint");
  const outputMint = publicKey(input.outputMint, "outputMint");
  if ((inputMint === SOLANA_USDG_MINT) === (outputMint === SOLANA_USDG_MINT)) {
    throw new SolanaPaperValidationError("Solana paper swaps require exactly one USDG leg");
  }
  parseSolanaRawAmount(input.amountRaw);
  return {
    kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: input.requestId,
    inputMint, outputMint, amountRaw: input.amountRaw as string,
    slippageBps: integer(input.slippageBps, 0, SOLANA_SLIPPAGE_BPS_MAX, "slippageBps"),
  };
}

export function validateSolanaPaperLimits(value: unknown, nowMs: number): SolanaPaperLimits {
  timestamp(nowMs, "nowMs");
  const input = record(value, ["perTradeUsdg", "dailyUsdg", "maxOpsPerDay", "maxDrawdownBps", "expiresAtMs"], "Solana paper limits");
  const perTrade = parseSolanaRawAmount(input.perTradeUsdg);
  const daily = parseSolanaRawAmount(input.dailyUsdg);
  if (perTrade > daily) throw new SolanaPaperValidationError("Solana per-trade limit must not exceed the daily limit");
  const expiresAtMs = timestamp(input.expiresAtMs, "expiresAtMs");
  if (expiresAtMs <= nowMs) throw new SolanaPaperValidationError("Solana paper limits have expired");
  return {
    perTradeUsdg: input.perTradeUsdg as string, dailyUsdg: input.dailyUsdg as string,
    maxOpsPerDay: integer(input.maxOpsPerDay, 1, Number.MAX_SAFE_INTEGER, "maxOpsPerDay"),
    maxDrawdownBps: integer(input.maxDrawdownBps, 1, 10_000, "maxDrawdownBps"),
    expiresAtMs,
  };
}

/** Revalidate even typed callers: a network response or stored JSON can lie. */
export function validateSolanaQuote(quote: SolanaQuote, intent: SolanaSwapIntent, nowMs: number): void {
  timestamp(nowMs, "nowMs");
  const expected = parseSolanaSwapIntent(intent);
  const input = record(quote, ["source", "inputMint", "outputMint", "inAmount", "outAmount", "minOutAmount", "slippageBps", "contextSlot", "quotedAtMs", "expiresAtMs"], "Solana quote");
  if (input.source !== "jupiter" || input.inputMint !== expected.inputMint || input.outputMint !== expected.outputMint || input.inAmount !== expected.amountRaw || input.slippageBps !== expected.slippageBps) {
    throw new SolanaPaperValidationError("Solana quote does not match the requested ExactIn swap");
  }
  parseSolanaRawAmount(input.inAmount);
  const out = parseSolanaRawAmount(input.outAmount);
  const minOut = parseSolanaRawAmount(input.minOutAmount);
  const floor = out * BigInt(10_000 - expected.slippageBps) / 10_000n;
  if (minOut > out || minOut < floor) throw new SolanaPaperValidationError("Solana quote minimum output exceeds the requested slippage");
  integer(input.contextSlot, 1, Number.MAX_SAFE_INTEGER, "contextSlot");
  const quotedAtMs = timestamp(input.quotedAtMs, "quotedAtMs");
  const expiresAtMs = timestamp(input.expiresAtMs, "expiresAtMs");
  if (quotedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs <= quotedAtMs || expiresAtMs - quotedAtMs > SOLANA_QUOTE_MAX_AGE_MS || nowMs - quotedAtMs >= SOLANA_QUOTE_MAX_AGE_MS) {
    throw new SolanaPaperValidationError("Solana quote is stale, future-dated or has an invalid expiry");
  }
}

/** Namespace the standalone paper book without EVM lowercasing. */
export function solanaPaperAgentId(owner: string): `sol:${string}` {
  return `sol:${publicKey(owner, "owner")}`;
}
