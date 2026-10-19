"use client";
import { useRef, useState } from "react";
import { SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import { solanaUnits } from "../lib/solana-amounts";
import { RequestError } from "./request-json";
import type { SolanaApi } from "./SolanaAutomation";

const WSOL = "So11111111111111111111111111111111111111112";
type ActionResult = { signature: string; status: "pending" | "finalized" | "failed" };
type OwnerAction = "revoke" | "withdraw" | "resume-buys";
const ACTION_NAMES: Record<OwnerAction, string> = { revoke: "revocation", withdraw: "withdrawal", "resume-buys": "request to resume buys" };

/**
 * THE SERVER REFUSED THESE SIGNED BYTES, SO KEEPING THEM ONLY RETRIES A REFUSAL.
 *
 * Signed owner and permission transactions are kept after an unknown outcome
 * (no answer, or a 5xx) so a retry resubmits the same bytes and never signs a
 * second transaction. A 4xx is an answer: the prepare window passed, the
 * limits changed, a trade is pending, or another owner transaction is saved.
 * The server checks all of that before it saves or broadcasts, and while an
 * owner transaction it did save is unresolved it refuses to prepare another,
 * so dropping refused bytes can never duplicate one. A sign-in or rate-limit
 * answer (401, 403, 408, 429) says nothing about the bytes and keeps them.
 */
export function refusedByServer(error: unknown): error is RequestError {
  return error instanceof RequestError && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status);
}

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
      // Saved bytes are only ever resubmitted for their own action. Revoking
      // prepares a fresh revocation; the server refuses it while the earlier
      // transaction is saved and unresolved, and otherwise that one can no
      // longer be submitted once this one is prepared.
      let saved = pending?.action === action ? pending : null;
      if (!saved) {
        const body = action === "withdraw" ? { stage: "prepare", action, mint, amountRaw: solanaUnits(amount, mint === SOLANA_USDG_MINT ? 6 : 9) } : { stage: "prepare", action };
        const { prepared } = await api<{ prepared: { transactionBase64: string } }>("owner", body);
        const signed = await sign(Uint8Array.from(atob(prepared.transactionBase64), (c) => c.charCodeAt(0)));
        saved = { action, signedTransactionBase64: btoa(String.fromCharCode(...signed)) };
        setPending(saved); setResult(null);
      }
      let next: ActionResult;
      try { ({ result: next } = await api<{ result: ActionResult }>("owner", { stage: "submit", signedTransactionBase64: saved.signedTransactionBase64 })); }
      catch (e) {
        if (!refusedByServer(e)) throw e;
        setPending(null); void refresh().catch(() => undefined);
        throw new Error(`${e.message} This signed ${ACTION_NAMES[saved.action]} was not accepted and has been discarded. Start it again to review and sign a new one.`);
      }
      setResult(next);
      if (next.status !== "pending") { setPending(null); await refresh(); }
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : "The owner action did not finish. Retry the existing transaction."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  return <div className="solana-card"><h2>Owner controls</h2>
    <p>Your wallet must sign every revocation and withdrawal. Withdrawals return to your own token account.</p>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <fieldset disabled={busy || !available}><legend>Vault recovery</legend>
      {/* Revoking is never held back by a withdrawal whose outcome is unknown. */}
      <button onClick={() => run("revoke")}>Revoke all Solana sessions</button>
      <button disabled={!!pending} onClick={() => run("resume-buys")}>Ask wallet to resume buys</button>
      <p>Resuming buys keeps the existing risk limits and portfolio high-water mark. If the drawdown still exceeds your limit, buying pauses again.</p>
      <label>Asset<select value={mint} onChange={(e) => setMint(e.target.value)}><option value={SOLANA_USDG_MINT}>USDG</option><option value={WSOL}>Wrapped SOL</option></select></label>
      <label>Amount to withdraw<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button disabled={!!pending} onClick={() => run("withdraw")}>Withdraw to my wallet</button>
    </fieldset>
    {pending && <p role="status">A signed {ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request.</p>}
    {pending && <button disabled={busy || !available} onClick={() => run(pending.action)}>Check existing owner transaction</button>}
    {result && <p role="status">Owner transaction: {result.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(result.signature)}`}>View transaction</a></p>}
  </div>;
}
