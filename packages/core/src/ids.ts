/**
 * CHAIN-NEUTRAL IDENTITY (Solana integration, phase 0, 2026-10-16).
 *
 * Until now every id in Merrymen was an EVM id on Robinhood Chain: a 0x
 * address, lowercased, or a 0x transaction hash. Solana ids are base58 and
 * CASE-SENSITIVE: lowercasing a mint makes a different (usually nonexistent)
 * mint, and lowercasing a signature makes it unfindable. So a chain is named
 * explicitly, the way CAIP-2 names it, and every id is canonicalised by its
 * chain's own rule:
 *
 *   EVM      0x + 40 hex (account, token) or 0x + 64 hex (operation), lowercased.
 *   Solana   base58 decoding to 32 bytes (account, token) or 64 bytes
 *            (signature), kept exactly as written.
 *
 * THE REGISTRY IS FAIL-CLOSED. A chain this file does not name is not a chain:
 * `chainInfo` answers null and the strict helpers throw. That is the opposite
 * of chain.ts `chainForId`, which maps every id but the testnet to Robinhood
 * mainnet; that helper stays as it is for the EVM paths that use it today.
 *
 * Rules lifted from worker/src/fomo/identity.ts, which already keeps Solana
 * mints apart from EVM addresses for research. Pure: no I/O, no clock, and
 * browser-safe (web imports it).
 */
import { ed25519 } from "@noble/curves/ed25519";

/** The chain families Merrymen can name. */
export type ChainFamily = "evm" | "solana";

/** CAIP-2 references: `eip155:<chain id>`, `solana:<first 32 chars of the genesis hash>`. */
export const CHAINS = Object.freeze({
  robinhood: "eip155:4663",
  robinhoodTestnet: "eip155:46630",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const);
export type ChainRef = (typeof CHAINS)[keyof typeof CHAINS];

/** The stable a chain's books are kept in: Paxos USDG on both (same issuer, same unit, 6 decimals). */
export interface CashAsset {
  symbol: "USDG";
  /** The token's address on that chain (an ERC-20 proxy on Robinhood Chain, a Token-2022 mint on Solana); null where none is verified. */
  address: string | null;
  decimals: 6;
  /** Solana only: the token program that owns the mint. */
  program?: string;
}

/** How a chain is shown beside the others: a short name, a glyph and its colours. */
export interface ChainLook {
  /** One or two characters for tight places (a badge, a chip). */
  glyph: string;
  /** The chain's own colour, for borders, dots and accents. */
  accent: string;
  /** A two-stop gradient for hero surfaces. */
  gradient: readonly [string, string];
}

export interface ChainInfo {
  ref: ChainRef;
  family: ChainFamily;
  /** The full name ("Robinhood Chain", "Solana"). */
  label: string;
  /** The short name for a badge ("Robinhood", "Solana"). */
  short: string;
  /** False on a test network: never shown as real money. */
  realMoney: boolean;
  /** The EVM chain id, for EVM chains only. */
  evmChainId?: number;
  explorer: { name: string; base: string; cluster?: string };
  cash: CashAsset;
  look: ChainLook;
}

/** Verified on chain 2026-10-16: the mint is owned by Token-2022, named "Global Dollar", symbol USDG, 6 decimals, transfer fee 0, transfer hook unset. */
export const SOLANA_USDG_MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Robinhood Chain USDG (packages/core/src/tokens.ts CASH.USDG), lowercased. */
const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const ROBINHOOD_LOOK: ChainLook = { glyph: "R", accent: "#CCFF00", gradient: ["#CCFF00", "#00C805"] };
const SOLANA_LOOK: ChainLook = { glyph: "◎", accent: "#14F195", gradient: ["#9945FF", "#14F195"] };

const REGISTRY: ReadonlyMap<string, ChainInfo> = new Map<string, ChainInfo>([
  [CHAINS.robinhood, {
    ref: CHAINS.robinhood, family: "evm", label: "Robinhood Chain", short: "Robinhood", realMoney: true, evmChainId: 4663,
    explorer: { name: "Blockscout", base: "https://robinhoodchain.blockscout.com" },
    cash: { symbol: "USDG", address: ROBINHOOD_USDG, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
  [CHAINS.robinhoodTestnet, {
    ref: CHAINS.robinhoodTestnet, family: "evm", label: "Robinhood Chain Testnet", short: "Robinhood test", realMoney: false, evmChainId: 46630,
    explorer: { name: "Blockscout", base: "https://explorer.testnet.chain.robinhood.com" },
    cash: { symbol: "USDG", address: null, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
  [CHAINS.solana, {
    ref: CHAINS.solana, family: "solana", label: "Solana", short: "Solana", realMoney: true,
    explorer: { name: "Solscan", base: "https://solscan.io" },
    cash: { symbol: "USDG", address: SOLANA_USDG_MINT, decimals: 6, program: TOKEN_2022_PROGRAM }, look: SOLANA_LOOK,
  }],
  [CHAINS.solanaDevnet, {
    ref: CHAINS.solanaDevnet, family: "solana", label: "Solana Devnet", short: "Solana dev", realMoney: false,
    explorer: { name: "Solscan", base: "https://solscan.io", cluster: "devnet" },
    cash: { symbol: "USDG", address: null, decimals: 6, program: TOKEN_2022_PROGRAM }, look: SOLANA_LOOK,
  }],
]);

/** Every chain Merrymen names, in display order. */
export function allChains(): ChainInfo[] {
  return [...REGISTRY.values()];
}

/** A chain's facts, or null for anything this registry does not name (never a default). */
export function chainInfo(ref: unknown): ChainInfo | null {
  return typeof ref === "string" ? REGISTRY.get(ref) ?? null : null;
}

/** As chainInfo, but an unknown chain throws: for code that must never guess. */
export function requireChain(ref: unknown): ChainInfo {
  const c = chainInfo(ref);
  if (!c) throw new Error(`unknown chain: ${String(ref).slice(0, 80)}`);
  return c;
}

/** The CAIP-2 reference of an EVM chain id this registry names, or null (never a default). */
export function chainOfEvmId(id: unknown): ChainRef | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  for (const c of REGISTRY.values()) if (c.family === "evm" && c.evmChainId === id) return c.ref;
  return null;
}

// ── base58 ──────────────────────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: ReadonlyMap<string, number> = new Map([...B58].map((c, i) => [c, i]));

/** Bitcoin-alphabet base58 to bytes, or null for any character outside it. */
export function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 128) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58_INDEX.get(ch);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" is a leading zero byte.
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Bytes to Bitcoin-alphabet base58. */
export function base58Encode(b: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of b) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of b) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

const BASE58_WORD = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Base58 text that decodes to exactly `n` bytes. */
function base58Of(s: string, n: number): boolean {
  if (!BASE58_WORD.test(s)) return false;
  const b = base58Decode(s);
  return b !== null && b.length === n;
}

// ── canonical ids ───────────────────────────────────────────────────────────

/** What an id names: an account (a wallet, a vault, a program), a token, or an operation (a tx hash, a signature). */
export type IdKind = "account" | "token" | "op";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * An id in its chain's canonical spelling, or null when it is not one: EVM
 * lowercased, Solana exactly as written (never case-folded). The chain must
 * be one this registry names.
 */
export function canonicalId(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  if (!c || typeof raw !== "string") return null;
  const s = raw.trim();
  if (c.family === "evm") {
    if (kind === "op") return EVM_HASH.test(s) ? s.toLowerCase() : null;
    return EVM_ADDRESS.test(s) ? s.toLowerCase() : null;
  }
  return base58Of(s, kind === "op" ? 64 : 32) ? s : null;
}

/** Two ids name the same thing on that chain. */
export function sameId(chain: unknown, kind: IdKind, a: unknown, b: unknown): boolean {
  const x = canonicalId(chain, kind, a);
  return x !== null && x === canonicalId(chain, kind, b);
}

/** The family an id's SHAPE belongs to, chain unknown: "evm", "solana" or null. Never a canonicaliser. */
export function idFamily(raw: unknown): ChainFamily | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (EVM_ADDRESS.test(s) || EVM_HASH.test(s)) return "evm";
  if (base58Of(s, 32) || base58Of(s, 64)) return "solana";
  return null;
}

/** The explorer page for an id on its chain, or null for an id that is not canonical there. */
export function explorerUrl(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  const id = canonicalId(chain, kind, raw);
  if (!c || !id) return null;
  const base = c.explorer.base;
  if (c.family === "evm") return `${base}/${kind === "op" ? "tx" : kind === "token" ? "token" : "address"}/${id}`;
  const path = kind === "op" ? "tx" : kind === "token" ? "token" : "account";
  return `${base}/${path}/${id}${c.explorer.cluster ? `?cluster=${c.explorer.cluster}` : ""}`;
}

// ── detectors for public, model-facing and secret backstops ─────────────────

export interface OnchainIdHit {
  family: ChainFamily;
  /** "address" (a 20- or 32-byte id), "hash" (a 32-byte EVM hash or a 64-byte Solana signature) or "link" (an explorer URL). */
  shape: "address" | "hash" | "link";
  value: string;
}

const EVM_IN_TEXT = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** A run of base58 long enough to be a 32-byte key (32-44 chars) or a 64-byte signature (86-88 chars), not inside a longer word. */
const BASE58_IN_TEXT = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![0-9A-Za-z])/g;
const SOLANA_LINK = /\b(?:https?:\/\/)?(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanabeach\.io|orb\.helius\.dev)\/[^\s)>\]]*/gi;

/** A maximal run of base58 characters, wherever it sits (the glued scan). */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;
function hexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}
/**
 * Base58 decodes one glued scan may spend. Each costs up to about 88 × 64
 * steps; past the cap every further candidate run counts as an id unread: a
 * false alarm on a text no one writes, never an id let through.
 */
const GLUED_DECODES = 4_096;

export interface OnchainIdScan {
  /**
   * Also find an id glued to the text around it ("CA<mint>", "<mint>is"): any
   * window of a longer base58 run that decodes to exactly 32 or 64 bytes. The
   * hit's value is the whole run, so a redactor strips all of it. Windows of
   * hex digits alone (hashes, long numbers) are never ids. Off by default:
   * services/brain/tests/data/onchain_ids.json pins the default to Brain's
   * Python mirror, which treats a run inside a longer word as no id.
   */
  glued?: boolean;
}

function base58Shape(s: string): "address" | "hash" | null {
  const b = base58Decode(s);
  return b?.length === 32 ? "address" : b?.length === 64 ? "hash" : null;
}

/**
 * The shape of an id inside `run`, "unread" once the budget is spent, or null.
 * 58^42 < 2^248 and 58^86 < 2^504, so a window shorter than 43 (or 87)
 * characters reaches 32 (or 64) bytes only through leading zero bytes, which
 * base58 writes as leading "1"s: other short windows are skipped undecoded.
 */
function gluedShape(run: string, budget: { left: number }): "address" | "hash" | "unread" | null {
  // nonHex[i]: characters before i that are not hex digits, so a window of hex alone is skipped in O(1).
  const nonHex = new Uint32Array(run.length + 1);
  for (let i = 0; i < run.length; i++) nonHex[i + 1] = nonHex[i]! + (hexDigit(run.charCodeAt(i)) ? 0 : 1);
  for (const [min, max, full, shape] of [[86, 88, 87, 64], [32, 44, 43, 32]] as const) {
    for (let start = 0; start + min <= run.length; start++) {
      for (let length = min; length <= max && start + length <= run.length; length++) {
        if (length < full && run[start] !== "1") continue;
        if (nonHex[start + length] === nonHex[start]) continue;
        if (budget.left-- <= 0) return "unread";
        if (base58Decode(run.slice(start, start + length))?.length === shape) return shape === 64 ? "hash" : "address";
      }
    }
  }
  return null;
}

/**
 * Every on-chain id in a text: EVM addresses and hashes, base58 runs that
 * decode to a 32-byte key or a 64-byte signature, and Solana explorer links.
 * For the backstops that must never publish, or hand a model, an id it did
 * not mean to: the shape is enough, a match is never checked against a chain.
 * `glued` also finds ids written against neighbouring letters or digits.
 */
export function onchainIdsIn(text: unknown, scan: OnchainIdScan = {}): OnchainIdHit[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: OnchainIdHit[] = [];
  for (const m of text.matchAll(EVM_IN_TEXT)) hits.push({ family: "evm", shape: m[0].length === 66 ? "hash" : "address", value: m[0] });
  for (const m of text.matchAll(SOLANA_LINK)) hits.push({ family: "solana", shape: "link", value: m[0] });
  if (scan.glued) {
    const budget = { left: GLUED_DECODES };
    for (const m of text.matchAll(BASE58_RUN)) {
      // "0x" opens hex: its x is the prefix's, never part of a base58 id.
      const s = m[0][0] === "x" && m.index! > 0 && text[m.index! - 1] === "0" ? m[0].slice(1) : m[0];
      if (s.length < 32) continue;
      // A whole run that is a key or signature, as below, wherever it sits; else look inside it.
      const whole = s.length <= 88 ? base58Shape(s) : null;
      const inside = whole ?? (s.length > 32 ? gluedShape(s, budget) : null);
      if (inside) hits.push({ family: "solana", shape: inside === "hash" ? "hash" : "address", value: s });
    }
    return hits;
  }
  for (const m of text.matchAll(BASE58_IN_TEXT)) {
    const s = m[0];
    // Base58 keys and signatures can contain letters only. Decode every
    // candidate; treating the absence of digits as prose bypasses the guards.
    const b = base58Decode(s);
    if (b?.length === 32) hits.push({ family: "solana", shape: "address", value: s });
    else if (b?.length === 64) hits.push({ family: "solana", shape: "hash", value: s });
  }
  return hits;
}

/** Whether a text carries any on-chain id (onchainIdsIn). */
export function onchainIdIn(text: unknown, scan: OnchainIdScan = {}): boolean {
  return onchainIdsIn(text, scan).length > 0;
}

/**
 * A Solana keypair: 64 bytes whose second half is the ed25519 public key of
 * the first. A transaction signature is also 64 bytes, and never passes this,
 * so a signature is not mistaken for a secret.
 */
export function isSolanaKeypair(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) return false;
  try {
    const pub = ed25519.getPublicKey(bytes.subarray(0, 32));
    for (let i = 0; i < 32; i++) if (pub[i] !== bytes[32 + i]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * A JSON array of exactly 64 byte values: the Solana CLI's id.json shape.
 *
 * Each value has ONE way to match. `1?\d?\d` read "11" as 1+1 or as 11, so a
 * long array of small values that failed at its end backtracked through every
 * split, doubling per value: a 150-byte text held the process for seconds.
 * JSON writes no leading zeros, so `[1-9]?\d` loses nothing.
 */
const BYTE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const BYTE_ARRAY_64 = new RegExp(String.raw`\[\s*(?:${BYTE}\s*,\s*){63}${BYTE}\s*\]`, "g");

/**
 * How many key-shaped candidates one scan reads. Reading one costs a base58
 * decode, and a keypair check an ed25519 scalar multiplication (about 0.4 ms),
 * so an uncapped scan let a text of 64-byte runs hold the process for seconds
 * per megabyte. Past the cap every further candidate counts as a secret
 * unread: a false alarm on a text no owner sends, never a key let through.
 */
const SECRET_CANDIDATES = 256;

/** The candidates a secret scan may still read. Hand one to several scans to cap them together. */
export type SecretScanBudget = { left: number };

/** A fresh budget of SECRET_CANDIDATES candidates. */
export function secretScanBudget(): SecretScanBudget {
  return { left: SECRET_CANDIDATES };
}

/**
 * Whether a text carries a Solana secret key: a base58 string or a JSON byte
 * array decoding to a 64-byte keypair (isSolanaKeypair). For the secret
 * backstops (the hosted owner-key guard, the Telegram agent's secret screen).
 */
export function solanaSecretIn(text: unknown, budget?: SecretScanBudget): boolean {
  return solanaSecretsIn(text, budget).length > 0;
}

/**
 * Every Solana secret key in a text (solanaSecretIn), exactly as written, so a
 * redactor can strip each one. A candidate past the budget is returned as a
 * secret without being read (SECRET_CANDIDATES).
 */
export function solanaSecretsIn(text: unknown, budget: SecretScanBudget = secretScanBudget()): string[] {
  if (typeof text !== "string" || text.length < 64) return [];
  const found: string[] = [];
  for (const m of text.matchAll(BASE58_IN_TEXT)) {
    // 64 bytes never encode shorter than 64 characters, so a shorter run (an
    // address) is no candidate and costs nothing.
    if (m[0].length < 64) continue;
    if (budget.left-- <= 0) found.push(m[0]);
    else {
      const b = base58Decode(m[0]);
      if (b && b.length === 64 && isSolanaKeypair(b)) found.push(m[0]);
    }
  }
  for (const m of text.matchAll(BYTE_ARRAY_64)) {
    if (budget.left-- <= 0) found.push(m[0]);
    else {
      const nums = m[0].slice(1, -1).split(",").map((x) => Number(x.trim()));
      if (nums.length === 64 && isSolanaKeypair(Uint8Array.from(nums))) found.push(m[0]);
    }
  }
  return found;
}
