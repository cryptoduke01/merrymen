import test from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT, parsePythSolUsd, readSolanaReferencePrice, solanaReferenceBound,
  solanaReferenceNotional, solanaReferenceToleranceBps, verifySolanaReferenceBound, SolanaReferencePriceError } from "./solana-reference-price";
import { pythAccount, pythReference } from "./solana-reference-price-fixture";

const NOW = 1_790_000_000_000;
const sell = { inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "1000000000", slippageBps: 50 };
const buy = { inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "25000000", slippageBps: 50 };

test("the pinned Pyth identities are canonical public keys", () => {
  for (const value of [PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT]) assert.equal(address(value), value);
});

test("reads a fresh, fully verified SOL/USD update at or after the trade's slot", async () => {
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => {
    calls.push([method, params]); return { context: { slot: 1001 }, value: pythAccount({ publishTimeMs: NOW - 10_000 }) };
  }, 1000, NOW);
  assert.deepEqual(calls, [["getAccountInfo", [PYTH_SOL_USD_ACCOUNT, { encoding: "base64", commitment: "confirmed", minContextSlot: 1000 }]]]);
  assert.equal(price.price, "50000000000"); assert.equal(price.exponent, -8); assert.equal(price.slot, 1001);
  await assert.rejects(readSolanaReferencePrice(async () => ({ context: { slot: 999 }, value: pythAccount({ publishTimeMs: NOW }) }), 1000, NOW), SolanaReferencePriceError);
});

test("refuses stale, future, uncertain, partial, foreign and malformed price accounts", () => {
  const good = { publishTimeMs: NOW - 1_000 };
  assert.doesNotThrow(() => parsePythSolUsd(pythAccount(good), 1000, NOW));
  for (const bad of [
    { ...good, publishTimeMs: NOW - 121_000 }, // stale
    { ...good, publishTimeMs: NOW + 6_000 }, // future-dated
    { ...good, conf: 500_000_001n }, // confidence wider than 1% of $500
    { ...good, level: 0 }, // Partial guardian verification
    { ...good, feedId: "11".repeat(32) }, // another feed
    { ...good, owner: "11111111111111111111111111111111" }, // not the Pyth receiver
    { ...good, price: 0n }, { ...good, price: -1n }, { ...good, exponent: 2 }, { ...good, exponent: -13 },
    { ...good, postedSlot: 1001n }, { ...good, postedSlot: 0n }, { ...good, length: 133 },
  ]) assert.throws(() => parsePythSolUsd(pythAccount(bad), 1000, NOW), SolanaReferencePriceError, JSON.stringify(bad, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  const tampered = pythAccount(good); tampered.data[0] = Buffer.from("x".repeat(134)).toString("base64");
  assert.throws(() => parsePythSolUsd(tampered, 1000, NOW), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd(null, 1000, NOW), SolanaReferencePriceError);
});

test("values both directions at the reference and floors guaranteed output by the tolerance", () => {
  const reference = pythReference(NOW); // $500 per SOL
  const s = solanaReferenceBound(sell, reference, 300);
  assert.equal(s.referenceOut, "500000000"); // 1 SOL is 500 USDG
  assert.equal(s.minOutFloor, "485000000");
  assert.equal(s.valueUsdg, "500000000");
  const b = solanaReferenceBound(buy, reference, 300);
  assert.equal(b.referenceOut, "50000000"); // 25 USDG is 0.05 SOL
  assert.equal(b.minOutFloor, "48500000");
  assert.equal(b.valueUsdg, "25000000");
  // A sell is charged at least what it is worth, whatever it was quoted at.
  assert.equal(solanaReferenceNotional(sell, "1", s), 500_000_000n);
  assert.equal(solanaReferenceNotional(sell, "510000000", s), 510_000_000n);
  assert.equal(solanaReferenceNotional(buy, "1", b), 25_000_000n);
  // The tolerance has to leave room for the trade's own slippage, and stays bounded.
  for (const tolerance of [50, 49, 1001]) assert.throws(() => solanaReferenceBound(sell, reference, tolerance), SolanaReferencePriceError);
  assert.throws(() => solanaReferenceBound({ ...sell, amountRaw: "1" }, reference, 300), SolanaReferencePriceError); // too small to value
  assert.throws(() => solanaReferenceBound({ ...sell, outputMint: SOLANA_WRAPPED_SOL_MINT }, reference, 300), SolanaReferencePriceError);
});

test("a stored bound must recompute exactly from its own reference and stay fresh", () => {
  const bound = solanaReferenceBound(sell, pythReference(NOW), 300);
  assert.deepEqual(verifySolanaReferenceBound(bound, sell, NOW + 1_000), bound);
  for (const forged of [{ ...bound, minOutFloor: "1" }, { ...bound, valueUsdg: "1" }, { ...bound, referenceOut: "1" }, { ...bound, toleranceBps: 1000 },
    { ...bound, reference: { ...bound.reference, price: "1" } }, { ...bound, reference: { ...bound.reference, account: PYTH_RECEIVER_PROGRAM } },
    { ...bound, reference: { ...bound.reference, postedSlot: bound.reference.slot + 1 } }]) {
    assert.throws(() => verifySolanaReferenceBound(forged, sell, NOW + 1_000), SolanaReferencePriceError);
  }
  assert.throws(() => verifySolanaReferenceBound(bound, { ...sell, amountRaw: "2000000000" }, NOW), SolanaReferencePriceError);
  assert.throws(() => verifySolanaReferenceBound(bound, sell, NOW + 121_000), SolanaReferencePriceError);
});

test("the tolerance setting defaults to 3% and refuses out-of-range or malformed values", () => {
  assert.equal(solanaReferenceToleranceBps({}), 300);
  assert.equal(solanaReferenceToleranceBps({ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "500" }), 500);
  for (const value of ["49", "1001", "3e2", "-300", "300.5", " 300"]) {
    assert.throws(() => solanaReferenceToleranceBps({ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: value }), SolanaReferencePriceError, value);
  }
});
