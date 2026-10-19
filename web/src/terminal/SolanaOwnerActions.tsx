"use client";
import { useRef, useState } from "react";
import { SOLANA_USDG_MINT, base58Encode } from "../../../packages/core/src/ids";
import { solanaUnits } from "../lib/solana-amounts";
import { RequestError } from "./request-json";
import type { SolanaApi } from "./SolanaAutomation";

const WSOL = "So11111111111111111111111111111111111111112";
type ActionResult = { signature: string; status: "pending" | "finalized" | "failed" };
type OwnerAction = "revoke" | "withdraw" | "resume-buys";
const ACTION_NAMES: Record<OwnerAction, string> = { revoke: "revocation", withdraw: "withdrawal", "resume-buys": "request to resume buys" };

/**
 * A 4XX REFUSES THE REQUEST IT ANSWERS, NOT NECESSARILY THE SIGNED BYTES.
 *
 * Signed owner and permission transactions are kept after an unknown outcome
 * (no answer, or a 5xx) so a retry resubmits the same bytes and never signs a
 * second transaction. A 4xx is an answer: the prepare window passed, the
 * limits changed, a trade is pending, or another owner transaction is saved.
 * Not a refusal: a sign-in or rate-limit answer (401, 403, 408, 429) or Solana
 * being switched off (404) says nothing about the bytes.
 *
 * The server checks all of that before it saves or broadcasts, so a refusal
 * of the FIRST submission proves these bytes were never saved and dropping
 * them can never lose or duplicate a transaction. A later submission is a
 * retry of bytes the server may already have saved and broadcast, and the
 * server answers a retry from its record of them (ownerStatus, finishSetup):
 * a 4xx there can follow a broadcast that later finalizes. So a refused
 * retry never says "not accepted": only the server's record decides
 * (outcomeAfterRefusal).
 */
export function refusedByServer(error: unknown): error is RequestError {
  return error instanceof RequestError && error.status >= 400 && error.status < 500 && ![401, 403, 404, 408, 429].includes(error.status);
}

/** The server's saved owner transaction, as the status route reports it. */
export type OwnerRecord = { signature: string; status: string } | null;

/**
 * The owner's signature on signed wire bytes, which is what the server records
 * them by. Null for bytes the server could never accept: it requires exactly
 * one signature, the owner's (compact-u16 count 1, then 64 bytes).
 */
export function signatureOf(signedTransactionBase64: string): string | null {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(signedTransactionBase64), (c) => c.charCodeAt(0)); } catch { return null; }
  return bytes.length > 65 && bytes[0] === 1 ? base58Encode(bytes.subarray(1, 65)) : null;
}

/**
 * WHAT HAPPENED TO SIGNED BYTES WHOSE RETRY WAS REFUSED, FROM THE SERVER'S RECORD.
 *
 * "unknown": the record could not be read, so the bytes stay.
 * "unheld": the server's owner transaction is not these bytes. They were
 * never saved, or were resolved and then replaced by a newer one; either
 * way resubmitting them can never be checked or sent again.
 * Otherwise the server holds them, with this outcome.
 */
export async function outcomeAfterRefusal(readRecord: () => Promise<OwnerRecord>, signature: string | null):
  Promise<"unknown" | "unheld" | "pending" | "finalized" | "failed"> {
  let record: OwnerRecord;
  try { record = await readRecord(); } catch { return "unknown"; }
  if (!record || !signature || record.signature !== signature) return "unheld";
  return record.status === "finalized" || record.status === "failed" ? record.status : "pending";
}

export function SolanaOwnerActions({ available, api, sign, refresh, readRecord }: {
  available: boolean; api: SolanaApi; sign: (bytes: Uint8Array) => Promise<Uint8Array>; refresh: () => Promise<void>;
  /** Reads the server's saved owner transaction afresh (and updates the screen). */
  readRecord: () => Promise<OwnerRecord>;
}) {
  const [mint, setMint] = useState(SOLANA_USDG_MINT as string), [amount, setAmount] = useState("1");
  // `sent`: an earlier submission of these bytes reached the server, or may have.
  const [pending, setPending] = useState<{ action: OwnerAction; signedTransactionBase64: string; signature: string | null; sent: boolean } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Bytes cleared without a known outcome, linked so the owner can check Solana itself.
  const [cleared, setCleared] = useState<{ action: OwnerAction; signature: string } | null>(null);
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
        const signedTransactionBase64 = btoa(String.fromCharCode(...signed));
        saved = { action, signedTransactionBase64, signature: signatureOf(signedTransactionBase64), sent: false };
        setPending(saved); setResult(null); setCleared(null);
      }
      const name = ACTION_NAMES[saved.action];
      let next: ActionResult, recorded = false;
      try { ({ result: next } = await api<{ result: ActionResult }>("owner", { stage: "submit", signedTransactionBase64: saved.signedTransactionBase64 })); }
      catch (e) {
        if (!refusedByServer(e)) { setPending({ ...saved, sent: true }); throw e; }
        if (!saved.sent) {
          // The first submission of these bytes: the server refused them before saving anything.
          setPending(null); void refresh().catch(() => undefined);
          throw new Error(`${e.message} This signed ${name} was not accepted and has been discarded. Start it again to review and sign a new one.`);
        }
        const outcome = await outcomeAfterRefusal(readRecord, saved.signature);
        if (outcome === "unknown") throw new Error(`${e.message} An earlier submission of this signed ${name} may already be on Solana, so it was kept. This does not mean it failed. Check it again shortly.`);
        if (outcome === "pending") {
          if (saved.signature) setResult({ signature: saved.signature, status: "pending" });
          throw new Error(`${e.message} The server holds this signed ${name} and still records it as awaiting confirmation, so it was kept. It may already have completed on Solana. Check it again shortly.`);
        }
        if (outcome === "unheld") {
          setPending(null); setResult(null);
          if (saved.signature) setCleared({ action: saved.action, signature: saved.signature });
          throw new Error(`${e.message} The server holds no record of this signed ${name}, so it was cleared and cannot be resent. If an earlier submission reached Solana, its result shows on Solana and in your vault balances. Check before starting another.`);
        }
        // The server's record settles it: reading it already refreshed the screen.
        next = { signature: saved.signature!, status: outcome }; recorded = true;
      }
      // The server returned its record of these bytes: they were accepted.
      const accepted = { ...saved, signature: next.signature, sent: true };
      setResult(next);
      if (next.status !== "pending") { setPending(null); if (!recorded) await refresh(); } else setPending(accepted);
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
    {cleared && !pending && <p role="status"><a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(cleared.signature)}`}>Check this {ACTION_NAMES[cleared.action]} on Solana</a></p>}
    {result && <p role="status">Owner transaction: {result.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(result.signature)}`}>View transaction</a></p>}
  </div>;
}
