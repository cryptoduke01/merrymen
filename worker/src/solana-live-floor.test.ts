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
import { PYTH_SOL_USD_ACCOUNT } from "./solana-reference-price";
import { pythAccount } from "./solana-reference-price-fixture";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { ensureSolanaTradingSchema } from "./solana-trading-store";
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

async function fixture(t: TestContext, opts: { cash: bigint; wsol: bigint; mark: "fair" | "dust"; build: Build; strategy?: Record<string, unknown>; pythAgeMs?: number }) {
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
  // The local test build declares its own id: declare_id! embeds its 32 bytes, which the executor requires.
  const dataAddress = key(91), binary = Buffer.concat([Buffer.from("runtime-tested-binary"), keyBytes(PROGRAM)]), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const vaultState = (seq: bigint) => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8; b[p++] = 2; b[p++] = 255;
    for (const v of [owner, session]) { keyBytes(v).copy(b, p); p += 32; }
    for (const v of [1n, seq, BigInt(Math.floor(limits.expiresAtMs / 1000)), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(v, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const accountFor = (k: string): unknown => k === vault ? rpcAccount(vaultState(0n), PROGRAM)
    : k === cashAta ? rpcAccount(token(SOLANA_USDG_MINT, vault, opts.cash), TOKEN_2022_PROGRAM)
    : k === wsolAta ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, opts.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : k === feePayer ? rpcAccount(Buffer.alloc(0), SYSTEM)
    : k === ownerUsdg ? rpcAccount(token(SOLANA_USDG_MINT, owner, 0n), TOKEN_2022_PROGRAM)
    : k === ownerWsol ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, owner, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : k === PYTH_SOL_USD_ACCOUNT ? pythAccount({ price: 15_000_000_000n, conf: 1_500_000n, publishTimeMs: clock.now - (opts.pythAgeMs ?? 0) }) : null;
  const response = (value: unknown) => ({ context: { slot: SLOT }, value });
  const sends: string[] = [];
  const read: SolanaLiveRead = async (method, params = []) => {
    switch (method) {
      case "getSlot": return SLOT;
      case "getBlockHeight": return 900;
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
  // Two agreeing providers, as the live transport always has: deployment checks and bookings need both.
  const rpc: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async wire => { sends.push(wire); return "sent"; } };
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
  const app = createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now });
  const submissions = async () => (await db.prepare("SELECT request_id,notional_raw,submission_json FROM solana_runtime_submissions").all() as
    Array<{ request_id: string; notional_raw: string; submission_json: string }>).map(r => ({ ...r, submission: JSON.parse(r.submission_json) as SolanaSignedSubmission }));
  const agent = () => createSolanaAgent({ db, runtime: app, market, now: () => clock.now });
  return { app, scope, sends, submissions, agent, net };
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

test("a fair manual sell is admitted once, with its reference floor recorded, and a 2%-cheap fill is charged at the reference", async t => {
  const fair = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const placed = await fair.app.trade(fair.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "fair-sell") });
  assert.equal("status" in placed && placed.status, "pending");
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

test("a stale independent price refuses even a fair live trade", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, pythAgeMs: 180_000 });
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "stale-sell") }), /refused: risk/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});
