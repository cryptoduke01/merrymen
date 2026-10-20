import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { readFileSync } from "node:fs";
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
const methods = ["setupPaper", "writeOffPaper", "preview", "trade", "prepareLive", "submitSetup", "activateLive", "prepareOwnerAction", "submitOwnerAction"];
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
    for (const route of ["paper", "paper/write-off", "intent", "setup", "settings", "strategy", "owner"]) routes[route] = createRequire(import.meta.url)(`${directory}${route}/route.ts`).POST;
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
test("the owner's previewed minimum reaches the runtime's trade, and the page sends it with every trade", async () => {
  // The route forwards the intent, floor included, untouched.
  const intent = { mode: "paper", requestId: "floor-one", minOutAmount: "9950000" };
  assert.equal((await post("intent", { mode: "paper", intent, action: "trade" })).status, 200);
  assert.deepEqual(calls.pop(), { method: "trade", args: [scope, { mode: "paper", intent }] });
  // The page's trade request carries the minimum of the quote the owner just saw. Without it the server
  // places the trade at whatever the fresh route guarantees (the floor check is skipped), so this is pinned.
  // A behavioural test of the request body belongs in SolanaScreen.test.ts (the web UI track).
  const page = readFileSync(fileURLToPath(new URL("../terminal/SolanaScreen.tsx", import.meta.url)), "utf8");
  const placeTrade = page.slice(page.indexOf("const placeTrade = async () => {"), page.indexOf("const tokenLabel ="));
  assert.ok(placeTrade.length > 0, "placeTrade must exist for this pin to mean anything");
  assert.equal((placeTrade.match(/api</g) ?? []).length, 1, "one request");
  assert.match(placeTrade, /api<\{ receipt: Receipt \}>\("intent", \{ action: "trade", mode, intent: \{ \.\.\.intent, minOutAmount: preview\.quote\.minOutAmount \} \}\)/);
});
test("the paper write-off takes only a canonical mint and always writes off in the verified binding's book", async () => {
  const mint = "So11111111111111111111111111111111111111112";
  for (const body of [{}, { mint: "" }, { mint: "not-a-mint" }, { mint: ` ${mint}` }, { mint: 7 }, { mint, owner }, { mint, tenant }, { mint, amountRaw: "1" }]) {
    assert.equal((await post("paper/write-off", body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
  const response = await post("paper/write-off", { mint });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.pop(), { method: "writeOffPaper", args: [scope, { mint }] });
  assert.deepEqual(calls, []);
});
test("live mode requires explicit separate consent and registration requires saved live mode", async () => {
  assert.equal((await post("settings", { mode: "live", limits, revision: 2 })).status, 400);
  assert.equal((await post("setup", { stage: "prepare", sessionPublicKey: owner })).status, 409);
  assert.deepEqual(calls, []);
  // Live limits must say how much SOL a sale may put in, per trade and per day.
  assert.equal((await post("settings", { mode: "live", limits, revision: 2, liveConsent: true })).status, 400);
  assert.deepEqual(calls, []);
  const live = { ...limits, perTradeWsol: "100000000", dailyWsol: "500000000" };
  assert.equal((await post("settings", { mode: "live", limits: live, revision: 2, liveConsent: true })).status, 200);
  assert.deepEqual(calls.pop(), { method: "settings", args: [tenant, owner, 2, "live", live] });
  binding.requestedMode = "live"; binding.limits = live;
  assert.equal((await post("setup", { stage: "prepare", sessionPublicKey: owner })).status, 200);
  assert.deepEqual(calls.pop(), { method: "prepareLive", args: [scope, { limits: live, sessionPublicKey: owner }] });
});
test("settings refuse paper limits beyond the account bounds with a 400 before saving anything", async () => {
  // Paper limits carry no SOL sell caps, and used to be checked only for shape here.
  for (const wide of [{ ...limits, maxOpsPerDay: 97 }, { ...limits, expiresAtMs: Date.now() + 169 * 3_600_000 }]) {
    const response = await post("settings", { mode: "paper", limits: wide, revision: 2 });
    assert.equal(response.status, 400, JSON.stringify(wide));
    assert.match((await response.json() as { error: string }).error, /between 1 and 96|168 hours/);
  }
  assert.deepEqual(calls, []);
  const widest = { ...limits, maxOpsPerDay: 96 };
  assert.equal((await post("settings", { mode: "paper", limits: widest, revision: 2 })).status, 200);
  assert.deepEqual(calls.pop(), { method: "settings", args: [tenant, owner, 2, "paper", widest] });
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
