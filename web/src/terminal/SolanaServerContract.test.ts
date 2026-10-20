/**
 * WHAT THE SOLANA PAGE RELIES ON, RUN AGAINST THE REAL RUNTIME.
 *
 * SolanaScreen.test.ts drives the page against fixture routes. These tests
 * pin the server half of that contract with createSolanaAppRuntime itself,
 * through solanaResponse where the page sees an HTTP answer:
 * - the registration bytes prepareLive really builds (vault initialize or
 *   not, the four token-account creations, a priority fee or none) pass the
 *   page's whole check, checkPreparedPermission, and a changed one does not;
 * - which owner transactions the server prepares while another is pending,
 *   the rule SolanaOwnerActions shows the owner (and ownerPrepare models in
 *   SolanaScreen.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes, createTransactionMessage,
  decompileTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signTransaction, type Blockhash, type Instruction } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import { SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, deriveSolanaVaultAddress } from "../../../packages/core/src/solana-live";
import { wrapSqlite } from "../../../worker/src/db";
import { createSolanaAppRuntime } from "../../../worker/src/solana-app-runtime";
import type { SolanaLiveRead, SolanaLiveRpc } from "../../../worker/src/solana-live-rpc";
import type { SolanaPaperMarket } from "../../../worker/src/solana-paper-service";
import { solanaResponse } from "../lib/solana-api";
import { SqlSolanaBindingStore } from "../lib/solana-binding-store";
import { refusedByServer } from "./SolanaOwnerActions";
import { checkPreparedPermission, OWNER_MAX_PRIORITY_FEE_LAMPORTS, type PreparedPermission } from "./SolanaPermission";
import { RequestError } from "./request-json";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false) {
  return { owner, executable, lamports: 100_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}

/** A live-mode runtime on an in-memory database and a two-provider fake chain (built as in solana-owner-outcome.test.ts). */
async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionKeys = await createKeyPairFromPrivateKeyBytes(Buffer.alloc(32, 22));
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "live", limits);
  const dataAddress = key(41), binary = Buffer.from("runtime-tested-binary"), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, sends: 0, height: 4900, simulatedUnits: null as number | null, priorityFees: null as number[] | null };
  const state = () => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [1n, 0n, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  // The vault (once initialized) and the owner wallet, a plain system account; every token account is missing, so its rent is counted.
  const accountFor = (k: unknown) => k === vault ? (controls.initialized ? account(state()) : null) : k === owner ? account(Buffer.alloc(0), SOLANA_SYSTEM_PROGRAM) : null;
  const read: SolanaLiveRead = async (method, params = []) => {
    if (method === "getSlot") return 1000;
    if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: controls.height, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
    if (method === "getMinimumBalanceForRentExemption") return (128 + (params[0] as number)) * 6960;
    if (method === "getAccountInfo") {
      if (params[0] === PROGRAM) return response(account(program, LOADER, true));
      if (params[0] === dataAddress) {
        const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
        return response({ ...account(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
      }
      return response(accountFor(params[0]));
    }
    if (method === "getMultipleAccounts") return response((params[0] as string[]).map(accountFor));
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([null]);
    if (method === "getTransaction") return null;
    if (method === "simulateTransaction" && controls.simulatedUnits !== null) return response({ err: null, unitsConsumed: controls.simulatedUnits, logs: [], accounts: null });
    if (method === "getRecentPrioritizationFees" && controls.priorityFees) return controls.priorityFees.map((prioritizationFee, i) => ({ slot: 1000 - i, prioritizationFee }));
    throw new Error(`Unexpected test RPC ${method}`);
  };
  // Two independent providers that agree. A send is counted and its answer lost.
  const rpc: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async () => {
    controls.sends++; throw new Error("lost send response");
  } };
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: clock.now, buyBlockedReasons: [] }),
    quote: async () => { throw new Error("no quotes in these tests"); },
  };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"), MERRYMEN_JUPITER_API_KEY: "fixture" };
  const app = createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now });
  const sign = async (wire: string) => getBase64EncodedWireTransaction(await signTransaction([ownerKeys], getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  return { raw, db, clock, scope, owner, session, vault, controls, app, sign };
}

const flag = process.env.MERRYMEN_SOLANA;
test.before(() => { process.env.MERRYMEN_SOLANA = "1"; });
test.after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
/** What the page receives from a route, and whether it would treat it as a refusal (SolanaOwnerActions.refusedByServer). */
async function asPage(run: () => Promise<unknown>) {
  const response = await solanaResponse(run);
  const body = await response.json() as { error?: string };
  return { status: response.status, error: body.error, refusal: !response.ok && refusedByServer(new RequestError(body.error ?? "", response.status)) };
}

/** The prepared bytes' instructions, decompiled. */
function instructionsOf(transactionBase64: string): Instruction[] {
  const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  return decompileTransactionMessage(compiled, { lastValidBlockHeight: 5000n }).instructions as Instruction[];
}
/** The same message with other instructions: what a changed server could ask the wallet to sign. */
function rebuilt(owner: string, instructions: Instruction[]): string {
  // getBase64EncodedWireTransaction already returns base64 wire bytes.
  return String(getBase64EncodedWireTransaction(compileTransaction(setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: key(42) as unknown as Blockhash, lastValidBlockHeight: 5000n },
    setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))))));
}
/** Which instruction each one is, by program and the accounts it names. */
function shape(instructions: Instruction[], vault: string, owner: string): string[] {
  return instructions.map(ix => {
    if (ix.programAddress === COMPUTE_BUDGET) return "compute-budget";
    if (ix.programAddress === PROGRAM) return ix.accounts?.length === 3 ? "initialize" : "create-session";
    if (ix.programAddress !== SOLANA_ASSOCIATED_TOKEN_PROGRAM) return String(ix.programAddress);
    const wallet = ix.accounts![2]!.address, mint = ix.accounts![3]!.address;
    return `ata:${wallet === vault ? "vault" : wallet === owner ? "owner" : "other"}:${mint === SOLANA_USDG_MINT ? "usdg" : "wsol"}`;
  });
}

test("the server's real registration bytes pass the page's whole check, with and without vault initialize and a priority fee", async () => {
  const f = await fixture();
  try {
    // The page derives the vault itself, as SolanaScreen.prepareRegistration does.
    const expected = { owner: f.owner, programId: PROGRAM, vault: await deriveSolanaVaultAddress(PROGRAM, f.owner), session: f.session };
    const atas = ["ata:vault:usdg", "ata:vault:wsol", "ata:owner:usdg", "ata:owner:wsol"];
    const cases = [
      { name: "new vault, no fee", initialized: false, fee: false, shape: ["initialize", ...atas, "create-session"] },
      { name: "existing vault, no fee", initialized: true, fee: false, shape: [...atas, "create-session"] },
      { name: "new vault, priority fee", initialized: false, fee: true, shape: ["compute-budget", "compute-budget", "initialize", ...atas, "create-session"] },
      { name: "existing vault, priority fee", initialized: true, fee: true, shape: ["compute-budget", "compute-budget", ...atas, "create-session"] },
    ];
    for (const item of cases) {
      f.controls.initialized = item.initialized;
      f.controls.simulatedUnits = item.fee ? 150_000 : null; f.controls.priorityFees = item.fee ? [200_000] : null;
      const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
      assert.deepEqual(shape(instructionsOf(setup.transactionBase64), f.vault, f.owner), item.shape, item.name);
      // Exactly what the page receives from the route, through exactly its check.
      const prepared = JSON.parse(JSON.stringify(setup)) as PreparedPermission;
      const terms = checkPreparedPermission(prepared, expected, limits);
      assert.equal(terms.priorityFeeLamports, setup.priorityFeeLamports, item.name);
      assert.equal(terms.priorityFeeLamports === "0", !item.fee, item.name);
      assert.ok(BigInt(terms.priorityFeeLamports) <= OWNER_MAX_PRIORITY_FEE_LAMPORTS, item.name);
      assert.ok(BigInt(setup.requiredLamports) > BigInt(setup.priorityFeeLamports), item.name);
    }
    assert.equal(f.controls.sends, 0, "preparing sends nothing");
  } finally { f.raw.close(); }
});

test("a registration whose token-account creation or initialize differs from the server's in any account is refused before the wallet opens", async () => {
  const f = await fixture();
  try {
    const expected = { owner: f.owner, programId: PROGRAM, vault: f.vault, session: f.session };
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const instructions = instructionsOf(setup.transactionBase64);
    const at = instructions.findIndex(ix => ix.programAddress === SOLANA_ASSOCIATED_TOKEN_PROGRAM && ix.accounts![3]!.address === SOLANA_USDG_MINT);
    const init = instructions.findIndex(ix => ix.programAddress === PROGRAM && ix.accounts?.length === 3);
    const usdgAta = instructions[at]!, initialize = instructions[init]!, stranger = key(77);
    const withAccounts = (ix: Instruction, accounts: Instruction["accounts"]) => ({ ...ix, accounts }) as Instruction;
    const replaced = (ix: Instruction, index: number, value: string) => withAccounts(ix, ix.accounts!.map((meta, i) => i === index ? { ...meta, address: address(value) } : meta));
    const swap = (index: number, ix: Instruction) => instructions.map((item, i) => i === index ? ix : item);
    // The unchanged rebuild passes: what is refused below is the change alone.
    assert.ok(checkPreparedPermission({ ...setup, transactionBase64: rebuilt(f.owner, instructions) }, expected, limits));
    const changed: Array<[string, Instruction[]]> = [
      ["USDG account under the classic token program", swap(at, replaced(usdgAta, 5, SOLANA_CLASSIC_TOKEN_PROGRAM))],
      ["another program in the system program's place", swap(at, replaced(usdgAta, 4, stranger))],
      ["an extra account", swap(at, withAccounts(usdgAta, [...usdgAta.accounts!, { address: address(stranger), role: 1 }]))],
      ["a third party's token account", swap(at, replaced(usdgAta, 2, stranger))],
      ["another mint", swap(at, replaced(usdgAta, 3, stranger))],
      ["an initialize with an extra account", swap(init, withAccounts(initialize, [...initialize.accounts!, { address: address(stranger), role: 1 }]))],
      ["an initialize with another program in the system program's place", swap(init, replaced(initialize, 2, stranger))],
    ];
    for (const [name, list] of changed) {
      assert.throws(() => checkPreparedPermission({ ...setup, transactionBase64: rebuilt(f.owner, list) }, expected, limits), /does not match what this page shows\. Nothing was signed/, name);
    }
    // A server that names another session or vault, or claims another fee, or other limits, is refused too.
    assert.throws(() => checkPreparedPermission({ ...setup, session: stranger }, expected, limits), /different session/);
    assert.throws(() => checkPreparedPermission({ ...setup, vault: stranger }, expected, limits), /different vault/);
    assert.throws(() => checkPreparedPermission({ ...setup, priorityFeeLamports: "5000" }, expected, limits), /fee does not match its bytes/);
    assert.throws(() => checkPreparedPermission(setup, expected, { ...limits, perTradeUsdg: "1000000" }), /does not match the saved limits shown/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("while a submitted owner transaction is unresolved the server prepares no other, a revocation included; one only prepared is replaced", async () => {
  const f = await fixture();
  try {
    f.controls.initialized = true;
    // Prepared and signed but never submitted: a revocation replaces it, and its bytes can no longer be sent.
    const unsent = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "1000000" });
    const unsentSigned = await f.sign(unsent.transactionBase64);
    assert.equal((await asPage(() => f.app.prepareOwnerAction(f.scope, { action: "revoke" }))).status, 200);
    const late = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: unsentSigned }));
    assert.equal(late.refusal, true, late.error); assert.equal(f.controls.sends, 0, "refused before anything is saved or sent");
    // Submitted (saved and broadcast) and unresolved: nothing else is prepared, a revocation included.
    const withdrawal = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "1000000" });
    const signed = await f.sign(withdrawal.transactionBase64);
    const submitted = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: signed }));
    assert.equal(submitted.status, 200); assert.equal(f.controls.sends, 1);
    for (const input of [{ action: "revoke" }, { action: "resume-buys" }, { action: "withdraw-sol", amountRaw: "1000000" }] as const) {
      const answer = await asPage(() => f.app.prepareOwnerAction(f.scope, input));
      assert.equal(answer.status, 409, input.action);
      assert.equal(answer.error, "Refresh the pending owner transaction before preparing another.", input.action);
      assert.equal(answer.refusal, true, input.action);
    }
    // The status names it, which is what the page holds every owner action back on.
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ownerTransaction?.status, "pending"); assert.equal(status.live.ownerTransaction?.kind, "withdraw-sol");
    // Its blockhash provably expired (finalized height past it, vault unchanged): it is failed, and a revocation prepares again.
    f.controls.height = 5100;
    const retry = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: signed }));
    assert.equal(retry.status, 200);
    assert.equal((await f.app.status(f.scope)).live.ownerTransaction?.status, "failed");
    assert.equal((await asPage(() => f.app.prepareOwnerAction(f.scope, { action: "revoke" }))).status, 200);
  } finally { f.raw.close(); }
});

