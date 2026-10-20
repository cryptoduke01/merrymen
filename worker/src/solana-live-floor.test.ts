/**
 * The 2026-10-18 audit's GAP0 scenarios, end to end and with no network: agent
 * tick or manual intent → runtime → executor → recordSigned, against a fake RPC
 * and a stubbed Jupiter. A bad build quote, or a dust mark, must not get a live
 * sale signed, admitted or broadcast. Fair trades still go through.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAgent } from "./solana-agent";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import type { SolanaSignedSubmission } from "./solana-executor";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { PYTH_SOL_USD_ACCOUNT, SOLANA_PYTH_FEEDS, readSolanaReferencePrice, solanaPythGeneration, type SolanaPythGeneration } from "./solana-reference-price";
import { pythAccount } from "./solana-reference-price-fixture";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "./solana-trading-store";
import { sealSecret } from "./store-crypto";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111", SYSTEM = "11111111111111111111111111111111";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", RPC = "https://rpc.fixture.invalid/";
const NOW = 1_000_000, SLOT = 1000;
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (v: string) => Buffer.from(getBase58Encoder().encode(v));
// 25 USDG and 0.2 SOL per trade; 100 USDG and 1 SOL a day.
const limits = { perTradeUsdg: "25000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "200000000", dailyWsol: "1000000000" };
// Fair price is $150 per SOL. Pyth agrees: 150.00000000 with an 8-decimal exponent.
const fairOut = (input: string, amount: bigint) => input === SOLANA_WRAPPED_SOL_MINT ? amount * 150n / 1000n : amount * 1000n / 150n;
type Build = { kind: "dust" } | { kind: "fair" } | { kind: "factor"; num: bigint; den: bigint };
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
function rpcAccount(data: Buffer, owner: string, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
function token(mint: string, owner: string, amount: bigint) {
  const b = Buffer.alloc(165); keyBytes(mint).copy(b, 0); keyBytes(owner).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; return b;
}
function mintJson(mint: string) {
  const usdg = mint === SOLANA_USDG_MINT;
  return { context: { slot: SLOT }, value: { executable: false, owner: usdg ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, lamports: 1, space: 82,
    data: { program: usdg ? "spl-token-2022" : "spl-token", space: 82, parsed: { type: "mint", info: { isInitialized: true, decimals: usdg ? 6 : 9,
      supply: "1000000000000", freezeAuthority: null, mintAuthority: null } } } } };
}

async function fixture(t: TestContext, opts: { cash: bigint; wsol: bigint; mark: "fair" | "dust"; build: Build; strategy?: Record<string, unknown>; pythAgeMs?: number;
  /** Serve the chain as two agreeing providers (readEach), as reconciling a recorded trade requires. */
  quorum?: boolean }) {
  const net = { lastBuild: null as null | { amount: bigint; out: bigint; min: bigint; input: string }, urls: [] as string[] };
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input); net.urls.push(url.split("?")[0]!);
    if (url === RPC) {
      const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
      const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : body.method === "getSlot" ? SLOT
        : body.method === "getAccountInfo" ? mintJson(body.params[0] as string) : assert.fail(`unexpected mint RPC ${body.method}`);
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    if (url.startsWith("https://api.jup.ag/swap/v1/quote?")) {
      const q = new URL(url).searchParams, amount = BigInt(q.get("amount")!), inputMint = q.get("inputMint")!, outputMint = q.get("outputMint")!;
      const slip = Number(q.get("slippageBps")), fair = fairOut(inputMint, amount);
      const out = opts.build.kind === "dust" ? 1n : opts.build.kind === "fair" ? fair : fair * opts.build.num / opts.build.den;
      const min = out * BigInt(10_000 - slip) / 10_000n || 1n;
      net.lastBuild = { amount, out, min, input: inputMint };
      return json({ swapMode: "ExactIn", inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: min.toString(),
        slippageBps: slip, contextSlot: SLOT, platformFee: null, priceImpactPct: "0.01",
        routePlan: [{ swapInfo: { ammKey: key(70), inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString() }, percent: 100 }] });
    }
    if (url === "https://api.jup.ag/swap/v1/swap-instructions") {
      const body = JSON.parse(String(init!.body)) as { userPublicKey: string; destinationTokenAccount: string; quoteResponse: Record<string, string | number> };
      const q = body.quoteResponse, inputMint = String(q.inputMint), outputMint = String(q.outputMint);
      const temp = await deriveSolanaAta(body.userPublicKey, inputMint, inputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM);
      const data = Buffer.alloc(36); Buffer.from(SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR).copy(data);
      data.writeUInt32LE(1, 9); data[14] = 100; data[16] = 1;
      data.writeBigUInt64LE(BigInt(q.inAmount as string), 17); data.writeBigUInt64LE(BigInt(q.outAmount as string), 25); data.writeUInt16LE(Number(q.slippageBps), 33);
      const accounts = [SOLANA_CLASSIC_TOKEN_PROGRAM, key(40), body.userPublicKey, temp, key(41), key(42), body.destinationTokenAccount, inputMint, outputMint, JUP, TOKEN_2022_PROGRAM]
        .map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: [3, 4, 5, 6].includes(i) }));
      return json({ swapInstruction: { programId: JUP, data: data.toString("base64"), accounts }, addressLookupTableAddresses: [] });
    }
    return assert.fail(`unexpected network call ${url}`);
  });
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: NOW };
  t.after(() => raw.close());
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21))).publicKey);
  const session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const feePayer = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const ownerUsdg = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsol = await deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const dataAddress = key(91), binary = Buffer.from("runtime-tested-binary"), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const vaultState = (seq: bigint) => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8; b[p++] = 2; b[p++] = 255;
    for (const v of [owner, session]) { keyBytes(v).copy(b, p); p += 32; }
    for (const v of [1n, seq, BigInt(Math.floor(limits.expiresAtMs / 1000)), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(v, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  // Accounts beyond the vault's own: each Pyth generation's SOL/USD account at $150, owned by its own receiver.
  // A test may serve something else at a Pyth address or add an account; `pythReads` lists each Pyth account read.
  const served = new Map<string, () => unknown>(Object.values(SOLANA_PYTH_FEEDS).map(feed => [feed.account, () =>
    pythAccount({ price: 15_000_000_000n, conf: 1_500_000n, publishTimeMs: clock.now - (opts.pythAgeMs ?? 0), owner: feed.receiverProgram })]));
  const pythAddresses = new Set(Object.values(SOLANA_PYTH_FEEDS).map(feed => feed.account)), pythReads: string[] = [];
  const extra = (k: string): unknown => { if (pythAddresses.has(k)) pythReads.push(k); return served.get(k)?.() ?? null; };
  const accountFor = (k: string): unknown => k === vault ? rpcAccount(vaultState(0n), PROGRAM)
    : k === cashAta ? rpcAccount(token(SOLANA_USDG_MINT, vault, opts.cash), TOKEN_2022_PROGRAM)
    : k === wsolAta ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, opts.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : k === feePayer ? rpcAccount(Buffer.alloc(0), SYSTEM)
    : k === ownerUsdg ? rpcAccount(token(SOLANA_USDG_MINT, owner, 0n), TOKEN_2022_PROGRAM)
    : k === ownerWsol ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, owner, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : extra(k);
  const response = (value: unknown) => ({ context: { slot: SLOT }, value });
  const sends: string[] = [];
  const read: SolanaLiveRead = async (method, params = []) => {
    switch (method) {
      case "getSlot": return SLOT;
      case "getBlockHeight": return 900;
      case "getEpochInfo": return { absoluteSlot: SLOT, blockHeight: 900 };
      case "getAccountInfo": {
        const [k, cfg] = params as [string, { dataSlice?: { offset: number; length: number } }];
        if (k === PROGRAM) return response(rpcAccount(program, LOADER, true));
        if (k === dataAddress) { const s = cfg.dataSlice!; return response({ ...rpcAccount(programData.subarray(s.offset, s.offset + s.length), LOADER), space: programData.length }); }
        return response(accountFor(k));
      }
      case "getMultipleAccounts": return response((params[0] as string[]).map(accountFor));
      case "getMinimumBalanceForRentExemption": return 2_039_280;
      case "getLatestBlockhash": return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
      case "getFeeForMessage": return response(10_000);
      case "getSignatureStatuses": return response([null]);
      case "getTransaction": return null;
      case "simulateTransaction": {
        // The route delivers exactly the build quote's guaranteed minimum.
        const lb = net.lastBuild!, selling = lb.input === SOLANA_WRAPPED_SOL_MINT;
        const cashAfter = selling ? opts.cash + lb.min : opts.cash - lb.amount, wsolAfter = selling ? opts.wsol - lb.amount : opts.wsol + lb.min;
        const [v, inp, out, payer] = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
        const after = (k: string) => k === v ? rpcAccount(vaultState(1n), PROGRAM)
          : k === cashAta ? rpcAccount(token(SOLANA_USDG_MINT, vault, cashAfter), TOKEN_2022_PROGRAM)
          : k === wsolAta ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, wsolAfter), SOLANA_CLASSIC_TOKEN_PROGRAM)
          : rpcAccount(Buffer.alloc(0), SYSTEM, false, 100_000_000 - 10_000);
        return response({ err: null, unitsConsumed: 200_000, accounts: [v!, inp!, out!, payer!].map(after) });
      }
      default: return assert.fail(`unexpected live RPC ${method}`);
    }
  };
  const rpc: SolanaLiveRpc = { read: fn => fn(read), send: async wire => { sends.push(wire); return "sent"; },
    ...(opts.quorum ? { readEach: async <T>(fn: (rpc: SolanaLiveRead) => Promise<T>) => [await fn(read), await fn(read)] } : {}) };
  const quote = async (i: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number }) => {
    const out = opts.mark === "dust" ? 1n : fairOut(i.inputMint, BigInt(i.amountRaw));
    return { source: "jupiter" as const, inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: out.toString(),
      minOutAmount: ((out * BigInt(10_000 - i.slippageBps) / 10_000n) || 1n).toString(), slippageBps: i.slippageBps, contextSlot: SLOT,
      quotedAtMs: clock.now, expiresAtMs: clock.now + 30_000 };
  };
  const readMint = async (mint: string) => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
    decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: SLOT, observedAtMs: clock.now, buyBlockedReasons: [] });
  const market = { readMint, quote };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"),
    MERRYMEN_JUPITER_API_KEY: "fixture-not-a-key", MERRYMEN_SOLANA_RPC_MAINNET: RPC };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "live", limits);
  await ensureSolanaTradingSchema(db);
  const record = { programId: PROGRAM, vault, session, sessionEpoch: "1", registrationSignature: key(43), registeredAtMs: NOW - 10_000 };
  await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, owner, JSON.stringify(record),
    sealSecret(`solana-session/v1 ${TENANT} ${owner} ${PROGRAM} ${vault} ${session} 1\n` + sessionSeed.toString("base64"), Buffer.alloc(32, 30)));
  // Prior settled history: the vault holds opts.wsol bought at the fair price.
  const basis = opts.wsol * 150n / 1000n;
  await db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, owner, JSON.stringify({
    hwmRaw: (opts.cash + basis).toString(), cashRaw: opts.cash.toString(), wsolRaw: opts.wsol.toString(), costBasisUsdgRaw: basis.toString(),
    realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: NOW - 5000 }));
  if (opts.strategy) { const b = (await bindings.get(TENANT))!; await bindings.strategy(TENANT, owner, b.revision, opts.strategy as never); }
  // `runtime(more)`: an app runtime on the same database, chain and clock whose env adds `more`.
  const runtime = (more: Record<string, string> = {}) => createSolanaAppRuntime({ db, rpc, market, env: { ...env, ...more }, now: () => clock.now }), app = runtime();
  const submissions = async () => (await db.prepare("SELECT request_id,notional_raw,submission_json FROM solana_runtime_submissions").all() as
    Array<{ request_id: string; notional_raw: string; submission_json: string }>).map(r => ({ ...r, submission: JSON.parse(r.submission_json) as SolanaSignedSubmission }));
  const agent = (runtime: ReturnType<typeof createSolanaAppRuntime> = app) => createSolanaAgent({ db, runtime, market, now: () => clock.now });
  return { app, scope, sends, submissions, agent, net, runtime, served, pythReads, db };
}
const manual = (inputMint: string, amountRaw: string, requestId: string) => ({ kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId, inputMint,
  outputMint: inputMint === SOLANA_USDG_MINT ? SOLANA_WRAPPED_SOL_MINT : SOLANA_USDG_MINT, amountRaw, slippageBps: 50 });
const rebalance = { enabled: true, rebalanceBps: 100, tradeUsdgRaw: "25000000", intervalSeconds: 60 };

test("A: an agent sell with a fair mark and a dust build quote is never signed, admitted or sent", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "dust" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.ok(f.net.urls.includes("https://api.jup.ag/swap/v1/swap-instructions"), "the dust route was built and then refused");
});

test("B: a dust mark and a dust build cannot sell the whole position", async t => {
  const f = await fixture(t, { cash: 0n, wsol: 1_000_000_000n, mark: "dust", build: { kind: "dust" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("B2: with a dust mark but a fair build, the agent's sale is sized by SOL and charged at its reference value", async t => {
  // The dust mark makes the whole 1 SOL look worth 1 micro-USDG. The agent asks for
  // the 0.2 SOL per-trade maximum; that is 30 USDG at $150, over the 25 USDG limit.
  const f = await fixture(t, { cash: 0n, wsol: 1_000_000_000n, mark: "dust", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.equal(f.net.lastBuild?.amount, 200_000_000n);
});

test("C: a manual sell previewed fairly but built at dust is refused", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "dust" } });
  const intent = manual(SOLANA_WRAPPED_SOL_MINT, "166000000", "manual-sell-1");
  const preview = await f.app.preview(f.scope, { mode: "live", intent }) as { quote: { minOutAmount: string } };
  assert.equal(preview.quote.minOutAmount, "24775500");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent }), /refused: risk/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("D: a manual buy built at 1% of fair is refused", async t => {
  const f = await fixture(t, { cash: 100_000_000n, wsol: 0n, mark: "fair", build: { kind: "factor", num: 1n, den: 100n } });
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "manual-buy-1") }), /refused: risk/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

/** The reference-price [alert] lines this process said while `run` ran. */
async function referenceAlerts(t: TestContext, run: () => Promise<unknown>): Promise<string[]> {
  const errors = t.mock.method(console, "error"), from = errors.mock.callCount();
  try { await run(); } finally { errors.mock.restore(); }
  return errors.mock.calls.slice(from).map(call => String(call.arguments[0])).filter(line => line.startsWith("[alert] solana-reference-price"));
}

test("a fair manual sell is admitted once, with its reference floor recorded, and a 2%-cheap fill is charged at the reference", async t => {
  const fair = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  let placed: Awaited<ReturnType<typeof fair.app.trade>> | undefined;
  // A fresh reference says nothing to the operator.
  assert.deepEqual(await referenceAlerts(t, async () => {
    placed = await fair.app.trade(fair.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "fair-sell") });
  }), []);
  assert.ok(placed && "status" in placed && placed.status === "pending");
  const [row] = await fair.submissions();
  assert.equal(row!.notional_raw, "15000000");
  assert.equal(row!.submission.risk.reference.minOutFloor, "14550000");
  assert.ok(BigInt(row!.submission.minOutAmount) >= BigInt(row!.submission.risk.reference.minOutFloor));
  assert.equal(fair.sends.length, 1);
  const cheap = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "factor", num: 98n, den: 100n } });
  const cheapPlaced = await cheap.app.trade(cheap.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "cheap-sell") });
  assert.equal("status" in cheapPlaced && cheapPlaced.status, "pending");
  assert.equal((await cheap.submissions())[0]!.notional_raw, "15000000");
});

test("a sell above the signed per-trade SOL limit is refused before any route is built", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "200000001", "too-much") }), /refused: risk/);
  assert.ok(!f.net.urls.some(url => url.startsWith("https://api.jup.ag/")));
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

/** This process's own MERRYMEN_SOLANA_PYTH_GENERATION for one test, restored after it. */
function processGeneration(t: TestContext, value: string | undefined) {
  const had = Object.hasOwn(process.env, "MERRYMEN_SOLANA_PYTH_GENERATION"), saved = process.env.MERRYMEN_SOLANA_PYTH_GENERATION;
  t.after(() => { if (had) process.env.MERRYMEN_SOLANA_PYTH_GENERATION = saved; else delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; });
  if (value === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = value;
}
/** A good read clears anything an earlier test left refused in this process, so the next refusal is said at once. */
const clearReferenceAlerts = () => readSolanaReferencePrice(async () => ({ context: { slot: SLOT }, value: pythAccount({ publishTimeMs: NOW }) }), SLOT, NOW,
  { generation: "current" });
const CURRENT = SOLANA_PYTH_FEEDS.current, UPGRADED = SOLANA_PYTH_FEEDS.upgraded;
/** What a Pyth generation setting that names no generation says, first time, in full. */
const CONFIG_ALERT = "[alert] solana-reference-price refused: reason=config generation=invalid failingForMs=0 refused=1 suppressed=0 — " +
  "MERRYMEN_SOLANA_PYTH_GENERATION must be current or upgraded (unset is current); no live Solana trade is admitted until the setting is fixed";

test("a Pyth generation setting that names neither generation is a configuration refusal before any quote or read, and says the [alert]", async t => {
  processGeneration(t, undefined);
  for (const value of ["Upgraded", "both", " current", UPGRADED.account]) {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    await clearReferenceAlerts();
    const said = await referenceAlerts(t, () => assert.rejects(
      f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: value }).trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "misconfigured") }),
      (error: unknown) => error instanceof Error && error.name === "SolanaAppRuntimeError" && (error as Error & { code: string }).code === "configuration" &&
        /independent SOL price source \(Pyth generation\) is misconfigured/.test(error.message), value));
    // Said once, as the line an operator pages on, with the setting to fix rather than a Pyth outage to chase,
    // and never with the value itself: the whole line is fixed text.
    assert.deepEqual(said, [CONFIG_ALERT], value);
    assert.ok(!said.some(line => line.split(" — ")[0]!.includes(value.trim())), value);
    assert.deepEqual(f.pythReads, [], value); assert.ok(!f.net.urls.some(url => url.startsWith("https://api.jup.ag/")), value);
    assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  }
});

test("the runtime's own env picks the generation for the read, the executor's check and the store's admission; the process's setting is never read", async t => {
  // A process setting that names no generation would refuse any read or check that consulted it.
  processGeneration(t, "Upgraded");
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "runtime-env-sell") });
  assert.equal("status" in placed && placed.status, "pending");
  assert.deepEqual(f.pythReads, [CURRENT.account]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.risk.reference.reference.account, CURRENT.account); assert.equal(f.sends.length, 1);
});

test("a WSOL withdrawal is valued from the runtime's generation, and a store keeps that valuation only while it checks the same one", async t => {
  processGeneration(t, "current");
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  f.served.set(f.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000)); // the owner pays for its own transaction
  await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  assert.deepEqual(f.pythReads, [UPGRADED.account]);
  const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
  assert.equal(saved.withdrawValuation?.reference.reference.account, UPGRADED.account);
  assert.equal(saved.withdrawValuation?.reference.referenceOut, "15000000"); // 0.1 SOL at $150
  // Offered again to a store that checks the other generation, or a setting that names none, it is dropped: never a refusal.
  for (const generation of [() => "current" as const, () => { throw new Error("names no generation"); }]) {
    const store = new SolanaTradingStore(f.db, f.scope, () => NOW, undefined, generation);
    assert.equal(await store.saveSetup(saved), true);
    assert.equal((await store.setup())!.withdrawValuation, undefined);
  }
  const same = new SolanaTradingStore(f.db, f.scope, () => NOW, undefined, () => "upgraded");
  assert.equal(await same.saveSetup(saved), true);
  assert.equal((await same.setup())!.withdrawValuation?.reference.reference.account, UPGRADED.account);
});

test("a WSOL withdrawal still prepares while the Pyth generation setting names none: no Pyth read, no valuation, and the [alert] is said", async t => {
  processGeneration(t, undefined);
  // The owner's way out never depends on the setting: the valuation is dropped and the high-water mark
  // stays put (the conservative direction), as for any other unreadable value.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  f.served.set(f.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000)); // the owner pays for its own transaction
  await clearReferenceAlerts();
  let prepared: { transactionBase64: string } | undefined;
  const said = await referenceAlerts(t, async () => {
    prepared = await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }).prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  });
  assert.ok(prepared && prepared.transactionBase64.length > 0);
  assert.deepEqual(f.pythReads, []);
  const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
  assert.deepEqual([saved.kind, saved.mint, saved.amountRaw, saved.withdrawValuation], ["withdraw", SOLANA_WRAPPED_SOL_MINT, "100000000", undefined]);
  assert.deepEqual(said, [CONFIG_ALERT]);
  // The same withdrawal with the setting unset is valued, from the default generation.
  const valued = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  valued.served.set(valued.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000));
  await valued.runtime().prepareOwnerAction(valued.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  assert.deepEqual(valued.pythReads, [CURRENT.account]);
  assert.equal((await new SolanaTradingStore(valued.db, valued.scope).setup())!.withdrawValuation?.reference.referenceOut, "15000000");
});

test("status names a misconfigured reference setting as a blocker of every trade, and an agent held by it still says the [alert]", async t => {
  processGeneration(t, undefined);
  const SOURCE = "The independent SOL price source (Pyth generation) is misconfigured.", TOLERANCE = "The independent SOL price tolerance is misconfigured.";
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  const good = await f.app.status(f.scope);
  assert.deepEqual([good.live.ready, good.live.blockers], [true, []]);
  for (const [more, blocker] of [[{ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }, SOURCE], [{ MERRYMEN_SOLANA_PYTH_GENERATION: "Upgraded" }, SOURCE],
    [{ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "49" }, TOLERANCE], [{ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "3e2" }, TOLERANCE]] as const) {
    await clearReferenceAlerts();
    let status: Awaited<ReturnType<typeof f.app.status>> | undefined;
    const said = await referenceAlerts(t, async () => { status = await f.runtime(more).status(f.scope); });
    // Not ready, and no exit either: trade() would refuse a sell as configuration too.
    assert.deepEqual([status!.live.ready, status!.live.canExit, status!.live.blockers], [false, false, [blocker]], JSON.stringify(more));
    assert.deepEqual(said, blocker === SOURCE ? [CONFIG_ALERT] : [], JSON.stringify(more));
  }
  // The agent holds instead of trying, and the operator still hears about the generation, once.
  await clearReferenceAlerts();
  let outcomes: string[] = [];
  const said = await referenceAlerts(t, async () => { outcomes = (await f.agent(f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" })).tick()).map(r => r.outcome); });
  assert.deepEqual(outcomes, ["held"]);
  assert.deepEqual(said, [CONFIG_ALERT]);
  assert.deepEqual(f.pythReads, []); assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("with MERRYMEN_SOLANA_PYTH_GENERATION=upgraded, live trades are read, checked by the executor and admitted by the store on the upgraded account alone", async t => {
  // The process names the other generation: a read or check that consulted it would refuse these trades.
  processGeneration(t, "current");
  for (const [inputMint, amountRaw, cash, wsol, notional] of [[SOLANA_WRAPPED_SOL_MINT, "100000000", 50_000_000n, 1_000_000_000n, "15000000"],
    [SOLANA_USDG_MINT, "25000000", 100_000_000n, 0n, "25000000"]] as const) {
    const f = await fixture(t, { cash, wsol, mark: "fair", build: { kind: "fair" } });
    const placed = await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(f.scope, { mode: "live", intent: manual(inputMint, amountRaw, "upgraded-trade") });
    assert.equal("status" in placed && placed.status, "pending", inputMint);
    // The runtime read the upgraded account and never the current one; the executor signed only
    // above that bound's floor, and the store admitted the bound as evidence from it.
    assert.deepEqual(f.pythReads, [UPGRADED.account], inputMint);
    const [row] = await f.submissions();
    assert.equal(row!.submission.risk.reference.reference.account, UPGRADED.account, inputMint);
    assert.ok(BigInt(row!.submission.minOutAmount) >= BigInt(row!.submission.risk.reference.minOutFloor), inputMint);
    assert.equal(row!.notional_raw, notional, inputMint); assert.equal(f.sends.length, 1, inputMint);
  }
});

test("a generation mismatch refuses: the other generation's account at the configured address, or the configured account gone, with no fallback", async t => {
  processGeneration(t, undefined);
  const sell = manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "mismatch-sell");
  // Set to upgraded, and the RPC serves, at the upgraded address, an account the current receiver owns.
  const swapped = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  swapped.served.set(UPGRADED.account, () => pythAccount({ price: 15_000_000_000n, conf: 1_500_000n, publishTimeMs: NOW, owner: CURRENT.receiverProgram }));
  await clearReferenceAlerts();
  let said = await referenceAlerts(t, () => assert.rejects(swapped.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(swapped.scope, { mode: "live", intent: sell }),
    /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=foreign generation=upgraded account=${UPGRADED.account} ` +
    "failingForMs=0 refused=1 suppressed=0"]);
  assert.deepEqual(swapped.pythReads, [UPGRADED.account]);
  assert.deepEqual(await swapped.submissions(), []); assert.equal(swapped.sends.length, 0);
  // Set to current, whose account is gone while the upgraded one is fresh: refused, and the upgraded account is never read.
  const closed = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  closed.served.set(CURRENT.account, () => null);
  await clearReferenceAlerts();
  said = await referenceAlerts(t, () => assert.rejects(closed.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "current" }).trade(closed.scope, { mode: "live", intent: sell }),
    /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=missing generation=current account=${CURRENT.account} ` +
    "failingForMs=0 refused=1 suppressed=0"]);
  assert.deepEqual(closed.pythReads, [CURRENT.account]);
  assert.deepEqual(await closed.submissions(), []); assert.equal(closed.sends.length, 0);
});

test("a signed trade whose bound came from one generation is refused at admission by a store that checks the other, or whose setting names none", async t => {
  processGeneration(t, undefined);
  // Signed and recorded by a runtime set to upgraded ...
  const signer = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  await signer.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(signer.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "carried") });
  const submission = (await signer.submissions())[0]!.submission;
  assert.equal(submission.risk.reference.reference.account, UPGRADED.account);
  // ... then offered for admission to the same account's journal on a fresh database, checked as each store is set.
  const checks: Array<[string, () => SolanaPythGeneration, boolean]> = [["current", () => "current", false],
    ["a setting that names none", () => solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }), false], ["upgraded", () => "upgraded", true]];
  for (const [name, generation, admitted] of checks) {
    const other = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    const journal = new SolanaTradingStore(other.db, other.scope, () => NOW, undefined, generation);
    if (admitted) assert.equal(await journal.recordSigned(structuredClone(submission)), true, name);
    else await assert.rejects(journal.recordSigned(structuredClone(submission)), /independent SOL price evidence is missing, stale or altered/, name);
    assert.equal((await other.submissions()).length, admitted ? 1 : 0, name);
  }
});

test("a retry of an admitted live trade returns it before any reference setting is checked: a bad or switched setting never blocks the replay", async t => {
  processGeneration(t, undefined);
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, quorum: true });
  const input = { mode: "live" as const, intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "admitted-then-retried") };
  const placed = await f.app.trade(f.scope, input);
  assert.ok("status" in placed && placed.status === "pending");
  const [admitted] = await f.submissions();
  assert.equal(admitted!.submission.risk.reference.reference.account, CURRENT.account);
  assert.deepEqual(f.pythReads, [CURRENT.account]);
  const jupiter = () => f.net.urls.filter(url => url.startsWith("https://api.jup.ag/")).length, built = jupiter();
  // A setting that names no generation, the other generation, and a tolerance out of range: each would refuse a new trade.
  for (const more of [{ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }, { MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" },
    { MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "49" }] as Array<Record<string, string>>) {
    const label = JSON.stringify(more), sendsBefore = f.sends.length;
    await clearReferenceAlerts();
    let again: Awaited<ReturnType<typeof f.app.trade>> | undefined;
    const said = await referenceAlerts(t, async () => { again = await f.runtime(more).trade(f.scope, input); });
    // The prior trade, reconciled and returned: the setting is never consulted, so nothing is said either.
    assert.ok(again && "signature" in again, label);
    assert.deepEqual([again.signature, again.status, again.requestId], [placed.signature, "pending", "admitted-then-retried"], label);
    assert.deepEqual(said, [], label);
    // No Pyth read (of either account), no Jupiter quote or build, no new submission.
    assert.deepEqual(f.pythReads, [CURRENT.account], label);
    assert.equal(jupiter(), built, label);
    const rows = await f.submissions();
    assert.deepEqual(rows.map(row => row.submission.signature), [placed.signature], label);
    // Unseen and inside its deadline, the recorded bytes are rebroadcast once, exactly as signed: never re-signed.
    assert.equal(f.sends.length, sendsBefore + 1, label);
    assert.ok(f.sends.every(wire => wire === admitted!.submission.signedTransactionBase64), label);
  }
});

test("a stale independent price refuses even a fair live trade, and says the [alert] an operator pages on", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, pythAgeMs: 180_000 });
  // A good read first clears anything an earlier test left refused in this process, so this refusal is said at once.
  await readSolanaReferencePrice(async () => ({ context: { slot: SLOT }, value: pythAccount({ publishTimeMs: NOW }) }), SLOT, NOW);
  const said = await referenceAlerts(t, () =>
    assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "stale-sell") }), /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=stale generation=current ` +
    `account=${PYTH_SOL_USD_ACCOUNT} ageMs=180000 maxAgeMs=120000 contextSlot=${SLOT} failingForMs=0 refused=1 suppressed=0`]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});
