/** Chain-scoped wallet bindings. Existing RH tenant identities remain unchanged. */
import { CHAINS } from "../../../packages/core/src/ids";
import { parseSolanaRawAmount, solanaPaperAgentId, validateSolanaAccountLimits, type SolanaPaperLimits } from "../../../packages/core/src/solana";
import type { Db } from "../../../worker/src/db";
import { getSolanaRuntimeDb } from "../../../worker/src/solana-runtime-db";

export type SolanaRequestedMode = "paper" | "live";
export interface SolanaStrategy {
  enabled: boolean;
  targetSolBps: number;
  rebalanceBps: number;
  tradeUsdgRaw: string;
  intervalSeconds: number;
}
export interface SolanaBinding {
  tenant: `0x${string}`;
  did: string;
  chain: typeof CHAINS.solana;
  owner: string;
  requestedMode: SolanaRequestedMode;
  limits: SolanaPaperLimits | null;
  strategy: SolanaStrategy | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}
export class SolanaBindingError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "missing" | "stale") {
    super({ invalid: "Invalid Solana account settings.", conflict: "This Solana wallet is already bound to another account, or this account already has a different Solana wallet.",
      missing: "Connect and verify a Solana wallet first.", stale: "Solana settings changed. Refresh before saving again." }[code]);
    this.name = "SolanaBindingError";
  }
}
export interface SolanaBindingStore {
  get(tenant: `0x${string}`): Promise<SolanaBinding | null>;
  bind(tenant: `0x${string}`, did: string, owner: string): Promise<SolanaBinding>;
  settings(tenant: `0x${string}`, owner: string, revision: number, mode: SolanaRequestedMode, limits: SolanaPaperLimits): Promise<SolanaBinding>;
  strategy(tenant: `0x${string}`, owner: string, revision: number, value: SolanaStrategy): Promise<SolanaBinding>;
  /** Kill switch: turn the tenant's autonomous strategy off. True when it was on. */
  disableForKill(tenant: `0x${string}`): Promise<boolean>;
  /** Every tenant with a saved strategy, on or off. */
  strategyTenants(): Promise<`0x${string}`[]>;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS solana_wallet_bindings (
  tenant TEXT PRIMARY KEY, did TEXT NOT NULL, chain TEXT NOT NULL,
  owner TEXT NOT NULL UNIQUE, requested_mode TEXT NOT NULL CHECK (requested_mode IN ('paper', 'live')),
  limits_json TEXT, strategy_json TEXT, revision BIGINT NOT NULL, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL
);`;
type Row = { tenant: string; did: string; chain: string; owner: string; requested_mode: SolanaRequestedMode;
  limits_json: string | null; strategy_json: string | null; revision: number | string; created_at_ms: number | string; updated_at_ms: number | string };
export function validateSolanaStrategy(value: unknown): SolanaStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolanaBindingError("invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["enabled", "targetSolBps", "rebalanceBps", "tradeUsdgRaw", "intervalSeconds"].includes(key))
    || typeof item.enabled !== "boolean" || !Number.isInteger(item.targetSolBps) || Number(item.targetSolBps) < 0 || Number(item.targetSolBps) > 10_000
    || !Number.isInteger(item.rebalanceBps) || Number(item.rebalanceBps) < 100 || Number(item.rebalanceBps) > 5_000
    || !Number.isInteger(item.intervalSeconds) || Number(item.intervalSeconds) < 30 || Number(item.intervalSeconds) > 86_400) throw new SolanaBindingError("invalid");
  try { parseSolanaRawAmount(item.tradeUsdgRaw); } catch { throw new SolanaBindingError("invalid"); }
  return { enabled: item.enabled, targetSolBps: Number(item.targetSolBps), rebalanceBps: Number(item.rebalanceBps),
    tradeUsdgRaw: item.tradeUsdgRaw as string, intervalSeconds: Number(item.intervalSeconds) };
}
function tenantKey(value: string): asserts value is `0x${string}` {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new SolanaBindingError("invalid");
}
function decoded(row: Row): SolanaBinding {
  if (row.chain !== CHAINS.solana) throw new SolanaBindingError("invalid");
  return { tenant: row.tenant as `0x${string}`, did: row.did, chain: CHAINS.solana, owner: row.owner,
    requestedMode: row.requested_mode, limits: row.limits_json ? JSON.parse(row.limits_json) as SolanaPaperLimits : null,
    strategy: row.strategy_json ? validateSolanaStrategy(JSON.parse(row.strategy_json)) : null,
    revision: Number(row.revision), createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) };
}
export class SqlSolanaBindingStore implements SolanaBindingStore {
  private ready: Promise<Db> | null = null;
  constructor(private connect: () => Promise<Db>, private dialect: "sqlite" | "postgres", private now: () => number = Date.now) {}
  private database(): Promise<Db> {
    if (!this.ready) this.ready = this.connect().then(async (db) => {
      if (this.dialect === "postgres") await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_983);
        await tx.exec(SCHEMA);
        // Db translates ADD COLUMN to Postgres's idempotent IF NOT EXISTS form.
        await tx.exec("ALTER TABLE solana_wallet_bindings ADD COLUMN strategy_json TEXT");
      });
      else await db.tx(async (tx) => {
        await tx.exec(SCHEMA);
        const columns = await tx.prepare("PRAGMA table_info(solana_wallet_bindings)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "strategy_json")) await tx.exec("ALTER TABLE solana_wallet_bindings ADD COLUMN strategy_json TEXT");
      });
      return db;
    }).catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }
  async get(tenant: `0x${string}`): Promise<SolanaBinding | null> {
    tenantKey(tenant);
    const row = await (await this.database()).prepare("SELECT * FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as Row | undefined;
    return row ? decoded(row) : null;
  }
  async bind(tenant: `0x${string}`, did: string, owner: string): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!/^did:privy:[A-Za-z0-9_-]{1,160}$/.test(did)) throw new SolanaBindingError("invalid");
    try { solanaPaperAgentId(owner); } catch { throw new SolanaBindingError("invalid"); }
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    // Both uniqueness constraints are decided by one atomic insert. Neither a
    // concurrent first binding nor a second tenant can replace an existing one.
    await db.prepare(`INSERT INTO solana_wallet_bindings
      (tenant,did,chain,owner,requested_mode,limits_json,revision,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,'paper',NULL,0,?,?) ON CONFLICT DO NOTHING`).run(tenant, did, CHAINS.solana, owner, nowMs, nowMs);
    const existing = await this.get(tenant);
    if (!existing || existing.owner !== owner || existing.did !== did) throw new SolanaBindingError("conflict");
    return existing;
  }
  async settings(tenant: `0x${string}`, owner: string, revision: number, mode: SolanaRequestedMode, limits: SolanaPaperLimits): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || !["paper", "live"].includes(mode)) throw new SolanaBindingError("invalid");
    const nowMs = this.now();
    let policy: SolanaPaperLimits;
    // The account bounds (96 operations a day, a 168-hour permission) for paper limits
    // too: paper books, paper trades and the strategy refuse anything wider later.
    try { policy = validateSolanaAccountLimits(limits, nowMs); } catch { throw new SolanaBindingError("invalid"); }
    const db = await this.database();
    const saved = await db.prepare(`UPDATE solana_wallet_bindings SET strategy_json = CASE WHEN requested_mode <> ? THEN NULL ELSE strategy_json END,
      requested_mode = ?, limits_json = ?,
      revision = revision + 1, updated_at_ms = ? WHERE tenant = ? AND owner = ? AND revision = ?`)
      .run(mode, mode, JSON.stringify(policy), nowMs, tenant, owner, revision);
    if (saved.changes !== 1) throw new SolanaBindingError("stale");
    return (await this.get(tenant))!;
  }
  async strategy(tenant: `0x${string}`, owner: string, revision: number, value: SolanaStrategy): Promise<SolanaBinding> {
    tenantKey(tenant);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new SolanaBindingError("invalid");
    const strategy = validateSolanaStrategy(value), nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    const saved = await db.prepare(`UPDATE solana_wallet_bindings SET strategy_json = ?, revision = revision + 1,
      updated_at_ms = ? WHERE tenant = ? AND owner = ? AND revision = ?`)
      .run(JSON.stringify(strategy), nowMs, tenant, owner, revision);
    if (saved.changes !== 1) throw new SolanaBindingError("stale");
    return (await this.get(tenant))!;
  }
  async strategyTenants(): Promise<`0x${string}`[]> {
    const rows = await (await this.database()).prepare("SELECT tenant FROM solana_wallet_bindings WHERE strategy_json IS NOT NULL ORDER BY tenant").all() as Array<{ tenant: string }>;
    return rows.map((row) => { tenantKey(row.tenant); return row.tenant; });
  }
  async disableForKill(tenant: `0x${string}`): Promise<boolean> {
    tenantKey(tenant);
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new SolanaBindingError("invalid");
    const db = await this.database();
    return db.tx(async (tx) => {
      // The same row lock trade admission takes. The revision bump below fences
      // any autonomous admission already in flight, whatever revision it read.
      const locked = await tx.prepare("UPDATE solana_wallet_bindings SET revision = revision WHERE tenant = ?").run(tenant);
      if (locked.changes !== 1) return false;
      const row = await tx.prepare("SELECT strategy_json FROM solana_wallet_bindings WHERE tenant = ?").get(tenant) as { strategy_json: string | null };
      if (!row.strategy_json) return false;
      let strategy: SolanaStrategy | null = null;
      try { strategy = validateSolanaStrategy(JSON.parse(row.strategy_json)); } catch { /* Unreadable: cleared below. */ }
      if (strategy && !strategy.enabled) return false;
      await tx.prepare("UPDATE solana_wallet_bindings SET strategy_json = ?, revision = revision + 1, updated_at_ms = ? WHERE tenant = ?")
        .run(strategy ? JSON.stringify({ ...strategy, enabled: false }) : null, nowMs, tenant);
      return true;
    });
  }
}

/** Lazy: importing a route never opens a database or writes a schema. */
let store: SolanaBindingStore | undefined;
export function getSolanaBindingStore(): SolanaBindingStore {
  if (!store) {
    store = new SqlSolanaBindingStore(getSolanaRuntimeDb, process.env.DATABASE_URL ? "postgres" : "sqlite");
  }
  return store;
}
