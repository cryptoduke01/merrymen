import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { sameGrantPermission, type Grant, type GrantRetryProof } from "@/lib/session";
import type { AccountState } from "./HostedControls";
import { markPermissionForReplacement } from "@/lib/permission-replacement";
import { RISK_PROFILES } from "@merrymen/core";

const tenant = `0x${"a".repeat(40)}`;
const grant = { smartAccount: `0x${"b".repeat(40)}`, owner: tenant, sessionKeyAddress: `0x${"c".repeat(40)}`, chainId: 4663, grantedAt: 1, expiresAt: 604801, binding: { version: "privy-did-owner-v1" }, caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 } } as Grant;
const account: AccountState = { session: { hosted: true, address: tenant }, status: { exists: false, tenant } };
let stored: Grant | null;
let snapshots: Grant[];
let trusted: boolean;
let storageFailed: boolean;
let mintCalls: number;
let handoffOk: boolean;
let signerAddress: string;
let beforeRetrySubmit: (() => void) | null;
let retryProof: GrantRetryProof | undefined;
let writes: string[];
let settingsWrite: Record<string,unknown>|null;
let setupResponse: unknown;
let setupReads: number;
let current: { kind: "ready"; account: AccountState } | { kind: "changed" };
let CreateAgent: typeof import("./screens/CreateAgent").CreateAgent;
let testDom: typeof import("./test-dom").testDom;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
  const screen = fileURLToPath(new URL("./screens/CreateAgent.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === screen) {
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => ({ account: { address: signerAddress }, did: "did:privy:test" }) };
      if (id === "@/lib/trencher-permission") return { TRENCHER_FACTORY: `0x${"e".repeat(40)}` };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "../tier") return { loadTier: async () => null, newAgentQualifies: () => true };
      if (id === "../account-session") return { fetchAccountForSession: async () => current };
      if (id === "@/lib/saved-grant-binding") return {
        loadRecoveryGrants: () => { if (storageFailed) throw new Error("storage unreadable"); return snapshots; },
        trustedSavedGrant: async (candidate: Grant) => !!candidate && trusted,
      };
      if (id === "@/lib/session") return {
        sameGrantPermission,
        loadGrant: () => stored,
        retryGrantHandoff: async (_grant: Grant, proof?: GrantRetryProof) => {
          retryProof=proof;beforeRetrySubmit?.();await proof?.beforeSubmit();
          writes.push("/api/grants"); return { ok: true };
        },
        isPrivyOwned: () => true,
        createPrivyOwnedWallet: async () => { mintCalls++; return { local: grant, handoff: { ok: handoffOk, ...(handoffOk?{}:{error: "temporary activation failure"}) } }; },
      };
    }
    return load.call(this, id, parent, isMain);
  });
  try { CreateAgent = createRequire(import.meta.url)(screen).CreateAgent; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom(); stored = null; snapshots = []; trusted = true; storageFailed = false; mintCalls = 0; handoffOk=false; signerAddress = tenant; writes = [];
  beforeRetrySubmit=null;retryProof=undefined;
  settingsWrite=null;setupResponse=null;setupReads=0;
  current = { kind: "ready", account };
  globalThis.fetch = async (input, init) => {
    const route = String(input);
    if (init?.method && init.method !== "GET") writes.push(route);
    if (route.startsWith("/api/mcp/approvals/")) { setupReads++; return setupResponse instanceof Response ? setupResponse : Response.json(setupResponse); }
    if (route === "/api/settings") { if(init?.method==="PUT")settingsWrite=JSON.parse(String(init.body)); return Response.json({ values: {} }); }
    if (route === "/api/grants") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${route}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const screen = () => React.createElement(CreateAgent, { account, onRefresh() {}, onSignedIn() {}, onBack() {}, onDone() {}, onFund() {} });

async function limits() {
  await ui.render(screen());
  await ui.click("Customise strategy and limits");
  await act(async () => { ui.container.querySelector<HTMLInputElement>('input[value="steady-basket"]')!.click(); });
  const input = ui.container.querySelector<HTMLInputElement>("#agent-name")!;
  assert.ok(input, "new-agent form is reachable for an account without a saved wallet");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Test agent");
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  await ui.click("Set trading limits");
  await ui.click("Continue");
}
async function failedActivation() {
  await limits(); await ui.click("Create agent");
  assert.equal(mintCalls, 1);
  assert.match(ui.container.textContent!, /Retry activation/);
  writes = [];
}

it("a verified stopped local wallet resumes instead of minting another permission", async () => {
  stored = grant;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(ui.container.querySelector("a")?.getAttribute("href"), "/grant#resign");
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a verified public recovery snapshot resumes without a browser's full grant", async () => {
  snapshots = [grant];
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("another tenant's unverified saved metadata is not adopted", async () => {
  stored = grant; trusted = false;
  await ui.render(screen());
  assert.ok(ui.container.querySelector("#agent-name"));
  assert.doesNotMatch(ui.container.textContent!, /Resume your saved wallet/);
});
it("an unreadable recovery journal fails closed", async () => {
  storageFailed = true;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Couldn.t check your saved wallet/);
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0);
});
it("a saved wallet appearing after setup opens blocks all mint and settings writes", async () => {
  await limits(); stored = grant;
  await ui.click("Create agent");
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a replacement marker added after rendering prevents Retry activation from posting", async () => {
  await failedActivation();
  markPermissionForReplacement(grant);
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
});
it("Retry activation rechecks the signed-in account and never posts after a tenant change", async () => {
  await failedActivation(); current = { kind: "changed" };
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /could not be verified for your current account/);
});

it("Retry activation requests a fresh proof for the same owner and permission", async () => {
  await failedActivation();
  await ui.click("Retry activation");
  assert.equal(mintCalls,1);
  assert.equal(retryProof?.ownerSigner.account.address,tenant);
  assert.equal(retryProof?.ownerSigner.binding,"privy-did-owner-v1");
  assert.equal(retryProof?.tenant,tenant);
  assert.deepEqual(writes,["/api/grants"]);
});

it("a lost success response recovers from authenticated stored permission status without posting again", async () => {
  await failedActivation();
  current={kind:"ready",account:{...account,status:{exists:true,tenant,grant}}};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.equal(retryProof,undefined);
  assert.equal(mintCalls,1);
  assert.match(ui.container.textContent!,/Your wallet is connected/);
});

for(const change of ["caps","expiry"] as const){
  const changedGrant=()=>change==="caps"?{...grant,caps:{...grant.caps,perTradeUsdg:1}}:{...grant,expiresAt:grant.expiresAt+1000};
  it(`reusing a session key with different ${change} cannot recover a lost response as success`,async()=>{
    await failedActivation();
    current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:changedGrant()}}};
    await ui.click("Retry activation");
    assert.deepEqual(writes,[]);assert.equal(retryProof,undefined);
    assert.match(ui.container.textContent!,/Another permission is active/);
    assert.doesNotMatch(ui.container.textContent!,/Your wallet is connected/);
  });
  it(`reusing a session key with different ${change} during signing cannot allow a stale repost`,async()=>{
    await failedActivation();
    beforeRetrySubmit=()=>{current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:changedGrant()}}};};
    await ui.click("Retry activation");
    assert.deepEqual(writes,[]);
    assert.match(ui.container.textContent!,/Another permission is active/);
    assert.doesNotMatch(ui.container.textContent!,/Your wallet is connected/);
  });
}

it("changing login during the retry signature prevents the handoff", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>{current={kind:"changed"};};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/signed-in account changed while confirming/);
});

it("selecting revocation during the retry signature prevents the handoff", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>markPermissionForReplacement(grant);
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/Resume your saved wallet/);
});

it("a newer permission arriving during the retry signature is not replaced", async () => {
  await failedActivation();
  beforeRetrySubmit=()=>{current={kind:"ready",account:{...account,status:{exists:true,tenant,grant:{...grant,sessionKeyAddress:`0x${"e".repeat(40)}`}}}};};
  await ui.click("Retry activation");
  assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/Another permission is active/);
});

it("a stale Privy signer from another hosted login cannot mint or change settings", async () => {
  await limits(); signerAddress = `0x${"d".repeat(40)}`;
  await ui.render(screen());
  await ui.click("Create agent");
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Your signing wallet changed/);
});

const proposalId=`prp_${"f".repeat(32)}`;
function setup(owner=tenant) {
  const expires_at=Math.floor(Date.now()/1000)+3600;
  const {maxImpactBps:_,...risk}=RISK_PROFILES.careful.settings;
  return {id:proposalId,kind:"agent_draft",status:"applied",binding:{purpose:"create",tenant:owner,expires_at,risk_level:"careful",settings:{agentName:"Little Robin",strategy:"weekend-gap",basketSymbols:["TSLA"],assetMode:"stocks",...risk}},expires_at,requested_by:"ChatGPT",result:{setup_only:true}};
}
async function assistantSetup() {
  ui.dom.window.history.replaceState(null,"",`/create?proposal=${proposalId}`);
  setupResponse=setup();
  await ui.render(screen());
}
it("assistant setup carries name, strategy, basket and reviewed risk into actual wallet creation",async()=>{
  await assistantSetup();
  assert.match(ui.container.textContent!,/Little Robin/);assert.match(ui.container.textContent!,/Weekend gap/);
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="mode"]')?.checked,true,"chat cannot opt a user into live trading");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  await ui.click("Create agent");
  assert.equal(setupReads,2,"setup standing is re-read before creation");
  assert.equal(mintCalls,1);
  assert.deepEqual({name:settingsWrite?.agentName,strategy:settingsWrite?.strategy,basket:settingsWrite?.basketSymbols,live:settingsWrite?.liveTradingEnabled}, {name:"Little Robin",strategy:"weekend-gap",basket:["TSLA"],live:false});
  for(const key of ["slippageBps","strategistStopLossBps","takeProfitBps","buyPerTickUsdg","llmMaxActionUsdg"]){
    assert.equal(settingsWrite?.[key],RISK_PROFILES.careful.settings[key as keyof typeof RISK_PROFILES.careful.settings]);
  }
  assert.equal(settingsWrite?.maxImpactBps,undefined);
});
it("revoking a connection after loading a setup blocks settings and wallet signing",async()=>{
  await assistantSetup();
  setupResponse=Response.json({error:"This assistant connection was revoked."},{status:403});
  await ui.click("Create agent");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/no longer available to your signed-in account or assistant connection/);
});
it("a foreign or expired setup never offers wallet creation",async()=>{
  ui.dom.window.history.replaceState(null,"",`/create?proposal=${proposalId}`);
  setupResponse=setup(`0x${"d".repeat(40)}`);
  await ui.render(screen());
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(ui.container.querySelector("#agent-name"),null);assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  const expired=setup();expired.expires_at=1;expired.binding.expires_at=1;setupResponse=expired;
  await ui.remount(screen());
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});
it("a login change invalidates a previously loaded assistant setup",async()=>{
  await assistantSetup();
  const other=`0x${"d".repeat(40)}`;
  const changed={...account,session:{...account.session,address:other}};
  await ui.render(React.createElement(CreateAgent,{account:changed,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/not approved for your current account/);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("the compact handoff carries the approved setup straight to explicit signing and returns to chat",async()=>{
  ui.dom.window.history.replaceState(null,"",`/connect/setup/${proposalId}?proposal=untrusted&name=Injected`);
  setupResponse=setup();handoffOk=true;
  let returned=0;let backed=0;
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){backed++;},onDone(){returned++;},onFund(){}}));
  assert.match(ui.container.textContent!,/Little Robin/);
  assert.match(ui.container.textContent!,/Weekend gap/);
  assert.match(ui.container.textContent!,/Confirm your limits/);
  assert.equal(ui.container.querySelector("#agent-name"),null,"the owner does not repeat chat's name and strategy choices");
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[name="mode"]')?.checked,true);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  await act(async()=>{ui.container.querySelector<HTMLButtonElement>('button[aria-label="Back to approved setup"]')!.click();});
  assert.equal(backed,1);
  assert.equal(ui.container.querySelector("#agent-name"),null,"Back returns to review instead of opening a new setup wizard");
  await ui.click("Confirm and sign");
  assert.equal(setupReads,2);assert.equal(mintCalls,1);
  assert.equal(settingsWrite?.agentName,"Little Robin");assert.equal(settingsWrite?.strategy,"weekend-gap");
  assert.equal(settingsWrite?.liveTradingEnabled,false);
  assert.match(ui.container.textContent!,/Wallet connected/);
  assert.match(ui.container.textContent!,/refresh Merryman to check activation/);
  await ui.click("Done — return to chat");assert.equal(returned,1);
});

it("compact handoff still blocks a revoked setup at the moment of signing",async()=>{
  setupResponse=setup();
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  setupResponse=Response.json({error:"forbidden"},{status:403});
  await ui.click("Confirm and sign");
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
  assert.match(ui.container.textContent!,/no longer available/);
});

it("an unavailable compact setup sends the owner back to chat instead of restarting the full wizard",async()=>{
  setupResponse=Response.json({error:"expired"},{status:410});
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/Return to the same chat/);
  assert.equal(ui.container.querySelector('a[href="/create"]'),null);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});

it("an older approved crypto-only setup without a crypto basket cannot reach signing",async()=>{
  const old=setup();const settings=old.binding.settings as Record<string,unknown>;
  settings.assetMode="crypto";delete settings.basketSymbols;setupResponse=old;
  await ui.render(React.createElement(CreateAgent,{account,assistantProposalId:proposalId,onRefresh(){},onSignedIn(){},onBack(){},onDone(){},onFund(){}}));
  assert.match(ui.container.textContent!,/Crypto-only setup needs an explicit basket/);
  assert.match(ui.container.textContent!,/Return to the same chat/);
  assert.equal(Array.from(ui.container.querySelectorAll("button")).some(button=>button.textContent==="Confirm and sign"),false);
  assert.equal(mintCalls,0);assert.deepEqual(writes,[]);
});
