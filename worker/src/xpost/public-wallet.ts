/** A public wallet is supplied by trusted grant/owner-consent projection, never by a model. */
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";

export interface PublicWallet {
  address: string;
  chainId: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{6,}/;
const MARKER = " Wallet (";
const TOKEN_MARKER = " CA (";

/** Unknown networks and malformed accounts fail closed instead of borrowing a chain label. */
export function publicWalletSuffix(wallet: PublicWallet | null | undefined): string | null {
  if (!wallet || !ADDRESS.test(wallet.address)) return null;
  const chain = wallet.chainId === 4663 ? "Robinhood Chain" : wallet.chainId === 46630 ? "Robinhood Chain Testnet" : null;
  return chain ? `${MARKER}${chain}): ${wallet.address.toLowerCase()}` : null;
}

/** Called only AFTER ordinary prose passed the unchanged X gate. No model ever sees this address. */
export function appendPublicWallet(prose: string, wallet: PublicWallet): string | null {
  const suffix = publicWalletSuffix(wallet);
  if (!suffix || ADDRESS_IN_TEXT.test(prose) || prose.includes(MARKER)) return null;
  const body = prose + suffix;
  return xWeightedLength(body) <= X_MAX_WEIGHTED ? body : null;
}

export function hasPublicWallet(body: string): boolean {
  return ADDRESS_IN_TEXT.test(body) || body.includes(MARKER) || body.includes(TOKEN_MARKER);
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

/** A CA is a completed trade's exact token contract on its verified execution network. */
export function publicTokenSuffix(token: PublicWallet | null | undefined): string | null {
  return publicWalletSuffix(token)?.replace(MARKER, TOKEN_MARKER) ?? null;
}

export function appendPublicToken(prose: string, token: PublicWallet): string | null {
  const suffix = publicTokenSuffix(token);
  if (!suffix || hasPublicWallet(prose)) return null;
  const body = prose + suffix;
  return xWeightedLength(body) <= X_MAX_WEIGHTED ? body : null;
}

export function publicTokenStillAllowed(post: { kind: string; body: string }, token: PublicWallet | null | undefined): boolean {
  if (!hasPublicWallet(post.body)) return true;
  const suffix = publicTokenSuffix(token);
  if ((post.kind !== "buy" && post.kind !== "sell") || !suffix || !post.body.endsWith(suffix)) return false;
  const prose = post.body.slice(0, -suffix.length);
  return prose.length > 0 && !hasPublicWallet(prose) && xWeightedLength(post.body) <= X_MAX_WEIGHTED;
}
