import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { installSolanaWorkerStop, SOLANA_WORKER_PARENT_GRACE_MS, SOLANA_WORKER_STOP_MESSAGE } from "../worker/src/solana-agent-cli.ts";

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
// POSIX signals only: on Windows the console delivers Ctrl+C to the child itself.
const posix = process.platform !== "win32";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

/**
 * The real `merrymen solana-agent` command and its real TypeScript worker, with
 * a temporary home, no bindings, no keys and every network call refused.
 */
function startAgent(t, { detached = false, wedge = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "msa-signal-"));
  const home = path.join(directory, "home");
  const pids = path.join(directory, "pids");
  const network = path.join(directory, "network-attempt");
  const wedgeFile = path.join(directory, "wedge");
  const guard = path.join(directory, "guard.mjs");
  writeFileSync(guard, `
import { appendFileSync, existsSync } from "node:fs";
// A wedged worker: once the file appears, its event loop never runs again, so
// neither signals nor IPC messages reach its JavaScript handlers.
if (${JSON.stringify(wedge)} && process.argv.some((arg) => arg.endsWith("solana-agent-cli.ts"))) {
  setInterval(() => { if (existsSync(${JSON.stringify(wedgeFile)})) for (;;) {} }, 20).unref();
}
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\t" + process.argv.slice(1).join(" ") + "\\n");
const refuse = () => { appendFileSync(${JSON.stringify(network)}, "attempt\\n"); throw new Error("network disabled"); };
globalThis.fetch = async () => refuse();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "object" && typeof options?.path === "string" && options.port === undefined) ||
      (typeof options === "string" && !/^[0-9]+$/.test(options))) return connect.apply(this, args);
  return refuse();
};
syncBuiltinESMExports();
`);
  const env = {
    MERRYMEN_HOME: home, NO_COLOR: "1", NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    // Configured but never contacted: the worker has no bindings to trade.
    MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example.invalid/",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const cli = spawn(process.execPath, [BIN, "solana-agent"], {
    cwd: directory, env, detached, stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  let output = "";
  cli.stdout.on("data", (chunk) => { output += chunk; });
  cli.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(cli, "exit");
  let worker;
  t.after(async () => {
    for (const pid of [worker, cli.pid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await delay(100);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    cli, exited, output: () => output, wedge: () => writeFileSync(wedgeFile, ""),
    networkAttempted: () => existsSync(network),
    /** Resolves once the worker's first tick wrote its heartbeat, after it installed its handlers. */
    async ready() {
      worker = await until(() => {
        if (!existsSync(pids)) return null;
        const line = readFileSync(pids, "utf8").split("\n").find((entry) => entry.includes("solana-agent-cli.ts"));
        return line ? Number(line.split("\t")[0]) : null;
      }, 20_000, "the Solana worker process");
      const db = path.join(home, "solana-accounts.sqlite");
      await until(() => {
        if (!existsSync(db)) return false;
        const raw = new DatabaseSync(db, { readOnly: true });
        try {
          return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE name='solana_runtime_worker_heartbeat'").get()
            && !!raw.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get();
        } catch { return false; } finally { raw.close(); }
      }, 20_000, "the worker heartbeat");
      assert.equal(alive(worker), true);
      return worker;
    },
  };
}

test("SIGTERM to the solana-agent CLI stops its worker and exits with it", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  // A pid-based stop (kill, a supervisor, nohup) reaches only the CLI process.
  process.kill(agent.cli.pid, "SIGTERM");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.equal(signal, null, `the CLI died on the signal instead of waiting for its worker:\n${agent.output()}`);
  assert.equal(code, 0, agent.output());
  // The CLI exits only from the worker's exit, so the worker is already gone.
  assert.equal(alive(worker), false, "the worker kept running as an orphan after the CLI stopped");
  assert.equal(agent.networkAttempted(), false);
});

test("SIGINT to the CLI alone also reaches the worker", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  process.kill(agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], agent.output());
  assert.equal(alive(worker), false);
});

test("Ctrl+C to the whole process group stops the worker gracefully, not on the forwarded duplicate", { skip: !posix, timeout: 60_000 }, async (t) => {
  // A terminal delivers SIGINT to the CLI and the worker; the CLI then forwards
  // the same signal. The duplicate must not kill the worker mid-tick.
  const agent = startAgent(t, { detached: true });
  const worker = await agent.ready();
  process.kill(-agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], `the worker did not finish its graceful stop:\n${agent.output()}`);
  assert.equal(alive(worker), false);
});

test("SIGKILL of the CLI (or the OOM killer) still stops its worker", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  // Nothing can be forwarded: the worker notices its IPC channel close.
  process.kill(agent.cli.pid, "SIGKILL");
  await agent.exited;
  await until(() => !alive(worker), 20_000, "the orphaned worker to stop");
  assert.equal(agent.networkAttempted(), false);
});

test("a second Ctrl+C forces a wedged worker to stop", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t, { wedge: true });
  const worker = await agent.ready();
  agent.wedge();
  await delay(300);
  process.kill(agent.cli.pid, "SIGINT");
  await delay(1_000);
  assert.equal(alive(worker), true, "the first press only asks for a graceful stop");
  const started = Date.now();
  process.kill(agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [137, null], `the CLI did not force the stop:\n${agent.output()}`);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(alive(worker), false);
  assert.match(agent.output(), /Forcing the Solana worker to stop/);
});

test("the first Ctrl+C says the stop waits for the tick and how to force it", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t, { detached: true });
  await agent.ready();
  process.kill(-agent.cli.pid, "SIGINT");
  const [code] = await agent.exited;
  assert.equal(code, 0, agent.output());
  const notices = agent.output().match(/stopping after the current tick\. Press Ctrl\+C again to force\./g) ?? [];
  assert.equal(notices.length, 1, `one press, one notice, although it reached the worker twice:\n${agent.output()}`);
});

/** The worker's stop handling, driven directly: a fake process, abort, exit and timers. */
function stopHarness({ connected = true } = {}) {
  const host = Object.assign(new EventEmitter(), { connected, disconnected: 0, disconnect() { this.disconnected++; this.connected = false; } });
  const events = { aborts: 0, exits: [], writes: [], timers: [] };
  const handle = installSolanaWorkerStop(host, {
    abort: () => { events.aborts++; }, exit: (code) => { events.exits.push(code); }, write: (text) => { events.writes.push(text); },
    setTimer: (callback, ms) => { const timer = { callback, ms, unrefed: false, unref() { this.unrefed = true; } }; events.timers.push(timer); return timer; },
  });
  return { host, events, handle };
}

test("worker stop: the first signal is graceful, a second one forces the exit", () => {
  for (const [first, second, code] of [["SIGINT", "SIGINT", 130], ["SIGTERM", "SIGTERM", 143], ["SIGHUP", "SIGINT", 130]]) {
    for (const connected of [true, false]) {
      const { host, events } = stopHarness({ connected });
      host.emit(first);
      assert.deepEqual([events.aborts, events.exits], [1, []]);
      assert.match(events.writes.join(""), /stopping after the current tick\. Press Ctrl\+C again to force/);
      host.emit(second);
      assert.deepEqual(events.exits, [code], `${first} then ${second}`);
      assert.equal(events.aborts, 1);
    }
  }
});

test("worker stop: the command's message for the same press does not count twice; its force message forces", () => {
  const { host, events } = stopHarness();
  // One terminal Ctrl+C: the signal reaches the worker, and the command reports its own copy.
  host.emit("SIGINT");
  host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: false, signal: "SIGINT" });
  for (const junk of [null, "stop", { type: "other", force: true }, { type: SOLANA_WORKER_STOP_MESSAGE, force: "yes" }]) host.emit("message", junk);
  assert.deepEqual([events.aborts, events.exits], [1, []]);
  assert.equal(events.writes.length, 1);
  host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: true, signal: "SIGINT" });
  assert.deepEqual(events.exits, [130]);
  // A stop the command alone received (a pid-based kill) is graceful.
  const solo = stopHarness();
  solo.host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: false, signal: "SIGTERM" });
  assert.deepEqual([solo.events.aborts, solo.events.exits], [1, []]);
});

test("worker stop: losing the parent stops gracefully, then forces after the grace period", () => {
  const { host, events } = stopHarness();
  host.emit("disconnect");
  assert.equal(events.aborts, 1);
  assert.match(events.writes.join(""), /command that started this worker is gone/);
  assert.equal(events.timers.length, 1);
  assert.equal(events.timers[0].ms, SOLANA_WORKER_PARENT_GRACE_MS);
  assert.equal(events.timers[0].unrefed, true, "a finished tick still lets the process exit at once");
  assert.deepEqual(events.exits, []);
  events.timers[0].callback();
  assert.deepEqual(events.exits, [1]);
});

test("worker stop: a finished worker closes its channel, and that close is not a lost parent", () => {
  const { host, events, handle } = stopHarness();
  handle.finished();
  assert.equal(host.disconnected, 1, "an open IPC channel with listeners would keep the process alive");
  host.emit("disconnect");
  assert.deepEqual([events.aborts, events.timers.length, events.writes.length], [0, 0, 0]);
  // Without a channel nothing listens for messages or disconnects.
  const plain = stopHarness({ connected: false });
  assert.equal(plain.host.listenerCount("message") + plain.host.listenerCount("disconnect"), 0);
  plain.handle.finished();
  assert.equal(plain.host.disconnected, 0);
});
