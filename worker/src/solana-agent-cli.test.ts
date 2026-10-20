/**
 * The Solana worker's forced stop against the trading store's crash recovery.
 *
 * A real worker process (this file, run as a child) trades a paper account in
 * a SQLite file with the real store and runtime and the real stop handling,
 * and is forced to exit with process.exit mid-tick: inside the paper fill's
 * database transaction, or right after it committed. A restarted worker on the
 * same file must find either no fill or exactly the one fill, and never fill
 * the same attempt twice. No network: the market and the RPC are fakes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { createSolanaAgent } from "./solana-agent";
import { installSolanaWorkerStop, SOLANA_WORKER_REPEAT_MS } from "./solana-agent-cli";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import { wrapSqlite, type Db } from "./db";
import type { SolanaPaperMarket } from "./solana-paper-service";

const NOW = 1_000_000;
const TENANT = "0x1111111111111111111111111111111111111111", OWNER = "So11111111111111111111111111111111111111112";
const LIMITS = { perTradeUsdg: "10000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 1_000_000 };
const STRATEGY = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "5000000", intervalSeconds: 60 };
const INITIAL_CASH = 100_000_000n;
// Settings revision 2 (the limits, then the strategy), first attempt: the request ID the strategy's first fill uses.
const REQUEST = "rebalance-2-0";
const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
type Point = "in-commit" | "after-commit";

const market: SolanaPaperMarket = {
  readMint: async (mint) => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
  quote: async (i) => ({ source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
    outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
    contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 }),
};
const rpc = { read: async () => { throw new Error("No live RPC in a paper worker"); }, send: async () => { throw new Error("Must never send"); } };

function open(file: string): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(file);
  // The worker's own settings (solana-runtime-db.ts).
  raw.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  return { raw, db: wrapSqlite(raw) };
}
const runtimeFor = (db: Db) => createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });

/** Every statement whose SQL matches `pattern` waits for `pause` first, also inside transactions. */
function hooked(db: Db, pattern: RegExp, pause: () => Promise<void>): Db {
  const wrap = (inner: Db): Db => ({
    prepare(sql) {
      const statement = inner.prepare(sql);
      if (!pattern.test(sql)) return statement;
      return { ...statement, run: async (...params) => { await pause(); return statement.run(...params); } };
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((scoped) => fn(wrap(scoped))),
  });
  return wrap(db);
}

/** The worker process: one tick that stops at `point` until a signal ends it. */
async function crashChild(point: Point, file: string): Promise<void> {
  const { db: base } = open(file);
  const pause = () => {
    process.stdout.write(`paused ${point}\n`);
    setInterval(() => {}, 1_000);
    return new Promise<void>(() => {});
  };
  const db = point === "in-commit" ? hooked(base, /^UPDATE solana_runtime_paper_books SET book_json/, pause) : base;
  const actual = runtimeFor(db);
  const runtime = point === "after-commit"
    ? { status: actual.status, trade: async (...args: Parameters<typeof actual.trade>) => { const receipt = await actual.trade(...args); await pause(); return receipt; } }
    : actual;
  const controller = new AbortController();
  // The worker's real stop handling, as solana-agent-cli.ts installs it.
  installSolanaWorkerStop(process, { abort: () => controller.abort(), exit: (code) => process.exit(code),
    write: (text) => { process.stderr.write(text); }, setTimer: (callback, ms) => setTimeout(callback, ms) });
  await createSolanaAgent({ db, runtime, market, now: () => NOW, signal: controller.signal }).tick();
  process.stdout.write("tick finished\n");
}

async function seed(file: string): Promise<void> {
  const { raw, db } = open(file);
  try {
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.bind(TENANT, "did:privy:crash", OWNER);
    await bindings.settings(TENANT, OWNER, 0, "paper", LIMITS);
    await runtimeFor(db).setupPaper({ tenant: TENANT, owner: OWNER }, { initialCashRaw: INITIAL_CASH.toString(), limits: LIMITS });
    await bindings.strategy(TENANT, OWNER, 1, STRATEGY);
  } finally { raw.close(); }
}

async function book(db: Db) {
  const paper = (await runtimeFor(db).status({ tenant: TENANT, owner: OWNER }, { liveReads: false })).paper!;
  const attempts = await db.prepare("SELECT request_id FROM solana_runtime_autonomous_attempts WHERE tenant=? AND owner=?").all(TENANT, OWNER) as Array<{ request_id: string }>;
  return { cash: BigInt(paper.cashRaw), trades: paper.trades.map((trade) => trade.requestId), attempts: attempts.map((row) => row.request_id),
    wsol: paper.positions.map((position) => position.amountRaw) };
}

const childPoint = process.env.MERRYMEN_SOLANA_CRASH_CHILD as Point | undefined;
if (childPoint) {
  await crashChild(childPoint, process.env.MERRYMEN_SOLANA_CRASH_DB!);
} else {
  for (const point of ["in-commit", "after-commit"] as const) {
    test(`a forced stop ${point === "in-commit" ? "inside a paper fill's transaction" : "right after a paper fill committed"} is recovered by a restart without a second fill`,
      { skip: process.platform === "win32", timeout: 90_000 }, async (t) => {
        const directory = mkdtempSync(path.join(tmpdir(), "solana-crash-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const file = path.join(directory, "solana-accounts.sqlite");
        await seed(file);

        const child = spawn(process.execPath, ["--import", "tsx", THIS_FILE], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, MERRYMEN_SOLANA_CRASH_CHILD: point, MERRYMEN_SOLANA_CRASH_DB: file } });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const exited = once(child, "exit");
        for (const deadline = Date.now() + 60_000; !output.includes(`paused ${point}`);) {
          if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the worker never reached ${point}:\n${output}`);
          await delay(50);
        }
        // One Ctrl+C delivered twice (the terminal's copy and a launcher's) asks for a graceful stop, which waits for the tick.
        const sentAt = performance.now();
        child.kill("SIGINT");
        await delay(50);
        child.kill("SIGINT");
        const gap = performance.now() - sentAt;
        await delay(SOLANA_WORKER_REPEAT_MS + 300);
        if (gap < SOLANA_WORKER_REPEAT_MS / 2) {
          assert.equal(child.exitCode, null, `one press must not force a stop mid-tick:\n${output}`);
          assert.match(output, /stopping after the current tick/);
        } else {
          // This process stalled between the copies, so they may have been two
          // presses and forced the stop already: still a forced exit mid-tick.
          t.diagnostic(`the two copies went out ${Math.round(gap)} ms apart: the duplicate check is inconclusive`);
        }
        // The second press forces it: process.exit with the transaction (or the tick) unfinished.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        const [code, signal] = await exited;
        assert.deepEqual([code, signal], [130, null], output);
        assert.match(output, /forced stop without waiting for the current tick/);
        assert.doesNotMatch(output, /tick finished/);

        // Restart: a new worker on the same file.
        const { raw, db } = open(file);
        try {
          const after = await book(db);
          if (point === "in-commit") {
            assert.deepEqual(after, { cash: INITIAL_CASH, trades: [], attempts: [], wsol: [] }, "the cut-short fill left nothing behind");
          } else {
            assert.deepEqual([after.trades, after.attempts], [[REQUEST], [REQUEST]], "the committed fill is durable");
          }
          const agent = createSolanaAgent({ db, runtime: runtimeFor(db), market, now: () => NOW, signal: new AbortController().signal });
          const outcomes = (await agent.tick()).map((result) => result.outcome);
          assert.deepEqual(outcomes, [point === "in-commit" ? "submitted" : "waiting"]);
          assert.deepEqual((await agent.tick()).map((result) => result.outcome), ["waiting"], "nothing more in the same interval");
          const final = await book(db);
          assert.deepEqual([final.trades, final.attempts], [[REQUEST], [REQUEST]], "exactly one fill for the attempt");
          assert.equal(final.cash, INITIAL_CASH - 5_000_000n, "the cash moved once");
          assert.equal(final.wsol.length, 1);
        } finally { raw.close(); }
      });
  }
}
