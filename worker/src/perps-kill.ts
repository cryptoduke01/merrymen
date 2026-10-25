/**
 * THE PERPS HALF OF EVERY KILL.
 *
 * A login's Perps wallet (Kernel index 1) has a grant of its own, and nothing
 * that stops the Spot wallet reaches it: not removing the Spot grant, not
 * Solana's switch. So every kill path calls this beside its Solana half
 * (solana-kill.ts): the web's "Kill all agents" (DELETE /api/grants,
 * delete-agent, which the phone apps send too), the orchestrator's honourKill
 * for a hosted Telegram /kill, the self-hosted Telegram /kill (index.ts) and
 * `merrymen kill` (perps-kill-cli.ts). From the moment a Perps wallet can
 * exist, a kill must reach it, so this lands before anything can make one.
 *
 * IT REVOKES THE PERPS GRANT. Hosted, the tenant's row in the Perps grant
 * store; self-hosted, the Perps home's grant.json, archived first so its owner
 * key survives. No Perps worker runs yet, so revoking the grant is all there
 * is to stop. The stand-down (closing positions at Lighter and bringing the
 * money home) arrives with the worker in slices 3 and 4, and this half grows a
 * third answer then: closing.
 *
 * THE SAME GUARANTEES AS SOLANA'S HALF:
 *  - a half that fails throws (or, for self-hosted Telegram, answers
 *    "not-stopped"), and the caller reports the kill incomplete, never done;
 *  - a retry is safe: each answer is a fact about what is stored now;
 *  - an owner with no Perps wallet costs a kill one read-only look and
 *    nothing more: no lock, no table, no directory (GrantStore.revokeForKill);
 *  - it runs whatever MERRYMEN_PERPS says. A flag limits trading, never a kill.
 */
import { statSync, rmSync } from "node:fs";
import path from "node:path";
import { isHostedMode } from "../../packages/core/src/hosted";
import { getGrantStore, type GrantStore } from "./grant-store";
import { archiveGrantFile } from "./grant";
import { liftKillPause, pauseForKeptGrant, purposeHome } from "./home";

/** What a kill needs of the Perps grant store. */
export type PerpsKillStore = Pick<GrantStore, "revokeForKill">;

/**
 * A HOSTED kill's Perps half, by tenant: its Perps grant is revoked.
 *
 * `coveredSec` is for a kill carried out after it was asked for (honourKill):
 * only a grant stored at or before it is removed, as the Spot half's
 * removeUnlessNewer does, because a Perps grant signed after the kill is the
 * owner's own later decision. "stopped": a grant was revoked. "newer": only one
 * signed after the kill is there, and it stays. "none": there is none. Throws
 * when the store cannot say: the kill is then incomplete.
 */
export async function stopPerpsForKill(
  tenant: `0x${string}`,
  opts: { coveredSec?: number; store?: PerpsKillStore } = {},
): Promise<"stopped" | "newer" | "none"> {
  const store = opts.store ?? getGrantStore("perps");
  const result = await store.revokeForKill(tenant, opts.coveredSec);
  return result === "removed" ? "stopped" : result === "newer" ? "newer" : "none";
}

/**
 * A self-hosted Perps grant that could not be revoked: the archive of its
 * owner key could not be written, so the grant is kept (deleting it would lose
 * that key for good) and its home is paused instead, when it can be.
 */
export class PerpsKillIncomplete extends Error {
  constructor(why: string, readonly paused: boolean) {
    super(`Your Perps wallet's grant was NOT revoked: ${why}, and deleting it without a copy would lose its owner key for good.` +
      (paused ? " Its trading is paused instead." : " Its trading could not be paused either."));
    this.name = "PerpsKillIncomplete";
  }
}

/**
 * Self-hosted is one owner's install, so its kill stops every local Perps
 * wallet: the one grant.json in the Perps home (purposeHome("perps")),
 * archived into that home's own archive first, exactly as the Spot kill keeps
 * its owner key. "none" when there is no such file, without making anything.
 */
export async function stopLocalPerpsForKill(): Promise<"stopped" | "none"> {
  if (isHostedMode()) throw new Error("A hosted kill names its tenant.");
  const home = purposeHome("perps");
  const file = path.join(home, "grant.json");
  try {
    statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
  const kept = archiveGrantFile(file, path.join(home, "grants"));
  if (kept.kind === "failed") throw new PerpsKillIncomplete(kept.why, pauseForKeptGrant(home));
  rmSync(file, { force: true });
  // A pause an earlier, refused kill left in this home has done its job.
  liftKillPause(home);
  return "stopped";
}

/**
 * A self-hosted kill's Perps half for Telegram's answer (kill-confirm.ts):
 * "stopped" when a Perps grant was revoked, null when there was none, and
 * "not-stopped" when it could not be, so the kill is said to be incomplete.
 */
export async function selfHostedPerpsKill(): Promise<"stopped" | "not-stopped" | null> {
  try {
    return (await stopLocalPerpsForKill()) === "stopped" ? "stopped" : null;
  } catch {
    return "not-stopped";
  }
}
