"use client";
/**
 * WHAT THE OWNER'S WALLET IS ASKED TO SIGN, READ FROM THE BYTES.
 *
 * The server builds the session permission from the SAVED limits, never from
 * the form. The page used to show the form (unsaved edits, and a duration that
 * reset to 24 hours on every load) while the wallet signed something else. Now
 * the live card shows the saved limits with their absolute expiry, and before
 * the wallet opens, the prepared transaction is decoded here and must encode
 * exactly those limits, for this owner, vault, program and session key, with
 * nothing else in it beyond creating the vault and its token accounts and a
 * priority fee the owner pays, at most OWNER_MAX_PRIORITY_FEE_LAMPORTS.
 */
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { base58Encode, SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits } from "../../../packages/core/src/solana";
import { displaySolanaAmount, displaySolanaAmountOrNull } from "../lib/solana-amounts";

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
// Anchor discriminators of the vault program (packages/core/src/solana-live.ts).
const INITIALIZE = [48, 191, 163, 44, 71, 129, 63, 164];
const CREATE_SESSION = [242, 193, 143, 179, 150, 25, 122, 227];
const SESSION_DATA_LENGTH = 8 + 32 + 8 * 4 + 2 + 8;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/**
 * The most priority fee the server may put on an owner transaction: 0.001 SOL.
 * The same cap as SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS in
 * worker/src/solana-app-runtime.ts (a test keeps the two equal).
 */
export const OWNER_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;

export type SignedPermissionTerms = {
  perTradeUsdg: string; dailyUsdg: string; perTradeWsol: string; dailyWsol: string; maxOpsPerDay: number; expiresAtSeconds: string;
  /** The priority fee the owner pays on top of the signature fee, in lamports ("0" without one). */
  priorityFeeLamports: string;
};
const NOT_SIGNED = "The prepared permission does not match what this page shows. Nothing was signed. Refresh and review your saved limits.";
function refuse(): never { throw new Error(NOT_SIGNED); }
function startsWith(data: Uint8Array, prefix: readonly number[]) { return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte); }

/** Decodes the prepared registration and returns the limits it would sign, or refuses. */
export function readPermissionTransaction(transactionBase64: string, expected: { owner: string; programId: string; vault: string; session: string }): SignedPermissionTerms {
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    const transaction = getTransactionDecoder().decode(Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0)));
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch { return refuse(); }
  const keys = message.staticAccounts.map(String);
  // The owner pays and is the only signer; nothing is loaded from lookup tables.
  if (message.version !== 0 || message.addressTableLookups?.length || keys[0] !== expected.owner || message.header.numSignerAccounts !== 1) refuse();
  let terms: Omit<SignedPermissionTerms, "priorityFeeLamports"> | null = null;
  let unitLimit: bigint | null = null, unitPrice: bigint | null = null;
  for (const instruction of message.instructions) {
    const program = keys[instruction.programAddressIndex];
    const data = Uint8Array.from(instruction.data ?? []);
    const accounts = (instruction.accountIndices ?? []).map((index) => keys[index]);
    // A priority fee: one SetComputeUnitLimit and one SetComputeUnitPrice, touching no account.
    if (program === COMPUTE_BUDGET_PROGRAM && accounts.length === 0) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data.length === 5 && data[0] === 2 && unitLimit === null) { unitLimit = BigInt(view.getUint32(1, true)); continue; }
      if (data.length === 9 && data[0] === 3 && unitPrice === null) { unitPrice = view.getBigUint64(1, true); continue; }
      refuse();
    }
    // CreateIdempotent for the owner's and the vault's USDG and wrapped SOL accounts, paid by the owner.
    if (program === ASSOCIATED_TOKEN_PROGRAM && data.length === 1 && data[0] === 1 && accounts[0] === expected.owner
      && (accounts[2] === expected.owner || accounts[2] === expected.vault) && (accounts[3] === SOLANA_USDG_MINT || accounts[3] === WRAPPED_SOL)) continue;
    if (program === expected.programId && data.length === INITIALIZE.length && startsWith(data, INITIALIZE)
      && accounts[0] === expected.vault && accounts[1] === expected.owner) continue;
    if (program === expected.programId && !terms && data.length === SESSION_DATA_LENGTH && startsWith(data, CREATE_SESSION)
      && accounts[0] === expected.vault && accounts[1] === expected.owner) {
      if (base58Encode(data.slice(8, 40)) !== expected.session) refuse();
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      terms = { perTradeUsdg: view.getBigUint64(40, true).toString(), dailyUsdg: view.getBigUint64(48, true).toString(),
        perTradeWsol: view.getBigUint64(56, true).toString(), dailyWsol: view.getBigUint64(64, true).toString(),
        maxOpsPerDay: view.getUint16(72, true), expiresAtSeconds: view.getBigInt64(74, true).toString() };
      continue;
    }
    refuse();
  }
  if (!terms || (unitLimit === null) !== (unitPrice === null)) return refuse();
  // What the runtime charges: ceil(price × limit / 1e6) lamports, never above the cap.
  const priorityFee = unitLimit !== null && unitPrice !== null ? (unitPrice * unitLimit + 999_999n) / 1_000_000n : 0n;
  if (priorityFee > OWNER_MAX_PRIORITY_FEE_LAMPORTS) refuse();
  return { ...terms, priorityFeeLamports: priorityFee.toString() };
}

/** True only when the signed terms are exactly the saved limits the page showed. */
export function permissionMatchesLimits(terms: SignedPermissionTerms, limits: SolanaPaperLimits): boolean {
  return terms.perTradeUsdg === limits.perTradeUsdg && terms.dailyUsdg === limits.dailyUsdg
    && terms.perTradeWsol === limits.perTradeWsol && terms.dailyWsol === limits.dailyWsol
    && terms.maxOpsPerDay === limits.maxOpsPerDay && terms.expiresAtSeconds === String(Math.floor(limits.expiresAtMs / 1000));
}

/** The on-chain expiry is whole seconds; show exactly that instant, in UTC. */
export function permissionExpiry(expiresAtMs: number): string {
  return `${new Date(Math.floor(expiresAtMs / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function PermissionTerms({ limits, heading }: { limits: SolanaPaperLimits; heading: string }) {
  const hours = (limits.expiresAtMs - Date.now()) / 3_600_000;
  return <div className="solana-terms"><h3>{heading}</h3><ul>
    <li>{displaySolanaAmount(limits.perTradeUsdg)} USDG per trade and {displaySolanaAmount(limits.dailyUsdg)} USDG per 24 hours</li>
    {limits.perTradeWsol && limits.dailyWsol && <li>{displaySolanaAmount(limits.perTradeWsol, 9)} SOL sold per trade and {displaySolanaAmount(limits.dailyWsol, 9)} SOL sold per 24 hours</li>}
    <li>At most {limits.maxOpsPerDay} trades per 24 hours</li>
    <li>Expires {permissionExpiry(limits.expiresAtMs)}{hours > 0 ? ` (in about ${hours < 1 ? "less than an hour" : `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`})` : " (expired)"}</li>
  </ul><p>The {limits.maxDrawdownBps / 100}% maximum drawdown is enforced by the Merrymen trading service, not by the on-chain permission.</p></div>;
}

/**
 * THE PREPARED PERMISSION, AS ITS BYTES SAY, BEFORE THE WALLET OPENS.
 *
 * Shown between prepare and signing: the limits decoded from the bytes (they
 * equal the saved limits, or nothing reaches this point), the priority fee the
 * bytes carry (decoded, never the server's claim) and what the server says the
 * owner wallet must hold to send it, rent for the accounts it opens included.
 */
export function PermissionReview({ limits, terms, requiredLamports, ownerLamports, secondsLeft }: {
  limits: SolanaPaperLimits; terms: SignedPermissionTerms; requiredLamports: string | null; ownerLamports: string | null; secondsLeft: number;
}) {
  const fee = displaySolanaAmountOrNull(terms.priorityFeeLamports, 9), required = displaySolanaAmountOrNull(requiredLamports, 9), held = displaySolanaAmountOrNull(ownerLamports, 9);
  return <div className="solana-review">
    <PermissionTerms heading="Review before your wallet opens: the prepared permission encodes these limits" limits={limits} />
    <p>{terms.priorityFeeLamports === "0" || !fee ? "It carries no priority fee: your owner wallet pays only the network signature fee."
      : `It carries a priority fee of ${fee} SOL (at most ${displaySolanaAmount(OWNER_MAX_PRIORITY_FEE_LAMPORTS.toString(), 9)} SOL), paid by your owner wallet with the signature fee so it lands under congestion.`}</p>
    {required && <p>To send it your owner wallet must hold at least {required} SOL{held ? ` (it holds ${held} SOL)` : ""}, including rent for any vault and token accounts it opens.</p>}
    <p>Nothing has been signed yet. Sign within about {secondsLeft} seconds, or register again to prepare a new one.</p>
  </div>;
}

