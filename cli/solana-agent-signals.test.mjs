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
function startAgent(t, { detached = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "msa-signal-"));
  const home = path.join(directory, "home");
  const pids = path.join(directory, "pids");
  const network = path.join(directory, "network-attempt");
  const guard = path.join(directory, "guard.mjs");
  writeFileSync(guard, `
import { appendFileSync } from "node:fs";
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
    cli, exited, output: () => output,
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
