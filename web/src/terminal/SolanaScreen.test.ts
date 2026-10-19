import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, test, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction } from "@solana/kit";
import { base58Encode, CHAINS, SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import { buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, deriveSolanaVaultAddress, SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../../packages/core/src/solana-live";
import { JSDOM } from "jsdom";

const OWNER = "So11111111111111111111111111111111111111112";
const TENANT = `0x${"11".repeat(20)}`;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const paper = { cashRaw: "1000000000", positions: [] };
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
/** Saved live limits: 10 USDG a trade, 50 a day, 0.25/1 SOL sold, 7 days. */
const liveLimits = () => ({ ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000", expiresAtMs: Date.now() + 168 * 3_600_000 });
/** The registration the server prepares from the saved limits, as real wire bytes. */
async function permissionTransaction(session: string, signed: ReturnType<typeof liveLimits>, extra: Instruction[] = []) {
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER);
  const instructions = [buildInitializeSolanaVaultInstruction({ programAddress: PROGRAM, vault, owner: OWNER }),
    buildCreateSolanaSessionInstruction({ programAddress: PROGRAM, vault, owner: OWNER, session, perTrade: BigInt(signed.perTradeUsdg), daily: BigInt(signed.dailyUsdg),
      perTradeWsol: BigInt(signed.perTradeWsol), dailyWsol: BigInt(signed.dailyWsol), maxOps: signed.maxOpsPerDay, expiresAt: BigInt(Math.floor(signed.expiresAtMs / 1000)) }), ...extra];
  const message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address("11111111111111111111111111111111") as unknown as Blockhash, lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(address(OWNER), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 }))));
  return { transactionBase64: getBase64EncodedWireTransaction(compileTransaction(message)), vault, programId: PROGRAM, session, expiresAtMs: Date.now() + 60_000 };
}
/** Types into the input whose label starts with `label`, the way a person does. */
async function type(label: string, value: string) {
  const input = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
}
/** Clicks, then lets work outside React's microtasks (WebCrypto for the vault address) finish. */
async function press(text: string) {
  await ui.click(text);
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
}
const field = (label: string) => [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("input")!.value;
let SolanaScreen: typeof import("./SolanaScreen").SolanaScreen;
let testDom: typeof import("./test-dom").testDom, json: typeof import("./test-dom").json, deferred: typeof import("./test-dom").deferred;
let ui: ReturnType<typeof testDom>;
let state: ReturnType<typeof initial>;
let calls: Array<{ path: string; body: Record<string, unknown> | undefined }>;
let signCount: number;
let signerDid = "did:privy:alice";
let respond: (path: string, body: Record<string, unknown> | undefined) => Promise<Response>;
const originalFetch = globalThis.fetch;
function initial(mode: "paper" | "live" = "paper") {
  return { binding: { tenant: TENANT, owner: OWNER, did: signerDid, chain: CHAINS.solana, requestedMode: mode, limits, revision: 0, createdAtMs: 1, updatedAtMs: 1 },
    runtime: { owner: OWNER, requestedMode: mode, paper: null as typeof paper | null, limits,
      live: { ready: false, blockers: ["Deploy and verify the vault program before enabling live trading."], programId: null as string | null, vault: null, session: null, pending: [] } } };
}
before(async () => {
  // React DOM checks input-event support when it first loads. Supply a DOM
  // before importing the harness so typing exercises real React onChange.
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  Object.assign(globalThis as Record<string, unknown>, { window: boot.window, document: boot.window.document });
  ({ testDom, json, deferred } = await import("./test-dom"));
  const path = fileURLToPath(new URL("./SolanaScreen.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const intercept = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === path) {
      if (id === "./SolanaScreen.css") return {};
      if (id === "@/lib/privy-client") return { privyEnabled: () => true };
      if (id === "./HostedControls") return { SignIn: () => React.createElement("p", null, "Sign in") };
      if (id === "./useSolanaOwner") return { useSolanaOwner: () => ({
        ready: true, authenticated: true, did: signerDid, address: OWNER, ambiguous: false,
        getAccessToken: async () => "fixture-token", create: async () => {}, signBinding: async () => "fixture-signature",
        signSetup: async () => { signCount++; return Uint8Array.from([1, 2, 3]); },
      }) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { SolanaScreen = createRequire(import.meta.url)(path).SolanaScreen; }
  finally { intercept.mock.restore(); }
});
beforeEach(() => {
  ui = testDom(); signerDid = "did:privy:alice"; state = initial(); calls = []; signCount = 0;
  respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    const path = String(url).replace("/api/solana/", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body }); return respond(path, body);
  };
});
afterEach(async () => { globalThis.fetch = originalFetch; await ui.close(); });
const render = () => ui.render(React.createElement(SolanaScreen));
const button = (text: string) => [...ui.container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;

test("saved live consent cannot masquerade as active trading before program registration", async () => {
  state = initial("live"); await render();
  assert.match(ui.container.textContent!, /Live trading is not active yet/);
  assert.match(ui.container.textContent!, /Deploy and verify the vault program/);
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.equal(button("Preview trade").disabled, true);
  assert.equal(signCount, 0); assert.equal(calls.some((call) => call.path === "setup"), false);
});

test("paper creation uses exact raw USDG and never sends a browser-declared owner", async () => {
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "paper") { assert.deepEqual(body, { initialCashRaw: "1000000000" }); state.runtime.paper = paper; return json({ paper }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Create paper portfolio");
  assert.match(ui.container.textContent!, /1000 USDG/);
  assert.equal(signCount, 0);
});

test("an uncertain paper response retries the same request ID instead of creating a second fill", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: {
      source: "jupiter", inputMint: SOLANA_USDG_MINT, outputMint: OWNER, inAmount: "1000000", outAmount: "10000000", minOutAmount: "9950000", slippageBps: 50, contextSlot: 1, quotedAtMs: Date.now(), expiresAtMs: Date.now() + 20000,
    } } });
    if (path === "intent" && body?.action === "trade") {
      trades.push(body); if (trades.length === 1) throw new Error("Lost response after commit");
      return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade"); await ui.click("Simulate trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 2); assert.deepEqual(trades[0], trades[1]);
  assert.equal("owner" in trades[0]!, false); assert.equal("tenant" in trades[0]!, false);
  assert.match(ui.container.textContent!, /Simulated trade recorded/);
  assert.equal(button("Simulate trade").disabled, true);
  await ui.click("Start a new trade"); await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 3);
  assert.notEqual((trades[2]!.intent as { requestId: string }).requestId, (trades[0]!.intent as { requestId: string }).requestId);
});

test("registration retries the same signed bytes and bounded seed after an unknown submit outcome", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "";
  const submissions: unknown[] = [];
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") {
      sessionPublicKey = String(body.sessionPublicKey);
      return json({ setup: await permissionTransaction(sessionPublicKey, saved) });
    }
    if (path === "setup" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown submit outcome");
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; state.runtime.live.ready = true; return json({ live: { ready: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.equal(signCount, 1); assert.equal(activation, undefined);
  await press("Finish permission registration");
  assert.equal(signCount, 1); assert.deepEqual(submissions, ["AQID", "AQID"]);
  assert.ok(activation);
  const seed = Buffer.from(String((activation as Record<string, unknown>).sessionSecretKey), "base64");
  assert.equal(seed.length, 32); assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
  assert.equal(ui.dom.window.localStorage.length, 0);
});

test("a delayed response from the previous identity never populates a new account view", async () => {
  const old = deferred<Response>();
  let reads = 0;
  respond = async () => ++reads === 1 ? old.promise : json({ binding: null, runtime: null });
  await render();
  signerDid = "did:privy:bob"; await render();
  await act(async () => { old.resolve(json(state)); });
  assert.ok(!ui.container.textContent!.includes("Solana trading mode"));
  assert.match(ui.container.textContent!, /Verify Solana wallet/);
});

test("owner recovery stays available in paper mode and retries exact signed bytes", async () => {
  state.runtime.live.programId = OWNER;
  const submissions: unknown[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "revoke" });
      return json({ prepared: { transactionBase64: "AQID" } });
    }
    if (path === "owner" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown owner submission");
      return json({ result: { signature: "owner-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Revoke all Solana sessions");
  assert.equal(signCount, 1);
  await ui.click("Check existing owner transaction");
  assert.equal(signCount, 1); assert.deepEqual(submissions, ["AQID", "AQID"]);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
});

test("autonomous strategy is disabled by default and saves explicit bounded settings", async () => {
  let saved: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "strategy") { saved = body; return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.match(ui.container.textContent!, /Autonomous trading is disabled/);
  await ui.click("Save autonomous strategy");
  assert.deepEqual(saved, { revision: 0, strategy: { enabled: false, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 } });
  assert.equal(signCount, 0);
});
test("resuming buys requires a separate owner signature without changing trading limits", async () => {
  state.runtime.live.programId = OWNER;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "resume-buys" });
      return json({ prepared: { transactionBase64: "AQID" } });
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "resume-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Ask wallet to resume buys");
  assert.equal(signCount, 1);
  assert.equal(calls.some((call) => call.path === "settings"), false);
  assert.match(ui.container.textContent!, /drawdown still exceeds your limit/);
});

test("enabled automation reports a missing worker separately from saved consent", async () => {
  Object.assign(state.binding, { strategy: { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 } });
  Object.assign(state.runtime, { automation: { workerOnline: false, lastSeenAtMs: null } });
  await render();
  assert.match(ui.container.textContent!, /Waiting for Solana worker/);
  assert.ok(!ui.container.textContent!.includes("Solana worker connected"));
  Object.assign(state.runtime, { automation: { workerOnline: true, lastSeenAtMs: Date.now() } });
  await ui.click("Refresh account");
  assert.match(ui.container.textContent!, /Solana worker connected/);
  assert.ok(!ui.container.textContent!.includes("Waiting for Solana worker"));
});

test("unknown fees from proven expired submissions are not presented as zero fees", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "0", unresolvedFeeCount: 1, reservedUnknownFeeLamports: "10000" } });
  await render();
  assert.match(ui.container.textContent!, /Network fees are incomplete for 1 expired submission/);
  assert.match(ui.container.textContent!, /recorded fee total excludes unknown fees/);
  assert.match(ui.container.textContent!, /Reserved fee allowance: 0\.00001 SOL/);
});

test("live buying breaker leaves authenticated exits available and displays actual accounting", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { canExit: true, balances: { slot: 123, cashUsdg: "123456789", wsolRaw: "1200000000" },
    book: { realizedPnlUsdgRaw: "-1500001", networkFeesLamports: "5000" } });
  state.runtime.live.blockers = ["The on-chain buying breaker is paused; exits remain available."];
  await render();
  assert.equal(button("Preview trade").disabled, true);
  const direction = ui.container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { direction.value = "sell"; direction.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  assert.equal(button("Preview trade").disabled, false);
  assert.match(ui.container.textContent!, /123\.456789 USDG/); assert.match(ui.container.textContent!, /1\.2 wrapped SOL/);
  assert.match(ui.container.textContent!, /-1\.500001 USDG/); assert.match(ui.container.textContent!, /0\.000005 SOL/);
});

test("live limits carry the owner's SOL sell bounds in lamports; paper limits do not", async () => {
  state = initial("live");
  state.binding.limits = { ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000" } as typeof limits;
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.match(ui.container.textContent!, /Sales are limited to 0\.25 SOL per trade and 1 SOL per 24 hours/);
  const consent = ui.container.querySelector("input[type=checkbox]") as HTMLInputElement;
  await act(async () => { consent.click(); });
  await ui.click("Save Solana mode and limits");
  const live = saved[0]!.limits as Record<string, unknown>;
  assert.equal(live.perTradeWsol, "250000000"); assert.equal(live.dailyWsol, "1000000000");
  state = initial("paper");
  await ui.click("Refresh account");
  const paperRadio = [...ui.container.querySelectorAll("input[type=radio]")][0] as HTMLInputElement;
  await act(async () => { paperRadio.click(); });
  await ui.click("Save Solana mode and limits");
  assert.equal("perTradeWsol" in (saved[1]!.limits as Record<string, unknown>), false);
  assert.equal(signCount, 0);
});

test("wrapped SOL sent by someone else is shown held aside, not as trading performance", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { canExit: true, balances: { slot: 9, cashUsdg: "90000000", wsolRaw: "50000001" },
    book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "10000", quarantinedWsolRaw: "1" } });
  await render();
  assert.match(ui.container.textContent!, /0\.000000001 wrapped SOL arrived outside your recorded trades\. It is held aside/);
});

test("the live card shows the saved limits and signed expiry, and unsaved edits block registration", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    throw new Error("Unexpected fixture route");
  };
  await render();
  const text = () => ui.container.textContent!;
  // The duration is the saved one, not a 24-hour default; the expiry is the instant signed on chain.
  assert.equal(field("Permission duration"), "168");
  assert.match(text(), /Your wallet will be asked to sign these saved limits/);
  assert.match(text(), /10 USDG per trade and 50 USDG per 24 hours/);
  assert.match(text(), /0\.25 SOL sold per trade and 1 SOL sold per 24 hours/);
  assert.ok(text().includes(`Expires ${new Date(Math.floor(saved.expiresAtMs / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`));
  assert.equal(button("Register bounded trading permission").disabled, false);
  // Lower the per-trade limit without saving: the page must not offer to sign the old 10 USDG.
  await type("USDG per trade", "1");
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.match(text(), /The form has unsaved changes/);
  assert.match(text(), /10 USDG per trade/);
  await type("USDG per trade", "10");
  await type("Permission duration", "24");
  assert.equal(button("Register bounded trading permission").disabled, true);
  await type("Permission duration", "168");
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 0); assert.equal(calls.some((call) => call.path === "setup"), false);
});

test("a prepared permission that encodes anything but the shown limits never reaches the wallet", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let prepared: (session: string) => Promise<unknown> = async (session) => permissionTransaction(session, { ...saved, perTradeUsdg: "20000000", dailyUsdg: "60000000" });
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await prepared(String(body.sessionPublicKey)) });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /does not match the saved limits shown on this page\. Nothing was signed/);
  // A different expiry, or an extra instruction (an owner SOL transfer), is refused the same way.
  prepared = async (session) => permissionTransaction(session, { ...saved, expiresAtMs: saved.expiresAtMs + 3_600_000 });
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /does not match the saved limits shown on this page\. Nothing was signed/);
  const transfer: Instruction = { programAddress: address("11111111111111111111111111111111"), data: Uint8Array.of(2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0),
    accounts: [{ address: address(OWNER), role: 3 }, { address: address(base58Encode(new Uint8Array(32).fill(9))), role: 1 }] };
  prepared = async (session) => permissionTransaction(session, saved, [transfer]);
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /The prepared permission does not match what this page shows\. Nothing was signed/);
  assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 0);
});

const refusal = (error: string, status = 409) => json({ error, ownerFacing: true }, status);
test("a refused owner submission discards the stale signed bytes and leaves Revoke usable", async () => {
  state.runtime.live.programId = OWNER;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return json({ prepared: { transactionBase64: "AQID" } });
    if (path === "owner" && body?.stage === "submit") {
      const prepared = calls.filter((call) => call.path === "owner" && call.body?.stage === "prepare");
      if (prepared.at(-1)!.body!.action === "withdraw") return refusal("The prepared owner transaction expired before submission.");
      return json({ result: { signature: "revoke-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Withdraw to my wallet");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. This signed withdrawal was not accepted and has been discarded/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, false);
  await ui.click("Revoke all Solana sessions");
  assert.equal(signCount, 2);
  const owner = calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit");
  assert.deepEqual(owner, ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
});

test("an unknown withdrawal outcome keeps its bytes for checking but never holds back Revoke", async () => {
  state.runtime.live.programId = OWNER;
  let lost = true;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return json({ prepared: { transactionBase64: "AQID" } });
    if (path === "owner" && body?.stage === "submit") {
      if (lost) { lost = false; throw new Error("Lost response"); }
      return json({ result: { signature: "revoke-proof", status: "pending" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Withdraw to my wallet");
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
  assert.equal(button("Ask wallet to resume buys").disabled, true);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  await ui.click("Revoke all Solana sessions");
  // A fresh revocation was prepared and signed; the withdrawal bytes were not resent as a revoke.
  assert.equal(signCount, 2);
  assert.deepEqual(calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit"),
    ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  assert.match(ui.container.textContent!, /A signed revocation has no confirmed outcome yet/);
});

test("a refused permission submit discards the signed bytes and the next click prepares a fresh one", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  const sessions: string[] = [];
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessions.push(String(body.sessionPublicKey)); return json({ setup: await permissionTransaction(sessions.at(-1)!, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      if (sessions.length === 1) return refusal("The prepared owner transaction expired before submission.");
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. The signed permission was not accepted, so it has been discarded/);
  // Not "Finish permission registration": retrying the refused bytes could never succeed.
  await press("Register bounded trading permission");
  assert.equal(signCount, 2); assert.equal(sessions.length, 2);
  assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 2);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessions[1]);
});

test("a registration that later fails on chain is discarded instead of being activated forever", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let outcome = "pending";
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: outcome } });
    if (path === "setup" && body?.stage === "activate") return refusal("The permission transaction failed. Prepare a new permission.");
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  outcome = "failed";
  await press("Finish permission registration");
  assert.match(ui.container.textContent!, /The permission transaction failed\. No session was activated/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 1);
});

test("a confirmed permission that cannot be activated drops its session key instead of retrying", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    if (path === "setup" && body?.stage === "activate") return refusal("The current vault permission does not match the signed limits.", 400);
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.match(ui.container.textContent!, /does not match the signed limits\. This permission could not be activated, so its session key has been discarded/);
  assert.equal(button("Register bounded trading permission").disabled, false);
});
