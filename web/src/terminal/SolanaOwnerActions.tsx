"use client";
import { useRef, useState } from "react";
import type { Instruction } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Encode } from "../../../packages/core/src/ids";
import { buildRevokeSolanaSessionsInstruction, buildSetSolanaBreakerInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../../packages/core/src/solana-live";
import { displaySolanaAmountOrNull, solanaUnits } from "../lib/solana-amounts";
import { RequestError } from "./request-json";
import type { SolanaApi } from "./SolanaAutomation";
import { OWNER_MAX_PRIORITY_FEE_LAMPORTS, readOwnerPaidTransaction, type OwnerPaidInstruction } from "./SolanaPermission";

const WSOL = "So11111111111111111111111111111111111111112";
type ActionResult = { signature: string; status: "pending" | "finalized" | "failed" };
type OwnerAction = "revoke" | "withdraw" | "withdraw-sol" | "resume-buys";
const ACTION_NAMES: Record<OwnerAction, string> = { revoke: "revocation", withdraw: "withdrawal", "withdraw-sol": "native SOL withdrawal", "resume-buys": "request to resume buys" };
/** The server's saved owner transaction by its kind; "session" is a trading permission registration. */
const KIND_NAMES: Readonly<Record<string, string>> = { ...ACTION_NAMES, session: "trading permission" };
const kindName = (kind: string | undefined) => kind !== undefined && Object.hasOwn(KIND_NAMES, kind) ? KIND_NAMES[kind]! : "owner transaction";
const sol = (raw: unknown) => displaySolanaAmountOrNull(raw, 9);
/** What the owner wallet holds and must hold to send an owner transaction (status.live.ownerWallet). */
export type OwnerWallet = { lamports: string; revokeLamports: string; withdrawLamports: string };
/** Owner-recoverable SOL outside the book (status.live.recoverable). */
export type RecoverableSol = { nativeLamports: string; unsyncedWsolLamports: string };
/** What the owner route's prepare answers, beyond the bytes to sign. */
export type PreparedOwnerTransaction = { transactionBase64: string; requiredLamports?: string; ownerLamports?: string; priorityFeeLamports?: string };
/** What the owner asked the server to prepare: the owner route's prepare body, without its stage. */
export type OwnerRequest = { action: "revoke" } | { action: "resume-buys" } | { action: "withdraw"; mint: string; amountRaw: string } | { action: "withdraw-sol"; amountRaw: string };

function plain(instruction: Instruction): OwnerPaidInstruction {
  return { program: String(instruction.programAddress), data: Uint8Array.from(instruction.data ?? []), accounts: (instruction.accounts ?? []).map((meta) => String(meta.address)) };
}
function sameInstruction(a: OwnerPaidInstruction, b: OwnerPaidInstruction): boolean {
  return a.program === b.program && a.data.length === b.data.length && a.data.every((byte, index) => byte === b.data[index])
    && a.accounts.length === b.accounts.length && a.accounts.every((account, index) => account === b.accounts[index]);
}
/**
 * The instructions the server builds for `request` (prepareOwnerAction in
 * worker/src/solana-app-runtime.ts), from the same core builders, for this
 * owner's vault of this program: `required` in order, after an optional
 * SyncNative of the vault's wrapped SOL account (a wrapped SOL withdrawal
 * wraps native SOL sent there first).
 */
async function expectedOwnerInstructions(request: OwnerRequest, owner: string, programId: string): Promise<{ required: OwnerPaidInstruction[]; sync: OwnerPaidInstruction | null }> {
  const vault = await deriveSolanaVaultAddress(programId, owner);
  if (request.action === "revoke") return { required: [plain(buildRevokeSolanaSessionsInstruction({ programAddress: programId, vault, owner }))], sync: null };
  if (request.action === "resume-buys") return { required: [plain(buildSetSolanaBreakerInstruction({ programAddress: programId, vault, authority: owner, paused: false }))], sync: null };
  if (request.action === "withdraw-sol") return { required: [plain(buildWithdrawSolanaNativeInstruction({ programAddress: programId, vault, owner, amount: BigInt(request.amountRaw) }))], sync: null };
  const tokenProgram = request.mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : request.mint === SOLANA_WRAPPED_SOL_MINT ? SOLANA_CLASSIC_TOKEN_PROGRAM : null;
  if (!tokenProgram) throw new Error("Only USDG and wrapped SOL can be withdrawn.");
  const vaultToken = await deriveSolanaAta(vault, request.mint, tokenProgram), ownerToken = await deriveSolanaAta(owner, request.mint, tokenProgram);
  return {
    required: [
      // CreateIdempotent of the owner's own token account, paid by the owner.
      { program: SOLANA_ASSOCIATED_TOKEN_PROGRAM, data: Uint8Array.of(1), accounts: [owner, ownerToken, owner, request.mint, SOLANA_SYSTEM_PROGRAM, tokenProgram] },
      plain(buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: request.mint, tokenProgram, vaultToken, ownerToken, amount: BigInt(request.amountRaw) })),
    ],
    sync: tokenProgram === SOLANA_CLASSIC_TOKEN_PROGRAM ? { program: SOLANA_CLASSIC_TOKEN_PROGRAM, data: Uint8Array.of(17), accounts: [vaultToken] } : null,
  };
}

/**
 * THE PAGE'S CHECK OF A PREPARED OWNER TRANSACTION, BEFORE THE WALLET OPENS.
 *
 * The owner key signs, and pays for, every owner transaction, so the page
 * reads the server's bytes as it reads a permission's: a v0 message the
 * owner alone signs and pays for, a priority fee of at most
 * OWNER_MAX_PRIORITY_FEE_LAMPORTS (readOwnerPaidTransaction), and nothing but
 * exactly what the owner asked for, for this owner's vault of this program:
 * the revocation; the resume request (breaker off); the native SOL
 * withdrawal of exactly the amount typed; or the token withdrawal of exactly
 * the amount typed to the owner's own token account, with that account's
 * creation and, for wrapped SOL, the SyncNative before it. A priority fee
 * the server states must be the one the bytes carry. Returns that fee in
 * lamports, or throws: nothing reaches the wallet.
 */
export async function checkPreparedOwnerTransaction(prepared: PreparedOwnerTransaction, request: OwnerRequest, expected: { owner: string; programId: string }): Promise<string> {
  const name = ACTION_NAMES[request.action];
  const refuse = (): never => { throw new Error(`The prepared ${name} does not match what you asked for. Nothing was signed. Refresh and try again.`); };
  const decoded = readOwnerPaidTransaction(prepared.transactionBase64, expected.owner) ?? refuse();
  let wanted: Awaited<ReturnType<typeof expectedOwnerInstructions>>;
  try { wanted = await expectedOwnerInstructions(request, expected.owner, expected.programId); } catch { return refuse(); }
  const [first] = decoded.instructions;
  const rest = wanted.sync && first && sameInstruction(first, wanted.sync) ? decoded.instructions.slice(1) : decoded.instructions;
  if (rest.length !== wanted.required.length || !rest.every((instruction, index) => sameInstruction(instruction, wanted.required[index]!))) refuse();
  const fee = decoded.priorityFeeLamports.toString();
  if (prepared.priorityFeeLamports !== undefined && prepared.priorityFeeLamports !== fee) {
    throw new Error(`The prepared ${name}'s priority fee does not match its bytes. Nothing was signed. Refresh and try again.`);
  }
  return fee;
}

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
export type OwnerRecord = { signature: string; status: string; kind?: string } | null;

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
 * never saved (the server saves before it broadcasts, so they never reached
 * Solana), or were resolved and then replaced by a newer one (their outcome
 * stays on Solana). Either way dropping them cannot lose or duplicate one.
 * Otherwise the server holds them, with this outcome.
 */
export async function outcomeAfterRefusal(readRecord: () => Promise<OwnerRecord>, signature: string | null):
  Promise<"unknown" | "unheld" | "pending" | "finalized" | "failed"> {
  let record: OwnerRecord;
  try { record = await readRecord(); } catch { return "unknown"; }
  if (!record || !signature || record.signature !== signature) return "unheld";
  return record.status === "finalized" || record.status === "failed" ? record.status : "pending";
}

/**
 * ONE SUBMITTED OWNER TRANSACTION AT A TIME, A REVOCATION INCLUDED.
 *
 * The server keeps one owner transaction per account. While one it saved is
 * awaiting final confirmation (status ownerTransaction "pending": a
 * withdrawal, a resume request, a revocation or a permission registration),
 * prepareOwner refuses to prepare another, a revocation too, with 409
 * "Refresh the pending owner transaction before preparing another.", until it
 * is final or provably expired (its blockhash's last valid height passed),
 * usually within a few minutes. Replacing it would lose the record its
 * outcome is booked from. So the page holds every owner action back while
 * the server reports one pending, says why, and offers a check instead of a
 * button the server would refuse.
 *
 * Signed bytes this page holds with an unknown outcome do not by themselves
 * hold back a revocation: if the server never saved them, a revocation
 * replaces them and they can no longer be sent; if it did, the prepare is
 * refused and the page reads the server's record to show it.
 */
export function SolanaOwnerActions({ available, owner, programId, api, sign, refresh, readRecord, serverTransaction = null, ownerWallet = null, recoverable = null }: {
  available: boolean;
  /** The bound owner wallet and the vault program the status names: what the prepared bytes must be for. */
  owner: string | null; programId: string | null;
  api: SolanaApi; sign: (bytes: Uint8Array) => Promise<Uint8Array>; refresh: () => Promise<void>;
  /** Reads the server's saved owner transaction afresh (and updates the screen). */
  readRecord: () => Promise<OwnerRecord>;
  /** The server's saved owner transaction from the last status read. */
  serverTransaction?: OwnerRecord;
  ownerWallet?: OwnerWallet | null;
  recoverable?: RecoverableSol | null;
}) {
  const [mint, setMint] = useState(SOLANA_USDG_MINT as string), [amount, setAmount] = useState("1"), [solAmount, setSolAmount] = useState("");
  // `sent`: an earlier submission of these bytes reached the server, or may have.
  const [pending, setPending] = useState<{ action: OwnerAction; signedTransactionBase64: string; signature: string | null; sent: boolean } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Bytes cleared without a known outcome, linked so the owner can check Solana itself.
  const [cleared, setCleared] = useState<{ action: OwnerAction; signature: string } | null>(null);
  // What the server said the last prepared transaction needs from the owner wallet.
  const [cost, setCost] = useState<{ action: OwnerAction; required: string; held: string | null; fee: string | null } | null>(null);
  const inFlight = useRef(false);
  const serverPending = serverTransaction?.status === "pending" ? serverTransaction : null;
  const run = (action: OwnerAction) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError("");
    void (async () => {
      // Saved bytes are only ever resubmitted for their own action. Any other
      // action prepares fresh bytes; the server refuses that while the earlier
      // transaction is saved and unresolved, and otherwise the earlier one can
      // no longer be submitted once this one is prepared.
      let saved = pending?.action === action ? pending : null;
      if (!saved) {
        if (!owner || !programId) throw new Error("Connect the Solana wallet bound to this account and wait for the vault program to be verified.");
        const request: OwnerRequest = action === "withdraw" ? { action, mint, amountRaw: solanaUnits(amount, mint === SOLANA_USDG_MINT ? 6 : 9) }
          // Native lamports held by the vault account above its rent reserve (withdraw_sol).
          : action === "withdraw-sol" ? { action, amountRaw: solanaUnits(solAmount, 9) }
          : { action };
        let prepared: PreparedOwnerTransaction;
        try { ({ prepared } = await api<{ prepared: PreparedOwnerTransaction }>("owner", { stage: "prepare", ...request })); }
        catch (e) {
          // Refused before anything was signed (another owner transaction is
          // still pending, say): show the server's record of why.
          if (refusedByServer(e)) await refresh().catch(() => undefined);
          throw e;
        }
        // The wallet only opens for bytes that do exactly what the owner asked; the fee shown is the one they carry.
        setCost(null);
        const fee = await checkPreparedOwnerTransaction(prepared, request, { owner, programId });
        const required = sol(prepared.requiredLamports);
        setCost(required ? { action, required, held: sol(prepared.ownerLamports), fee: fee !== "0" ? sol(fee) : null } : null);
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
      // Pending or not, the server's record changed: read it, so the page shows
      // what the server will now refuse (see SolanaOwnerActions above).
      if (next.status !== "pending") { setPending(null); if (!recorded) await refresh(); }
      else { setPending(accepted); await refresh().catch(() => undefined); }
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : "The owner action did not finish. Retry the existing transaction."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  /** The server's pending record when this page does not hold its bytes (another device, a reload, a permission). */
  const check = () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError("");
    void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : "The owner transaction could not be checked. Try again shortly."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  const held = sol(ownerWallet?.lamports), revokeNeeds = sol(ownerWallet?.revokeLamports), withdrawNeeds = sol(ownerWallet?.withdrawLamports);
  const short = !!ownerWallet && !!held && !!revokeNeeds && !!withdrawNeeds && BigInt(ownerWallet.lamports) < BigInt(ownerWallet.revokeLamports);
  const native = sol(recoverable?.nativeLamports), unsynced = sol(recoverable?.unsyncedWsolLamports);
  const pendingIsServers = !!pending && !!serverPending && pending.signature === serverPending.signature;
  return <div className="solana-card"><h2>Owner controls</h2>
    <p>Your wallet must sign every revocation and withdrawal. Token withdrawals return to your own token accounts; native SOL returns to your owner wallet.</p>
    {held && revokeNeeds && withdrawNeeds && <p>Your owner wallet holds {held} SOL and pays the network fees of these transactions. To revoke it must hold at least {revokeNeeds} SOL; to withdraw, up to {withdrawNeeds} SOL, since a withdrawal may open your token account. Merrymen adds a priority fee only from SOL beyond that, and this page signs none above {sol(OWNER_MAX_PRIORITY_FEE_LAMPORTS.toString())} SOL.</p>}
    {short && <p role="alert" className="solana-warning">That is too little to revoke. Send SOL to your owner wallet now, so you can revoke or withdraw in an emergency.</p>}
    {error && <p role="alert" className="solana-error">{error}</p>}
    {serverPending && !pendingIsServers && <p role="status">Your {kindName(serverPending.kind)} is awaiting final confirmation on Solana. Until it is final, or its blockhash expires (usually within a few minutes), the server prepares no other owner transaction, a revocation included. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(serverPending.signature)}`}>View it on Solana</a></p>}
    {serverPending && !pending && <button disabled={busy || !available} onClick={check}>Check owner transaction</button>}
    <fieldset disabled={busy || !available}><legend>Vault recovery</legend>
      <button disabled={!!serverPending} onClick={() => run("revoke")}>Revoke all Solana sessions</button>
      <button disabled={!!pending || !!serverPending} onClick={() => run("resume-buys")}>Ask wallet to resume buys</button>
      <p>Resuming buys keeps the existing risk limits and portfolio high-water mark. If the drawdown still exceeds your limit, buying pauses again.</p>
      <label>Asset<select value={mint} onChange={(e) => setMint(e.target.value)}><option value={SOLANA_USDG_MINT}>USDG</option><option value={WSOL}>Wrapped SOL</option></select></label>
      <label>Amount to withdraw<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button disabled={!!pending || !!serverPending} onClick={() => run("withdraw")}>Withdraw to my wallet</button>
      {unsynced && unsynced !== "0" && <p>{unsynced} SOL was sent to the vault&apos;s wrapped SOL account without being wrapped. A wrapped SOL withdrawal wraps it first and can include it.</p>}
      {native && <p>The vault account holds {native} SOL above its rent reserve. It is never traded or counted in performance; withdraw it to your owner wallet here.</p>}
      <label>Native SOL to withdraw<input inputMode="decimal" value={solAmount} onChange={(e) => setSolAmount(e.target.value)} /></label>
      <button disabled={!!pending || !!serverPending} onClick={() => run("withdraw-sol")}>Withdraw native SOL</button>
    </fieldset>
    {cost && <p>The prepared {ACTION_NAMES[cost.action]} needs your owner wallet to hold at least {cost.required} SOL{cost.held ? ` (it holds ${cost.held} SOL)` : ""}: its network fee{cost.fee ? `, a priority fee of ${cost.fee} SOL so it lands under congestion` : ""}, any token account it opens, and the wallet&apos;s own minimum balance.</p>}
    {pending && <p role="status">{pendingIsServers
      ? `A signed ${ACTION_NAMES[pending.action]} is awaiting final confirmation on Solana. Until it is final or expired, no other owner transaction can be prepared, a revocation included. Check it shortly.`
      // Another pending record (another device or tab) holds Revoke back too: never promise it here.
      : serverPending ? `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Revoking waits for the server's pending ${kindName(serverPending.kind)} above: it can be prepared once that is final or expired.`
      : `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Revoking stays available: if the server never saved this ${ACTION_NAMES[pending.action]}, a revocation replaces it and it can no longer be sent; if the server saved it, a revocation can be prepared once it is final or expired.`}</p>}
    {pending && <button disabled={busy || !available} onClick={() => run(pending.action)}>Check existing owner transaction</button>}
    {cleared && !pending && <p role="status"><a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(cleared.signature)}`}>Check this {ACTION_NAMES[cleared.action]} on Solana</a></p>}
    {result && <p role="status">Owner transaction: {result.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(result.signature)}`}>View transaction</a></p>}
  </div>;
}
