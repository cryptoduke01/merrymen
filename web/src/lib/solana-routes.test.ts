import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "./solana-api";
import * as auth from "./solana-auth";
import * as bindings from "./solana-binding-store";
import { CHAINS } from "../../../packages/core/src/ids";

const tenant = `0x${"11".repeat(20)}` as const, owner = "So11111111111111111111111111111111111111112";
const scope = { tenant, owner };
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3600000 };
let binding: bindings.SolanaBinding;
let calls: Array<{ method: string; args: unknown[] }>;
let deny = false;
const routes: Record<string, (req: Request) => Promise<Response>> = {};
const methods = ["setupPaper", "preview", "trade", "prepareLive", "submitSetup", "activateLive", "prepareOwnerAction", "submitOwnerAction"];
// These exercise a deployment that offers Solana; solana-enabled.test.ts covers one that does not.
const flag = process.env.MERRYMEN_SOLANA;
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
before(() => {
  process.env.MERRYMEN_SOLANA = "1";
  const directory = fileURLToPath(new URL("../app/api/solana/", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(directory)) {
      if (id === "@/lib/solana-auth") return auth;
      if (id === "@/lib/solana-binding-store") return bindings;
      if (id === "@/lib/solana-api") return { ...api, solanaContext: async () => {
        if (deny) throw new auth.SolanaWebError(401, "Sign in first.");
        return { principal: { tenant, did: binding.did }, binding, scope,
          store: Object.fromEntries(["settings", "strategy"].map((method) => [method, async (...args: unknown[]) => { calls.push({ method, args }); return binding; }])) };
      } };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: () => Object.fromEntries(methods.map((method) => [method,
        async (...args: unknown[]) => { calls.push({ method, args }); return { fixture: true }; }])) };
    }
    return original.call(this, id, parent, isMain);
  });
  try {
    for (const route of ["paper", "intent", "setup", "settings", "strategy", "owner"]) routes[route] = createRequire(import.meta.url)(`${directory}${route}/route.ts`).POST;
  } finally { interception.mock.restore(); }
});
beforeEach(() => {
  calls = []; deny = false;
  binding = { tenant, did: "did:privy:alice", owner, chain: CHAINS.solana, requestedMode: "paper", limits, strategy: null, revision: 2, createdAtMs: 1, updatedAtMs: 1 };
});
async function post(route: string, body: unknown) {
  return routes[route]!(new Request(`https://app.example.test/api/solana/${route}`, { method: "POST", body: JSON.stringify(body) }));
}
test("every Solana mutation refuses unauthenticated callers before runtime execution", async () => {
  deny = true;
  for (const route of Object.keys(routes)) assert.equal((await post(route, {})).status, 401);
  assert.deepEqual(calls, []);
});
test("paper and intent routes always derive tenant and owner from the verified binding", async () => {
  assert.equal((await post("paper", { initialCashRaw: "1000000000" })).status, 200);
  assert.deepEqual(calls.pop(), { method: "setupPaper", args: [scope, { initialCashRaw: "1000000000", limits }] });
  const intent = { mode: "paper", requestId: "intent-one" };
  assert.equal((await post("intent", { mode: "paper", intent, action: "trade" })).status, 200);
  assert.deepEqual(calls.pop(), { method: "trade", args: [scope, { mode: "paper", intent }] });
  for (const extra of [{ owner }, { tenant }, { mode: "live" }]) {
    assert.notEqual((await post("intent", { mode: "paper", intent, action: "trade", ...extra })).status, 200);
  }
  assert.deepEqual(calls, []);
});
test("live mode requires explicit separate consent and registration requires saved live mode", async () => {
  assert.equal((await post("settings", { mode: "live", limits, revision: 2 })).status, 400);
  assert.equal((await post("setup", { stage: "prepare", sessionPublicKey: owner })).status, 409);
  assert.deepEqual(calls, []);
  assert.equal((await post("settings", { mode: "live", limits, revision: 2, liveConsent: true })).status, 200);
  assert.deepEqual(calls.pop(), { method: "settings", args: [tenant, owner, 2, "live", limits] });
  binding.requestedMode = "live";
  assert.equal((await post("setup", { stage: "prepare", sessionPublicKey: owner })).status, 200);
  assert.deepEqual(calls.pop(), { method: "prepareLive", args: [scope, { limits, sessionPublicKey: owner }] });
});
test("strategy endpoint rejects excessive size and persists explicit enablement under the current revision", async () => {
  const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };
  assert.equal((await post("strategy", { strategy: { ...strategy, tradeUsdgRaw: "10000001" }, revision: 2 })).status, 400);
  assert.equal((await post("strategy", { strategy, revision: 2 })).status, 200);
  assert.deepEqual(calls.pop(), { method: "strategy", args: [tenant, owner, 2, strategy] });
  assert.deepEqual(calls, []);
});
test("owner recovery remains available without live consent and cannot redirect a withdrawal", async () => {
  assert.equal((await post("owner", { stage: "prepare", action: "revoke" })).status, 200);
  assert.deepEqual(calls.pop(), { method: "prepareOwnerAction", args: [scope, { action: "revoke" }] });
  assert.equal((await post("owner", { stage: "prepare", action: "withdraw", mint: owner, amountRaw: "1", destination: "attacker" })).status, 400);
  assert.equal((await post("owner", { stage: "submit", signedTransactionBase64: "AQID" })).status, 200);
  assert.deepEqual(calls.pop(), { method: "submitOwnerAction", args: [scope, { signedTransactionBase64: "AQID" }] });
  assert.deepEqual(calls, []);
});
