"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { CHAINS, SOLANA_USDG_MINT, base58Encode } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits, SolanaQuote } from "../../../packages/core/src/solana";
import type { SolanaPaperSnapshot } from "../../../worker/src/solana-paper-store";
import type { SolanaBinding } from "@/lib/solana-binding-store";
import { privyEnabled } from "@/lib/privy-client";
import { useSolanaOwner } from "./useSolanaOwner";
import { requestJson } from "./request-json";
import { SignIn } from "./HostedControls";
import { SolanaAutomation } from "./SolanaAutomation";
import { SolanaOwnerActions } from "./SolanaOwnerActions";
import { solanaUnits as units, displaySolanaAmount as display } from "../lib/solana-amounts";
import "./SolanaScreen.css";

const WSOL = "So11111111111111111111111111111111111111112";
type RuntimeStatus = {
  owner: string; requestedMode: "paper" | "live"; paper: SolanaPaperSnapshot | null;
  live: { ready: boolean; canExit?: boolean; cashTokenAccount?: string | null; blockers: string[]; programId: string | null; vault: string | null; session: string | null; pending: Receipt[];
    balances?: { slot: number; cashUsdg: string; wsolRaw: string } | null;
    book?: { realizedPnlUsdgRaw: string; networkFeesLamports: string; unresolvedFeeCount?: number; reservedUnknownFeeLamports?: string; quarantinedWsolRaw?: string } | null;
    history?: Receipt[]; ownerTransaction?: { signature: string; status: string; kind?: string } | null };
  limits: SolanaPaperLimits | null;
  automation?: { workerOnline: boolean; lastSeenAtMs: number | null };
};
type Status = { binding: SolanaBinding | null; runtime: RuntimeStatus | null };
type Setup = { transactionBase64: string; programId: string; vault: string; session: string; expiresAtMs: number };
type Receipt = { mode?: string; requestId?: string; signature?: string; status?: string; state?: string };
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0)); }

export function SolanaScreen() {
  return <section className="solana-screen" aria-labelledby="solana-title">
    <header><p className="solana-eyebrow">Solana · mainnet</p><h1 id="solana-title">Your Solana account</h1><p>Practice at live prices, or authorize a bounded trading session for real funds.</p></header>
    {privyEnabled() ? <ConnectedSolana /> : <p role="status">Protected wallet sign-in must be configured before using Solana.</p>}
  </section>;
}

function ConnectedSolana() {
  const signer = useSolanaOwner();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper"), [consent, setConsent] = useState(false);
  const [perTrade, setPerTrade] = useState("10"), [daily, setDaily] = useState("50");
  const [perTradeSol, setPerTradeSol] = useState("0.1"), [dailySol, setDailySol] = useState("0.5");
  const [ops, setOps] = useState("20"), [drawdown, setDrawdown] = useState("20"), [duration, setDuration] = useState("24");
  const [initialCash, setInitialCash] = useState("1000"), [side, setSide] = useState<"buy" | "sell">("buy"), [amount, setAmount] = useState("1");
  const [preview, setPreview] = useState<SolanaQuote | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [registration, setRegistration] = useState<{ signature?: string; secret: string; signedTransactionBase64: string } | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const accountEpoch = useRef(0), inFlight = useRef(false);
  const statusRevision = useRef<number | null>(null);
  const identity = useRef(signer.did);
  identity.current = signer.did;
  const tokenSource = useRef(signer.getAccessToken);
  tokenSource.current = signer.getAccessToken;
  const api = useCallback(async <T,>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const requestedIdentity = identity.current;
    const requestedEpoch = accountEpoch.current;
    if (!requestedIdentity) throw new Error("Sign in before opening your Solana account.");
    const token = await tokenSource.current();
    if (requestedIdentity !== identity.current || requestedEpoch !== accountEpoch.current) throw new Error("Your signing account changed. Refresh before continuing.");
    if (!token) throw new Error("Your sign-in expired. Sign in again.");
    const result = await requestJson<T>(`/api/solana/${path}`, { signal,
      headers: { Authorization: `Bearer ${token}`, "X-Merrymen-Privy-Did": requestedIdentity, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    if (requestedIdentity !== identity.current || requestedEpoch !== accountEpoch.current) throw new Error("Your signing account changed. Refresh before continuing.");
    return result;
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const epoch = accountEpoch.current;
    const next = await api<Status>("status", undefined, signal);
    if (epoch !== accountEpoch.current || signal?.aborted) return;
    if (statusRevision.current !== null && statusRevision.current !== next.binding?.revision) setPreview(null);
    statusRevision.current = next.binding?.revision ?? null;
    setStatus(next);
    if (next.binding) {
      setMode(next.binding.requestedMode);
      if (next.binding.limits) {
        setPerTrade(display(next.binding.limits.perTradeUsdg)); setDaily(display(next.binding.limits.dailyUsdg));
        setOps(String(next.binding.limits.maxOpsPerDay)); setDrawdown(String(next.binding.limits.maxDrawdownBps / 100));
        if (next.binding.limits.perTradeWsol && next.binding.limits.dailyWsol) {
          setPerTradeSol(display(next.binding.limits.perTradeWsol, 9)); setDailySol(display(next.binding.limits.dailyWsol, 9));
        }
      }
    }
  }, [api]);
  useEffect(() => {
    accountEpoch.current++;
    setStatus(null); setError(""); setConsent(false); setPreview(null); setReceipt(null); setRegistration(null); request.current = null; statusRevision.current = null;
    if (!signer.authenticated) return;
    const abort = new AbortController();
    void refresh(abort.signal).catch((e: unknown) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not load your Solana account."); });
    return () => { accountEpoch.current++; abort.abort(); };
  }, [signer.did, signer.authenticated, refresh]);
  const act = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const epoch = accountEpoch.current;
    try { await fn(); } catch (e) { if (epoch === accountEpoch.current) setError(e instanceof Error ? e.message : "The Solana request did not finish. Refresh before retrying."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const binding = status?.binding;
  const sameWallet = !!binding && signer.address === binding.owner;
  const policy = (): SolanaPaperLimits => {
    const maxOpsPerDay = Number(ops), maxDrawdownBps = Number(units(drawdown, 2)), hours = Number(duration);
    if (!Number.isInteger(maxOpsPerDay) || maxOpsPerDay < 1 || maxOpsPerDay > 96
      || !Number.isInteger(maxDrawdownBps) || maxDrawdownBps < 1 || maxDrawdownBps > 10_000
      || !Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("Choose 1–96 trades per day, a drawdown of 0.01–100%, and a duration up to 168 hours.");
    // Live sessions bound every sale by the SOL it puts in, not only the USDG it returns.
    const sell = mode === "live" ? { perTradeWsol: units(perTradeSol, 9), dailyWsol: units(dailySol, 9) } : {};
    if (sell.perTradeWsol && BigInt(sell.perTradeWsol) > BigInt(sell.dailyWsol)) throw new Error("The SOL sold per trade cannot exceed the SOL sold per 24 hours.");
    return { perTradeUsdg: units(perTrade, 6), dailyUsdg: units(daily, 6), maxOpsPerDay, maxDrawdownBps, expiresAtMs: Date.now() + Math.floor(hours * 3_600_000), ...sell };
  };
  const invalidate = () => { setPreview(null); setReceipt(null); request.current = null; };
  const tradeIntent = () => {
    const amountRaw = units(amount, side === "buy" ? 6 : 9);
    const key = JSON.stringify([mode, side, amountRaw]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    return { kind: "spl-swap", chain: CHAINS.solana, mode, requestId: request.current.id,
      inputMint: side === "buy" ? SOLANA_USDG_MINT : WSOL, outputMint: side === "buy" ? WSOL : SOLANA_USDG_MINT,
      amountRaw, slippageBps: 50 };
  };
  const bind = async () => {
    if (!signer.address) throw new Error("Wait for your Solana wallet to connect.");
    const owner = signer.address;
    const challenge = await api<{ nonce: string; message: string }>(`bind?owner=${encodeURIComponent(owner)}`);
    const signature = await signer.signBinding(challenge.message);
    await api("bind", { owner, nonce: challenge.nonce, signature }); await refresh();
  };
  const setupLive = async () => {
    if (!sameWallet) throw new Error("Connect the Solana wallet bound to this account.");
    let pending = registration;
    if (!pending) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      try {
        const sessionPublicKey = base58Encode(ed25519.getPublicKey(seed));
        const { setup } = await api<{ setup: Setup }>("setup", { stage: "prepare", sessionPublicKey });
        if (setup.session !== sessionPublicKey) throw new Error("The prepared permission names a different session. Nothing was signed.");
        const signed = await signer.signSetup(fromBase64(setup.transactionBase64));
        pending = { secret: base64(seed), signedTransactionBase64: base64(signed) };
        // Keep the bounded session seed and exact signed bytes before submit:
        // a lost response must retry this registration, never create a new one.
        setRegistration(pending);
      } finally { seed.fill(0); }
    }
    if (!pending.signature) {
      const { registration: submitted } = await api<{ registration: { signature: string; status: string } }>("setup", { stage: "submit", signedTransactionBase64: pending.signedTransactionBase64 });
      if (submitted.status === "failed") { setRegistration(null); throw new Error("The permission transaction failed. No session was activated."); }
      pending = { ...pending, signature: submitted.signature }; setRegistration(pending);
    }
    await api("setup", { stage: "activate", signature: pending.signature, sessionSecretKey: pending.secret });
    setRegistration(null); await refresh();
  };
  const liveBook = status?.runtime?.live.book;
  if (!signer.authenticated) return <div className="solana-card"><p>Sign in with the same account you use for Robinhood Chain.</p><SignIn onDone={() => { void refresh().catch(() => undefined); }} /></div>;
  return <>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <div className="solana-card"><h2>Wallet ownership</h2>
      {binding ? <><p className="solana-address">{binding.owner}</p><p>{sameWallet ? "Verified wallet connected." : "Connect the exact embedded wallet shown above before signing a permission."}</p></>
        : <><p>{signer.address ?? (signer.ready ? "Create your protected Solana wallet, then verify that it belongs to this account." : "Connecting your protected wallet…")}</p>
          <button disabled={busy || !signer.ready || signer.ambiguous} onClick={() => void act(signer.address ? bind : signer.create)}>{signer.address ? "Verify Solana wallet" : "Create Solana wallet"}</button>
          {signer.ambiguous && <p role="alert">Multiple embedded Solana wallets are connected. Select the intended owner before continuing.</p>}</>}
      <button className="solana-secondary" disabled={busy} onClick={() => void act(() => refresh())}>Refresh account</button>
    </div>
    {binding && <>
      <form className="solana-card" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        await api("settings", { mode, limits: policy(), revision: binding.revision, liveConsent: consent }); invalidate(); await refresh();
      }); }}><h2>Solana trading mode</h2>
        <fieldset disabled={busy}><legend>Choose how this account trades</legend>
          <label><input type="radio" name="solana-mode" checked={mode === "paper"} onChange={() => { setMode("paper"); setConsent(false); invalidate(); }} /> Paper · simulated funds</label>
          <label><input type="radio" name="solana-mode" checked={mode === "live"} onChange={() => { setMode("live"); setConsent(false); invalidate(); }} /> Live · real funds</label>
        </fieldset>
        <div className="solana-fields">
          <label>USDG per trade<input inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} /></label>
          <label>USDG per 24 hours<input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} /></label>
          <label>Trades per 24 hours<input type="number" min="1" max="96" value={ops} onChange={(e) => setOps(e.target.value)} /></label>
          <label>Maximum drawdown (%)<input inputMode="decimal" value={drawdown} onChange={(e) => setDrawdown(e.target.value)} /></label>
          <label>Permission duration (hours)<input type="number" min="1" max="168" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
          {mode === "live" && <>
            <label>SOL sold per trade<input inputMode="decimal" value={perTradeSol} onChange={(e) => setPerTradeSol(e.target.value)} /></label>
            <label>SOL sold per 24 hours<input inputMode="decimal" value={dailySol} onChange={(e) => setDailySol(e.target.value)} /></label>
          </>}
        </div>
        {mode === "live" && <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I authorize real Solana trades within these limits after registering the permission with my wallet.</label>}
        <button disabled={busy || (mode === "live" && !consent)}>Save Solana mode and limits</button>
        <p>Saved preference: {binding.requestedMode}. A saved live preference becomes executable only after a verified wallet permission.</p>
      </form>
      {binding.requestedMode === "paper" ? <div className="solana-card"><h2>Paper portfolio</h2>
        {status?.runtime?.paper ? <><p className="solana-value">{display(status.runtime.paper.cashRaw)} USDG</p><p>Simulated cash. {status.runtime.paper.positions.length} open position(s).</p>
          {status.runtime.paper.positions.map((position) => <p key={position.mint}>{position.mint === WSOL ? "Wrapped SOL" : position.mint}: {display(position.amountRaw, position.decimals)}</p>)}
          <p>Network fees and account rent are excluded from paper results.</p>
          {!!status.runtime.paper.trades?.length && <details><summary>Recent simulated trades</summary><ul>{status.runtime.paper.trades.slice(0, 20).map((trade) => <li key={trade.requestId}>{trade.side === "buy" ? "Buy" : "Sell"} · {trade.requestId} · simulated</li>)}</ul></details>}
          </> : <><label>Starting simulated USDG<input inputMode="decimal" value={initialCash} onChange={(e) => setInitialCash(e.target.value)} /></label>
            <button disabled={busy || !binding.limits} onClick={() => void act(async () => { await api("paper", { initialCashRaw: units(initialCash, 6) }); await refresh(); })}>Create paper portfolio</button></>}
      </div> : <div className="solana-card"><h2>Live permission</h2>
        <p>{status?.runtime?.live.ready ? "Registered permission ready." : "Live trading is not active yet."}</p>
        {binding.limits?.perTradeWsol && binding.limits.dailyWsol && <p>Sales are limited to {display(binding.limits.perTradeWsol, 9)} SOL per trade and {display(binding.limits.dailyWsol, 9)} SOL per 24 hours, whatever the price.</p>}
        {!!status?.runtime?.live.blockers.length && <ul>{status.runtime.live.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        {status?.runtime?.live.vault && <p>Vault: <span className="solana-address">{status.runtime.live.vault}</span></p>}
        {status?.runtime?.live.cashTokenAccount && (status.runtime.live.ready || status.runtime.live.canExit) && <div><h3>Fund the Solana vault</h3><p>Send USDG on Solana to this verified USDG token account:</p><p className="solana-address">{status.runtime.live.cashTokenAccount}</p><p>Deposit USDG only. Direct wrapped SOL deposits have no recorded cost basis and cannot be traded by this session.</p></div>}
        {status?.runtime?.live.balances && <><p className="solana-value">{display(status.runtime.live.balances.cashUsdg)} USDG</p><p>{display(status.runtime.live.balances.wsolRaw, 9)} wrapped SOL · observed at slot {status.runtime.live.balances.slot}</p></>}
        {liveBook && <p>Recorded realized P&amp;L: {display(liveBook.realizedPnlUsdgRaw)} USDG. Network fees: {display(liveBook.networkFeesLamports, 9)} SOL.</p>}
        {liveBook?.quarantinedWsolRaw && liveBook.quarantinedWsolRaw !== "0" && <p role="status">{display(liveBook.quarantinedWsolRaw, 9)} wrapped SOL arrived outside your recorded trades. It is held aside: never traded, never counted in performance, and you can withdraw it.</p>}
        {liveBook && (liveBook.unresolvedFeeCount ?? 0) > 0 && <p role="status">Network fees are incomplete for {liveBook.unresolvedFeeCount} expired submission(s). Their swaps are proven not executed; the recorded fee total excludes unknown fees. Reserved fee allowance: {display(liveBook.reservedUnknownFeeLamports ?? "0", 9)} SOL.</p>}
        {status?.runtime?.live.ownerTransaction && <p>Owner transaction: {status.runtime.live.ownerTransaction.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(status.runtime.live.ownerTransaction.signature)}`}>View owner transaction</a></p>}
        {!!status?.runtime?.live.pending.length && <p role="status">{status.runtime.live.pending.length} trade(s) awaiting final confirmation. Refresh to reconcile the saved request.</p>}
        {!!status?.runtime?.live.history?.length && <details><summary>Recent live requests</summary><ul>{status.runtime.live.history.slice(0, 20).map((trade) => <li key={trade.requestId}>{trade.requestId}: {trade.status}{trade.signature && <> · <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`}>Transaction</a></>}</li>)}</ul></details>}
        <p>The initial live market is USDG ↔ wrapped SOL. Deposit only after the program and vault have been verified.</p>
        {registration && <p>Keep this page open while finalization completes. Retry activation with the existing registration.</p>}
        <button disabled={busy || !sameWallet || !binding.limits || !status?.runtime?.live.programId} onClick={() => void act(setupLive)}>{registration ? "Finish permission registration" : "Register bounded trading permission"}</button>
      </div>}
      <form className="solana-card" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        const result = await api<{ preview: SolanaQuote | { quote: SolanaQuote } }>("intent", { action: "preview", mode, intent: tradeIntent() });
        setPreview("quote" in result.preview ? result.preview.quote : result.preview); setReceipt(null);
      }); }}><h2>USDG ↔ wrapped SOL</h2>
        <label>Direction<select disabled={busy} value={side} onChange={(e) => { setSide(e.target.value as "buy" | "sell"); invalidate(); }}><option value="buy">Buy wrapped SOL</option><option value="sell">Sell wrapped SOL</option></select></label>
        <label>{side === "buy" ? "USDG to spend" : "Wrapped SOL to sell"}<input disabled={busy} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); invalidate(); }} /></label>
        <p>Slippage limit: 0.5%. Saved mode: {binding.requestedMode}.</p>
        <button disabled={busy || !!receipt || mode !== binding.requestedMode || !binding.limits || (mode === "live" && !(side === "sell" ? status?.runtime?.live.canExit : status?.runtime?.live.ready))}>Preview trade</button>
        {preview && <><p>Minimum received: {display(preview.minOutAmount, side === "buy" ? 9 : 6)} {side === "buy" ? "wrapped SOL" : "USDG"}.</p>
          <button type="button" disabled={busy || !!receipt || mode !== binding.requestedMode} onClick={() => void act(async () => {
            const result = await api<{ receipt: Receipt }>("intent", { action: "trade", mode, intent: tradeIntent() }); setReceipt(result.receipt); await refresh();
          })}>{mode === "paper" ? "Simulate trade" : "Place live trade"}</button></>}
        {receipt && <p role="status">{receipt.mode === "paper" ? "Simulated trade recorded." : `Live request recorded${receipt.status ? `: ${receipt.status}` : ""}.`} {receipt.signature && <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(receipt.signature)}`}>View transaction</a>}</p>}
        {receipt && <button type="button" className="solana-secondary" disabled={busy} onClick={invalidate}>Start a new trade</button>}
      </form>
      <SolanaAutomation key={`strategy-${signer.did}`} binding={binding} api={api} refresh={refresh} workerOnline={status?.runtime?.automation?.workerOnline ?? false} />
      <SolanaOwnerActions key={`owner-${signer.did}`} available={sameWallet && !!status?.runtime?.live.programId} api={api} sign={signer.signSetup} refresh={refresh} />
    </>}
  </>;
}
