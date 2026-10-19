/**
 * An independent price for live Solana trades: Pyth's SOL/USD price account,
 * read through the configured Solana RPC. It is a floor, not a fill price. A
 * live trade whose guaranteed output is far below what SOL is worth is refused,
 * whatever Jupiter quoted, and a sell is charged at least what it is worth.
 *
 * The account, owner program, feed id and PriceUpdateV2 layout are pinned from
 * Pyth's documentation and were NOT read from mainnet when this was written.
 * Confirm them on mainnet before live; any mismatch fails closed.
 */
import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { parseSolanaRawAmount } from "../../packages/core/src/solana";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import type { SolanaLiveRead } from "./solana-live-rpc";

/** Pyth Solana Receiver: owner of every posted PriceUpdateV2 account. */
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** Pyth's sponsored SOL/USD price feed account (shard 0). */
export const PYTH_SOL_USD_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** Sponsored feeds post on a heartbeat and on price moves; older than this is unproven. */
export const SOLANA_REFERENCE_MAX_AGE_MS = 120_000;
export const SOLANA_REFERENCE_MAX_FUTURE_MS = 5_000;
/** Confidence interval at most 1% of price. */
export const SOLANA_REFERENCE_MAX_CONF_BPS = 100;
export const SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS = 300;
export const SOLANA_REFERENCE_MIN_TOLERANCE_BPS = 50;
export const SOLANA_REFERENCE_MAX_TOLERANCE_BPS = 1_000;
const DISCRIMINATOR = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);
// 8 discriminator + 32 write authority + 2 verification level (1 when Full) + 32 feed id
// + price i64, conf u64, exponent i32, publish/prev publish i64, ema price i64, ema conf u64, posted slot u64.
const PRICE_UPDATE_LEN = 134;
const FULL = 1;

export class SolanaReferencePriceError extends Error {
  constructor() { super("The independent SOL price is unavailable or unproven; no live trade was admitted."); this.name = "SolanaReferencePriceError"; }
}
function fail(): never { throw new SolanaReferencePriceError(); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safe(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(); return value;
}

export interface SolanaReferencePrice {
  source: "pyth"; account: string; feedId: string;
  /** USD per SOL is price × 10^exponent. */
  price: string; conf: string; exponent: number;
  publishTimeMs: number; postedSlot: number; slot: number;
}
export interface SolanaReferenceBound {
  reference: SolanaReferencePrice;
  toleranceBps: number;
  /** What the trade's input is worth at the reference, in output base units. */
  referenceOut: string;
  /** The lowest guaranteed output a live trade may sign for. */
  minOutFloor: string;
  /** USDG notional at the reference: a buy's input, a sell's reference proceeds. */
  valueUsdg: string;
}

/** Parse and check one PriceUpdateV2 account as returned by getAccountInfo base64. */
export function parsePythSolUsd(raw: unknown, contextSlot: number, nowMs: number): SolanaReferencePrice {
  safe(contextSlot); safe(nowMs);
  if (!object(raw) || raw.owner !== PYTH_RECEIVER_PROGRAM || raw.executable !== false ||
      !Array.isArray(raw.data) || raw.data[1] !== "base64" || typeof raw.data[0] !== "string") return fail();
  const data = Buffer.from(raw.data[0], "base64");
  if (data.toString("base64") !== raw.data[0] || data.length !== PRICE_UPDATE_LEN || !data.subarray(0, 8).equals(DISCRIMINATOR)) return fail();
  // Partial verification has fewer guardian signatures behind it; only Full counts.
  if (data[40] !== FULL) return fail();
  const feedId = data.subarray(41, 73).toString("hex");
  if (feedId !== PYTH_SOL_USD_FEED_ID) return fail();
  const price = data.readBigInt64LE(73), conf = data.readBigUInt64LE(81), exponent = data.readInt32LE(89);
  const publishTime = data.readBigInt64LE(93), postedSlot = data.readBigUInt64LE(125);
  if (price <= 0n || exponent < -12 || exponent > 0 || conf * 10_000n > price * BigInt(SOLANA_REFERENCE_MAX_CONF_BPS)) return fail();
  if (publishTime <= 0n || publishTime > BigInt(Number.MAX_SAFE_INTEGER) / 1000n) return fail();
  const publishTimeMs = Number(publishTime) * 1000;
  if (publishTimeMs > nowMs + SOLANA_REFERENCE_MAX_FUTURE_MS || nowMs - publishTimeMs > SOLANA_REFERENCE_MAX_AGE_MS) return fail();
  if (postedSlot < 1n || postedSlot > BigInt(contextSlot)) return fail();
  return { source: "pyth", account: PYTH_SOL_USD_ACCOUNT, feedId, price: price.toString(), conf: conf.toString(), exponent,
    publishTimeMs, postedSlot: Number(postedSlot), slot: contextSlot };
}

/** Read the reference at or after `minContextSlot`. Never touches Jupiter. */
export async function readSolanaReferencePrice(read: SolanaLiveRead, minContextSlot: number, nowMs: number): Promise<SolanaReferencePrice> {
  const result = await read("getAccountInfo", [PYTH_SOL_USD_ACCOUNT, { encoding: "base64", commitment: "confirmed", minContextSlot }]);
  if (!object(result) || !object(result.context) || !Object.hasOwn(result, "value")) return fail();
  const slot = safe(result.context.slot);
  if (slot < minContextSlot) return fail();
  return parsePythSolUsd(result.value, slot, nowMs);
}

export function solanaReferenceToleranceBps(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS;
  if (raw === undefined || raw === "") return SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || value < SOLANA_REFERENCE_MIN_TOLERANCE_BPS || value > SOLANA_REFERENCE_MAX_TOLERANCE_BPS) return fail();
  return value;
}

/**
 * Bound a USDG↔WSOL ExactIn trade by the reference. USDG is taken as $1; a depeg
 * beyond the tolerance refuses trading rather than guessing. The tolerance must
 * exceed the trade's own slippage, or no honest fill could pass.
 */
export function solanaReferenceBound(intent: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number },
  reference: SolanaReferencePrice, toleranceBps: number): SolanaReferenceBound {
  if (!Number.isSafeInteger(toleranceBps) || toleranceBps < SOLANA_REFERENCE_MIN_TOLERANCE_BPS || toleranceBps > SOLANA_REFERENCE_MAX_TOLERANCE_BPS ||
      !Number.isSafeInteger(intent.slippageBps) || intent.slippageBps < 0 || toleranceBps <= intent.slippageBps) return fail();
  const amount = parseSolanaRawAmount(intent.amountRaw), price = BigInt(reference.price), exponent = reference.exponent;
  if (price <= 0n || !Number.isSafeInteger(exponent) || exponent < -12 || exponent > 0) return fail();
  // USDG has 6 decimals and wrapped SOL 9, so one lamport is worth price × 10^(exponent - 3) micro-USDG.
  const scale = 10n ** BigInt(3 - exponent);
  let referenceOut: bigint, valueUsdg: bigint;
  if (intent.inputMint === SOLANA_WRAPPED_SOL_MINT && intent.outputMint === SOLANA_USDG_MINT) {
    referenceOut = amount * price / scale; valueUsdg = referenceOut;
  } else if (intent.inputMint === SOLANA_USDG_MINT && intent.outputMint === SOLANA_WRAPPED_SOL_MINT) {
    referenceOut = amount * scale / price; valueUsdg = amount;
  } else return fail();
  // A trade too small to value at the reference cannot be bounded by it.
  if (referenceOut <= 0n) return fail();
  const minOutFloor = referenceOut * BigInt(10_000 - toleranceBps) / 10_000n;
  if (minOutFloor <= 0n) return fail();
  return { reference: structuredClone(reference), toleranceBps, referenceOut: referenceOut.toString(), minOutFloor: minOutFloor.toString(), valueUsdg: valueUsdg.toString() };
}

/**
 * Recompute a stored bound from its own reference and the intent, and check it
 * is still fresh. Admission calls this so a bound can't be edited or replayed.
 */
export function verifySolanaReferenceBound(bound: SolanaReferenceBound, intent: Parameters<typeof solanaReferenceBound>[0], nowMs: number): SolanaReferenceBound {
  if (!object(bound) || !object(bound.reference)) return fail();
  const r = bound.reference;
  try { address(r.account); } catch { return fail(); }
  if (r.source !== "pyth" || r.account !== PYTH_SOL_USD_ACCOUNT || r.feedId !== PYTH_SOL_USD_FEED_ID ||
      typeof r.price !== "string" || typeof r.conf !== "string" || !/^[1-9][0-9]{0,18}$/.test(r.price) || !/^(0|[1-9][0-9]{0,19})$/.test(r.conf) ||
      BigInt(r.conf) * 10_000n > BigInt(r.price) * BigInt(SOLANA_REFERENCE_MAX_CONF_BPS)) return fail();
  safe(r.publishTimeMs); safe(r.postedSlot); safe(r.slot); safe(nowMs);
  if (r.postedSlot < 1 || r.postedSlot > r.slot || r.publishTimeMs > nowMs + SOLANA_REFERENCE_MAX_FUTURE_MS || nowMs - r.publishTimeMs > SOLANA_REFERENCE_MAX_AGE_MS) return fail();
  const expected = solanaReferenceBound(intent, r, bound.toleranceBps);
  if (expected.referenceOut !== bound.referenceOut || expected.minOutFloor !== bound.minOutFloor || expected.valueUsdg !== bound.valueUsdg) return fail();
  return expected;
}

/** The USDG notional admission charges: a buy's input, a sell's quoted or reference proceeds, whichever is larger. */
export function solanaReferenceNotional(intent: { inputMint: string; amountRaw: string }, quotedOut: string, bound: SolanaReferenceBound): bigint {
  if (intent.inputMint === SOLANA_USDG_MINT) return parseSolanaRawAmount(intent.amountRaw);
  const quoted = parseSolanaRawAmount(quotedOut), reference = parseSolanaRawAmount(bound.valueUsdg);
  return quoted > reference ? quoted : reference;
}
