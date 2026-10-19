/** Synthetic Pyth SOL/USD accounts for tests. No network data. */
import { createHash } from "node:crypto";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID, solanaReferenceBound, type SolanaReferenceBound,
  type SolanaReferencePrice } from "./solana-reference-price";

export interface PythFixture {
  price?: bigint; conf?: bigint; exponent?: number; publishTimeMs: number; postedSlot?: bigint;
  feedId?: string; level?: number; owner?: string; length?: number;
}
/** A PriceUpdateV2 account as getAccountInfo returns it (base64). Default: $500.00000000/SOL. */
export function pythAccount(f: PythFixture) {
  const data = Buffer.alloc(f.length ?? 134);
  createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8).copy(data);
  data[40] = f.level ?? 1;
  Buffer.from(f.feedId ?? PYTH_SOL_USD_FEED_ID, "hex").copy(data, 41);
  data.writeBigInt64LE(f.price ?? 50_000_000_000n, 73);
  data.writeBigUInt64LE(f.conf ?? 10_000_000n, 81);
  data.writeInt32LE(f.exponent ?? -8, 89);
  data.writeBigInt64LE(BigInt(Math.floor(f.publishTimeMs / 1000)), 93);
  data.writeBigUInt64LE(f.postedSlot ?? 999n, 125);
  return { owner: f.owner ?? PYTH_RECEIVER_PROGRAM, executable: false, lamports: 1_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}
/** A reference read at `slot`, published at `nowMs`, at `usdPerSol` (8 decimals). */
export function pythReference(nowMs: number, usdPerSol = 50_000_000_000n, slot = 1000): SolanaReferencePrice {
  return { source: "pyth", account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", feedId: PYTH_SOL_USD_FEED_ID,
    price: usdPerSol.toString(), conf: "10000000", exponent: -8, publishTimeMs: Math.floor(nowMs / 1000) * 1000, postedSlot: slot - 1, slot };
}
export function pythBound(intent: Parameters<typeof solanaReferenceBound>[0], nowMs: number, usdPerSol?: bigint, slot?: number, toleranceBps = 300): SolanaReferenceBound {
  return solanaReferenceBound(intent, pythReference(nowMs, usdPerSol, slot), toleranceBps);
}
