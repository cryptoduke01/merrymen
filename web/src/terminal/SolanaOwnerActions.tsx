"use client";
import { useRef, useState } from "react";
import { SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import { solanaUnits } from "../lib/solana-amounts";
import type { SolanaApi } from "./SolanaAutomation";

const WSOL = "So11111111111111111111111111111111111111112";
type ActionResult = { signature: string; status: "pending" | "finalized" | "failed" };
type OwnerAction = "revoke" | "withdraw" | "resume-buys";
export function SolanaOwnerActions({ available, api, sign, refresh }: {
  available: boolean; api: SolanaApi; sign: (bytes: Uint8Array) => Promise<Uint8Array>; refresh: () => Promise<void>;
}) {
  const [mint, setMint] = useState(SOLANA_USDG_MINT as string), [amount, setAmount] = useState("1");
  const [pending, setPending] = useState<{ action: OwnerAction; signedTransactionBase64: string } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false);
  const run = (action: OwnerAction) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError("");
    void (async () => {
      let saved = pending;
      if (!saved) {
        const body = action === "withdraw" ? { stage: "prepare", action, mint, amountRaw: solanaUnits(amount, mint === SOLANA_USDG_MINT ? 6 : 9) } : { stage: "prepare", action };
        const { prepared } = await api<{ prepared: { transactionBase64: string } }>("owner", body);
        const signed = await sign(Uint8Array.from(atob(prepared.transactionBase64), (c) => c.charCodeAt(0)));
        saved = { action, signedTransactionBase64: btoa(String.fromCharCode(...signed)) };
        setPending(saved); setResult(null);
      }
      const { result: next } = await api<{ result: ActionResult }>("owner", { stage: "submit", signedTransactionBase64: saved.signedTransactionBase64 });
      setResult(next);
      if (next.status !== "pending") { setPending(null); await refresh(); }
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : "The owner action did not finish. Retry the existing transaction."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  return <div className="solana-card"><h2>Owner controls</h2>
    <p>Your wallet must sign every revocation and withdrawal. Withdrawals return to your own token account.</p>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <fieldset disabled={busy || !!pending || !available}><legend>Vault recovery</legend>
      <button onClick={() => run("revoke")}>Revoke all Solana sessions</button>
      <button onClick={() => run("resume-buys")}>Ask wallet to resume buys</button>
      <p>Resuming buys keeps the existing risk limits and portfolio high-water mark. If the drawdown still exceeds your limit, buying pauses again.</p>
      <label>Asset<select value={mint} onChange={(e) => setMint(e.target.value)}><option value={SOLANA_USDG_MINT}>USDG</option><option value={WSOL}>Wrapped SOL</option></select></label>
      <label>Amount to withdraw<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button onClick={() => run("withdraw")}>Withdraw to my wallet</button>
    </fieldset>
    {pending && <button disabled={busy || !available} onClick={() => run(pending.action)}>Check existing owner transaction</button>}
    {result && <p role="status">Owner transaction: {result.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(result.signature)}`}>View transaction</a></p>}
  </div>;
}
