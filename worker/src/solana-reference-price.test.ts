import test from "node:test";
import assert from "node:assert/strict";
import { address, getBase58Decoder } from "@solana/kit";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { PYTH_PUSH_ORACLE_PROGRAM, PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD,
  SOLANA_PYTH_DEFAULT_GENERATION, SOLANA_PYTH_FEEDS, derivePythPriceFeedAccount, parsePythSolUsd, readSolanaReferencePrice,
  solanaPythFeed, solanaPythGeneration, solanaReferenceBound, solanaReferenceNotional, solanaReferenceToleranceBps,
  verifySolanaReferenceBound, SolanaReferencePriceError, type SolanaPythGeneration } from "./solana-reference-price";
import { PYTH_SOL_USD_MAINNET_SNAPSHOT, PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, pythAccount, pythReference,
  pythSnapshotResult } from "./solana-reference-price-fixture";

const NOW = 1_790_000_000_000;
const sell = { inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "1000000000", slippageBps: 50 };
const buy = { inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "25000000", slippageBps: 50 };

test("the pinned Pyth identities are canonical public keys", () => {
  for (const value of [PYTH_RECEIVER_PROGRAM, PYTH_PUSH_ORACLE_PROGRAM, PYTH_SOL_USD_ACCOUNT]) assert.equal(address(value), value);
});

// Pyth's upgraded (2026-08-26) push oracle. Not used by the module; a second real derivation to check against.
const UPGRADED_PUSH_ORACLE = "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou";

test("the pinned account is the push oracle's sponsored shard-0 PDA for the SOL/USD feed id", async () => {
  assert.equal(PYTH_SPONSORED_SHARD, 0);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID), PYTH_SOL_USD_ACCOUNT);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, PYTH_PUSH_ORACLE_PROGRAM), PYTH_SOL_USD_ACCOUNT);
  // Each of these was read on mainnet on 2026-10-19: a SOL/USD PriceUpdateV2 owned by its generation's receiver.
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 1), "6bWEn5B8eJCRAek5acd3R7d4Sx3e7JWvt84srqqfYgt");
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 0, UPGRADED_PUSH_ORACLE), PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.account);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 1, UPGRADED_PUSH_ORACLE), "GGdMnioYUC8qFWrWXJP2n3YHAns49MJW87CeuT7sgvrf");
  for (const [feed, shard] of [[PYTH_SOL_USD_FEED_ID.toUpperCase(), 0], [`0x${PYTH_SOL_USD_FEED_ID}`, 0], [PYTH_SOL_USD_FEED_ID.slice(2), 0],
    [PYTH_SOL_USD_FEED_ID, -1], [PYTH_SOL_USD_FEED_ID, 65_536], [PYTH_SOL_USD_FEED_ID, 0.5]] as const) {
    await assert.rejects(derivePythPriceFeedAccount(feed, shard), SolanaReferencePriceError, `${feed} ${shard}`);
  }
});

test("decodes a real mainnet SOL/USD account read with this module's own call", async () => {
  const snap = PYTH_SOL_USD_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  assert.equal(snap.account, PYTH_SOL_USD_ACCOUNT);
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => { calls.push([method, params]); return result; }, snap.minContextSlot, snap.fetchedAtMs);
  assert.deepEqual(calls, [[snap.request.method, snap.request.params]]);
  // $105.16339767 per SOL, ±3 bps, published 1.2 s before the answer arrived.
  assert.deepEqual(price, { source: "pyth", account: PYTH_SOL_USD_ACCOUNT, feedId: PYTH_SOL_USD_FEED_ID, price: "10516339767", conf: "3289584",
    exponent: -8, publishTimeMs: 1_792_380_064_000, postedSlot: 458_681_624, slot: 458_681_624 });
  // The bytes the decoder skips agree with the push-oracle layout: the PDA is its own
  // write authority, the level is Full (one byte), and the byte left for Partial is unused.
  const data = Buffer.from((result.value.data as [string, string])[0], "base64");
  assert.equal(getBase58Decoder().decode(data.subarray(8, 40)), PYTH_SOL_USD_ACCOUNT);
  assert.equal(data[40], 1); assert.equal(data[133], 0);
  assert.equal(data.readBigInt64LE(101), 1_792_380_063n); // previous publish time
  assert.equal(data.readBigInt64LE(109), 10_498_945_660n); // EMA price, $104.99
  // What it bounds: 1 SOL sold is worth 105.163397 USDG; 25 USDG buys 0.237725297 SOL.
  const sell1 = solanaReferenceBound(sell, price, 300), buy25 = solanaReferenceBound(buy, price, 300);
  assert.deepEqual([sell1.referenceOut, sell1.minOutFloor], ["105163397", "102008495"]);
  assert.deepEqual([buy25.referenceOut, buy25.minOutFloor], ["237725297", "230593538"]);
  // The same real bytes go stale 120 s after publication.
  assert.doesNotThrow(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_000));
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_001), SolanaReferencePriceError);
  // And a context slot before the post is refused.
  assert.throws(() => parsePythSolUsd(result.value, 458_681_623, snap.fetchedAtMs), SolanaReferencePriceError);
});

test("a real upgraded-generation account shares the layout but is refused while the current generation is selected", () => {
  const snap = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  assert.notEqual(snap.account, SOLANA_PYTH_FEEDS.current.account);
  assert.equal(result.value.owner, "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // Relabelled to the current owner, the same decoder reads it, and it agrees with the current feed to 0.01 bp.
  const decoded = parsePythSolUsd({ ...result.value, owner: SOLANA_PYTH_FEEDS.current.receiverProgram }, result.context.slot, snap.fetchedAtMs, "current");
  assert.deepEqual([decoded.price, decoded.exponent, decoded.publishTimeMs, decoded.postedSlot], ["10516352961", -8, 1_792_380_063_000, 458_681_625]);
});

// Pyth's 2026-08-26 Core upgrade, as derived on-chain (not from Pyth's contradictory upgrade table).
const UPGRADED = { receiverProgram: "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp", priceFeedProgram: "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou",
  account: "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE" };

test("both Pyth generations are pinned, frozen and distinct, and each account is its own price feed program's shard-0 PDA", async () => {
  assert.deepEqual(Object.keys(SOLANA_PYTH_FEEDS).sort(), ["current", "upgraded"]);
  assert.deepEqual(SOLANA_PYTH_FEEDS.current, { generation: "current", receiverProgram: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    priceFeedProgram: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT", account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE" });
  assert.deepEqual(SOLANA_PYTH_FEEDS.upgraded, { generation: "upgraded", ...UPGRADED });
  assert.equal(SOLANA_PYTH_FEEDS.upgraded.account, PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.account);
  // Configuration picks a generation; it can never edit one.
  assert.ok(Object.isFrozen(SOLANA_PYTH_FEEDS) && Object.isFrozen(SOLANA_PYTH_FEEDS.current) && Object.isFrozen(SOLANA_PYTH_FEEDS.upgraded));
  assert.throws(() => { (SOLANA_PYTH_FEEDS.current as { account: string }).account = UPGRADED.account; }, TypeError);
  // The unqualified constants are the default generation's.
  assert.deepEqual([PYTH_RECEIVER_PROGRAM, PYTH_PUSH_ORACLE_PROGRAM, PYTH_SOL_USD_ACCOUNT],
    [SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].receiverProgram, SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].priceFeedProgram,
      SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].account]);
  for (const generation of ["current", "upgraded"] as const) {
    const feed = solanaPythFeed(generation);
    assert.equal(feed, SOLANA_PYTH_FEEDS[generation]);
    for (const value of [feed.receiverProgram, feed.priceFeedProgram, feed.account]) assert.equal(address(value), value);
    assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, feed.priceFeedProgram), feed.account, generation);
    // Nor is it the other generation's program's PDA.
    const other = SOLANA_PYTH_FEEDS[generation === "current" ? "upgraded" : "current"];
    assert.notEqual(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, other.priceFeedProgram), feed.account, generation);
  }
  const all = Object.values(SOLANA_PYTH_FEEDS).flatMap(f => [f.receiverProgram, f.priceFeedProgram, f.account]);
  assert.equal(new Set(all).size, 6);
  for (const bad of ["Current", "UPGRADED", "", "both", "toString", "__proto__"]) {
    assert.throws(() => solanaPythFeed(bad as SolanaPythGeneration), SolanaReferencePriceError, bad);
  }
});

test("the generation setting defaults to the default generation and accepts only current or upgraded", () => {
  assert.equal(SOLANA_PYTH_DEFAULT_GENERATION, "current");
  assert.equal(solanaPythGeneration({}), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "" }), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "current" }), "current");
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }), "upgraded");
  for (const value of ["Upgraded", "UPGRADED", " upgraded", "upgraded ", "new", "both", "1", "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou", "toString"]) {
    assert.throws(() => solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: value }), SolanaReferencePriceError, value);
  }
});

test("with the upgraded generation selected, the real upgraded account is read and bounded and the current one is refused", async () => {
  const snap = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => { calls.push([method, params]); return result; }, snap.minContextSlot, snap.fetchedAtMs,
    { generation: "upgraded" });
  // The same call shape as the current account's, to the upgraded account.
  assert.deepEqual(calls, [[snap.request.method, snap.request.params]]);
  assert.equal(snap.request.params[0], UPGRADED.account);
  // $105.16352961 per SOL, ±3 bps; it agrees with the current snapshot to 0.01 bp.
  assert.deepEqual(price, { source: "pyth", account: UPGRADED.account, feedId: PYTH_SOL_USD_FEED_ID, price: "10516352961", conf: "3228192",
    exponent: -8, publishTimeMs: 1_792_380_063_000, postedSlot: 458_681_625, slot: 458_681_625 });
  const data = Buffer.from((result.value.data as [string, string])[0], "base64");
  assert.equal(getBase58Decoder().decode(data.subarray(8, 40)), UPGRADED.account); // the PDA is its own write authority
  // A bound read from it verifies under "upgraded" only.
  const bound = solanaReferenceBound(sell, price, 300);
  assert.deepEqual([bound.referenceOut, bound.minOutFloor], ["105163529", "102008623"]);
  assert.deepEqual(verifySolanaReferenceBound(bound, sell, snap.fetchedAtMs, "upgraded"), bound);
  assert.throws(() => verifySolanaReferenceBound(bound, sell, snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // And a current-generation bound does not verify under "upgraded".
  const current = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  const currentBound = solanaReferenceBound(sell, parsePythSolUsd(current.value, current.context.slot, snap.fetchedAtMs, "current"), 300);
  assert.throws(() => verifySolanaReferenceBound(currentBound, sell, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
  assert.throws(() => verifySolanaReferenceBound({ ...currentBound, reference: { ...currentBound.reference, account: UPGRADED.account } }, sell,
    snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // The current account's real bytes are refused under "upgraded", even when served for the upgraded address,
  // and so are the upgraded bytes relabelled to the current receiver.
  assert.throws(() => parsePythSolUsd(current.value, current.context.slot, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
  await assert.rejects(readSolanaReferencePrice(async () => current, snap.minContextSlot, snap.fetchedAtMs, { generation: "upgraded" }), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd({ ...result.value, owner: SOLANA_PYTH_FEEDS.current.receiverProgram }, result.context.slot, snap.fetchedAtMs, "upgraded"),
    SolanaReferencePriceError);
  // Freshness and slot checks are the generation-independent ones.
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_001, "upgraded"), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd(result.value, 458_681_624, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
});

test("without an explicit generation, reads and checks follow MERRYMEN_SOLANA_PYTH_GENERATION", async t => {
  const saved = Object.hasOwn(process.env, "MERRYMEN_SOLANA_PYTH_GENERATION") ? process.env.MERRYMEN_SOLANA_PYTH_GENERATION : undefined;
  t.after(() => { if (saved === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = saved; });
  const upgraded = pythSnapshotResult(PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT), current = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  const at = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.fetchedAtMs, min = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.minContextSlot;
  const served = (by: Record<string, unknown>) => { const asked: string[] = [];
    return { asked, read: async (_method: string, params: readonly unknown[] = []) => { asked.push(params[0] as string); return by[params[0] as string] ?? { context: { slot: min + 2 }, value: null }; } }; };
  const both = { [SOLANA_PYTH_FEEDS.current.account]: current, [UPGRADED.account]: upgraded };
  delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION;
  let rpc = served(both);
  assert.equal((await readSolanaReferencePrice(rpc.read, min, at)).account, SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].account);
  assert.deepEqual(rpc.asked, [SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].account]);
  process.env.MERRYMEN_SOLANA_PYTH_GENERATION = "upgraded";
  rpc = served(both);
  const price = await readSolanaReferencePrice(rpc.read, min, at);
  assert.deepEqual([price.account, price.price, rpc.asked], [UPGRADED.account, "10516352961", [UPGRADED.account]]);
  assert.equal(parsePythSolUsd(upgraded.value, upgraded.context.slot, at).account, UPGRADED.account);
  assert.throws(() => parsePythSolUsd(current.value, current.context.slot, at), SolanaReferencePriceError);
  const bound = solanaReferenceBound(sell, price, 300);
  assert.deepEqual(verifySolanaReferenceBound(bound, sell, at), bound);
  process.env.MERRYMEN_SOLANA_PYTH_GENERATION = "current";
  assert.throws(() => verifySolanaReferenceBound(bound, sell, at), SolanaReferencePriceError);
  // A setting that names no generation reads nothing and refuses.
  process.env.MERRYMEN_SOLANA_PYTH_GENERATION = "Upgraded";
  rpc = served(both);
  await assert.rejects(readSolanaReferencePrice(rpc.read, min, at), SolanaReferencePriceError);
  assert.deepEqual(rpc.asked, []);
  assert.throws(() => verifySolanaReferenceBound(bound, sell, at), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd(upgraded.value, upgraded.context.slot, at), SolanaReferencePriceError);
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

test("refuses a receiver account of another type and an executable account, each otherwise a valid SOL/USD update", () => {
  const good = { publishTimeMs: NOW - 1_000 };
  // Each case differs from an accepted account in that one field only: the
  // level byte is Full, the feed id, price, times and length are all valid,
  // so only the discriminator or the executable guard can refuse it.
  assert.doesNotThrow(() => parsePythSolUsd(pythAccount({ ...good, accountType: "PriceUpdateV2", executable: false }), 1000, NOW));
  for (const accountType of ["EncodedVaa", "TwapUpdate", "Config", "PriceUpdateV1", "priceUpdateV2"]) {
    const other = pythAccount({ ...good, accountType });
    assert.equal(Buffer.from(other.data[0] as string, "base64")[40], 1, accountType);
    assert.throws(() => parsePythSolUsd(other, 1000, NOW), SolanaReferencePriceError, accountType);
  }
  for (const executable of [true, undefined, "false", 0, null]) {
    assert.throws(() => parsePythSolUsd(pythAccount({ ...good, executable }), 1000, NOW), SolanaReferencePriceError, String(executable));
  }
  const missing: Record<string, unknown> = pythAccount(good); delete missing.executable;
  assert.throws(() => parsePythSolUsd(missing, 1000, NOW), SolanaReferencePriceError);
  // The real mainnet bytes are refused the same way once marked executable.
  const real = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  assert.doesNotThrow(() => parsePythSolUsd(real.value, real.context.slot, PYTH_SOL_USD_MAINNET_SNAPSHOT.fetchedAtMs));
  assert.throws(() => parsePythSolUsd({ ...real.value, executable: true }, real.context.slot, PYTH_SOL_USD_MAINNET_SNAPSHOT.fetchedAtMs), SolanaReferencePriceError);
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
