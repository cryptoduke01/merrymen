/** Read-only sale evidence for X. Raw money stays here and never enters a model prompt. */
import type { Db } from "./db";
import { PUBLISHABLE_SOURCES } from "./thesis-policy";
import { distinctTrades } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./trade-evidence";
import { BUY_FRESH_MS, BUY_STALE_MS, type PlanSell, type SaleOutcome } from "./xpost/planner";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

/** A measured gross result. No tolerance turns a small loss into break-even. */
export function grossSaleOutcome(row: { pnl: unknown; cash: unknown }, costEvidenced: boolean): SaleOutcome {
  if (!costEvidenced || row.pnl === null || row.cash === null || row.pnl === undefined || row.cash === undefined) return "unknown";
  const pnl = Number(row.pnl);
  const cash = Number(row.cash);
  if (!Number.isFinite(pnl) || !Number.isFinite(cash) || cash < 0 || cash - pnl <= 0) return "unknown";
  return pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat";
}

/**
 * Only the current verified grant's account/chain and receipt-backed live
 * exits. Partial sells say sold, never fully closed. A cost replay failure
 * removes the result claim, not the independently proven sale. The SQL is
 * scoped before operation deduplication and the decision join binds its agent.
 */
export async function readSaleResults(db: Db, agentId: string, chainId: number, nowSec: number): Promise<PlanSell[]> {
  if (!ADDRESS.test(agentId) || !Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isFinite(nowSec)) return [];
  try {
    const account = await db.prepare("SELECT smart_account, chain_id, epoch FROM agents WHERE LOWER(smart_account) = LOWER(?)").get(agentId) as Record<string, unknown> | undefined;
    if (!account || Number(account.chain_id) !== chainId || !Number.isSafeInteger(Number(account.epoch))) return [];
    const spelling = String(account.smart_account);
    const rows = await db.prepare(`
      SELECT ${OP_KEY} AS op, t.decision_id, t.sell_token AS token, t.tx_hash, t.fill_qty_raw,
             COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name AS name,
             t.created_at, t.realized_pnl_usdg AS pnl, t.fill_cash_usdg AS cash
        FROM ${distinctTrades("LOWER(t.agent_id) = LOWER(?) AND t.epoch = ?")}
        JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
       WHERE t.status = 'landed' AND t.basis_source = 'receipt' AND t.fill_side = 'sell'
         AND t.kind IN ('swap', 'curve-trade') AND d.action = 'sell'
         AND d.source IN (${PUBLISHABLE_SOURCES.map(() => "?").join(",")})
         AND t.created_at > ? AND t.created_at <= ?
       ORDER BY t.created_at DESC, t.id DESC LIMIT 50
    `).all(spelling, Number(account.epoch), ...PUBLISHABLE_SOURCES, nowSec - (BUY_STALE_MS + BUY_FRESH_MS) / 1000, nowSec) as Record<string, unknown>[];
    const valid = rows.filter((r) => HASH.test(String(r.op)) && HASH.test(String(r.tx_hash)) && ADDRESS.test(String(r.token)) && /^\d+$/.test(String(r.fill_qty_raw)) && BigInt(String(r.fill_qty_raw)) > 0n && typeof r.decision_id === "string" && r.decision_id.length > 0);
    let evidenced = new Set<string>();
    try {
      evidenced = await readEvidencedSells(db, spelling, "landed", valid.map((r) => ({ op: String(r.op), token: String(r.token).toLowerCase() })));
    } catch {
      // Unread/estimated cost cannot become an emotional performance claim.
    }
    return valid.map((r) => ({
      side: "sell",
      operationKey: String(r.op).toLowerCase(),
      token: String(r.token).toLowerCase(),
      decisionId: String(r.decision_id),
      symbol: typeof r.symbol === "string" ? r.symbol : null,
      name: typeof r.name === "string" ? r.name : null,
      paper: false,
      atSec: Number(r.created_at),
      outcome: grossSaleOutcome({ pnl: r.pnl, cash: r.cash }, evidenced.has(String(r.op))),
    }));
  } catch {
    return [];
  }
}
