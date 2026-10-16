/** A public wallet is supplied by trusted grant/owner-consent projection, never by a model. */
import { onchainIdIn } from "../../../packages/core/src/ids";
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";

export interface PublicWallet {
  address: string;
  chainId: number;
  /** For a trade's token: its landed transaction, when there is one (paper has none). */
  txHash?: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{6,}/;
const MARKER = " Wallet (";
const TOKEN_MARKER = " CA (";

/**
 * An id anywhere in the text: a 0x run as before, or any id core's detector
 * finds (a Solana key or signature, a Solana explorer link). Solana ids carry
 * no 0x, so the hex rule alone let one through as ordinary prose.
 */
function idInText(text: string): boolean {
  return ADDRESS_IN_TEXT.test(text) || onchainIdIn(text);
}

/** Unknown networks and malformed accounts fail closed instead of borrowing a chain label. */
export function publicWalletSuffix(wallet: PublicWallet | null | undefined): string | null {
  if (!wallet || !ADDRESS.test(wallet.address)) return null;
  const chain = wallet.chainId === 4663 ? "Robinhood Chain" : wallet.chainId === 46630 ? "Robinhood Chain Testnet" : null;
  return chain ? `${MARKER}${chain}): ${wallet.address.toLowerCase()}` : null;
}

/** Called only AFTER ordinary prose passed the unchanged X gate. No model ever sees this address. */
export function appendPublicWallet(prose: string, wallet: PublicWallet): string | null {
  const suffix = publicWalletSuffix(wallet);
  if (!suffix || idInText(prose) || prose.includes(MARKER)) return null;
  const body = prose + suffix;
  return xWeightedLength(body) <= X_MAX_WEIGHTED ? body : null;
}

export function hasPublicWallet(body: string): boolean {
  return idInText(body) || body.includes(MARKER) || body.includes(TOKEN_MARKER);
}

/** A pending disclosure must still name the currently consented account and chain when sent. */
export function publicWalletStillAllowed(
  post: { kind: string; body: string },
  wallet: PublicWallet | null | undefined,
): boolean {
  if (!hasPublicWallet(post.body)) return true;
  const suffix = publicWalletSuffix(wallet);
  if (post.kind !== "intro" || !suffix || !post.body.endsWith(suffix)) return false;
  const prose = post.body.slice(0, -suffix.length);
  return prose.length > 0 && !hasPublicWallet(prose) && xWeightedLength(post.body) <= X_MAX_WEIGHTED;
}

/** Where a landed Robinhood Chain transaction is shown. Testnet trades get no link. */
const TX_BASE = "https://robinhoodchain.blockscout.com/tx/";

/**
 * A CA is a completed trade's exact token contract on its verified execution
 * network. It stands alone on the post's last line after a blank one: no label
 * and no chain, so it copies cleanly (owner's direction, 2026-10-13). With
 * `withTx` (the operator's own agents) the landed transaction's explorer link
 * goes on its own line just before it.
 */
export function publicTokenSuffix(token: PublicWallet | null | undefined, withTx = false): string | null {
  if (!token || !ADDRESS.test(token.address) || ![4663, 46630].includes(token.chainId)) return null;
  const tx = withTx && token.chainId === 4663 && typeof token.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(token.txHash)
    ? `\n\n${TX_BASE}${token.txHash.toLowerCase()}` : "";
  return `${tx}\n\n${token.address.toLowerCase()}`;
}

export function appendPublicToken(prose: string, token: PublicWallet, withTx = false): string | null {
  const suffix = publicTokenSuffix(token, withTx);
  if (!suffix || hasPublicWallet(prose)) return null;
  const body = prose + suffix;
  return xWeightedLength(body) <= X_MAX_WEIGHTED ? body : null;
}

export function publicTokenStillAllowed(post: { kind: string; body: string }, token: PublicWallet | null | undefined, withTx = false): boolean {
  if (!hasPublicWallet(post.body)) return true;
  const suffix = publicTokenSuffix(token, withTx);
  if ((post.kind !== "buy" && post.kind !== "sell") || !suffix || !post.body.endsWith(suffix)) return false;
  const prose = post.body.slice(0, -suffix.length);
  return prose.length > 0 && !hasPublicWallet(prose) && xWeightedLength(post.body) <= X_MAX_WEIGHTED;
}
