import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { createSolanaLiveMarket, JUPITER_SWAP_PROGRAM, validateJupiterCpi } from "./solana-live-market";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
function fixture() {
  const request = { requestId: "route-1", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    amountRaw: "1000000", slippageBps: 100, swapAuthority: key(10), sourceTokenAccount: key(11), destinationTokenAccount: key(12),
    inputTokenProgram: TOKEN_2022_PROGRAM, outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM };
  const quote = { source: "jupiter" as const, inputMint: request.inputMint, outputMint: request.outputMint,
    inAmount: request.amountRaw, outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100,
    contextSlot: 1000, quotedAtMs: 100_000, expiresAtMs: 130_000 };
  const rawQuote = { ...quote, source: undefined, minOutAmount: undefined, quotedAtMs: undefined, expiresAtMs: undefined,
    otherAmountThreshold: quote.minOutAmount, swapMode: "ExactIn", platformFee: null, routePlan: [{ percent: 100,
      swapInfo: { ammKey: key(30), inputMint: request.inputMint, outputMint: request.outputMint, inAmount: request.amountRaw, outAmount: quote.outAmount } }] };
  const data = Buffer.alloc(36); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data); data.writeUInt32LE(1, 9);
  data[14] = 100; data[16] = 1; data.writeBigUInt64LE(1_000_000n, 17); data.writeBigUInt64LE(2_000_000n, 25); data.writeUInt16LE(100, 33);
  const rawBuild = { swapInstruction: { programId: JUPITER_SWAP_PROGRAM, data: data.toString("base64"), accounts:
    [SOLANA_CLASSIC_TOKEN_PROGRAM, key(20), request.swapAuthority, request.sourceTokenAccount, key(21), key(22),
      request.destinationTokenAccount, request.inputMint, request.outputMint, JUPITER_SWAP_PROGRAM, TOKEN_2022_PROGRAM]
      .map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: [3,4,5,6].includes(i) })) }, addressLookupTableAddresses: [] as string[] };
  return { request, quote, rawQuote, rawBuild, data };
}
test("pinned route discriminator matches the Anchor IDL name independently", () => {
  const f = fixture();
  assert.deepEqual([...f.data.subarray(0, 8)], [193, 32, 155, 51, 65, 214, 156, 129]);
  assert.equal(validateJupiterCpi(f.rawBuild, f.request, f.quote).dataBase64, f.rawBuild.swapInstruction.data);
  createHash("sha256").update("global:route").digest().subarray(0, 8).copy(f.data);
  f.rawBuild.swapInstruction.data = f.data.toString("base64");
  assert.throws(() => validateJupiterCpi(f.rawBuild, f.request, f.quote));
});
test("quote and CPI use exact coherent v1 response, fixed origins, hard slippage and no provider transaction", async () => {
  const f = fixture(); const seen: { url: URL; init: RequestInit }[] = [];
  const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
    rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
    fetch: async (url, init) => { seen.push({ url: new URL(String(url)), init: init! });
      return Response.json(seen.length === 1 ? f.rawQuote : { ...f.rawBuild,
        setupInstructions: [{ programId: "untrusted" }], otherInstructions: [{ data: "untrusted" }], transaction: "untrusted" }); },
  });
  const built = await market.build(f.request);
  assert.deepEqual(built.quote, f.quote); assert.equal(built.dataBase64, f.rawBuild.swapInstruction.data);
  assert.ok(!Object.hasOwn(built, "transaction")); assert.ok(!Object.hasOwn(built, "otherInstructions"));
  assert.deepEqual(seen.map(item => item.url.origin + item.url.pathname), ["https://api.jup.ag/swap/v1/quote", "https://api.jup.ag/swap/v1/swap-instructions"]);
  assert.equal(seen[0]!.url.searchParams.get("instructionVersion"), "V1");
  const body = JSON.parse(seen[1]!.init.body as string);
  assert.deepEqual(body.quoteResponse, JSON.parse(JSON.stringify(f.rawQuote)));
  assert.equal(body.userPublicKey, f.request.swapAuthority); assert.equal(body.destinationTokenAccount, f.request.destinationTokenAccount);
  assert.equal(body.wrapAndUnwrapSol, false); assert.equal(body.dynamicSlippage, false);
});
test("CPI rejects substituted authority, amount, output, slippage, fees, program and foreign signer", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.programId = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[2]!.pubkey = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[6]!.pubkey = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[4]!.isSigner = true; },
    (f: ReturnType<typeof fixture>) => { f.data.writeBigUInt64LE(1n, 17); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data.writeBigUInt64LE(1n, 25); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data.writeUInt16LE(200, 33); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data[35] = 1; f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.addressLookupTableAddresses = [key(30), key(30)]; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateJupiterCpi(f.rawBuild, f.request, f.quote)); }
});
test("stale chain context and incoherent quote graph never produce a CPI", async () => {
  for (const stale of [false, true]) {
    const f = fixture(); if (!stale) f.rawQuote.routePlan[0]!.swapInfo.inAmount = "1";
    let requests = 0;
    const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
      rpc: { read: callback => callback(async () => 1100), send: async () => assert.fail("must not submit") },
      fetch: async () => Response.json(++requests === 1 ? f.rawQuote : f.rawBuild) });
    await assert.rejects(market.build(f.request)); if (!stale) assert.equal(requests, 1);
  }
});
