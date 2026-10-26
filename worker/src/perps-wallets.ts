/**
 * EVERY PERPS WALLET THIS FLEET HAS RUN A WORKER FOR — what every public read
 * leaves out (docs/perps.md rule 17: perps are never published in v1).
 *
 * A hosted Perps worker has an `agents` row like any agent: its own accounting
 * needs one (the epoch its paper checkpoint is joined on, its peaks, its
 * report), and the mirror copies it to the shared ledger. But the public
 * directory and leaderboard list `agents` rows, and nothing on the row says
 * which wallet it is — the worker that wrote it is the Perps wallet's, and
 * only the orchestrator knows that for a fact. So the orchestrator records the
 * account here, in the shared database, BEFORE it first starts a worker for it
 * (spawnChild): there is never a moment when a Perps agent's row exists in the
 * shared ledger and this table does not name it. A recording that fails starts
 * no worker.
 *
 * Never deleted: a Perps wallet that was killed or expired is still a Perps
 * wallet, and its rows are still in the shared ledger. Made only when the
 * first Perps worker is about to start, so a fleet with none has no table, and
 * every reader treats an absent table as naming nobody.
 */
import type { Db } from "./db";

export const PERPS_WALLETS_DDL = `CREATE TABLE IF NOT EXISTS perps_wallets (
  smart_account TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  first_seen_at BIGINT NOT NULL
)`;

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Record a Perps wallet before its worker first starts. Idempotent; throws when it could not be written. */
export async function recordPerpsWallet(db: Db, w: { smartAccount: string; owner: string; chainId: number; nowSec: number }): Promise<void> {
  const account = w.smartAccount.toLowerCase(), owner = w.owner.toLowerCase();
  if (!ADDRESS.test(account) || !ADDRESS.test(owner) || !Number.isSafeInteger(w.chainId)) throw new Error("not a Perps wallet to record");
  await db.exec(PERPS_WALLETS_DDL);
  await db
    .prepare("INSERT INTO perps_wallets (smart_account, owner, chain_id, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (smart_account) DO NOTHING")
    .run(account, owner, w.chainId, w.nowSec);
}

function missingTable(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === "42P01" || /no such table: (?:main\.)?perps_wallets\b/.test(String(err?.message ?? ""));
}

/**
 * The Perps wallets on record, lowercased: an absent table names nobody.
 * THROWS when the table is there and cannot be read — a public read that
 * cannot tell a Perps wallet from a Spot one must say it could not read, never
 * publish both (each caller's own unread answer).
 */
export async function readPerpsWallets(db: Pick<Db, "prepare">): Promise<ReadonlySet<string>> {
  try {
    const rows = (await db.prepare("SELECT smart_account FROM perps_wallets").all()) as Array<{ smart_account: unknown }>;
    return new Set(rows.map((r) => String(r.smart_account).toLowerCase()));
  } catch (e) {
    if (missingTable(e)) return new Set();
    throw e;
  }
}
