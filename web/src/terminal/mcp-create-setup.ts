import { AGENT_NAME_RE, DEFAULT_BASKET_SYMBOLS, RISK_PROFILES, STOCK_TOKENS, normalizeAgentName } from "@merrymen/core";
import { requestJson, RequestError } from "./request-json";

const ID = /^prp_[0-9a-f]{32}$/;
const STRATEGIES = new Set(["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter"]);
const STOCK_SYMBOLS = new Set(STOCK_TOKENS.map(token => token.symbol.toUpperCase()));
const RISK_KEYS = ["strategistStopLossBps", "takeProfitBps", "buyPerTickUsdg", "llmMaxActionUsdg", "slippageBps"] as const;
const KEYS = new Set<string>(["agentName", "strategy", "basketSymbols", "assetMode", ...RISK_KEYS]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export interface McpCreateSetup {
  id: string;
  owner: string;
  requestedBy: string;
  expiresAt: number;
  name: string;
  strategy: string;
  assetMode: "all" | "stocks" | "crypto";
  basket: string[];
  riskLevel: string | null;
  riskSettings: Record<string, number>;
}

export function mcpSetupRequest(search: string): { id: string | null; invalid: boolean } {
  const ids = new URLSearchParams(search).getAll("proposal");
  return ids.length === 0 ? { id: null, invalid: false }
    : ids.length === 1 && ID.test(ids[0]!) ? { id: ids[0]!, invalid: false }
      : { id: null, invalid: true };
}

export async function loadMcpCreateSetup(id:string,owner:string):Promise<McpCreateSetup> {
  try {
    return approvedMcpSetup(await requestJson<unknown>(`/api/mcp/approvals/${encodeURIComponent(id)}`),id,owner);
  } catch(e) {
    if(e instanceof RequestError){
      if(e.status===401)throw new Error("Sign in again to continue your Merryman setup.");
      if(e.status===403||e.status===404)throw new Error("This setup is no longer available to your signed-in account or assistant connection. Return to your assistant to reconnect and prepare a fresh setup.");
      if(e.status===410)throw new Error("This approved setup expired. Ask your assistant for a fresh setup.");
    }
    throw e;
  }
}

/** Only the owner-authenticated approval response can supply a setup. URL fields never supply settings. */
export function approvedMcpSetup(value: unknown, id: string, owner: string, nowMs = Date.now()): McpCreateSetup {
  const v = object(value);
  const b = object(v?.binding);
  const s = object(b?.settings);
  const result = object(v?.result);
  const refused = () => new Error("This setup is not approved for your current account, or it has expired. Return to your assistant for a new setup.");
  if (!ID.test(id) || v?.id !== id || v.kind !== "agent_draft" || v.status !== "applied" || b?.purpose !== "create" || result?.setup_only !== true) throw refused();
  if (!/^0x[0-9a-f]{40}$/i.test(owner) || typeof b.tenant !== "string" || b.tenant.toLowerCase() !== owner.toLowerCase()) throw refused();
  if (typeof v.expires_at !== "number" || !Number.isFinite(v.expires_at) || v.expires_at * 1000 <= nowMs || b.expires_at !== v.expires_at) throw refused();
  if (!s || Object.keys(s).some(key => !KEYS.has(key))) throw refused();
  if (typeof s.agentName !== "string" || normalizeAgentName(s.agentName) !== s.agentName || !AGENT_NAME_RE.test(s.agentName)) throw refused();
  if (typeof s.strategy !== "string" || !STRATEGIES.has(s.strategy)) throw refused();
  if (s.assetMode !== undefined && !["all", "stocks", "crypto"].includes(String(s.assetMode))) throw refused();
  if (s.basketSymbols !== undefined && (!Array.isArray(s.basketSymbols) || s.basketSymbols.length < 1 || s.basketSymbols.length > 10 || s.basketSymbols.some(x => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/.test(x)))) throw refused();
  // Older approved drafts can omit their basket. The stock default would be
  // excluded by crypto-only mode, and this handoff skips market selection.
  // Custom-token membership remains the owner approval's responsibility.
  if (s.strategy !== "trencher" && s.assetMode === "crypto" && (!Array.isArray(s.basketSymbols) || s.basketSymbols.every(symbol => STOCK_SYMBOLS.has(symbol.toUpperCase())))) {
    throw new Error("Crypto-only setup needs an explicit basket containing at least one crypto token. Return to your assistant to choose a crypto basket or another asset mode and prepare a fresh setup.");
  }
  const level = b.risk_level;
  if (level !== null && level !== "careful" && level !== "balanced" && level !== "bold") throw refused();
  const riskSettings: Record<string, number> = {};
  for (const key of RISK_KEYS) {
    if (s[key] === undefined) continue;
    if (!level || s[key] !== RISK_PROFILES[level].settings[key]) throw refused();
    riskSettings[key] = s[key] as number;
  }
  return {
    id, owner: owner.toLowerCase(), requestedBy: typeof v.requested_by === "string" ? v.requested_by : "your assistant",
    expiresAt: v.expires_at, name: s.agentName, strategy: s.strategy,
    assetMode: s.strategy === "trencher" ? "crypto" : (s.assetMode as McpCreateSetup["assetMode"] | undefined) ?? "all",
    basket: s.strategy === "trencher" ? [] : (s.basketSymbols as string[] | undefined) ?? [...DEFAULT_BASKET_SYMBOLS],
    riskLevel: level, riskSettings,
  };
}
