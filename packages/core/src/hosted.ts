import { secretScanBudget, solanaSecretIn, type SecretScanBudget } from "./ids";

/**
 * Hosted mode — the single switch that turns merrymen from a self-hosted
 * single-tenant tool into a multi-tenant service on a public URL.
 *
 * ONE FLAG, read from ONE place, because the two modes have OPPOSITE threat
 * models and every fund-safety decision downstream branches on which one is
 * true. Self-hosted: one user, one machine, the owner key is theirs and the
 * localhost host-guard is the whole perimeter. Hosted: many users on a public
 * domain, the server holds session keys for real accounts, and the perimeter
 * is wallet-native auth on every mutating route.
 *
 * Defaults to SELF-HOSTED (false) — the safe default, and what every existing
 * install already is. Hosted mode is opt-in via MERRYMEN_HOSTED, so no
 * self-hosted user can accidentally trip into the multi-tenant code paths.
 */
export function isHostedMode(): boolean {
  const v = (process.env.MERRYMEN_HOSTED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The server secret that signs session cookies and challenge nonces.
 *
 * REQUIRED in hosted mode and returned as null otherwise. A missing secret in
 * hosted mode is a boot-time refusal, never a silent fallback to a default —
 * a predictable signing key is a forgeable session for every tenant.
 */
export function sessionSecret(): string | null {
  const s = process.env.MERRYMEN_SESSION_SECRET;
  if (typeof s === "string" && s.length >= 32) return s;
  return null;
}

/** A 32-byte (64 hex char) private key, with or without the 0x. */
const RAW_KEY = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;

/**
 * Does this object carry FUND-CUSTODY material that must never reach a hosted
 * server?
 *
 * THE ONE DEFINITION, shared by the grant API (which rejects such payloads) and
 * the boot check (which refuses to start if any stored grant holds one). In
 * hosted mode the server holds only the capped, revocable SESSION key; the OWNER
 * key — sudo over the account, the root of custody — stays in the browser. This
 * catches the named field (`demoOwnerPrivateKey`) AND any raw 32-byte key or
 * BIP-39-length mnemonic hiding anywhere in the payload, so a renamed field or a
 * nested blob can't smuggle one past. A Solana secret key is caught too
 * (carriesSolanaSecret).
 *
 * `demoSessionPrivateKey` is deliberately NOT flagged: the worker needs the
 * session key to act, and the wall makes a leaked one value-churn, never theft.
 */
export function carriesOwnerKey(obj: unknown): boolean {
  if (obj == null) return false;
  if (typeof obj === "object" && "demoOwnerPrivateKey" in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>).demoOwnerPrivateKey;
    if (typeof v === "string" && v.length > 0) return true;
  }
  // Scan the serialized JSON for a raw key or a mnemonic, but EXEMPT the one
  // field that legitimately holds a 64-hex value — the session key — so its
  // presence alone doesn't trip the guard.
  let json: string;
  try {
    json = JSON.stringify(obj, (k, val) => (k === "demoSessionPrivateKey" ? undefined : val));
  } catch {
    return false;
  }
  if (RAW_KEY.test(json)) return true;
  // A 12/15/18/21/24-word lowercase mnemonic — the other shape of an owner key.
  if (/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/.test(json)) return true;
  return carriesSolanaSecret(obj);
}

/**
 * A Solana secret key (a 64-byte keypair as base58 or a JSON byte array:
 * solanaSecretIn) anywhere in the object, the session-key field included: no
 * Solana key belongs in a grant today, and a 0x key can never match. A keypair
 * is recognised by its own public key, so a signature, an address or random
 * bytes never trip this.
 *
 * Every string is also scanned as it reads, not only as JSON escapes it, so an
 * id.json pasted with its line breaks is still a byte array.
 *
 * The grant's top-level `serialized` ZeroDev blob is scanned DECODED, as the
 * object it holds: base64 shares most of base58's alphabet, so runs of the
 * blob's own text are base58 candidates that mean nothing. Anything there that
 * is not a ZeroDev blob is scanned as written.
 *
 * Every scan in one walk shares one budget (secretScanBudget), so key-shaped
 * runs split across many strings cannot make the walk read each of them.
 */
function carriesSolanaSecret(obj: unknown, budget: SecretScanBudget = secretScanBudget()): boolean {
  let found = false;
  let blob: object | null = null;
  let json: string;
  try {
    json = JSON.stringify(obj, function (this: unknown, k: string, val: unknown) {
      if (typeof val !== "string") return val;
      if (this === obj && k === "serialized") {
        blob = zeroDevParams(val);
        if (blob !== null) return undefined;
      }
      if (solanaSecretIn(val, budget)) found = true;
      return val;
    });
  } catch {
    return false;
  }
  return found || solanaSecretIn(json, budget) || (blob !== null && carriesSolanaSecret(blob, budget));
}

/**
 * The object a ZeroDev permission blob holds, or null for anything else: base64
 * of UTF-8 JSON (@zerodev/permissions serializePermissionAccountParams), read
 * back the way deserializePermissionAccountParams reads it.
 */
function zeroDevParams(s: string): object | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A boot-time refusal: in hosted mode, if ANY grant at rest carries an owner
 * key, throw rather than start.
 *
 * The custody boundary is only as good as the weakest thing that ever wrote a
 * grant. This is the backstop for a grant that predates the boundary, a manual
 * import, or a future bug: hosted mode simply will not run while a custody key
 * sits in its store. Call it at startup over every stored grant.
 */
export function assertNoOwnerKeysAtRest(grants: readonly unknown[]): void {
  if (!isHostedMode()) return;
  const offenders = grants.filter(carriesOwnerKey).length;
  if (offenders > 0) {
    throw new Error(
      `hosted mode refuses to start: ${offenders} stored grant(s) carry an owner key. ` +
        `A hosted server must never hold fund-custody keys — purge them before booting.`,
    );
  }
}
