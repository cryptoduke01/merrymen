"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { CHAINS, SOLANA_USDG_MINT, base58Encode } from "../../../packages/core/src/ids";
import { SOLANA_QUOTE_MAX_AGE_MS, type SolanaPaperLimits, type SolanaQuote } from "../../../packages/core/src/solana";
import type { SolanaPaperSnapshot } from "../../../worker/src/solana-paper-store";
import type { SolanaBinding } from "@/lib/solana-binding-store";
import { privyEnabled } from "@/lib/privy-client";
import { useSolanaOwner } from "./useSolanaOwner";
import { requestJson } from "./request-json";
import { SignIn } from "./HostedControls";
import { SolanaAutomation } from "./SolanaAutomation";
import { OWNER_CONFIRMATION_UNAVAILABLE, outcomeAfterRefusal, refusedByServer, signatureOf, SolanaOwnerActions, type OwnerRecord, type OwnerWallet, type RecoverableSol } from "./SolanaOwnerActions";
import { ownerKeyExportEnabled, releasedProgramSha256, SolanaRecovery } from "./SolanaRecovery";
import { checkPreparedPermission, PermissionReview, PermissionTerms, permissionExpiry, type PreparedPermission, type SignedPermissionTerms } from "./SolanaPermission";
import { deriveSolanaVaultAddress } from "../../../packages/core/src/solana-live";
import { solanaUnits as units, displaySolanaAmount as display, displaySolanaAmountOrNull } from "../lib/solana-amounts";
import "./SolanaScreen.css";

const WSOL = "So11111111111111111111111111111111111111112";
type RuntimeStatus = {
  owner: string; requestedMode: "paper" | "live"; paper: SolanaPaperSnapshot | null;
  live: { ready: boolean; canExit?: boolean; cashTokenAccount?: string | null; blockers: string[]; programId: string | null; vault: string | null; session: string | null; pending: Receipt[];
    balances?: { slot: number; cashUsdg: string; wsolRaw: string } | null;
    book?: { realizedPnlUsdgRaw: string; networkFeesLamports: string; unresolvedFeeCount?: number; reservedUnknownFeeLamports?: string; quarantinedWsolRaw?: string } | null;
    history?: Receipt[]; ownerTransaction?: { signature: string; status: string; kind?: string } | null;
    /** Not blockers: a low shared fee payer, an owner wallet short of SOL for revoke or withdraw. */
    warnings?: string[];
    feePayer?: { lamports: string; level: FeePayerLevel } | null;
    ownerWallet?: OwnerWallet | null; recoverable?: RecoverableSol | null };
  limits: SolanaPaperLimits | null;
  automation?: { workerOnline: boolean; lastSeenAtMs: number | null };
};
type Status = { binding: SolanaBinding | null; runtime: RuntimeStatus | null };
type FeePayerLevel = "ok" | "low" | "buys-blocked" | "exits-blocked";
/** The shared network fee payer's level, in the owner's words (the runtime's blockers and warnings say what follows from it). */
const FEE_PAYER_LEVELS: Record<FeePayerLevel, string> = { ok: "funded", low: "low; trading continues and operators are alerted",
  "buys-blocked": "too low for buys; exits continue", "exits-blocked": "too low for any trade, exits included" };
/**
 * A prepared permission the owner reviews before the wallet opens. The server
 * accepts its signature for 60 seconds from prepare; the page offers to sign
 * it for less, so the signed bytes still reach the server in time.
 */
type Review = { transactionBase64: string; limits: SolanaPaperLimits; terms: SignedPermissionTerms; requiredLamports: string | null; ownerLamports: string | null; deadline: number };
const REVIEW_SIGN_WINDOW_MS = 45_000;
type Receipt = { mode?: string; requestId?: string; signature?: string; status?: string; state?: string;
  intent?: { outputMint?: string }; minOutAmount?: string; quotedOutAmount?: string; quote?: { minOutAmount?: string }; outputAmountRaw?: string };
/** A preview is only good for its quote's lifetime, and only for the exact trade it quoted. */
type Preview = { quote: SolanaQuote; key: string; deadline: number };
const RAW = /^(0|[1-9][0-9]*)$/;
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0)); }
/** The saved expiry is absolute; the form shows the whole hours left, so an untouched form matches it. */
function hoursLeft(expiresAtMs: number): string {
  const remaining = expiresAtMs - Date.now();
  return remaining > 0 ? String(Math.min(168, Math.max(1, Math.ceil(remaining / 3_600_000)))) : "24";
}

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
  const [preview, setPreview] = useState<Preview | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [, setQuoteClock] = useState(0);
  // `signature` is what the server records these bytes by; `sent`: an earlier submission reached the server, or may have.
  const [registration, setRegistration] = useState<{ signature: string | null; sent: boolean; secret: string; signedTransactionBase64: string; limits: SolanaPaperLimits } | null>(null);
  const [savedDuration, setSavedDuration] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null), [reviewLapsed, setReviewLapsed] = useState(false);
  const [, setReviewClock] = useState(0);
  // The reviewed permission's session seed: kept out of React state and zeroed when the review ends.
  const reviewSeed = useRef<Uint8Array | null>(null);
  // True while the owner's wallet is open on the reviewed bytes (signRegistration).
  const signingReview = useRef(false);
  const discardReview = useCallback(() => { reviewSeed.current?.fill(0); reviewSeed.current = null; setReview(null); }, []);
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
  /** Reads and shows the account; returns what it read, or null if the account changed meanwhile. */
  const load = useCallback(async (signal?: AbortSignal): Promise<Status | null> => {
    const epoch = accountEpoch.current;
    const next = await api<Status>("status", undefined, signal);
    if (epoch !== accountEpoch.current || signal?.aborted) return null;
    if (statusRevision.current !== null && statusRevision.current !== next.binding?.revision) { setPreview(null); discardReview(); }
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
        const hours = hoursLeft(next.binding.limits.expiresAtMs);
        setDuration(hours); setSavedDuration(hours);
      } else setSavedDuration(null);
    }
    return next;
  }, [api, discardReview]);
  const refresh = useCallback(async (signal?: AbortSignal) => { await load(signal); }, [load]);
  /** The server's saved owner transaction, read afresh: which signed bytes it holds, and their outcome. */
  const readRecord = useCallback(async (): Promise<OwnerRecord> => {
    const next = await load();
    if (!next) throw new Error("Your signing account changed. Refresh before continuing.");
    return next.runtime?.live.ownerTransaction ?? null;
  }, [load]);
  useEffect(() => {
    accountEpoch.current++;
    setStatus(null); setError(""); setConsent(false); setPreview(null); setReceipt(null); setRegistration(null); request.current = null; statusRevision.current = null;
    discardReview(); setReviewLapsed(false);
    if (!signer.authenticated) return;
    const abort = new AbortController();
    void refresh(abort.signal).catch((e: unknown) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not load your Solana account."); });
    return () => { accountEpoch.current++; abort.abort(); };
  }, [signer.did, signer.authenticated, refresh, discardReview]);
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
  /** The form shows exactly the saved mode and limits: nothing typed is waiting to be saved. */
  const formMatchesSaved = (): boolean => {
    const saved = binding?.limits;
    if (!binding || !saved || mode !== binding.requestedMode || duration !== savedDuration) return false;
    try {
      return units(perTrade, 6) === saved.perTradeUsdg && units(daily, 6) === saved.dailyUsdg && Number(ops) === saved.maxOpsPerDay
        && units(drawdown, 2) === String(saved.maxDrawdownBps)
        && (mode !== "live" || (units(perTradeSol, 9) === saved.perTradeWsol && units(dailySol, 9) === saved.dailyWsol));
    } catch { return false; }
  };
  /** Why a new permission cannot be registered with what the page shows, or null. */
  const registerBlock = (): string | null => {
    const saved = binding?.limits;
    if (!saved) return "Save live mode and its limits before registering a trading permission.";
    if (saved.expiresAtMs <= Date.now()) return `Your saved limits expired at ${permissionExpiry(saved.expiresAtMs)}. Save new limits before registering.`;
    if (!saved.perTradeWsol || !saved.dailyWsol) return "Save how much SOL a live trade and a live day may sell before registering.";
    if (!formMatchesSaved()) return "The form has unsaved changes. A permission is always signed with your saved limits: save your changes, or refresh to discard them, before registering.";
    return null;
  };
  const invalidate = () => { setPreview(null); setReceipt(null); request.current = null; };
  // Re-render when the previewed quote expires, so its minimum stops being offered.
  useEffect(() => {
    if (!preview) return;
    const wait = preview.deadline - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setQuoteClock((tick) => tick + 1), wait + 1);
    return () => clearTimeout(timer);
  }, [preview]);
  const quoteFresh = !!preview && Date.now() < preview.deadline;
  // A reviewed permission not signed in time is discarded: its bytes would reach the server too late.
  // Not while the wallet is open on it: the owner may be signing, and the
  // server's own 60-second window decides those bytes (signRegistration).
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { if (signingReview.current) return; discardReview(); setReviewLapsed(true); }, Math.max(0, review.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [review, discardReview]);
  // The review says how long is left to sign: re-render it every second while it is open, so it counts down.
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => setReviewClock((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [review]);
  const previewTrade = async () => {
    const intent = tradeIntent(), key = request.current!.key;
    // Timed on this clock from before the request, so a skewed device clock
    // cannot stretch the quote's lifetime and latency only shortens it.
    const started = Date.now();
    const result = await api<{ preview: SolanaQuote | { quote: SolanaQuote } }>("intent", { action: "preview", mode, intent });
    const quote = "quote" in result.preview ? result.preview.quote : result.preview;
    if (quote.inputMint !== intent.inputMint || quote.outputMint !== intent.outputMint || quote.inAmount !== intent.amountRaw || !RAW.test(quote.minOutAmount)) throw new Error("The preview does not match this trade. Preview again.");
    const lifetime = Math.min(SOLANA_QUOTE_MAX_AGE_MS, Math.max(0, quote.expiresAtMs - quote.quotedAtMs));
    setPreview({ quote, key, deadline: started + lifetime }); setReceipt(null);
  };
  const placeTrade = async () => {
    const intent = tradeIntent();
    // Only the quote the owner just saw, for exactly this trade: an expired or
    // different preview needs a new one before anything is sent.
    if (!preview || Date.now() >= preview.deadline || preview.key !== request.current?.key) {
      setPreview(null); throw new Error("This quote expired. Preview the trade again to see a current minimum before placing it.");
    }
    const result = await api<{ receipt: Receipt }>("intent", { action: "trade", mode, intent }); setReceipt(result.receipt); await refresh();
  };
  const tokenLabel = (mint: string) => mint === SOLANA_USDG_MINT ? "USDG" : "wrapped SOL";
  /** What the recorded trade itself guaranteed, not the earlier preview. */
  const receiptAmounts = (trade: Receipt): string | null => {
    const out = trade.intent?.outputMint ?? (side === "buy" ? WSOL : SOLANA_USDG_MINT), decimals = out === SOLANA_USDG_MINT ? 6 : 9, label = tokenLabel(out);
    if (trade.mode === "paper" && trade.outputAmountRaw && RAW.test(trade.outputAmountRaw) && trade.quote?.minOutAmount && RAW.test(trade.quote.minOutAmount))
      return `Simulated output: ${display(trade.outputAmountRaw, decimals)} ${label}, against a quoted minimum of ${display(trade.quote.minOutAmount, decimals)} ${label}.`;
    if (trade.mode !== "paper" && trade.minOutAmount && RAW.test(trade.minOutAmount) && trade.quotedOutAmount && RAW.test(trade.quotedOutAmount))
      return `Quoted output: ${display(trade.quotedOutAmount, decimals)} ${label}. Minimum enforced on chain: ${display(trade.minOutAmount, decimals)} ${label}.`;
    return null;
  };
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
  /**
   * Step 1 of registering: the server prepares the permission for a fresh
   * session key, and the page decodes the bytes. Nothing is signed: the owner
   * reviews the limits and the priority fee they encode first (PermissionReview).
   */
  const prepareRegistration = async () => {
    if (!sameWallet || !binding) throw new Error("Connect the Solana wallet bound to this account.");
    // Exactly the saved limits shown in the live card; the server encodes the saved ones.
    const shown = binding.limits, programId = status?.runtime?.live.programId, blocked = registerBlock();
    if (blocked || !shown || !programId) throw new Error(blocked ?? "Wait for the vault program to be verified before registering.");
    discardReview(); setReviewLapsed(false);
    const vault = await deriveSolanaVaultAddress(programId, binding.owner);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    try {
      const sessionPublicKey = base58Encode(ed25519.getPublicKey(seed));
      // Timed on this clock from before the request, so latency only shortens the window.
      const started = Date.now();
      const { setup } = await api<{ setup: PreparedPermission }>("setup", { stage: "prepare", sessionPublicKey });
      // The wallet only opens for bytes that encode what this page showed.
      const terms = checkPreparedPermission(setup, { owner: binding.owner, programId, vault, session: sessionPublicKey }, shown);
      reviewSeed.current = seed;
      setReview({ transactionBase64: setup.transactionBase64, limits: shown, terms, requiredLamports: setup.requiredLamports ?? null, ownerLamports: setup.ownerLamports ?? null,
        deadline: started + REVIEW_SIGN_WINDOW_MS });
    } finally { if (reviewSeed.current !== seed) seed.fill(0); }
  };
  /** Step 2: the owner signs exactly the reviewed bytes, then they are submitted and activated. */
  const signRegistration = async () => {
    const shown = review, seed = reviewSeed.current;
    if (!shown || !seed) throw new Error("Register again to prepare a permission to review.");
    if (Date.now() >= shown.deadline) {
      discardReview(); setReviewLapsed(true);
      throw new Error("This prepared permission was not signed in time, so it was discarded. Nothing was signed. Register again to prepare a new one.");
    }
    // Copied before the wallet opens, so a change of account that ends the
    // review (and zeroes its seed) cannot change the key being registered.
    const secret = base64(seed);
    // While the wallet is open the review timer leaves the review alone: the
    // page never says "nothing was signed" while the owner may be signing.
    // Signed bytes are submitted even if the deadline passed meanwhile: the
    // server's 60-second window decides, and its refusal of a first
    // submission discards them with an accurate message (submitRegistration).
    // A wallet that refuses or closes leaves the review in place to sign
    // again, unless its deadline passed meanwhile: then it lapses now.
    signingReview.current = true;
    let signature: Uint8Array;
    try { signature = await signer.signSetup(fromBase64(shown.transactionBase64)); }
    catch (e) {
      if (Date.now() >= shown.deadline) { discardReview(); setReviewLapsed(true); }
      throw e;
    } finally { signingReview.current = false; }
    const signed = base64(signature);
    const pending = { secret, signedTransactionBase64: signed, signature: signatureOf(signed), sent: false, limits: shown.limits };
    // Keep the bounded session seed and exact signed bytes before submit:
    // a lost response must retry this registration, never create a new one.
    setRegistration(pending); discardReview(); setReviewLapsed(false);
    await submitRegistration(pending);
  };
  /** Retries the signed registration this page holds. */
  const setupLive = async () => {
    if (!sameWallet || !binding) throw new Error("Connect the Solana wallet bound to this account.");
    const pending = registration;
    if (!pending) throw new Error("Register again to prepare a permission to review.");
    if (pending.limits.expiresAtMs <= Date.now()) {
      // The vault refuses to activate an expired permission, so its key can never be used.
      setRegistration(null);
      throw new Error(`This permission expired at ${permissionExpiry(pending.limits.expiresAtMs)} before it was activated, so its session key has been discarded. Register again to sign a new permission.`);
    }
    await submitRegistration(pending);
  };
  const submitRegistration = async (signedRegistration: NonNullable<typeof registration>) => {
    let pending = signedRegistration;
    // Submitting the saved bytes again is idempotent: the server reports the
    // outcome of the transaction it saved. A refusal of the first submission
    // proves the server never saved them, so they and their seed are dropped.
    // A refused retry is decided by the server's record, never assumed to be
    // "not accepted": the bytes may already be broadcast (refusedByServer).
    let submitted: { signature: string; status: string };
    try {
      ({ registration: submitted } = await api<{ registration: { signature: string; status: string } }>("setup", { stage: "submit", signedTransactionBase64: pending.signedTransactionBase64 }));
    } catch (e) {
      if (!refusedByServer(e)) { setRegistration({ ...pending, sent: true }); throw e; }
      if (!pending.sent) {
        setRegistration(null);
        throw new Error(`${e.message} The signed permission was not accepted, so it has been discarded and nothing was activated. Register again to review and sign a new permission.`);
      }
      const outcome = await outcomeAfterRefusal(readRecord, pending.signature);
      if (outcome === "unknown") throw new Error(`${e.message} An earlier submission of this signed permission may already be on Solana, so it and its session key were kept. Finish permission registration again shortly.`);
      if (outcome === "pending") throw new Error(`${e.message} The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept. Finish permission registration again shortly.`);
      if (outcome === "unheld") {
        // Resubmitting can never be checked or sent again; whether an earlier
        // submission landed is the server's status to show, not this page's guess.
        setRegistration(null);
        throw new Error(`${e.message} The server holds no record of this signed permission, so it and its session key were cleared from this page. Refresh to check whether a permission is active, then register again if needed.`);
      }
      submitted = { signature: pending.signature!, status: outcome };
    }
    if (submitted.status === "failed") { setRegistration(null); throw new Error("The permission transaction failed. No session was activated. Register again to sign a new permission."); }
    pending = { ...pending, signature: submitted.signature, sent: true }; setRegistration(pending);
    if (submitted.status !== "finalized") throw new Error("The permission is awaiting final confirmation on Solana. Keep this page open and finish registration in a moment.");
    try { await api("setup", { stage: "activate", signature: pending.signature, sessionSecretKey: pending.secret }); }
    catch (e) {
      if (!refusedByServer(e)) throw e;
      // The server answers activation from its record of this permission and
      // the vault as its RPC sees it, which can lag the finalized permission.
      // The key is dropped only when the server no longer holds the permission.
      const outcome = await outcomeAfterRefusal(readRecord, pending.signature);
      if (outcome === "failed") { setRegistration(null); throw new Error("The permission transaction failed. No session was activated. Register again to sign a new permission."); }
      if (outcome === "unheld") {
        setRegistration(null);
        throw new Error(`${e.message} The server no longer holds this permission, so it cannot be activated and its session key has been discarded. Register again to sign a new permission.`);
      }
      throw new Error(`${e.message} This permission is confirmed on Solana but is not active yet, so its session key was kept. Finish permission registration again shortly.`);
    }
    setRegistration(null); await refresh();
  };
  const liveBook = status?.runtime?.live.book;
  // A vault the server has read, funded or registered: what an owner key backup protects.
  const live = status?.runtime?.live, vaultSeen = !!live && (!!live.balances || !!live.book || !!live.session);
  // The recovery card: a live binding whose vault the server has read, or any
  // binding whose account still has a live book or session (switching back to
  // paper leaves the vault and its funds). Never paper-only (a paper binding
  // whose vault balances were read but that has no book or session gets no
  // card), never before the status has loaded. Showing it for a paper binding
  // with a live book or session is an owner decision; the stricter
  // alternative hides it for every paper binding.
  const recoveryVault = !!binding && !!live?.vault && !!live.programId && (binding.requestedMode === "live" ? vaultSeen : !!live.book || !!live.session);
  // Off by default; only the bound owner of a vault the server has read.
  const recoveryCard = ownerKeyExportEnabled() && sameWallet && recoveryVault && signer.address && live?.programId && live.vault
    ? { owner: signer.address, programId: live.programId, vault: live.vault } : null;
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
        {!!status?.runtime?.live.blockers.length && <ul aria-label="What stops live trading">{status.runtime.live.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        {!!live?.warnings?.length && <ul role="status" aria-label="Warnings" className="solana-warning">{live.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {live?.feePayer && Object.hasOwn(FEE_PAYER_LEVELS, live.feePayer.level) && <p>Shared network fee payer: {FEE_PAYER_LEVELS[live.feePayer.level]}{displaySolanaAmountOrNull(live.feePayer.lamports, 9) !== null && ` (${displaySolanaAmountOrNull(live.feePayer.lamports, 9)} SOL)`}. Merrymen pays your trades&apos; network fees from it; your owner wallet pays only for owner transactions.</p>}
        {status?.runtime?.live.vault && <p>Vault: <span className="solana-address">{status.runtime.live.vault}</span>{status.runtime.live.programId && <> · Program: <span className="solana-address">{status.runtime.live.programId}</span></>}</p>}
        {status?.runtime?.live.cashTokenAccount && (status.runtime.live.ready || status.runtime.live.canExit) && <div><h3>Fund the Solana vault</h3><p>Send USDG on Solana to this verified USDG token account:</p><p className="solana-address">{status.runtime.live.cashTokenAccount}</p><p>Deposit USDG only. Direct wrapped SOL deposits have no recorded cost basis and cannot be traded by this session.</p></div>}
        {status?.runtime?.live.balances && <><p className="solana-value">{display(status.runtime.live.balances.cashUsdg)} USDG</p><p>{display(status.runtime.live.balances.wsolRaw, 9)} wrapped SOL · observed at slot {status.runtime.live.balances.slot}</p></>}
        {liveBook && <p>Recorded realized P&amp;L: {display(liveBook.realizedPnlUsdgRaw)} USDG. Network fees: {display(liveBook.networkFeesLamports, 9)} SOL.</p>}
        {liveBook?.quarantinedWsolRaw && liveBook.quarantinedWsolRaw !== "0" && <p role="status">{display(liveBook.quarantinedWsolRaw, 9)} wrapped SOL arrived outside your recorded trades. It is held aside: never traded, never counted in performance, and you can withdraw it.</p>}
        {liveBook && (liveBook.unresolvedFeeCount ?? 0) > 0 && <p role="status">Network fees are incomplete for {liveBook.unresolvedFeeCount} expired submission(s). Their swaps are proven not executed; the recorded fee total excludes unknown fees. Reserved fee allowance: {display(liveBook.reservedUnknownFeeLamports ?? "0", 9)} SOL.</p>}
        {status?.runtime?.live.ownerTransaction && <p>Owner transaction: {status.runtime.live.ownerTransaction.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(status.runtime.live.ownerTransaction.signature)}`}>View owner transaction</a></p>}
        {!!status?.runtime?.live.pending.length && <p role="status">{status.runtime.live.pending.length} trade(s) awaiting final confirmation. Refresh to reconcile the saved request.</p>}
        {!!status?.runtime?.live.history?.length && <details><summary>Recent live requests</summary><ul>{status.runtime.live.history.slice(0, 20).map((trade) => <li key={trade.requestId}>{trade.requestId}: {trade.status}{trade.signature && <> · <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`}>Transaction</a></>}</li>)}</ul></details>}
        <p>The initial live market is USDG ↔ wrapped SOL. Deposit only after the program and vault have been verified.</p>
        {registration ? <PermissionTerms heading="The permission you signed" limits={registration.limits} />
          : review ? <PermissionReview limits={review.limits} terms={review.terms} requiredLamports={review.requiredLamports} ownerLamports={review.ownerLamports}
            secondsLeft={Math.max(1, Math.round((review.deadline - Date.now()) / 1000))} />
          : binding.limits && <PermissionTerms heading="Your wallet will be asked to sign these saved limits" limits={binding.limits} />}
        {registration && <p>Keep this page open while finalization completes. Retry activation with the existing registration.</p>}
        {!registration && !review && reviewLapsed && <p role="status">The prepared permission was not signed in time, so it was discarded. Nothing was signed. Register again to prepare a new one.</p>}
        {!registration && binding.limits && registerBlock() && <p role="status">{registerBlock()}</p>}
        {!registration && review ? <>
          <button disabled={busy || !sameWallet || !!registerBlock()} onClick={() => void act(signRegistration)}>Sign permission with my wallet</button>
          <button className="solana-secondary" disabled={busy} onClick={discardReview}>Discard prepared permission</button></>
          : <button disabled={busy || !sameWallet || !binding.limits || !status?.runtime?.live.programId || (!registration && !!registerBlock())} onClick={() => void act(registration ? setupLive : prepareRegistration)}>{registration ? "Finish permission registration" : "Register bounded trading permission"}</button>}
      </div>}
      <form className="solana-card" onSubmit={(event) => { event.preventDefault(); void act(previewTrade); }}><h2>USDG ↔ wrapped SOL</h2>
        <label>Direction<select disabled={busy} value={side} onChange={(e) => { setSide(e.target.value as "buy" | "sell"); invalidate(); }}><option value="buy">Buy wrapped SOL</option><option value="sell">Sell wrapped SOL</option></select></label>
        <label>{side === "buy" ? "USDG to spend" : "Wrapped SOL to sell"}<input disabled={busy} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); invalidate(); }} /></label>
        <p>Slippage limit: 0.5%. Saved mode: {binding.requestedMode}.</p>
        <button disabled={busy || !!receipt || mode !== binding.requestedMode || !binding.limits || (mode === "live" && !(side === "sell" ? status?.runtime?.live.canExit : status?.runtime?.live.ready))}>Preview trade</button>
        {preview && (receipt || quoteFresh ? <><p>Minimum received: {display(preview.quote.minOutAmount, preview.quote.outputMint === SOLANA_USDG_MINT ? 6 : 9)} {tokenLabel(preview.quote.outputMint)}.</p>
          {!receipt && <p>This quote is valid for about {Math.max(1, Math.round((preview.deadline - Date.now()) / 1000))} seconds. The trade is quoted again when placed, with the same 0.5% slippage limit; the receipt shows the minimum actually enforced.</p>}
          <button type="button" disabled={busy || !!receipt || !quoteFresh || mode !== binding.requestedMode} onClick={() => void act(placeTrade)}>{mode === "paper" ? "Simulate trade" : "Place live trade"}</button></>
          : <p role="status">This quote expired. Preview again to see a current minimum before trading.</p>)}
        {receipt && <p role="status">{receipt.mode === "paper" ? "Simulated trade recorded." : `Live request recorded${receipt.status ? `: ${receipt.status}` : ""}.`} {receipt.signature && <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(receipt.signature)}`}>View transaction</a>}</p>}
        {receipt && receiptAmounts(receipt) && <p>{receiptAmounts(receipt)}</p>}
        {receipt && <button type="button" className="solana-secondary" disabled={busy} onClick={invalidate}>Start a new trade</button>}
      </form>
      <SolanaAutomation key={`strategy-${signer.did}`} binding={binding} api={api} refresh={refresh} workerOnline={status?.runtime?.automation?.workerOnline ?? false} />
      <SolanaOwnerActions key={`owner-${signer.did}`} available={sameWallet && !!status?.runtime?.live.programId} owner={sameWallet ? binding.owner : null} programId={live?.programId ?? null}
        api={api} sign={signer.signSetup} refresh={refresh} readRecord={readRecord}
        serverTransaction={live?.ownerTransaction ?? null} ownerWallet={live?.ownerWallet ?? null} recoverable={live?.recoverable ?? null}
        confirmationUnavailable={!!live?.blockers.includes(OWNER_CONFIRMATION_UNAVAILABLE)}
        recovery={recoveryCard ? (releasedProgramSha256(recoveryCard.programId) ? "send" : "plan") : null} />
      {recoveryCard && <SolanaRecovery key={`recovery-${signer.did}`} owner={recoveryCard.owner}
        programId={recoveryCard.programId} vault={recoveryCard.vault} exportKey={signer.exportKey} />}
    </>}
  </>;
}
