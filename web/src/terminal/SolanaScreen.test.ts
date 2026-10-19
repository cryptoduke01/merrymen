import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, test, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode, CHAINS, SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import { deferred, json, testDom } from "./test-dom";

const OWNER = "So11111111111111111111111111111111111111112";
const TENANT = `0x${"11".repeat(20)}`;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const paper = { cashRaw: "1000000000", positions: [] };
let SolanaScreen: typeof import("./SolanaScreen").SolanaScreen;
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
before(() => {
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
  state = initial("live"); state.runtime.live.programId = OWNER;
  let sessionPublicKey = "";
  const submissions: unknown[] = [];
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") {
      sessionPublicKey = String(body.sessionPublicKey);
      return json({ setup: { transactionBase64: "AQID", session: sessionPublicKey, vault: OWNER, programId: OWNER, expiresAtMs: limits.expiresAtMs } });
    }
    if (path === "setup" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown submit outcome");
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; state.runtime.live.ready = true; return json({ live: { ready: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Register bounded trading permission");
  assert.equal(signCount, 1); assert.equal(activation, undefined);
  await ui.click("Finish permission registration");
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
