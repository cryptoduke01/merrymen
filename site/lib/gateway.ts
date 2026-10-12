/**
 * The merrymen gateway, as the website sees it.
 *
 * Only the PUBLIC surface is used from the browser: /memescope, which needs no
 * token and returns nothing private. Every other gateway route is holder-gated
 * and deliberately serves no `access-control-allow-origin`, so a page cannot
 * read one even if it tried — that is a security property of the gateway, not an
 * oversight, and this file must not grow a helper that works around it.
 *
 * Kept in sync by hand with MERRYMEN_GATEWAY_ORIGIN in packages/core/src/token.ts.
 * Both still point at the Railway service URL rather than ai.merrymen.dev while
 * that certificate is pending; when it lands, both change together.
 */
export const GATEWAY_ORIGIN = "https://merrymen-gateway-production.up.railway.app";

export interface ScopePool {
  token: string;
  quote: string;
  createdAt: number;
  txHash: string;
  symbol: string | null;
  decimals: number | null;
}

export interface ScopeResponse {
  pools: ScopePool[];
  cached?: boolean;
  stale?: boolean;
  ttl?: number;
}

export type ScopeOutcome =
  | { ok: true; data: ScopeResponse }
  | { ok: false; kind: "unconfigured" | "ratelimit" | "upstream" | "offline"; message: string };

/**
 * Fetch the scope, turning every failure into a described outcome.
 *
 * The distinctions matter to the reader: a gateway with no Bitquery key is a
 * deployment that simply hasn't enabled discovery, which is very different from
 * a provider outage, and neither should render as a generic broken page.
 */
export async function fetchScope(signal?: AbortSignal): Promise<ScopeOutcome> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/memescope`, { signal, cache: "no-store" });
    if (res.status === 503) {
      return { ok: false, kind: "unconfigured", message: "This gateway hasn't been given a Bitquery key, so discovery is off." };
    }
    if (res.status === 429) {
      return { ok: false, kind: "ratelimit", message: "Slow down — the scope only refreshes every 45 seconds anyway." };
    }
    if (!res.ok) {
      return { ok: false, kind: "upstream", message: "The chain indexer isn't answering right now." };
    }
    const data = (await res.json()) as ScopeResponse;
    return { ok: true, data: { ...data, pools: Array.isArray(data.pools) ? data.pools : [] } };
  } catch {
    return { ok: false, kind: "offline", message: "Couldn't reach the gateway." };
  }
}

/* ── iOS beta waiting list ─────────────────────────────────────────────────── */

export type SignupOutcome =
  | { ok: true; already: boolean; count: number }
  | { ok: false; message: string };

/**
 * Join the iOS beta list.
 *
 * The ONE call in this file that sends personal data, and the only gateway route
 * with a named-origin CORS allowlist rather than none — see the note at the top
 * of this file about why every other route deliberately serves no ACAO. That
 * rule stands; this is a documented exception, not a loophole to widen.
 *
 * The honeypot field is sent as `company`. A real person never fills a field
 * they cannot see, so a non-empty value marks a bot; the server accepts the
 * request and writes nothing, which tells the bot nothing.
 */
export async function joinIosBeta(email: string, honeypot: string, signal?: AbortSignal): Promise<SignupOutcome> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/ios-beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, company: honeypot }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; count?: number; error?: string };
    if (res.status === 429) {
      return { ok: false, message: "That's a lot of tries. Give it an hour." };
    }
    if (!res.ok || !data.ok) {
      // The server's reason is written for a person to read, so pass it through
      // rather than replacing it with something vaguer.
      return { ok: false, message: data.error || "Couldn't save that — try again in a moment." };
    }
    return { ok: true, already: Boolean(data.already), count: Number(data.count ?? 0) };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

/** How many are waiting. Returns null rather than guessing when unreachable. */
export async function iosBetaCount(signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(`${GATEWAY_ORIGIN}/ios-beta`, { signal, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : null;
  } catch {
    return null;
  }
}
