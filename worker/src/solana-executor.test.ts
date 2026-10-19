import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Encoder, getBase58Decoder,
  getTransactionDecoder, getCompiledTransactionMessageDecoder, verifySignature } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { deriveSolanaVaultAddress, deriveSolanaSwapAuthority, deriveSolanaAta, SOLANA_VAULT_LOCAL_TEST_PROGRAM,
  SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR, SOLANA_SWAP_EVENT_DISCRIMINATOR,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { createSolanaExecutor, reconcileSolanaSubmission, verifySolanaVaultDeployment, type SolanaLiveRecord, type SolanaSignedSubmission, type SolanaExecutorOptions } from "./solana-executor";
import { settleSolanaReceipt, solanaVaultEvents } from "./solana-settlement";
import { JUPITER_SWAP_PROGRAM, type JupiterCpiRoute } from "./solana-live-market";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { createSolanaLiveRpc } from "./solana-live-rpc";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { pythBound } from "./solana-reference-price-fixture";

const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const SLOT = 1000;
const NOW = 1_000_000;
const CASH = 1_000_000_000n;
function token(mint: string, owner: string, amount: bigint): Buffer {
  const bytes = Buffer.alloc(165); keyBytes(mint).copy(bytes, 0); keyBytes(owner).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64); bytes[108] = 1; return bytes;
}
function rpcAccount(data: Buffer, owner: string, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
function state(owner: string, session: string, seq = 0n, overrides: { paused?: boolean; expiry?: bigint } = {}): Buffer {
  const bytes = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(bytes);
  let offset = 8; bytes[offset++] = 2; bytes[offset++] = 255;
  for (const value of [owner, session]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [1n, seq, overrides.expiry ?? 10_000n, 100_000_000n, CASH, 5_000_000_000n, 50_000_000_000n]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  bytes.writeUInt16LE(96, offset); offset += 2; bytes[offset] = Number(overrides.paused ?? false); return bytes;
}
function event(submission: SolanaSignedSubmission, amountIn = 1_000_000n, amountOut = 2_000_000n): string {
  const bytes = Buffer.alloc(208); Buffer.from(SOLANA_SWAP_EVENT_DISCRIMINATOR).copy(bytes); let offset = 8;
  for (const value of [submission.intent.vault, submission.intent.owner, submission.session]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [BigInt(submission.sessionEpoch), BigInt(submission.vaultSequence)]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  for (const value of [submission.intent.inputMint, submission.intent.outputMint]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [amountIn, amountOut, 1000n]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  return bytes.toString("base64");
}
async function fixture() {
  const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(11));
  const feePayerKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(12));
  const session = await getAddressFromPublicKey(sessionKeyPair.publicKey), feePayer = await getAddressFromPublicKey(feePayerKeyPair.publicKey);
  const owner = key(20), vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const input = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const output = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const swap = await deriveSolanaSwapAuthority(PROGRAM, vault, 0n);
  const temp = await deriveSolanaAta(swap, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const ownerRefund = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const programDataAddress = key(31), binary = Buffer.from("audited-vault-test-binary");
  const program = Buffer.alloc(36); program.writeUInt32LE(2); keyBytes(programDataAddress).copy(program, 4);
  const programData = Buffer.alloc(45 + binary.length); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const clock = { value: NOW };
  const controls = { upgradeable: false, paused: false, failSend: false, simulationError: false, persistError: false,
    conflict: false, finalized: false, wrongSignature: false, fee: 10_000, riskWrongBalance: false, mintReason: false,
    riskDelay: 0, substituteCpi: false, badLookup: false, goodLookup: false, stateEpochAfter: false, badRefund: false, tempDonation: false,
    // The owner's input ATA closed or delegated, and tokens already sitting in the temporary input ATA.
    refundMissing: false, refundDelegate: false, tempTokens: 0n,
    // Pyth SOL/USD with 8 decimals; the fixture route buys 0.002 SOL per USDG, i.e. $500.
    referencePrice: 50_000_000_000n, referenceAgeMs: 0, forgeFloor: false,
    // The vault's finalized sequence after the receipt slot, and the second provider's own view.
    vaultSeqAfter: 1n, fallback: null as SolanaLiveRead | null };
  let record: SolanaLiveRecord | null = null;
  const calls: string[] = [];
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100,
    contextSlot: SLOT, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
  const data = Buffer.alloc(36); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data);
  data.writeUInt32LE(1, 9); data[14] = 100; data[16] = 1;
  data.writeBigUInt64LE(1_000_000n, 17); data.writeBigUInt64LE(2_000_000n, 25); data.writeUInt16LE(100, 33);
  const route: JupiterCpiRoute = { quote, dataBase64: data.toString("base64"), lookupTableAddresses: [], accounts:
    [SOLANA_CLASSIC_TOKEN_PROGRAM, key(40), swap, temp, key(41), key(42), output, SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT, JUPITER_SWAP_PROGRAM, TOKEN_2022_PROGRAM]
      .map((address, index) => ({ address, isSigner: index === 2, isWritable: [3,4,5,6].includes(index) })) };
  const response = (value: unknown) => ({ context: { slot: SLOT }, value });
  const refundAccount = () => {
    if (controls.refundMissing) return null;
    const bytes = token(SOLANA_USDG_MINT, controls.badRefund ? key(90) : owner, 0n);
    if (controls.refundDelegate) { bytes.writeUInt32LE(1, 72); keyBytes(key(91)).copy(bytes, 76); }
    return rpcAccount(bytes, TOKEN_2022_PROGRAM);
  };
  const tempLamports = () => controls.tempDonation || controls.tempTokens > 0n ? 2_039_280 : 0;
  const tempAccount = () => controls.tempTokens > 0n ? rpcAccount(token(SOLANA_USDG_MINT, swap, controls.tempTokens), TOKEN_2022_PROGRAM, false, 2_039_280)
    : controls.tempDonation ? rpcAccount(Buffer.alloc(0), SYSTEM, false, 2_039_280) : null;
  const receipt = (submission: SolanaSignedSubmission, failed = false, amountOut = 2_000_000n) => {
    const tx = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = [...message.staticAccounts, ...submission.loadedAddresses.writable, ...submission.loadedAddresses.readonly];
    const tempIndex = keys.indexOf(temp);
    const balances = Array.from({ length: keys.length }, (_, index) => index === 0 ? 100_000_000 : index === tempIndex ? tempLamports() : 1_000_000);
    const tokenRow = (account: string, mint: string, programId: string, amount: bigint) => ({ accountIndex: keys.indexOf(account),
      mint, owner: vault, programId, uiTokenAmount: { amount: amount.toString(), decimals: mint === SOLANA_USDG_MINT ? 6 : 9 } });
    return { version: 0, slot: SLOT + 1, transaction: [submission.signedTransactionBase64, "base64"], meta: {
      err: failed ? { InstructionError: [2, { Custom: 1 }] } : null, fee: 10_000,
      preBalances: balances, postBalances: balances.map((n, i) => i === 0 ? n - 10_000 + (!failed ? tempLamports() : 0) : i === tempIndex && !failed ? 0 : n), loadedAddresses: structuredClone(submission.loadedAddresses),
      preTokenBalances: [tokenRow(input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, CASH), tokenRow(output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 0n),
        ...(controls.tempTokens > 0n ? [{ ...tokenRow(temp, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, controls.tempTokens), owner: swap }] : [])],
      postTokenBalances: [tokenRow(input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, failed ? CASH : CASH - 1_000_000n),
        tokenRow(output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, failed ? 0n : amountOut)],
      logMessages: [`Program ${PROGRAM} invoke [1]`, ...(failed ? [] : [`Program data: ${event(submission, 1_000_000n, amountOut)}`]),
        `Program ${PROGRAM} ${failed ? "failed: custom program error: 0x1" : "success"}`] as string[] | null,
    } };
  };
  const read: SolanaLiveRead = async (method, params = []) => {
    calls.push(method);
    switch (method) {
      case "getSlot": return SLOT;
      case "getAccountInfo": {
        const [key, config] = params as [string, { dataSlice?: { offset: number; length: number } }];
        if (key === PROGRAM) return response(rpcAccount(program, LOADER, true));
        if (key === programDataAddress) {
          const bytes = Buffer.from(programData); bytes[12] = Number(controls.upgradeable);
          const slice = config.dataSlice!;
          return response({ ...rpcAccount(bytes.subarray(slice.offset, slice.offset + slice.length), LOADER), space: bytes.length });
        }
        if (key === "AddressLookupTab1e1111111111111111111111111") return response(rpcAccount(Buffer.alloc(56), SYSTEM));
        if (key === vault) {
          // Finalized evidence after the receipt (slot SLOT + 1).
          assert.deepEqual(config, { encoding: "base64", commitment: "finalized", minContextSlot: SLOT + 1 });
          return { context: { slot: SLOT + 2 }, value: rpcAccount(state(owner, session, controls.vaultSeqAfter), PROGRAM) };
        }
        if (key === getBase58Decoder().decode(new Uint8Array(32).fill(61))) {
          const table = Buffer.alloc(56 + 32 * route.accounts.length); table.writeUInt32LE(1);
          table.writeBigUInt64LE((1n << 64n) - 1n, 4); table.writeBigUInt64LE(BigInt(SLOT - 1), 12);
          route.accounts.forEach((a, i) => keyBytes(a.address).copy(table, 56 + i * 32));
          return response(rpcAccount(table, "AddressLookupTab1e1111111111111111111111111"));
        }
        throw new Error("Unexpected fixture account");
      }
      case "getMultipleAccounts": {
        const keys = params[0] as string[];
        if (keys[0] === vault) {
          const accounts = [rpcAccount(state(owner, session, 0n, { paused: controls.paused }), PROGRAM),
            rpcAccount(token(SOLANA_USDG_MINT, vault, CASH), TOKEN_2022_PROGRAM), rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM),
            rpcAccount(Buffer.alloc(0), SYSTEM)];
          if (keys.length === 5) { assert.equal(keys[4], ownerRefund); accounts.push(refundAccount()!); }
          return response(accounts);
        }
        if (keys.length === 2 && keys[0] === temp) { assert.equal(keys[1], ownerRefund); return response([tempAccount(), refundAccount()]); }
        return response(keys.map(value => value === output ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM)
          : value === temp ? tempAccount() : null));
      }
      case "getMinimumBalanceForRentExemption": return 2_039_280;
      case "getLatestBlockhash": return response({ blockhash: key(50), lastValidBlockHeight: 1200 });
      case "getFeeForMessage": return response(controls.fee);
      case "simulateTransaction": {
        const tx = getTransactionDecoder().decode(Buffer.from(params[0] as string, "base64"));
        assert.equal(Object.keys(tx.signatures).length, 2);
        assert.ok(Object.values(tx.signatures).every(signature => signature === null));
        const vaultAfter = state(owner, session, 1n); if (controls.stateEpochAfter) vaultAfter.writeBigUInt64LE(2n, 74);
        return response({ err: controls.simulationError ? { InstructionError: [2, "Custom"] } : null, unitsConsumed: 200_000,
          accounts: [rpcAccount(vaultAfter, PROGRAM), rpcAccount(token(SOLANA_USDG_MINT, vault, CASH - 1_000_000n), TOKEN_2022_PROGRAM),
            rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 2_000_000n), SOLANA_CLASSIC_TOKEN_PROGRAM), rpcAccount(Buffer.alloc(0), SYSTEM, false, 99_990_000 + (controls.tempDonation ? 2_039_280 : 0))] });
      }
      case "getSignatureStatuses": return response([controls.finalized ? { confirmationStatus: "finalized", slot: SLOT + 1, err: null } : null]);
      case "getTransaction": assert.ok(record); return receipt(record.submission);
      default: throw new Error(`Unexpected fixture method ${method}`);
    }
  };
  const rpc: SolanaLiveRpc = { read: operation => operation(read),
    readEach: async operation => [await operation(read), await operation(controls.fallback ?? read)],
    async send(wire) {
    calls.push("send"); assert.ok(record, "transaction must be durable before broadcast");
    assert.equal(record.submission.signedTransactionBase64, wire);
    if (controls.failSend) throw new Error("lost HTTP response");
    return controls.wrongSignature ? "different" : record.submission.signature;
  } };
  const options: SolanaExecutorOptions = { programId: PROGRAM, programBinarySha256: createHash("sha256").update(binary).digest("hex"),
    sessionKeyPair, feePayerKeyPair, rpc, now: () => clock.value, maxFeeLamports: "3000000",
    market: { async readMint(mint) { return { address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: SLOT, observedAtMs: NOW, buyBlockedReasons: controls.mintReason ? ["transfer-fee"] : [] }; },
      async build() {
        if (controls.substituteCpi) route.accounts = route.accounts.map((a, i) => i === 6 ? { ...a, address: key(60) } : a);
        if (controls.badLookup) route.lookupTableAddresses = ["AddressLookupTab1e1111111111111111111111111"];
        if (controls.goodLookup) route.lookupTableAddresses = [key(61)];
        return route;
      } },
    journal: { async get() { return record; }, async recordSigned(submission) {
      calls.push("persist"); if (controls.persistError) throw new Error("disk fsync failed"); if (controls.conflict) return false;
      record = { submission, status: "pending" }; return true;
    }, async settle(_owner, _id, signature, settlement) {
      assert.equal(signature, record!.submission.signature); record = { submission: record!.submission, status: settlement.status, settlement };
    } },
    async assessRisk({ intent }) {
      clock.value += controls.riskDelay;
      const reference = pythBound(intent, clock.value - controls.referenceAgeMs, controls.referencePrice, SLOT);
      return { observedAtMs: clock.value, slot: SLOT, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(),
        cashUsdg: controls.riskWrongBalance ? "1" : CASH.toString(), wsolRaw: "0", reference: controls.forgeFloor ? { ...reference, minOutFloor: "1" } : reference };
    } };
  const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "actual-test-1", owner, vault,
    inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 100 };
  return { options, intent, controls, calls, clock, receipt, session, feePayer, ownerRefund, route, read,
    programData, programDataAddress, getRecord: () => record };
}
/** The account the signed execute_swap passes in the owner_refund slot (index 14). */
function refundSlot(submission: SolanaSignedSubmission): string {
  const tx = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = [...compiled.staticAccounts, ...submission.loadedAddresses.writable, ...submission.loadedAddresses.readonly];
  const swap = compiled.instructions.find(ix => keys[ix.programAddressIndex] === PROGRAM)!;
  return keys[swap.accountIndices![14]!]!;
}

test("builds real two-signer v0 bytes, verifies them, persists before one send and settles actual finalized deltas", async () => {
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent);
  assert.equal(pending.status, "pending");
  assert.equal(f.calls.filter(call => call === "send").length, 1);
  assert.ok(f.calls.indexOf("persist") < f.calls.indexOf("send"));
  const tx = getTransactionDecoder().decode(Buffer.from(pending.submission.signedTransactionBase64, "base64"));
  assert.ok(await verifySignature(f.options.sessionKeyPair.publicKey, tx.signatures[f.session]!, tx.messageBytes));
  assert.ok(await verifySignature(f.options.feePayerKeyPair.publicKey, tx.signatures[f.feePayer]!, tx.messageBytes));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(compiled.version, 0);
  // No donation waits in the temporary account, so the owner's ATA is left out.
  assert.equal(compiled.staticAccounts[compiled.instructions[2]!.accountIndices![14]!], PROGRAM);
  const count = f.calls.length; assert.deepEqual(await executor.execute(f.intent), pending); assert.equal(f.calls.length, count);
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  f.controls.finalized = true;
  const finalized = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(finalized?.status, "finalized");
  assert.equal(finalized?.settlement?.amountIn, "1000000"); assert.equal(finalized?.settlement?.amountOut, "2000000");
  assert.equal(finalized?.settlement?.feeLamports, "10000");
});

test("lost send response and mismatched returned signature stay durable pending, never re-sign or resend", async () => {
  for (const mode of ["failSend", "wrongSignature"] as const) {
    const f = await fixture(); f.controls[mode] = true; const executor = createSolanaExecutor(f.options);
    const first = await executor.execute(f.intent); assert.equal(first.status, "pending");
    assert.deepEqual(await executor.execute(f.intent), first);
    f.clock.value += 120_000;
    assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
    assert.equal(f.calls.filter(call => call === "send").length, 1);
    assert.equal(f.calls.filter(call => call === "getLatestBlockhash").length, 1);
  }
});

test("crash recovery releases a sequence only when finalized vault state proves execution impossible; fees stay unknown", async () => {
  for (const mode of ["expired", "revoked", "advanced", "not-expired", "wrong-owner", "wrong-program", "old-slot", "receipt-present"] as const) {
    const f = await fixture(); f.controls.failSend = true;
    const executor = createSolanaExecutor(f.options); const original = await executor.execute(f.intent);
    const proofReads: string[] = [];
    const read: SolanaLiveRead = async (method, params) => {
      proofReads.push(method);
      if (method === "getSignatureStatuses") return { context: { slot: SLOT }, value: [null] };
      if (method === "getTransaction") return mode === "receipt-present" ? f.receipt(original.submission) : null;
      if (method === "getEpochInfo") {
        // Slot and height from one finalized bank.
        assert.deepEqual(params, [{ commitment: "finalized", minContextSlot: SLOT }]);
        return { absoluteSlot: SLOT + 2, blockHeight: ["revoked", "not-expired"].includes(mode) ? 1199 : 1201, epoch: 1, slotIndex: SLOT + 2, slotsInEpoch: 432_000 };
      }
      if (method === "getAccountInfo") {
        assert.deepEqual(params, [f.intent.vault, { encoding: "base64", commitment: "finalized", minContextSlot: SLOT + 2 }]);
        const bytes = state(mode === "wrong-owner" ? key(90) : f.intent.owner, f.session, mode === "advanced" ? 1n : 0n);
        if (mode === "revoked") bytes.writeBigUInt64LE(2n, 74);
        return { context: { slot: mode === "old-slot" ? SLOT : SLOT + 2 }, value: rpcAccount(bytes, mode === "wrong-program" ? key(91) : PROGRAM) };
      }
      return assert.fail(`Unexpected proof read ${method}`);
    };
    const rpc: SolanaLiveRpc = { read: callback => callback(read), readEach: async callback => [await callback(read), await callback(read)],
      send: async () => assert.fail("reconciliation cannot submit") };
    if (["wrong-owner", "wrong-program", "old-slot"].includes(mode)) {
      await assert.rejects(reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1));
      assert.equal(f.getRecord()!.status, "pending"); continue;
    }
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.ok(!proofReads.includes("getBlockHeight") && !proofReads.includes("getSlot"), mode);
    if (["expired", "revoked"].includes(mode)) {
      assert.equal(result!.status, "expired"); assert.equal(result!.settlement!.feeLamports, null);
      assert.equal(result!.settlement!.amountIn, "0"); assert.equal(result!.settlement!.amountOut, "0");
      assert.equal(result!.settlement!.slot, SLOT + 2);
      assert.equal(result!.settlement!.status === "expired" && result!.settlement!.expiryProof.blockHeight, mode === "expired" ? "1201" : "1199");
      assert.deepEqual(await executor.execute(f.intent), result);
      assert.ok(proofReads.indexOf("getEpochInfo") < proofReads.indexOf("getAccountInfo"));
    } else assert.equal(result!.status, "pending", mode);
    assert.equal(f.calls.filter(call => call === "send").length, 1);
  }
});

test("an expiry proof never pairs a current block height with a lagging node's slot (audit execution F1)", async () => {
  // One RPC URL load-balances two nodes. The swap landed at SLOT + 1 and the
  // current node has finalized it; the lagging node's finalized bank is SLOT.
  const nodes = { current: { slot: SLOT + 5, height: 1201, seq: 1n }, lagging: { slot: SLOT, height: 1199, seq: 0n } } as const;
  for (const bank of ["current", "lagging"] as const) {
    const f = await fixture(); f.controls.failSend = true;
    await createSolanaExecutor(f.options).execute(f.intent);
    const read: SolanaLiveRead = async (method, params) => {
      const config = (params?.at(-1) ?? {}) as { minContextSlot?: number };
      if (method === "getSignatureStatuses") return { context: { slot: nodes.lagging.slot }, value: [null] };
      if (method === "getTransaction") return null;
      if (method === "getBlockHeight") return nodes.current.height;
      if (method === "getSlot") return nodes.lagging.slot;
      if (method === "getEpochInfo") return { absoluteSlot: nodes[bank].slot, blockHeight: nodes[bank].height, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
      if (method === "getAccountInfo") {
        // The balancer may route to any node whose finalized bank reaches minContextSlot.
        const node = (config.minContextSlot ?? 0) <= nodes.lagging.slot ? nodes.lagging : nodes.current;
        return { context: { slot: node.slot }, value: rpcAccount(state(f.intent.owner, f.session, node.seq), PROGRAM) };
      }
      return assert.fail(`Unexpected read ${method}`);
    };
    const rpc: SolanaLiveRpc = { read: callback => callback(read), readEach: async callback => [await callback(read), await callback(read)],
      send: async wire => wire };
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(result!.status, "pending", bank); assert.equal(f.getRecord()!.status, "pending", bank);
  }
});

test("RPC-verified lookup tables compile real v0 account indices and are bound to finalized token evidence", async () => {
  const f = await fixture(); f.controls.goodLookup = true;
  const executor = createSolanaExecutor(f.options); const pending = await executor.execute(f.intent);
  assert.ok(pending.submission.loadedAddresses.writable.length > 0);
  assert.ok(pending.submission.loadedAddresses.readonly.length > 0);
  f.controls.finalized = true;
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "finalized");
  const raw = f.receipt(pending.submission);
  raw.meta.loadedAddresses.writable = raw.meta.loadedAddresses.writable.map((value, index) => index === 0 ? key(90) : value);
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, { confirmationStatus: "finalized", slot: SLOT + 1, err: null }, NOW + 1));
});
test("a System-owned prefunded temporary ATA can initialize and its refund is distinct from actual transaction fees", async () => {
  const f = await fixture(); f.controls.tempDonation = true;
  const executor = createSolanaExecutor(f.options); await executor.execute(f.intent); f.controls.finalized = true;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled!.status, "finalized"); assert.equal(settled!.settlement!.feeLamports, "10000");
  assert.equal(settled!.settlement!.amountIn, "1000000");
});

test("an owner who closed or delegated their input ATA still trades when no donation waits (audit VAULT-2)", async () => {
  for (const mode of ["refundMissing", "refundDelegate", "badRefund"] as const) {
    const f = await fixture(); f.controls[mode] = true; const executor = createSolanaExecutor(f.options);
    const pending = await executor.execute(f.intent);
    assert.equal(pending.status, "pending", mode);
    assert.equal(refundSlot(pending.submission), PROGRAM, mode);
    assert.equal(f.calls.filter(call => call === "send").length, 1);
    f.controls.finalized = true;
    assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "finalized", mode);
  }
});

test("a donation in the temporary ATA passes the owner's ATA for its refund and never inflates the receipt", async () => {
  const f = await fixture(); f.controls.tempTokens = 7n; const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent);
  assert.equal(pending.status, "pending");
  assert.equal(refundSlot(pending.submission), f.ownerRefund);
  f.controls.finalized = true;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled?.status, "finalized");
  assert.equal(settled?.settlement?.amountIn, "1000000"); assert.equal(settled?.settlement?.feeLamports, "10000");
});

test("a donation with the owner's ATA closed, delegated or foreign fails closed with owner-refund before persistence or send", async () => {
  for (const mode of ["refundMissing", "refundDelegate", "badRefund"] as const) {
    const f = await fixture(); f.controls.tempTokens = 7n; f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /refused: owner-refund/, mode);
    assert.ok(!f.calls.includes("persist"), mode); assert.ok(!f.calls.includes("send"), mode);
    assert.ok(!f.calls.includes("simulateTransaction"), mode);
  }
});

test("refuses unsafe authority, mutation, simulation, fees, stale safety and risk evidence before persistence or send", async () => {
  for (const mode of ["upgradeable", "paused", "simulationError", "riskWrongBalance", "mintReason", "substituteCpi", "badLookup", "stateEpochAfter"] as const) {
    const f = await fixture(); f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("persist"), mode); assert.ok(!f.calls.includes("send"), mode);
  }
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.controls.fee = 2_000_000; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.riskDelay = 30_000; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.options.programBinarySha256 = "0".repeat(64); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.options.feePayerKeyPair = f.options.sessionKeyPair; }]) {
    const f = await fixture(); change(f); await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("persist")); assert.ok(!f.calls.includes("send"));
  }
});

test("a build quote below the independent price floor is never signed, persisted or sent", async () => {
  // At $250/SOL, 1 USDG should buy 0.004 SOL; the route guarantees 0.00198, about half.
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.controls.referencePrice = 25_000_000_000n; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.forgeFloor = true; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.referenceAgeMs = 121_000; }]) {
    const f = await fixture(); change(f);
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /refused: risk/);
    assert.ok(!f.calls.includes("persist")); assert.ok(!f.calls.includes("send"));
  }
  // Within the 3% tolerance of a $510 reference the same route is still admitted.
  const f = await fixture(); f.controls.referencePrice = 51_000_000_000n;
  assert.equal((await createSolanaExecutor(f.options).execute(f.intent)).status, "pending");
  // 1 USDG is 0.001960784 SOL at $510; 97% of that is the floor the route clears.
  assert.equal(f.getRecord()!.submission.risk.reference.minOutFloor, "1901960");
});
test("durability failure or atomic sequence conflict prevents submission", async () => {
  for (const mode of ["persistError", "conflict"] as const) {
    const f = await fixture(); f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("send"));
  }
});
test("shutdown before work or during risk prevents admission; shutdown during commit preserves signed bytes without sending", async () => {
  for (const phase of ["before", "risk", "commit", "genesis"] as const) {
    const f = await fixture(), controller = new AbortController(); f.options.signal = controller.signal;
    const network: string[] = [];
    if (phase === "before") controller.abort("private abort reason");
    if (phase === "risk") {
      const assess = f.options.assessRisk;
      f.options.assessRisk = async input => { const result = await assess(input); controller.abort(); return result; };
    }
    if (phase === "commit") {
      const commit = f.options.journal.recordSigned;
      f.options.journal.recordSigned = async submission => { const result = await commit(submission); controller.abort(); return result; };
    }
    if (phase === "genesis") {
      const transport = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/",
        MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/" }, fetch: async (_url, init) => {
        const body = JSON.parse(init!.body as string); network.push(body.method);
        assert.equal(body.method, "getGenesisHash"); controller.abort();
        assert.equal(init!.signal!.aborted, true);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
      } });
      f.options.rpc = { ...f.options.rpc, send: transport.send };
    }
    const executor = createSolanaExecutor(f.options);
    if (phase === "before" || phase === "risk") {
      await assert.rejects(executor.execute(f.intent), /cancelled/);
      assert.equal(f.getRecord(), null); assert.ok(!f.calls.includes("persist"));
      if (phase === "before") assert.equal(f.calls.length, 0);
    } else {
      const result = await executor.execute(f.intent);
      assert.equal(result.status, "pending"); assert.equal(f.getRecord()!.submission.signature, result.submission.signature);
      assert.ok(result.submission.signedTransactionBase64.length > 0);
    }
    assert.ok(!f.calls.includes("send")); assert.ok(!network.includes("sendTransaction"));
  }
});

test("same request cannot be rebound to another amount and paper is never accepted by live executor", async () => {
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  await assert.rejects(executor.execute({ ...f.intent, mode: "paper" }));
  await executor.execute(f.intent);
  await assert.rejects(executor.execute({ ...f.intent, amountRaw: "2" }));
  assert.equal(f.calls.filter(call => call === "send").length, 1);
});

test("settlement refuses forged events, wrong bytes, token deltas and nonfinalized evidence", async () => {
  const f = await fixture(); const pending = await createSolanaExecutor(f.options).execute(f.intent);
  const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
  for (const change of [
    (r: ReturnType<typeof f.receipt>) => { r.transaction[0] = "forged"; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.postTokenBalances[1]!.uiTokenAmount.amount = "1"; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.logMessages![1] = `Program data: ${event(pending.submission, 1n, 2n)}`; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.logMessages = [`Program ${JUPITER_SWAP_PROGRAM} invoke [1]`, `Program data: ${event(pending.submission)}`, `Program ${JUPITER_SWAP_PROGRAM} success`]; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.postBalances[0]!--; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.preTokenBalances[0]!.owner = key(90); },
  ]) {
    const raw = f.receipt(pending.submission); change(raw);
    assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1));
  }
  assert.throws(() => settleSolanaReceipt(pending.submission, f.receipt(pending.submission), { ...status, confirmationStatus: "confirmed" }, NOW + 1));
  const failed = f.receipt(pending.submission, true);
  assert.equal(settleSolanaReceipt(pending.submission, failed, { ...status, err: failed.meta.err }, NOW + 1).status, "failed");
  for (const err of [undefined, false, 0, {}, [], "invented-error", { InstructionError: [256, { Custom: 1 }] },
    { InstructionError: [2, { Custom: -1 }] }, { InstructionError: [2, {}] }, { DuplicateInstruction: "2" },
    { InsufficientFundsForRent: { account_index: 0, extra: true } }]) {
    const malformed = { ...failed, meta: { ...failed.meta, err } };
    assert.throws(() => settleSolanaReceipt(pending.submission, malformed, { ...status, err }, NOW + 1));
  }
  for (const err of ["InsufficientFundsForFee", { InstructionError: [2, "InvalidArgument"] },
    { DuplicateInstruction: 2 }, { InsufficientFundsForRent: { account_index: 0 } }]) {
    const recognized = { ...failed, meta: { ...failed.meta, err } };
    assert.equal(settleSolanaReceipt(pending.submission, recognized, { ...status, err }, NOW + 1).status, "failed");
  }
  assert.throws(() => settleSolanaReceipt(pending.submission, failed, { confirmationStatus: "finalized", slot: SLOT + 1 }, NOW + 1));
  assert.throws(() => solanaVaultEvents([`Program ${PROGRAM} invoke [1]`, "Log truncated"], PROGRAM));
});

/** A second provider's view of the fixture, with selected reads replaced. */
function provider(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Record<string, (params: readonly unknown[]) => unknown>>): SolanaLiveRead {
  return async (method, params = []) => overrides[method] ? overrides[method]!(params) : f.read(method, params);
}

test("a fill is booked only when both providers return the same finalized receipt (audit G3-1)", async () => {
  // The primary withholds nothing but forges; the honest fallback has never seen the signature.
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent); f.controls.finalized = true;
  f.controls.fallback = provider(f, { getSignatureStatuses: () => ({ context: { slot: SLOT }, value: [null] }), getTransaction: () => null,
    getEpochInfo: () => ({ absoluteSlot: SLOT + 2, blockHeight: 1199 }),
    getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, 0n), PROGRAM) }) });
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  assert.equal(f.getRecord()!.status, "pending");
  // Both providers return internally consistent receipts with different fills.
  f.controls.fallback = provider(f, { getTransaction: () => f.receipt(pending.submission, false, 2_500_000n) });
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  // A provider that cannot answer leaves it pending too.
  f.controls.fallback = provider(f, { getTransaction: () => { throw new Error("provider down"); } });
  await assert.rejects(executor.reconcile(f.intent.owner, f.intent.requestId));
  assert.equal(f.getRecord()!.status, "pending");
  // A transport with only one provider can never book.
  const single = { ...f.options.rpc }; delete single.readEach;
  await assert.rejects(reconcileSolanaSubmission(single, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1), /two independent RPC providers/);
  assert.equal(f.getRecord()!.status, "pending");
  f.controls.fallback = null;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled?.status, "finalized"); assert.equal(settled?.settlement?.amountOut, "2000000");
});

test("an expiry is booked only when both providers prove it; their heights may differ (audit G3-1)", async () => {
  const proof = (blockHeight: number) => ({ getSignatureStatuses: () => ({ context: { slot: SLOT }, value: [null] }), getTransaction: () => null,
    getEpochInfo: () => ({ absoluteSlot: SLOT + 2, blockHeight }) });
  for (const [primary, fallback, expected] of [[1201, 1199, "pending"], [1201, 1300, "expired"]] as const) {
    const f = await fixture(); f.controls.failSend = true; const executor = createSolanaExecutor(f.options);
    await executor.execute(f.intent);
    const view = (height: number, seq = 0n) => provider(f, { ...proof(height),
      getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, seq), PROGRAM) }) });
    const rpc: SolanaLiveRpc = { read: callback => callback(view(primary)), readEach: async callback => [await callback(view(primary)), await callback(view(fallback))],
      send: async wire => wire };
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(result!.status, expected);
    if (result!.settlement?.status === "expired") assert.equal(result!.settlement.expiryProof.blockHeight, "1201");
  }
  // The fallback saw the sequence move: the swap may have landed.
  const f = await fixture(); f.controls.failSend = true; const executor = createSolanaExecutor(f.options);
  await executor.execute(f.intent);
  const view = (seq: bigint) => provider(f, { ...proof(1201),
    getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, seq), PROGRAM) }) });
  const rpc: SolanaLiveRpc = { read: callback => callback(view(0n)), readEach: async callback => [await callback(view(0n)), await callback(view(1n))], send: async wire => wire };
  assert.equal((await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1))!.status, "pending");
});

test("the vault program must verify as immutable and audited on both providers before anything is signed (audit G3-5)", async () => {
  for (const lie of ["upgradeable", "substituted"] as const) {
    const f = await fixture();
    f.controls.fallback = provider(f, { getAccountInfo: params => {
      const [address, config] = params as [string, { dataSlice: { offset: number; length: number } }];
      if (address !== f.programDataAddress) return f.read("getAccountInfo", params);
      const bytes = Buffer.from(f.programData); if (lie === "upgradeable") bytes[12] = 1; else bytes[bytes.length - 1]! ^= 1;
      return { context: { slot: SLOT }, value: { ...rpcAccount(bytes.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length), LOADER), space: bytes.length } };
    } });
    await assert.rejects(verifySolanaVaultDeployment(f.options.rpc, PROGRAM, f.options.programBinarySha256), /unsafe-program/, lie);
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /unsafe-program/, lie);
    assert.ok(!f.calls.includes("persist") && !f.calls.includes("send"), lie);
  }
});

test("a verified immutable deployment is cached per provider pair; failures are not", async () => {
  const f = await fixture(); let slices = 0;
  const counting: SolanaLiveRead = async (method, params = []) => {
    if (method === "getAccountInfo" && (params[0] === PROGRAM || params[0] === f.programDataAddress)) slices++;
    return f.read(method, params);
  };
  const rpc: SolanaLiveRpc = { providerKey: `cache-test-${Math.random()}`, read: callback => callback(counting),
    readEach: async callback => [await callback(counting), await callback(counting)], send: async wire => wire };
  await assert.rejects(verifySolanaVaultDeployment(rpc, PROGRAM, "0".repeat(64)), /unsafe-program/);
  const failed = slices;
  await assert.rejects(verifySolanaVaultDeployment(rpc, PROGRAM, "0".repeat(64)), /unsafe-program/);
  assert.equal(slices, failed * 2, "a failure is checked again");
  slices = 0;
  assert.deepEqual(await verifySolanaVaultDeployment(rpc, PROGRAM, f.options.programBinarySha256), { slot: SLOT });
  const verified = slices; assert.ok(verified >= 4, "both providers read the program and its data");
  assert.deepEqual(await verifySolanaVaultDeployment(rpc, PROGRAM, f.options.programBinarySha256), { slot: SLOT });
  assert.equal(slices, verified, "the second check is served from the cache");
});

test("a finalized swap whose logs were truncated or not recorded settles from its token deltas and the vault's finalized sequence (audit execution F2)", async () => {
  const truncated = [`Program ${PROGRAM} invoke [1]`, `Program ${TOKEN_2022_PROGRAM} invoke [2]`, `Program ${TOKEN_2022_PROGRAM} success`,
    `Program ${JUPITER_SWAP_PROGRAM} invoke [2]`, "Program log: Instruction: SharedAccountsRoute", "Log truncated"];
  for (const logs of [truncated, null]) {
    const f = await fixture(); const executor = createSolanaExecutor(f.options);
    const pending = await executor.execute(f.intent); f.controls.finalized = true;
    const raw = f.receipt(pending.submission); raw.meta.logMessages = logs;
    const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
    const evidence = { address: f.intent.vault, slot: SLOT + 2, state: (await import("../../packages/core/src/solana-live")).decodeSolanaVaultAccount(state(f.intent.owner, f.session, 1n)) };
    // Without the vault's finalized sequence it stays unsettled, as before.
    assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1));
    for (const bad of [{ ...evidence, slot: SLOT }, { ...evidence, address: key(90) },
      { ...evidence, state: { ...evidence.state, seq: 0n } }, { ...evidence, state: { ...evidence.state, owner: key(90) } }]) {
      assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, bad));
    }
    const settled = settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence);
    assert.equal(settled.status, "finalized"); assert.equal(settled.amountIn, "1000000"); assert.equal(settled.amountOut, "2000000");
    // Token rows still bound the fill.
    const short = structuredClone(raw); short.meta.postTokenBalances[1]!.uiTokenAmount.amount = "1";
    assert.throws(() => settleSolanaReceipt(pending.submission, short, status, NOW + 1, evidence));
    // End to end: both providers serve the truncated receipt and the advanced vault.
    f.controls.fallback = provider(f, { getTransaction: () => raw });
    const through = { ...f.options.rpc, read: f.options.rpc.read, readEach: async <T,>(callback: (read: SolanaLiveRead) => Promise<T>) =>
      [await callback(provider(f, { getTransaction: () => raw })), await callback(f.controls.fallback!)] };
    const booked = await reconcileSolanaSubmission(through, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(booked!.status, "finalized"); assert.equal(booked!.settlement!.amountOut, "2000000");
  }
  // The vault's sequence did not move: never booked.
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent); f.controls.finalized = true; f.controls.vaultSeqAfter = 0n;
  const raw = f.receipt(pending.submission); raw.meta.logMessages = truncated;
  f.controls.fallback = provider(f, { getTransaction: () => raw });
  const through = { ...f.options.rpc, readEach: async <T,>(callback: (read: SolanaLiveRead) => Promise<T>) =>
    [await callback(f.controls.fallback!), await callback(f.controls.fallback!)] };
  await assert.rejects(reconcileSolanaSubmission(through, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1));
  assert.equal(f.getRecord()!.status, "pending");
});

test("truncated logs keep strict provenance: a failed receipt needs no logs, a visible event must still match", async () => {
  const f = await fixture(); const pending = await createSolanaExecutor(f.options).execute(f.intent);
  const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
  const evidence = { address: f.intent.vault, slot: SLOT + 2, state: (await import("../../packages/core/src/solana-live")).decodeSolanaVaultAccount(state(f.intent.owner, f.session, 1n)) };
  const failed = f.receipt(pending.submission, true);
  for (const logs of [[`Program ${PROGRAM} invoke [1]`, "Log truncated"], null]) {
    failed.meta.logMessages = logs;
    assert.equal(settleSolanaReceipt(pending.submission, failed, { ...status, err: failed.meta.err }, NOW + 1).status, "failed");
  }
  const raw = f.receipt(pending.submission);
  // A forged event before the cut still disagrees with the token rows.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program data: ${event(pending.submission, 1_000_000n, 3_000_000n)}`, "Log truncated"];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
  // The marker only ever ends a log.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, "Log truncated", `Program ${PROGRAM} success`];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
  // Complete logs still need exactly one matching event, evidence or not.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program ${PROGRAM} success`];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
});
