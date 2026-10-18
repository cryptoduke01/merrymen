/** Deterministic, opt-in USDG/SOL rebalancer. Both modes use the same admission boundary. */
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, validateSolanaPaperLimits, validateSolanaQuote, type SolanaPaperLimits } from "../../packages/core/src/solana";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore, validateSolanaStrategy, type SolanaStrategy } from "../../web/src/lib/solana-binding-store";
import { getSolanaAppRuntime } from "./solana-app-runtime";
import type { Db } from "./db";
import { createSolanaMarket } from "./solana-market";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { ensureSolanaTradingSchema, type SolanaAccountScope } from "./solana-trading-store";

export interface SolanaRebalanceInput {
  cashRaw: string; wsolRaw: string; solValueUsdgRaw: string; limits: SolanaPaperLimits;
  strategy: SolanaStrategy; mode: "paper" | "live"; revision: number; nowMs: number;
}
/** Integer-only sizing against an executable full-position exit quote. */
export function planSolanaRebalance(input: SolanaRebalanceInput) {
  const strategy = validateSolanaStrategy(input.strategy), limits = validateSolanaPaperLimits(input.limits, input.nowMs);
  if (!strategy.enabled) return null;
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("Invalid Solana strategy revision.");
  const cash = parseSolanaRawAmount(input.cashRaw, true), held = parseSolanaRawAmount(input.wsolRaw, true), value = parseSolanaRawAmount(input.solValueUsdgRaw, true);
  if ((held === 0n) !== (value === 0n)) throw new Error("A current executable SOL valuation is required.");
  const equity = cash + value;
  if (equity === 0n) return null;
  const target = equity * BigInt(strategy.targetSolBps) / 10_000n, delta = target - value;
  const deviation = delta < 0n ? -delta : delta;
  if (deviation * 10_000n < equity * BigInt(strategy.rebalanceBps) || delta === 0n) return null;
  const notional = [deviation, BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b);
  const buying = delta > 0n;
  const amount = buying ? (notional < cash ? notional : cash) : held * notional / value;
  if (amount === 0n) return null;
  const requestId = `rebalance-${input.revision}-${Math.floor(input.nowMs / (strategy.intervalSeconds * 1000))}`;
  return { ...parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId,
    inputMint: buying ? SOLANA_USDG_MINT : SOLANA_WRAPPED_SOL_MINT, outputMint: buying ? SOLANA_WRAPPED_SOL_MINT : SOLANA_USDG_MINT,
    amountRaw: amount.toString(), slippageBps: 50 }), mode: input.mode };
}
/** Re-quote the actual partial exit; a full-position minimum is not its unit price. */
export async function boundSolanaRebalanceSell(
  intent: NonNullable<ReturnType<typeof planSolanaRebalance>>, cap: bigint, market: SolanaPaperMarket, now: () => number,
) {
  if (intent.inputMint === SOLANA_USDG_MINT) return intent;
  let sized = intent;
  for (let attempt = 0; attempt < 3; attempt++) {
    const paper = parseSolanaSwapIntent({ ...sized, mode: "paper" });
    const quote = await market.quote(paper); validateSolanaQuote(quote, paper, now());
    const quoted = BigInt(quote.outAmount);
    if (quoted <= cap) return sized;
    const reduced = BigInt(sized.amountRaw) * cap * 9990n / (quoted * 10000n);
    if (reduced <= 0n) return null;
    sized = { ...sized, amountRaw: reduced.toString() };
  }
  return null;
}
type Runtime = Pick<ReturnType<typeof getSolanaAppRuntime>, "status" | "trade">;
export interface SolanaAgentOptions { db: Db; runtime: Runtime; market: SolanaPaperMarket; now?: () => number; postgres?: boolean; signal?: AbortSignal }
export function createSolanaAgent(options: SolanaAgentOptions) {
  const now = options.now ?? Date.now;
  return {
    async tick() {
      await ensureSolanaTradingSchema(options.db, options.postgres);
      await options.db.prepare("INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?) ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms").run(now());
      // Disabling a strategy never disables receipt recovery. Confirmation is
      // read-only and must keep working after mode changes or key rotation.
      const unsettled = await options.db.prepare("SELECT DISTINCT tenant,owner FROM solana_runtime_submissions WHERE status='pending'").all() as SolanaAccountScope[];
      const setups = await options.db.prepare("SELECT tenant,owner,setup_json FROM solana_runtime_setups").all() as Array<SolanaAccountScope & { setup_json: string }>;
      const recovered = new Map<string, Awaited<ReturnType<Runtime["status"]>>>();
      for (const scope of [...unsettled, ...setups.filter(item => { try { return JSON.parse(item.setup_json).status === "pending"; } catch { return false; } })]) {
        if (options.signal?.aborted) break;
        if (recovered.has(scope.tenant)) continue;
        try { recovered.set(scope.tenant, await options.runtime.status({ tenant: scope.tenant, owner: scope.owner })); } catch { /* Retry next tick; no replacement transaction. */ }
      }
      const rows = await options.db.prepare("SELECT tenant,owner,requested_mode,limits_json,strategy_json,revision FROM solana_wallet_bindings WHERE chain=? AND strategy_json IS NOT NULL ORDER BY tenant")
        .all(CHAINS.solana) as Array<{ tenant: string; owner: string; requested_mode: "paper" | "live"; limits_json: string | null; strategy_json: string; revision: number }>;
      const results: Array<{ owner: string; outcome: "held" | "submitted" | "unavailable" }> = [];
      for (const row of rows) {
        if (options.signal?.aborted) break;
        const scope: SolanaAccountScope = { tenant: row.tenant, owner: row.owner };
        try {
          const strategy = validateSolanaStrategy(JSON.parse(row.strategy_json));
          if (!strategy.enabled || !row.limits_json) continue;
          const limits = validateSolanaPaperLimits(JSON.parse(row.limits_json), now());
          const status = recovered.get(scope.tenant) ?? await options.runtime.status(scope);
          let cashRaw: string, wsolRaw: string;
          if (row.requested_mode === "paper") {
            if (!status.paper || status.paper.positions.some(p => p.mint !== SOLANA_WRAPPED_SOL_MINT)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            cashRaw = status.paper.cashRaw; wsolRaw = status.paper.positions.find(p => p.mint === SOLANA_WRAPPED_SOL_MINT)?.amountRaw ?? "0";
          } else {
            if (!status.live.balances || status.live.pending.length || (!status.live.ready && !status.live.canExit)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            cashRaw = status.live.balances.cashUsdg; wsolRaw = status.live.balances.wsolRaw;
          }
          let solValueUsdgRaw = "0";
          if (BigInt(wsolRaw) > 0n) {
            const markIntent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "rebalance-mark",
              inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: wsolRaw, slippageBps: 50 });
            const mark = await options.market.quote(markIntent); validateSolanaQuote(mark, markIntent, now()); solValueUsdgRaw = mark.minOutAmount;
          }
          let intent = planSolanaRebalance({ cashRaw, wsolRaw, solValueUsdgRaw, limits, strategy, mode: row.requested_mode, revision: Number(row.revision), nowMs: now() });
          if (intent) intent = await boundSolanaRebalanceSell(intent, [BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b), options.market, now);
          if (!intent) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          if (row.requested_mode === "live" && !status.live.ready && intent.inputMint === SOLANA_USDG_MINT) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          if (options.signal?.aborted) break;
          await options.runtime.trade(scope, { mode: row.requested_mode, intent, autonomousRevision: Number(row.revision), signal: options.signal });
          results.push({ owner: row.owner, outcome: "submitted" });
        } catch { results.push({ owner: row.owner, outcome: "unavailable" }); }
      }
      return results;
    },
  };
}

/** Dedicated sibling worker; Solana addresses never enter the RH worker loop. */
export async function runSolanaAgent(signal: AbortSignal) {
  const db = await getSolanaRuntimeDb();
  // Initialize the shared binding schema without inventing or registering a tenant.
  const bindings = new SqlSolanaBindingStore(async () => db, process.env.DATABASE_URL ? "postgres" : "sqlite");
  await bindings.get("0x0000000000000000000000000000000000000000");
  const agent = createSolanaAgent({ db, runtime: getSolanaAppRuntime(), market: createSolanaMarket(), postgres: !!process.env.DATABASE_URL, signal });
  while (!signal.aborted) {
    try {
      const results = await agent.tick();
      // Counts only: no credentials, signed bytes or tenant identities in logs.
      if (results.length) process.stdout.write(JSON.stringify({ solana: "tick", submitted: results.filter(r => r.outcome === "submitted").length,
        held: results.filter(r => r.outcome === "held").length, unavailable: results.filter(r => r.outcome === "unavailable").length }) + "\n");
    } catch { process.stderr.write("Solana worker storage is unavailable; no new trades were admitted.\n"); }
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); };
      const timer = setTimeout(onAbort, 15_000); signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
