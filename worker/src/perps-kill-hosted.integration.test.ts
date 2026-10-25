/**
 * THE KILL MATRIX, HOSTED TELEGRAM: a /kill confirmed in chat (or recorded by
 * the recovery replies) is carried out by the orchestrator's honourKill, and
 * it reaches every wallet a Spot-only, a Perps-only or a two-wallet owner
 * has. web/src/app/api/grants/kill-perps.test.ts holds the web rows and
 * worker/src/perps-kill.test.ts the self-hosted ones.
 *
 * Driven through the real order-ferry pass (honourPendingKills, which is
 * also what reconcile and shutdown call) over real file-backed stores, with
 * a real kill request in the tenant's home. Only the Solana stop and the
 * owner's ✅ are recorded instead of done, and the Perps stop is the real one
 * unless a test makes it fail.
 *
 * MERRYMEN_HOME is per process (node --test forks per file).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(realpathSync(os.tmpdir()), "merrymen-perps-kill-hosted-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");

const { honourPendingKills, childHome, setKillConfirmForTest, setSolanaKillForTest, setPerpsKillForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { KILL_CONFIRM_OWED, KILL_DONE_PERPS_TEXT, killRequested, writeKillRequest } = await import("./kill-request");
const { stopPerpsForKill } = await import("./perps-kill");
after(() => rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const T = "0x00000000000000000000000000000000000000a1" as const;
const SPOT = "0x00000000000000000000000000000000000000c3" as const;
const PERPS = "0x00000000000000000000000000000000000000c4" as const;
const nowSec = () => Math.floor(Date.now() / 1000);
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const grant = (account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: T, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}`,
  grantedAt: 1, expiresAt: 9_999_999_999, grantFeatures: ["tradeable-v2"],
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});
type Owner = "spot-only" | "perps-only" | "two-wallet";
const hasSpot = (o: Owner) => o !== "perps-only";
const hasPerps = (o: Owner) => o !== "spot-only";

/** Every ✅ the orchestrator would have sent, and whether it carried the Perps line. */
const confirmed: Array<{ tenant: string; perps: boolean }> = [];
setKillConfirmForTest(async (tenant, done) => { confirmed.push({ tenant, perps: done?.perps === true }); });
const solanaStops: string[] = [];
let solanaDown = false;
setSolanaKillForTest(async (tenant) => {
  solanaStops.push(tenant);
  if (solanaDown) throw new Error("solana bindings unavailable");
});
/** The real Perps stop, unless `perpsDown`. */
let perpsDown = false;
setPerpsKillForTest(async (tenant, coveredSec) => {
  if (perpsDown) throw new Error("perps grant store unavailable");
  return (await stopPerpsForKill(tenant, { coveredSec })) === "stopped";
});

const spotStore = getGrantStore("spot"), perpsStore = getGrantStore("perps");
async function owner(o: Owner) {
  if (hasSpot(o)) await spotStore.put(T, grant(SPOT, key("ab")));
  if (hasPerps(o)) await perpsStore.put(T, grant(PERPS, key("cd"), { purpose: "perps" }));
}
/** The child's (or the hold process's) side of a confirmed /kill: a request in the tenant's home. */
function telegramKill(killedAt = nowSec()) {
  mkdirSync(childHome(T), { recursive: true });
  writeKillRequest(childHome(T), { smartAccount: SPOT, serialized: "killed-permission" }, killedAt);
}

beforeEach(async () => {
  await spotStore.remove(T);
  await perpsStore.remove(T);
  rmSync(path.join(FLEET, "tenants-perps"), { recursive: true, force: true });
  rmSync(childHome(T), { recursive: true, force: true });
  confirmed.length = 0;
  solanaStops.length = 0;
  solanaDown = false;
  perpsDown = false;
});

describe("a hosted Telegram /kill, carried out by the orchestrator", () => {
  for (const o of ["spot-only", "perps-only", "two-wallet"] as const) {
    it(`${o}: every wallet it has is revoked, and the owner is told once, naming the Perps wallet only if it had one`, async () => {
      await owner(o);
      telegramKill();
      await honourPendingKills();
      assert.equal(await spotStore.hasStoredGrant(T), false);
      assert.equal(await perpsStore.hasStoredGrant(T), false);
      assert.deepEqual(solanaStops, [T]);
      assert.deepEqual(confirmed, [{ tenant: T, perps: hasPerps(o) }]);
      if (!hasPerps(o)) assert.equal(existsSync(path.join(FLEET, "tenants-perps")), false, "a Spot-only kill makes no Perps directory");
      // A later pass finds both gone: safe, and no second ✅.
      await honourPendingKills();
      assert.equal(confirmed.length, 1);
    });
  }

  for (const o of ["perps-only", "two-wallet"] as const) {
    it(`${o}: a Perps half that fails keeps the kill pending, never done; the next pass finishes it and owes one ✅`, async () => {
      await owner(o);
      telegramKill();
      perpsDown = true;
      await honourPendingKills();
      assert.equal(await perpsStore.hasStoredGrant(T), true, "not revoked yet");
      assert.equal(await spotStore.hasStoredGrant(T), false, "the Robinhood grant went regardless");
      assert.deepEqual(confirmed, [], "no ✅ while a half is not done");
      assert.equal(killRequested(childHome(T)), true, "the request stays pending, so nothing arms");
      perpsDown = false;
      await honourPendingKills();
      assert.equal(await perpsStore.hasStoredGrant(T), false);
      assert.deepEqual(confirmed, [{ tenant: T, perps: true }]);
    });
  }

  it("two-wallet: the Perps grant removed while Solana failed is remembered for the ✅ the next pass sends", async () => {
    await owner("two-wallet");
    telegramKill();
    solanaDown = true;
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false, "the Perps half ran, though Solana's failed");
    assert.ok(existsSync(path.join(childHome(T), KILL_CONFIRM_OWED)));
    assert.deepEqual(confirmed, []);
    solanaDown = false;
    await honourPendingKills();
    assert.deepEqual(confirmed, [{ tenant: T, perps: true }], "told once, and told about the Perps wallet");
  });

  it("a Perps grant signed after the kill stays, as a Spot one does", async () => {
    await owner("perps-only");
    telegramKill(nowSec() - 120);
    await honourPendingKills();
    assert.ok(await perpsStore.get(T), "the owner's later Perps grant is kept");
    assert.deepEqual(confirmed, []);
  });

  it("the ✅'s Perps line claims only the grant, nothing about where the money is", () => {
    assert.match(KILL_DONE_PERPS_TEXT, /Perps wallet's stored trading grant is deleted too/);
    assert.doesNotMatch(KILL_DONE_PERPS_TEXT, /funds|money|closed|flat/i);
  });
});
