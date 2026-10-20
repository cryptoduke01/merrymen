import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, test, mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction } from "@solana/kit";
import { base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import { buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, buildRevokeSolanaSessionsInstruction, buildSetSolanaBreakerInstruction,
  buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction, deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../../packages/core/src/solana-live";
import { JSDOM } from "jsdom";
import { runSolanaRecoverCommand } from "../../../worker/src/solana-recover-command";
import { SOLANA_VAULT_RELEASES as TOOL_RELEASES, solanaRecoveryProgramTrust } from "../../../worker/src/solana-recover";

const OWNER = "So11111111111111111111111111111111111111112";
const TENANT = `0x${"11".repeat(20)}`;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const paper = { cashRaw: "1000000000", positions: [] };
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
/** Saved live limits: 10 USDG a trade, 50 a day, 0.25/1 SOL sold, 7 days. */
const liveLimits = () => ({ ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000", expiresAtMs: Date.now() + 168 * 3_600_000 });
/** CreateIdempotent for `wallet`'s token account of `mint`, paid by the owner, as prepareLive builds it. */
async function createAta(wallet: string, mint: string): Promise<Instruction> {
  const program = mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(1), accounts: [
    { address: address(OWNER), role: 3 }, { address: address(await deriveSolanaAta(wallet, mint, program)), role: 1 }, { address: address(wallet), role: 0 },
    { address: address(mint), role: 0 }, { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(program), role: 0 }] };
}
/** The registration the server prepares from the saved limits, as real wire bytes (the real builder's are in SolanaServerContract.test.ts). */
async function permissionTransaction(session: string, signed: ReturnType<typeof liveLimits>, extra: Instruction[] = []) {
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER);
  const instructions = [buildInitializeSolanaVaultInstruction({ programAddress: PROGRAM, vault, owner: OWNER }),
    await createAta(vault, SOLANA_USDG_MINT), await createAta(vault, SOLANA_WRAPPED_SOL_MINT), await createAta(OWNER, SOLANA_USDG_MINT), await createAta(OWNER, SOLANA_WRAPPED_SOL_MINT),
    buildCreateSolanaSessionInstruction({ programAddress: PROGRAM, vault, owner: OWNER, session, perTrade: BigInt(signed.perTradeUsdg), daily: BigInt(signed.dailyUsdg),
      perTradeWsol: BigInt(signed.perTradeWsol), dailyWsol: BigInt(signed.dailyWsol), maxOps: signed.maxOpsPerDay, expiresAt: BigInt(Math.floor(signed.expiresAtMs / 1000)) }), ...extra];
  return { transactionBase64: ownerPaid(instructions), vault, programId: PROGRAM, session, expiresAtMs: Date.now() + 60_000 };
}
/** A v0 transaction the owner pays for, as wire bytes. */
function ownerPaid(instructions: Instruction[]): string {
  const message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address("11111111111111111111111111111111") as unknown as Blockhash, lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(address(OWNER), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 }))));
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
/**
 * The owner transaction the runtime prepares for an owner route `body`, as
 * real wire bytes for OWNER's vault of the status's program, after `before`
 * (a priority fee, say). SolanaServerContract.test.ts runs the server's own
 * through the same page check.
 */
async function ownerBytes(body: Record<string, unknown> | undefined, before: Instruction[] = []): Promise<string> {
  const programAddress = state.runtime.live.programId!, vault = await deriveSolanaVaultAddress(programAddress, OWNER), amount = () => BigInt(String(body!.amountRaw));
  let instructions: Instruction[];
  if (body?.action === "revoke") instructions = [buildRevokeSolanaSessionsInstruction({ programAddress, vault, owner: OWNER })];
  else if (body?.action === "resume-buys") instructions = [buildSetSolanaBreakerInstruction({ programAddress, vault, authority: OWNER, paused: false })];
  else if (body?.action === "withdraw-sol") instructions = [buildWithdrawSolanaNativeInstruction({ programAddress, vault, owner: OWNER, amount: amount() })];
  else if (body?.action === "withdraw") {
    const mint = String(body.mint), tokenProgram = mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
    instructions = [await createAta(OWNER, mint), buildWithdrawSolanaVaultInstruction({ programAddress, vault, owner: OWNER, mint, tokenProgram,
      vaultToken: await deriveSolanaAta(vault, mint, tokenProgram), ownerToken: await deriveSolanaAta(OWNER, mint, tokenProgram), amount: amount() })];
  } else throw new Error("Unexpected owner action");
  return ownerPaid([...before, ...instructions]);
}
/** The owner route's prepare answer for `body`, with real bytes. */
const prepareAnswer = async (body: Record<string, unknown> | undefined) => json({ prepared: { transactionBase64: await ownerBytes(body) } });
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
/** Registers in the page's two steps: prepare and review, then sign with the wallet. */
async function register() {
  await press("Register bounded trading permission");
  if ([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet")) await press("Sign permission with my wallet");
}
const field = (label: string) => [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("input")!.value;
let SolanaScreen: typeof import("./SolanaScreen").SolanaScreen;
const recoveryPath = fileURLToPath(new URL("./SolanaRecovery.tsx", import.meta.url));
let testDom: typeof import("./test-dom").testDom, json: typeof import("./test-dom").json, deferred: typeof import("./test-dom").deferred;
let ui: ReturnType<typeof testDom>;
let state: ReturnType<typeof initial>;
let calls: Array<{ path: string; body: Record<string, unknown> | undefined }>;
let signCount: number, exportCount = 0;
/** What the fixture wallet returns for a signature request (a promise: the wallet stays open until it settles). */
let signedBytes: () => Uint8Array | Promise<Uint8Array>;
let signerDid = "did:privy:alice";
/** The release pin SolanaRecovery reads (SOLANA_VAULT_RELEASES); undefined reads the real one. */
let releases: Array<{ programId: string; sha256: string }> | undefined;
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
    // The recovery card's release pin, as a test sets it.
    if (parent?.filename === recoveryPath && id === "../../../packages/core/src/solana-live") {
      const real = original.call(this, id, parent, isMain) as Record<string, unknown>;
      const pinned = { ...real };
      Object.defineProperty(pinned, "SOLANA_VAULT_RELEASES", { enumerable: true, get: () => releases ?? Reflect.get(real, "SOLANA_VAULT_RELEASES") });
      return pinned;
    }
    if (parent?.filename === path) {
      if (id === "./SolanaScreen.css") return {};
      if (id === "@/lib/privy-client") return { privyEnabled: () => true };
      if (id === "./HostedControls") return { SignIn: () => React.createElement("p", null, "Sign in") };
      if (id === "./useSolanaOwner") return { useSolanaOwner: () => ({
        ready: true, authenticated: true, did: signerDid, address: OWNER, ambiguous: false,
        getAccessToken: async () => "fixture-token", create: async () => {}, signBinding: async () => "fixture-signature",
        signSetup: async () => { signCount++; return signedBytes(); },
        exportKey: async () => { exportCount++; },
      }) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { SolanaScreen = createRequire(import.meta.url)(path).SolanaScreen; }
  finally { intercept.mock.restore(); }
});
beforeEach(() => {
  ui = testDom(); signerDid = "did:privy:alice"; state = initial(); calls = []; signCount = 0; exportCount = 0; signedBytes = () => Uint8Array.from([1, 2, 3]); releases = undefined;
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
  await render(); await register();
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
  state.runtime.live.programId = PROGRAM;
  const submissions: unknown[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "revoke" });
      return prepareAnswer(body);
    }
    if (path === "owner" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown owner submission");
      return json({ result: { signature: "owner-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Revoke all Solana sessions");
  assert.equal(signCount, 1);
  await press("Check existing owner transaction");
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
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "resume-buys" });
      return prepareAnswer(body);
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "resume-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Ask wallet to resume buys");
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
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      const prepared = calls.filter((call) => call.path === "owner" && call.body?.stage === "prepare");
      if (prepared.at(-1)!.body!.action === "withdraw") return refusal("The prepared owner transaction expired before submission.");
      return json({ result: { signature: "revoke-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. This signed withdrawal was not accepted and has been discarded/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, false);
  await press("Revoke all Solana sessions");
  assert.equal(signCount, 2);
  const owner = calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit");
  assert.deepEqual(owner, ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
});

/** The owner route's prepare, as prepareOwner answers it: nothing new while a saved owner transaction is pending (pinned in SolanaServerContract.test.ts). */
const ownerPrepare = (body: Record<string, unknown> | undefined) => (state.runtime.live as { ownerTransaction?: { status: string } | null }).ownerTransaction?.status === "pending"
  ? refusal("Refresh the pending owner transaction before preparing another.") : prepareAnswer(body);
const ownerTransaction = (signature: string, status: string, kind: string) => Object.assign(state.runtime.live, { ownerTransaction: { signature, status, kind } });
test("withdrawal bytes the server never saved do not hold back Revoke: the revocation replaces them", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") {
      // The withdrawal's submission never reached the server; the revocation's is saved and broadcast.
      if (ownerCalls().filter((call) => call === "submit").length === 1) throw new Error("Lost response");
      ownerTransaction("revoke-sig", "pending", "revoke");
      return json({ result: { signature: "revoke-sig", status: "pending" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
  assert.equal(button("Ask wallet to resume buys").disabled, true);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(ui.container.textContent!, /Revoking stays available: if the server never saved this withdrawal, a revocation replaces it and it can no longer be sent; if the server saved it, a revocation can be prepared once it is final or expired/);
  await press("Revoke all Solana sessions");
  // A fresh revocation was prepared and signed; the withdrawal bytes were not resent as a revoke.
  assert.equal(signCount, 2);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  // Now the server holds the revocation: nothing else, another revocation included, until it resolves.
  assert.match(ui.container.textContent!, /A signed revocation is awaiting final confirmation on Solana\. Until it is final or expired, no other owner transaction can be prepared, a revocation included/);
  assert.equal(button("Revoke all Solana sessions").disabled, true);
});

test("signed bytes the server never saved, next to a different pending server record, never promise that Revoke is available", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    // The withdrawal's submission never reaches the server.
    if (path === "owner" && body?.stage === "submit") throw new Error("Lost response");
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Revoking stays available/);
  // Another device's resume request is saved and pending on the server: Revoke waits for it, and the page says so.
  ownerTransaction("other-device-sig", "pending", "resume-buys");
  await ui.click("Refresh account");
  const text = ui.container.textContent!;
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  assert.doesNotMatch(text, /Revoking stays available/);
  assert.match(text, /Your request to resume buys is awaiting final confirmation on Solana/);
  assert.match(text, /A signed withdrawal has no confirmed outcome yet\. Check it before signing another withdrawal or resume request\. Revoking waits for the server's pending request to resume buys above: it can be prepared once that is final or expired\./);
  assert.equal(button("Check existing owner transaction").disabled, false);
  // Once that record resolves, Revoke is available again, and the page says so.
  ownerTransaction("other-device-sig", "finalized", "resume-buys");
  await ui.click("Refresh account");
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(ui.container.textContent!, /Revoking stays available/);
});

test("while the server holds a submitted owner transaction, every owner action waits for it, Revoke included, and says so", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") {
      const withdrawal = ownerCalls().filter((call) => call.startsWith("prepare:")).at(-1) === "prepare:withdraw";
      if (!withdrawal) return json({ result: { signature: "revoke-sig", status: "finalized" } });
      const record = (state.runtime.live as { ownerTransaction?: { status: string } | null }).ownerTransaction;
      if (!record) ownerTransaction("withdraw-sig", "pending", "withdraw");
      return json({ result: { signature: "withdraw-sig", status: record?.status ?? "pending" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  const text = () => ui.container.textContent!;
  assert.match(text(), /A signed withdrawal is awaiting final confirmation on Solana\. Until it is final or expired, no other owner transaction can be prepared, a revocation included/);
  for (const name of ["Revoke all Solana sessions", "Ask wallet to resume buys", "Withdraw to my wallet", "Withdraw native SOL"]) assert.equal(button(name).disabled, true, name);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit"]);
  // It finalizes; the check reads that, and the actions come back.
  ownerTransaction("withdraw-sig", "finalized", "withdraw");
  await press("Check existing owner transaction");
  assert.match(text(), /Owner transaction: finalized/);
  assert.doesNotMatch(text(), /awaiting final confirmation/);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  await press("Revoke all Solana sessions");
  assert.equal(signCount, 2);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit", "prepare:revoke", "submit"]);
});

test("a Revoke pressed before the page knew of a pending owner transaction is refused before the wallet opens, and the page shows why", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "revoke-sig", status: "pending" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  // Another device submitted a permission registration after this page last read the status.
  ownerTransaction("permission-sig", "pending", "session");
  await press("Revoke all Solana sessions");
  const text = () => ui.container.textContent!;
  assert.equal(signCount, 0, "the wallet never opened");
  assert.match(text(), /Refresh the pending owner transaction before preparing another\./);
  assert.match(text(), /Your trading permission is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction, a revocation included/);
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  // A record this page has no bytes for is checked by reading the server's status.
  ownerTransaction("permission-sig", "failed", "session");
  await ui.click("Check owner transaction");
  assert.doesNotMatch(text(), /awaiting final confirmation on Solana/);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // An unknown kind from the server is named plainly, never looked up on the prototype.
  ownerTransaction("odd-sig", "pending", "constructor");
  await ui.click("Refresh account");
  assert.match(text(), /Your owner transaction is awaiting final confirmation on Solana/);
  assert.deepEqual(ownerCalls(), ["prepare:revoke"]);
});

const ownerCalls = () => calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit");
test("a 4xx on a re-check of accepted withdrawal bytes keeps them and reports the server's record, never 'not accepted'", async () => {
  state.runtime.live.programId = PROGRAM;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      submits++;
      // The server saved and broadcast these bytes; it holds them as pending.
      if (submits === 1) { Object.assign(state.runtime.live, { ownerTransaction: { signature: "withdraw-sig", status: "pending", kind: "withdraw" } }); return json({ result: { signature: "withdraw-sig", status: "pending" } }); }
      // The re-check reaches ownerStatus, which cannot use the RPC's answer.
      if (submits === 2) return refusal("Owner confirmation does not match the saved transaction.", 400);
      // A route-level refusal (Solana's mode changed) after the withdrawal finalized.
      return refusal("Review and save live mode and its limits before registering a trading permission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Owner transaction: pending/);
  await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|discarded/);
  assert.match(text, /does not match the saved transaction\. The server holds this signed withdrawal and still records it as awaiting confirmation, so it was kept\. It may already have completed on Solana/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true, "no second withdrawal while the first may complete");
  // The server's record, not the refusal, settles it.
  (state.runtime.live as { ownerTransaction?: { status: string } }).ownerTransaction!.status = "finalized";
  await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded/);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(signCount, 1);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit", "submit"]);
});

test("a 4xx after an unknown outcome clears bytes the server holds no record of, without claiming they were never sent", async () => {
  state.runtime.live.programId = PROGRAM;
  // Real wire bytes: one owner signature, then a message.
  const signature = new Uint8Array(64).fill(9), wire = Uint8Array.from([1, ...signature, 0x80, 1, 2, 3]);
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      assert.equal(body.signedTransactionBase64, Buffer.from(wire).toString("base64"));
      if (++submits === 1) throw new Error("Lost response");
      return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  signedBytes = () => wire;
  await render(); await press("Withdraw to my wallet");
  assert.equal(button("Withdraw to my wallet").disabled, true);
  await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted/);
  assert.match(text, /expired before submission\. The server holds no record of this signed withdrawal, so it was cleared and cannot be resent/);
  // Its own transaction link, so the owner can see whether an earlier attempt landed.
  const link = [...ui.container.querySelectorAll("a")].find((item) => item.textContent === "Check this withdrawal on Solana")!;
  assert.equal(link.getAttribute("href"), `https://solscan.io/tx/${base58Encode(signature)}`);
  assert.equal(button("Withdraw to my wallet").disabled, false);
  assert.equal(calls.filter((call) => call.path === "status").length, 2, "the server's record was read before clearing");
});

test("a refused retry keeps the signed bytes when the server's record cannot be read", async () => {
  state.runtime.live.programId = PROGRAM;
  let submits = 0, statusUp = true;
  respond = async (path, body) => {
    if (path === "status") return statusUp ? json(state) : json({ error: "Solana is temporarily unavailable.", ownerFacing: true }, 503);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      if (++submits === 1) throw new Error("Lost response");
      statusUp = false; return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet"); await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.match(ui.container.textContent!, /An earlier submission of this signed withdrawal may already be on Solana, so it was kept\. This does not mean it failed/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
});

test("a 404 or a sign-in answer to signed owner bytes is not a refusal: the bytes are kept", async () => {
  state.runtime.live.programId = PROGRAM;
  const answers = [refusal("Solana trading is not available.", 404), refusal("Your sign-in expired.", 401), refusal("Too many requests.", 429), refusal("Your sign-in does not match this Solana account.", 403), refusal("Request timed out.", 408)];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") return answers.shift()!;
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  for (let i = 0; i < 4; i++) {
    assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
    assert.equal(button("Check existing owner transaction").disabled, false);
    await press("Check existing owner transaction");
  }
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(signCount, 1);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit", "submit", "submit", "submit"]);
});

test("a 4xx on a re-check of an accepted permission keeps its bytes and session key", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "", submits = 0;
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessionPublicKey = String(body.sessionPublicKey); return json({ setup: await permissionTransaction(sessionPublicKey, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      submits++;
      if (submits === 1) { Object.assign(state.runtime.live, { ownerTransaction: { signature: "accepted-sig", status: "pending", kind: "session" } }); return json({ registration: { signature: "accepted-sig", status: "pending" } }); }
      if (submits === 2) return refusal("Invalid owner transaction confirmation.", 400);
      return json({ registration: { signature: "accepted-sig", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  await press("Finish permission registration");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|discarded/);
  assert.match(text, /Invalid owner transaction confirmation\. The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept/);
  assert.ok(button("Finish permission registration"));
  await press("Finish permission registration");
  // The same bytes, the same session key: never a second permission.
  assert.equal(signCount, 1);
  const submitted = calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").map((call) => call.body!.signedTransactionBase64);
  assert.deepEqual(submitted, ["AQID", "AQID", "AQID"]);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
});

test("a refused permission retry the server holds no record of is cleared without claiming it was never sent", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") {
      if (++submits === 1) throw new Error("Lost response");
      return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.ok(button("Finish permission registration"));
  await press("Finish permission registration");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|nothing was activated/);
  assert.match(text, /expired before submission\. The server holds no record of this signed permission, so it and its session key were cleared from this page\. Refresh to check whether a permission is active/);
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 1); assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
});

test("a confirmed permission whose activation is refused keeps its session key while the server holds it", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "", activations = 0;
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessionPublicKey = String(body.sessionPublicKey); return json({ setup: await permissionTransaction(sessionPublicKey, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      Object.assign(state.runtime.live, { ownerTransaction: { signature: "fixture-chain-signature", status: "finalized", kind: "session" } });
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") {
      // The first vault read lags the finalized permission.
      if (++activations === 1) return refusal("The current vault permission does not match the signed limits.", 400);
      activation = body; return json({ live: { registered: true } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.doesNotMatch(ui.container.textContent!, /discarded/);
  assert.match(ui.container.textContent!, /does not match the signed limits\. This permission is confirmed on Solana but is not active yet, so its session key was kept/);
  await press("Finish permission registration");
  assert.equal(signCount, 1); assert.equal(activations, 2);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
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
  await render(); await register();
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. The signed permission was not accepted, so it has been discarded/);
  // Not "Finish permission registration": retrying the refused bytes could never succeed.
  await register();
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
  await render(); await register();
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  outcome = "failed";
  await press("Finish permission registration");
  assert.match(ui.container.textContent!, /The permission transaction failed\. No session was activated/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 1);
});

test("a held permission that expires before activation is discarded without resubmitting it", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = { ...liveLimits(), expiresAtMs: Date.now() + 400 }; state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "pending" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
  await press("Finish permission registration");
  assert.match(ui.container.textContent!, /This permission expired at .* before it was activated, so its session key has been discarded/);
  assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 1);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Finish permission registration"), false);
});

test("a confirmed permission the server no longer holds drops its session key instead of retrying", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    // Another device prepared a newer owner transaction: the server's record is no longer this one.
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    if (path === "setup" && body?.stage === "activate") return refusal("The signed permission does not match this session key.", 400);
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /does not match this session key\. The server no longer holds this permission, so it cannot be activated and its session key has been discarded/);
  assert.equal(button("Register bounded trading permission").disabled, false);
});

const quoteFor = (lifetimeMs: number, quotedAtMs = Date.now()) => ({ source: "jupiter", inputMint: SOLANA_USDG_MINT, outputMint: OWNER, inAmount: "1000000", outAmount: "10000000",
  minOutAmount: "9950000", slippageBps: 50, contextSlot: 1, quotedAtMs, expiresAtMs: quotedAtMs + lifetimeMs });
test("a previewed minimum expires with its quote and the trade needs a new preview", async () => {
  state.runtime.paper = paper;
  let lifetime = 200;
  const trades: Record<string, unknown>[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(lifetime) } });
    if (path === "intent" && body?.action === "trade") { trades.push(body); return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade");
  assert.match(ui.container.textContent!, /Minimum received: 0\.00995 wrapped SOL/);
  assert.equal(button("Simulate trade").disabled, false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  // The quote's lifetime has passed: its minimum is no longer offered and nothing can be traded on it.
  assert.ok(!ui.container.textContent!.includes("Minimum received"));
  assert.match(ui.container.textContent!, /This quote expired\. Preview again/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Simulate trade"), false);
  assert.equal(trades.length, 0);
  lifetime = 20_000;
  await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 1);
});

test("a quote that is already past its expiry never offers a trade, whatever the device clock says", async () => {
  state.runtime.paper = paper;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    // Server clock ten minutes ahead of the device; the quote itself has no lifetime left.
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(0, Date.now() + 600_000) } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade");
  assert.match(ui.container.textContent!, /This quote expired/);
  assert.equal(calls.some((call) => call.body?.action === "trade"), false);
});

test("receipts show the minimum the recorded trade enforced, not the earlier preview", async () => {
  state = initial("live"); Object.assign(state.runtime.live, { ready: true, canExit: true, programId: PROGRAM });
  let sent: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") {
      sent = body;
      return json({ receipt: { mode: "live", requestId: (body.intent as { requestId: string }).requestId, status: "pending", intent: { outputMint: OWNER }, minOutAmount: "9900000", quotedOutAmount: "9940000" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade"); await ui.click("Place live trade");
  assert.ok(sent);
  assert.match(ui.container.textContent!, /Quoted output: 0\.00994 wrapped SOL\. Minimum enforced on chain: 0\.0099 wrapped SOL\./);
  state = initial("paper"); state.runtime.paper = paper;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") return json({ receipt: { mode: "paper", requestId: "r", intent: { outputMint: OWNER }, quote: { minOutAmount: "9950000" }, outputAmountRaw: "9990000" } });
    throw new Error("Unexpected fixture route");
  };
  await ui.click("Refresh account"); await ui.click("Start a new trade"); await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.match(ui.container.textContent!, /Simulated output: 0\.00999 wrapped SOL, against a quoted minimum of 0\.00995 wrapped SOL\./);
});

const EXPORT_FLAG = "NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT";
/** A live owner whose vault the server has read: what key export can protect. */
function liveVault() {
  state = initial("live");
  Object.assign(state.runtime.live, { programId: PROGRAM, vault: "Vau1tAddress1111111111111111111111111111111", balances: { slot: 9, cashUsdg: "0", wsolRaw: "0" } });
}
const exportCard = () => [...ui.container.querySelectorAll(".solana-card")].find((item) => [...item.querySelectorAll("button")].some((b) => b.textContent === "Export owner key with Privy"));
async function withExportFlag(value: string | undefined, run: () => Promise<void>) {
  const before = process.env[EXPORT_FLAG];
  if (value === undefined) delete process.env[EXPORT_FLAG]; else process.env[EXPORT_FLAG] = value;
  try { await run(); } finally { if (before === undefined) delete process.env[EXPORT_FLAG]; else process.env[EXPORT_FLAG] = before; }
}
test("owner key export is off unless the deployment turns it on, even for a live vault", async () => {
  for (const value of [undefined, "", "0", "true"]) await withExportFlag(value, async () => {
    liveVault(); await render();
    assert.equal(!!exportCard(), false, String(value));
    assert.doesNotMatch(ui.container.textContent!, /Export owner key|solana-recover|recovery tool/);
    await ui.close(); ui = testDom();
  });
  assert.equal(exportCount, 0);
});
test("with export turned on, it is offered only to the bound owner of a vault the server has read", async () => {
  await withExportFlag("1", async () => {
    // Paper only: no vault to protect, so no reason to handle the key.
    await render(); assert.equal(!!exportCard(), false);
    // Status could not load: nothing shows that a vault exists.
    respond = async () => { throw new Error("Merrymen is down"); };
    await ui.click("Refresh account"); assert.equal(!!exportCard(), false);
    respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
    liveVault(); await ui.click("Refresh account");
    const card = exportCard()!;
    assert.ok(card.textContent!.includes(`Vault program: ${PROGRAM}`));
    assert.ok(card.textContent!.includes("Vault: Vau1tAddress1111111111111111111111111111111"));
    assert.ok(card.textContent!.includes(`Owner wallet: ${OWNER}`));
    assert.match(card.textContent!, /Anyone who has this key controls your owner wallet and everything in your vault/);
    assert.match(card.textContent!, /Merrymen never sees it and will never ask for it/);
    assert.match(card.textContent!, /any app or person offering to recover your funds/);
    // Export needs an explicit acknowledgement each time.
    assert.equal(button("Export owner key with Privy").disabled, true);
    const acknowledge = [...card.querySelectorAll("label")].find((item) => item.textContent?.includes("anyone with this key can take my funds"))!.querySelector("input")!;
    await act(async () => { acknowledge.click(); });
    await ui.click("Export owner key with Privy");
    assert.equal(exportCount, 1);
    assert.match(ui.container.textContent!, /export window is closed/);
    assert.equal(button("Export owner key with Privy").disabled, true, "acknowledged again before another export");
    assert.equal(signCount, 0);
    // Never for a different connected wallet.
    state.binding.owner = base58Encode(new Uint8Array(32).fill(5));
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
  });
});
test("the export card never names a merrymen command that cli/bin.mjs does not register", async () => {
  const cli = readFileSync(fileURLToPath(new URL("../../../cli/bin.mjs", import.meta.url)), "utf8");
  await withExportFlag("1", async () => {
    liveVault(); await render();
    const text = exportCard()!.textContent!;
    for (const [, command] of text.matchAll(/merrymen ([a-z][a-z0-9-]*)/g)) assert.ok(cli.includes(`case "${command}"`), `merrymen ${command} is not a registered command`);
  });
});

test("the live card shows warnings, the fee payer's level and the runtime's setup and refund blockers", async () => {
  state = initial("live");
  const refund = "Someone sent USDG to your vault's next swap account. The vault returns it to your own USDG token account, which is closed or not safe to use (it has a delegate or close authority, or is frozen). Reopen your USDG token account in your wallet, or withdraw a little USDG here, which opens it. Buying is paused until then; exits remain available.";
  Object.assign(state.runtime.live, { programId: PROGRAM, blockers: ["Live Solana trading needs the same answer from two independent RPC providers.", "The fee payer warning threshold is misconfigured.", refund],
    warnings: ["The shared network fee payer is low (0.01 SOL; operators are alerted below 0.02 SOL). Trading continues."],
    feePayer: { lamports: "10000000", exitMinimumLamports: "2044280", buyMinimumLamports: "2084280", lowLamports: "20000000", level: "low" } });
  await render();
  const text = ui.container.textContent!;
  assert.ok(text.includes("Live Solana trading needs the same answer from two independent RPC providers."));
  assert.ok(text.includes("The fee payer warning threshold is misconfigured."));
  assert.ok(text.includes(refund));
  assert.match(text, /The shared network fee payer is low \(0\.01 SOL; operators are alerted below 0\.02 SOL\)\. Trading continues\./);
  assert.match(text, /Shared network fee payer: low; trading continues and operators are alerted \(0\.01 SOL\)/);
  assert.ok(ui.container.querySelector("[aria-label=Warnings]"));
  // A malformed or unknown fee payer answer hides that line; it never blanks the screen.
  Object.assign(state.runtime.live, { feePayer: { lamports: "-5", level: "drained" }, warnings: [] });
  await ui.click("Refresh account");
  assert.doesNotMatch(ui.container.textContent!, /Shared network fee payer/);
  assert.match(ui.container.textContent!, /Owner controls/);
});

test("owner controls show the owner wallet's SOL against what revoke and withdraw need, and the recoverable SOL", async () => {
  state.runtime.live.programId = PROGRAM;
  Object.assign(state.runtime.live, { ownerWallet: { lamports: "500000", revokeLamports: "895880", withdrawLamports: "2934280" },
    recoverable: { nativeLamports: "1500000000", unsyncedWsolLamports: "250000000" } });
  await render();
  const text = () => ui.container.textContent!;
  assert.match(text(), /Your owner wallet holds 0\.0005 SOL and pays the network fees of these transactions\. To revoke it must hold at least 0\.00089588 SOL; to withdraw, up to 0\.00293428 SOL/);
  assert.match(text(), /Merrymen adds a priority fee only from SOL beyond that, and this page signs none above 0\.001 SOL/);
  assert.match(text(), /That is too little to revoke\. Send SOL to your owner wallet now/);
  assert.match(text(), /The vault account holds 1\.5 SOL above its rent reserve/);
  assert.match(text(), /0\.25 SOL was sent to the vault's wrapped SOL account without being wrapped/);
  Object.assign(state.runtime.live, { ownerWallet: { lamports: "900000", revokeLamports: "895880", withdrawLamports: "2934280" }, recoverable: { nativeLamports: "0", unsyncedWsolLamports: "0" } });
  await ui.click("Refresh account");
  assert.doesNotMatch(text(), /too little to revoke/);
  assert.doesNotMatch(text(), /without being wrapped/);
  assert.match(text(), /The vault account holds 0 SOL above its rent reserve/);
});

test("Withdraw native SOL prepares the runtime's withdraw-sol in lamports, and shows what the owner wallet must hold", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "withdraw-sol", amountRaw: "1500000000" });
      // 200,000 units at 50,000 micro-lamports: a 0.00001 SOL priority fee.
      return json({ prepared: { transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880", ownerLamports: "10000000", priorityFeeLamports: "10000" } });
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "native-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await type("Native SOL to withdraw", "1.5");
  await press("Withdraw native SOL");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /The prepared native SOL withdrawal needs your owner wallet to hold at least 0\.00090588 SOL \(it holds 0\.01 SOL\): its network fee, a priority fee of 0\.00001 SOL so it lands under congestion/);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.deepEqual(calls.filter((call) => call.path === "owner").map((call) => call.body!.stage), ["prepare", "submit"]);
});

test("owner transaction bytes that do anything but what the owner asked never reach the wallet, and the fee shown is the one they carry", async () => {
  state.runtime.live.programId = PROGRAM;
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER), stranger = base58Encode(new Uint8Array(32).fill(9));
  const usdgAccount = (wallet: string) => deriveSolanaAta(wallet, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const wsolAccount = (wallet: string) => deriveSolanaAta(wallet, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const transfer: Instruction = { programAddress: address(SOLANA_SYSTEM_PROGRAM), data: Uint8Array.of(2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0),
    accounts: [{ address: address(OWNER), role: 3 }, { address: address(stranger), role: 1 }] };
  const syncNative = async (wallet: string, program = SOLANA_CLASSIC_TOKEN_PROGRAM): Promise<Instruction> =>
    ({ programAddress: address(program), data: Uint8Array.of(17), accounts: [{ address: address(await wsolAccount(wallet)), role: 1 }] });
  const withdrawUsdg = async (ownerToken: string, amount = 1_000_000n) => [await createAta(OWNER, SOLANA_USDG_MINT), buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault, owner: OWNER,
    mint: SOLANA_USDG_MINT, tokenProgram: TOKEN_2022_PROGRAM, vaultToken: await usdgAccount(vault), ownerToken, amount })];
  let answer: (body: Record<string, unknown>) => Promise<{ transactionBase64: string; requiredLamports?: string; priorityFeeLamports?: string }>;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return json({ prepared: await answer(body) });
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "owner-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await type("Native SOL to withdraw", "1.5");
  const text = () => ui.container.textContent!;
  const refused: Array<[string, string, (body: Record<string, unknown>) => Promise<{ transactionBase64: string; requiredLamports?: string; priorityFeeLamports?: string }>, RegExp]> = [
    ["a revocation that also moves the owner's SOL", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, [transfer]) }), /The prepared revocation does not match what you asked for\. Nothing was signed/],
    ["a revocation that also registers a trading session", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([
      buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault, owner: OWNER }),
      buildCreateSolanaSessionInstruction({ programAddress: PROGRAM, vault, owner: OWNER, session: stranger, perTrade: 1n << 40n, daily: 1n << 40n, perTradeWsol: 1n << 40n, dailyWsol: 1n << 40n, maxOps: 96, expiresAt: 1n << 40n })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a revocation of another owner's vault", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault: await deriveSolanaVaultAddress(PROGRAM, stranger), owner: OWNER })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a revocation under another program", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([buildRevokeSolanaSessionsInstruction({ programAddress: stranger, vault, owner: OWNER })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a resume request that pauses buying", "Ask wallet to resume buys", async () => ({ transactionBase64: ownerPaid([buildSetSolanaBreakerInstruction({ programAddress: PROGRAM, vault, authority: OWNER, paused: true })]) }),
      /The prepared request to resume buys does not match what you asked for/],
    ["a native SOL withdrawal of another amount", "Withdraw native SOL", async () => ({ transactionBase64: ownerPaid([buildWithdrawSolanaNativeInstruction({ programAddress: PROGRAM, vault, owner: OWNER, amount: 1_500_000_001n })]) }),
      /The prepared native SOL withdrawal does not match what you asked for/],
    ["a USDG withdrawal to someone else's token account", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid(await withdrawUsdg(await usdgAccount(stranger))) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a USDG withdrawal of another amount", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid(await withdrawUsdg(await usdgAccount(OWNER), 2_000_000n)) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a USDG withdrawal after a SyncNative of the vault's USDG account", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid([
      { programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), data: Uint8Array.of(17), accounts: [{ address: address(await usdgAccount(vault)), role: 1 }] }, ...await withdrawUsdg(await usdgAccount(OWNER))]) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a priority fee above 0.001 SOL", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(1_400_000, 1_000_000n)) }),
      /The prepared revocation does not match what you asked for/],
    ["a priority fee limit without a price", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n).slice(0, 1)) }),
      /The prepared revocation does not match what you asked for/],
    ["a stated fee its bytes do not carry", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880", priorityFeeLamports: "0" }),
      /The prepared revocation's priority fee does not match its bytes\. Nothing was signed/],
    ["bytes that are not a transaction", "Revoke all Solana sessions", async () => ({ transactionBase64: "AQID" }), /The prepared revocation does not match what you asked for/],
  ];
  for (const [name, label, prepared, refusedWith] of refused) {
    answer = prepared;
    await press(label);
    assert.match(text(), refusedWith, name);
    assert.equal(signCount, 0, name);
    assert.equal(calls.some((call) => call.body?.stage === "submit"), false, name);
    assert.doesNotMatch(text(), /needs your owner wallet to hold/, name);
  }
  // What the server really builds is signed: the fee shown is the one decoded from the bytes, not the server's claim.
  answer = async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880" });
  await press("Revoke all Solana sessions");
  assert.equal(signCount, 1);
  assert.match(text(), /The prepared revocation needs your owner wallet to hold at least 0\.00090588 SOL: its network fee, a priority fee of 0\.00001 SOL so it lands under congestion/);
  // A wrapped SOL withdrawal that first wraps native SOL sent to the vault's wrapped SOL account.
  const mint = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith("Asset"))!.querySelector("select")!;
  await act(async () => { mint.value = SOLANA_WRAPPED_SOL_MINT; mint.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  answer = async (body) => ({ transactionBase64: await ownerBytes(body, [await syncNative(vault)]) });
  await press("Withdraw to my wallet");
  assert.equal(signCount, 2);
  assert.deepEqual(calls.filter((call) => call.path === "owner" && call.body?.stage === "prepare").at(-1)!.body, { stage: "prepare", action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000000" });
  // But never a SyncNative of someone else's account, or under another token program.
  for (const before of [[await syncNative(stranger)], [await syncNative(vault, TOKEN_2022_PROGRAM)]]) {
    answer = async (body) => ({ transactionBase64: await ownerBytes(body, before) });
    await press("Withdraw to my wallet");
    assert.match(text(), /The prepared withdrawal does not match what you asked for/);
  }
  assert.equal(signCount, 2);
});

/** SetComputeUnitLimit and SetComputeUnitPrice, as the runtime adds them to an owner transaction. */
function priorityFee(units: number, microLamports: bigint): Instruction[] {
  const limit = new Uint8Array(5), price = new Uint8Array(9);
  limit[0] = 2; new DataView(limit.buffer).setUint32(1, units, true);
  price[0] = 3; new DataView(price.buffer).setBigUint64(1, microLamports, true);
  const program = address("ComputeBudget111111111111111111111111111111");
  return [{ programAddress: program, data: limit }, { programAddress: program, data: price }];
}
test("a permission's priority fee is shown from its bytes, with what the owner wallet must hold, before the wallet opens", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let claimed = "10000";
  respond = async (path, body) => {
    if (path === "status") return json(state);
    // 200,000 units at 50,000 micro-lamports: a 0.00001 SOL priority fee.
    if (path === "setup" && body?.stage === "prepare") return json({ setup: { ...await permissionTransaction(String(body.sessionPublicKey), saved, priorityFee(200_000, 50_000n)),
      requiredLamports: "9915880", ownerLamports: "50000000", priorityFeeLamports: claimed } });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "pending" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  const text = () => ui.container.textContent!;
  assert.equal(signCount, 0, "the wallet has not opened");
  assert.match(text(), /Review before your wallet opens/);
  assert.match(text(), /It carries a priority fee of 0\.00001 SOL \(at most 0\.001 SOL\), paid by your owner wallet/);
  assert.match(text(), /your owner wallet must hold at least 0\.00991588 SOL \(it holds 0\.05 SOL\), including rent for any vault and token accounts it opens/);
  assert.match(text(), /10 USDG per trade and 50 USDG per 24 hours/);
  assert.match(text(), /Nothing has been signed yet/);
  assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  await press("Sign permission with my wallet");
  assert.equal(signCount, 1);
  assert.equal(calls.filter((call) => call.body?.stage === "submit").length, 1);
  assert.match(text(), /awaiting final confirmation/);
  // Discarding a review signs nothing; a server that states another fee than its bytes never reaches the wallet.
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = saved;
  await ui.close(); ui = testDom(); signCount = 0; calls = [];
  await render(); await press("Register bounded trading permission");
  await ui.click("Discard prepared permission");
  assert.ok(button("Register bounded trading permission")); assert.equal(signCount, 0);
  claimed = "0";
  await press("Register bounded trading permission");
  assert.match(text(), /The prepared permission's fee does not match its bytes\. Nothing was signed/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet"), false);
  assert.equal(signCount, 0);
});

test("a reviewed permission not signed in time is discarded without opening the wallet", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.match(ui.container.textContent!, /It carries no priority fee/);
  const now = Date.now;
  Date.now = () => now() + 46_000;
  try { await press("Sign permission with my wallet"); } finally { Date.now = now; }
  assert.match(ui.container.textContent!, /was not signed in time, so it was discarded\. Nothing was signed/);
  assert.equal(signCount, 0);
  assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  assert.equal(button("Register bounded trading permission").disabled, false);
});

/**
 * A live owner whose review is prepared with `leftMs` to sign: the review's
 * clock is read before the prepare request (shifted here) and its timer after
 * it (the real clock), so the review window ends `leftMs` from now.
 */
async function reviewEndingIn(leftMs: number) {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  const now = Date.now;
  const progress = { submits: 0, activated: false };
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { Date.now = now; return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) }); }
    if (path === "setup" && body?.stage === "submit") { progress.submits++; return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } }); }
    if (path === "setup" && body?.stage === "activate") { progress.activated = true; state.runtime.live.ready = true; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  Date.now = () => now() - (45_000 - leftMs);
  try { await press("Register bounded trading permission"); } finally { Date.now = now; }
  assert.match(ui.container.textContent!, /Nothing has been signed yet/);
  return progress;
}
const LAPSED = /not signed in time|Nothing was signed/;
test("a review whose deadline passes while the wallet is open never says nothing was signed, and the signed permission is submitted", async () => {
  const progress = await reviewEndingIn(300);
  const wallet = deferred<Uint8Array>();
  signedBytes = () => wallet.promise;
  await press("Sign permission with my wallet");
  assert.equal(signCount, 1, "the wallet is open");
  // The deadline passes with the wallet still open.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  // The owner signs: the bytes are submitted (the server's window decides) and activated.
  wallet.resolve(Uint8Array.from([1, 2, 3]));
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  assert.equal(progress.submits, 1); assert.equal(progress.activated, true);
  assert.match(ui.container.textContent!, /Registered permission ready/);
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
});
test("a wallet that refuses after the review's deadline leaves the review lapsed; before it, the review stays to sign again", async () => {
  let progress = await reviewEndingIn(300);
  let refuse!: (error: Error) => void;
  signedBytes = () => new Promise<Uint8Array>((_, reject) => { refuse = reject; });
  await press("Sign permission with my wallet");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  refuse(new Error("The owner closed the wallet."));
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  assert.match(ui.container.textContent!, /The owner closed the wallet\./);
  assert.match(ui.container.textContent!, /The prepared permission was not signed in time, so it was discarded\. Nothing was signed/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet"), false);
  assert.equal(progress.submits, 0);
  // Refused well before the deadline: the same review stays, and signing it again submits once.
  await ui.close(); ui = testDom(); signCount = 0;
  progress = await reviewEndingIn(30_000);
  signedBytes = () => Promise.reject(new Error("The owner closed the wallet."));
  await press("Sign permission with my wallet");
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  assert.match(ui.container.textContent!, /Nothing has been signed yet/);
  signedBytes = () => Uint8Array.from([1, 2, 3]);
  await press("Sign permission with my wallet");
  assert.equal(signCount, 2); assert.equal(progress.submits, 1); assert.equal(progress.activated, true);
});
/** The `merrymen solana-recover` command the card shows, as the arguments a shell passes, with an RPC in place of <https-url>. */
function cardCommand(text: string): string[] {
  const shown = text.match(/merrymen solana-recover (--program \S+ --rpc <https-url> [^\n]*?)(?=The key goes|Nothing is signed|$)/)?.[1];
  assert.ok(shown, text);
  return shown.trim().split(/\s+/).map((arg) => arg === "<https-url>" ? "https://rpc.example.test" : arg);
}
/**
 * Runs the real tool on `args` offline: no answer ever comes from the RPC,
 * so it stops at its first chain read, or refuses before it. A generated
 * test key stands in on standard input.
 */
async function runTool(args: string[], list: readonly { programId: string; sha256: string }[]) {
  const reads: string[] = [];
  const fetch = (async (url: unknown) => { reads.push(String(url)); throw new Error("offline"); }) as typeof globalThis.fetch;
  const key = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  const stdin = Object.assign((async function* () { yield key; })(), { isTTY: false });
  const error = await runSolanaRecoverCommand(args, { releases: list, fetch, stdin, sleep: async () => {}, log: () => {}, warn: () => {} })
    .then(() => null, (e: unknown) => e as Error);
  return { reads: reads.length, error };
}
const NOT_RELEASED = /is not a released Merrymen vault program/;
test("for a released program, step 2 names the signing command with the key on standard input and the pinned hash, and the tool accepts it", async () => {
  await withExportFlag("1", async () => {
    const pin = [{ programId: PROGRAM, sha256: "ab".repeat(32) }];
    releases = pin;
    // A hash in the status answer is never shown: the tool checks its own pin, not the server.
    liveVault(); Object.assign(state.runtime.live, { programSha256: "cd".repeat(32) });
    await render();
    const text = exportCard()!.textContent!;
    assert.ok(text.includes(`Step 2: recover without Merrymen`));
    assert.ok(text.includes(`merrymen solana-recover --program ${PROGRAM} --rpc <https-url> --key-file - --send`), text);
    assert.match(text, /The key goes in on standard input \(--key-file -\), for example pbpaste \| merrymen solana-recover … on a Mac/);
    assert.match(text, /Never type the key into the command itself/);
    assert.ok(text.includes(`--owner ${OWNER} in place of --key-file - --send: nothing is signed or sent`));
    assert.ok(text.includes(`Vault program: ${PROGRAM}`));
    assert.ok(text.includes(`Released program binary SHA-256: ${"ab".repeat(32)}`));
    assert.doesNotMatch(text, /cdcdcdcd/);
    assert.match(text, /after checking that program's deployed binary against its released hash, built into the tool/);
    // Never the escape hatch the tool tells owners to refuse.
    assert.doesNotMatch(text, /unlisted-program|program-sha256/);
    // The tool's own program check passes on exactly these arguments, with the same pin: it goes on to read the chain.
    const args = cardCommand(text);
    assert.deepEqual(args, ["--program", PROGRAM, "--rpc", "https://rpc.example.test", "--key-file", "-", "--send"]);
    assert.deepEqual(solanaRecoveryProgramTrust({ programId: PROGRAM, send: true, releases: pin }), { listed: true, sha256: "ab".repeat(32) });
    const run = await runTool(args, pin);
    assert.ok(run.reads > 0, "past the program check, at its first RPC read");
    assert.doesNotMatch(run.error?.message ?? "", NOT_RELEASED);
    // The same command against a tool with no release refuses before reading anything: why it is shown only for a listed program.
    const unreleased = await runTool(args, []);
    assert.equal(unreleased.reads, 0); assert.match(unreleased.error!.message, NOT_RELEASED);
  });
});
test("for a program no release lists, step 2 offers only the read-only plan, which the tool accepts, and no hash", async () => {
  await withExportFlag("1", async () => {
    // Today's pin (none released), then a pin that lists another program.
    for (const pin of [undefined, [{ programId: OWNER, sha256: "ab".repeat(32) }], [{ programId: PROGRAM, sha256: "AB".repeat(32) }]]) {
      releases = pin;
      liveVault(); Object.assign(state.runtime.live, { programSha256: "ab".repeat(32) });
      await render();
      const text = exportCard()!.textContent!;
      assert.ok(text.includes("Step 2: check your vault without Merrymen"), JSON.stringify(pin));
      assert.match(text, /This vault program is not a released Merrymen vault program yet, so the Merrymen command-line tool does not sign for it/);
      assert.ok(text.includes(`merrymen solana-recover --program ${PROGRAM} --rpc <https-url> --owner ${OWNER}`), text);
      assert.doesNotMatch(text, /--send|--key-file|SHA-256|released hash|unlisted-program|program-sha256/);
      // Step 1 still keeps the owner's offline copy of the key.
      assert.ok(button("Export owner key with Privy"));
      const args = cardCommand(text);
      assert.deepEqual(args, ["--program", PROGRAM, "--rpc", "https://rpc.example.test", "--owner", OWNER]);
      const run = await runTool(args, TOOL_RELEASES);
      assert.ok(run.reads > 0, "the plan is accepted and reads the chain");
      assert.doesNotMatch(run.error?.message ?? "", NOT_RELEASED);
      await ui.close(); ui = testDom();
    }
  });
});
test("the card's release pin is the one the recovery tool trusts by default", async () => {
  const recovery = createRequire(import.meta.url)(recoveryPath) as typeof import("./SolanaRecovery");
  // The real pin (no test override): what the page offers to sign for is exactly what the tool signs for.
  assert.deepEqual(recovery.solanaVaultReleases(), TOOL_RELEASES);
  for (const release of TOOL_RELEASES) assert.equal(recovery.releasedProgramSha256(release.programId), release.sha256);
  // A malformed pin entry never counts as released.
  releases = [{ programId: PROGRAM, sha256: "not-a-hash" }, { programId: 7, sha256: "ab".repeat(32) } as unknown as { programId: string; sha256: string }];
  assert.deepEqual(recovery.solanaVaultReleases(), []);
  assert.equal(recovery.releasedProgramSha256(PROGRAM), null);
});

test("the recovery card waits for the status, and shows only for a live vault: never paper-only, unbound or a vault not read", async () => {
  await withExportFlag("1", async () => {
    // Loading: nothing is known about a vault yet.
    liveVault();
    const first = deferred<Response>();
    respond = async (path) => { if (path === "status") return first.promise; throw new Error("Unexpected fixture route"); };
    await render();
    assert.equal(!!exportCard(), false);
    await act(async () => { first.resolve(json(state)); });
    assert.ok(exportCard(), "shown once the status names a read vault");
    respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
    // A live binding whose vault the server has not read (no balances, book or session).
    Object.assign(state.runtime.live, { balances: null }); await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper only: the vault address is known but holds nothing of this account's.
    state = initial("paper"); Object.assign(state.runtime.live, { programId: PROGRAM, vault: "Vau1tAddress1111111111111111111111111111111" });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper, with the vault's balances read but no live book or session: still no card
    // (a live binding would show one: the paper restriction is what hides it).
    Object.assign(state.runtime.live, { balances: { slot: 9, cashUsdg: "5000000", wsolRaw: "0" } });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper with a live session still registered: the vault and its session outlive the switch back to paper.
    Object.assign(state.runtime.live, { session: "Sess1onKey111111111111111111111111111111111" });
    await ui.click("Refresh account");
    assert.ok(exportCard());
    Object.assign(state.runtime.live, { session: null, balances: null });
    // Back to paper after trading live: the funded vault still needs a recovery path.
    Object.assign(state.runtime.live, { book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "0" } });
    await ui.click("Refresh account");
    assert.ok(exportCard());
    // The server cannot name the program (its configuration failed): no command to give, so no card.
    Object.assign(state.runtime.live, { programId: null, vault: null }); await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Unbound: no card, whatever the wallet.
    respond = async (path) => { if (path === "status") return json({ binding: null, runtime: null }); throw new Error("Unexpected fixture route"); };
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    assert.equal(exportCount, 0);
  });
});
