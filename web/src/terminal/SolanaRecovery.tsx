"use client";
/**
 * AN OFFLINE COPY OF THE OWNER KEY, OFF UNTIL THE DEPLOYMENT TURNS IT ON.
 *
 * Revoke and withdraw are only reachable through the server's prepare and
 * submit routes, and the owner key lives in Privy's embedded wallet. The vault
 * answers to that key alone, so an offline copy keeps the owner's authority
 * over the vault if Merrymen or this site is unavailable. Privy shows the key
 * to its owner in its own window on its own domain; this page never receives
 * it.
 *
 * Handling a raw key is a phishing and loss risk, so the card is shown only
 * when NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT=1, only to the bound owner
 * wallet, and only when the server has read a live vault for that owner (a
 * paper-only owner has nothing to recover). Turn the flag on only after export
 * is enabled for the Privy app in its dashboard. It names no recovery command:
 * a command it names must be registered in cli/bin.mjs (SolanaScreen.test.ts).
 */
import { useRef, useState } from "react";

/** Inlined at build time; anything but "1" leaves key export off. */
export function ownerKeyExportEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT === "1";
}

export function SolanaRecovery({ owner, programId, vault, exportKey }: {
  owner: string; programId: string | null; vault: string | null; exportKey: () => Promise<void>;
}) {
  const [understood, setUnderstood] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [closed, setClosed] = useState(false);
  const inFlight = useRef(false);
  const open = () => {
    if (inFlight.current || !understood) return;
    inFlight.current = true; setBusy(true); setError(""); setClosed(false);
    void exportKey().then(() => { setClosed(true); setUnderstood(false); })
      .catch(() => setError("Privy did not open the key export. Wallet export may be turned off for this app, or your sign-in needs to be refreshed."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  return <div className="solana-card"><h2>Back up your owner key</h2>
    <p>Your vault answers to your owner wallet, not to Merrymen: its key alone can revoke every trading session and withdraw your vault balances. Privy can show you this key in its own window so you can keep an offline copy in case Merrymen or this site is ever unavailable.</p>
    <p>Owner wallet: <span className="solana-address">{owner}</span></p>
    {programId && <p>Vault program: <span className="solana-address">{programId}</span></p>}
    {vault && <p>Vault: <span className="solana-address">{vault}</span></p>}
    <p role="note" className="solana-warning">Anyone who has this key controls your owner wallet and everything in your vault, and a leaked key cannot be revoked. Privy shows it in its own secure window: Merrymen never sees it and will never ask for it. Store it offline only. Never paste it into a website, chat, email or support request, and never give it to any app or person offering to recover your funds.</p>
    <label><input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that anyone with this key can take my funds.</label>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <button disabled={busy || !understood} onClick={open}>Export owner key with Privy</button>
    {closed && <p role="status">Privy&apos;s export window is closed. If you copied the key, store it offline and clear your clipboard.</p>}
    <p>This export only works while this site is up, so keep the offline copy before you need it.</p>
  </div>;
}
