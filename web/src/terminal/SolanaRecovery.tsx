"use client";
/**
 * RECOVERY THAT DOES NOT DEPEND ON MERRYMEN'S SERVERS.
 *
 * Revoke and withdraw were only reachable through the server's prepare and
 * submit routes, so an outage, a stuck owner transaction or a database
 * failure froze vault funds until the operator recovered. The owner key lives
 * in Privy's embedded wallet; Privy can show it to its owner in its own
 * window on its own domain, and this page never receives it. The recovery CLI
 * (`merrymen solana-recover`) reads that key from a file or stdin and signs
 * the revoke and withdrawals on the owner's own computer.
 *
 * This card renders whenever the bound owner wallet is connected, including
 * when the Solana status cannot be loaded at all.
 */
import { useRef, useState } from "react";

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
  return <div className="solana-card"><h2>Recover without Merrymen</h2>
    <p>Your vault answers to your owner wallet, not to Merrymen. If Merrymen is unavailable, you can still revoke every trading session and withdraw your vault balances yourself, signing on your own computer with your owner key.</p>
    <p>Owner wallet: <span className="solana-address">{owner}</span></p>
    {programId && <p>Vault program: <span className="solana-address">{programId}</span></p>}
    {vault && <p>Vault: <span className="solana-address">{vault}</span></p>}
    <h3>1. Export your owner key</h3>
    <p role="note" className="solana-warning">Anyone who has this key controls your owner wallet and everything in your vault, and a leaked key cannot be revoked. Privy shows it in its own secure window: Merrymen never sees it and will never ask for it. Export it only to keep it offline or to run the recovery tool on your own computer. Never paste it into a website, chat, email or support request.</p>
    <label><input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that anyone with this key can take my funds.</label>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <button disabled={busy || !understood} onClick={open}>Export owner key with Privy</button>
    {closed && <p role="status">Privy&apos;s export window is closed. If you copied the key, store it offline and clear your clipboard.</p>}
    <h3>2. Run the recovery tool</h3>
    <p>On your own computer, run <code>merrymen solana-recover</code>. It reads the exported key from a file or from standard input; do not type the key as a command-line argument, where your shell history would keep it. Delete any key file when you are done.</p>
    <p>This export only works while this site is up. If you could not afford to lose access to your vault, keep an offline copy of the key before you need it.</p>
  </div>;
}
