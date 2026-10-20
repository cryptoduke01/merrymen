import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { runSolanaAgent } from "./solana-agent";
import { EX_CONFIG, hostedSolanaRefusals } from "./deploy-guard-checks";

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** IPC message from `merrymen solana-agent`: one per signal the command itself received. */
export const SOLANA_WORKER_STOP_MESSAGE = "merrymen-solana-worker-stop";
/** After the parent command is gone, how long the current tick may still run before the worker exits anyway. */
export const SOLANA_WORKER_PARENT_GRACE_MS = 60_000;

export interface SolanaWorkerStopHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** True while an IPC channel to the parent command is open. */
  readonly connected?: boolean;
  disconnect?(): void;
}
export interface SolanaWorkerStopOptions {
  /** Graceful stop: the current tick finishes, then the loop exits. */
  abort(): void;
  /** Forced stop, without waiting for the tick. Must not return control to the tick. */
  exit(code: number): void;
  write(text: string): void;
  setTimer(callback: () => void, ms: number): { unref?(): unknown };
  parentGraceMs?: number;
}

/**
 * Stop handling for the Solana worker.
 *
 * - The first stop request is graceful: the current tick finishes, then the loop exits.
 * - A second signal delivered to this worker forces an exit. When the worker runs under
 *   `merrymen solana-agent`, that command no longer forwards signals as signals; it sends
 *   one IPC message per signal it received, so a terminal Ctrl+C (which reaches both
 *   processes) still counts once here, and the command sends `force` on the second press.
 * - When the parent command dies without a signal (SIGKILL, OOM), its IPC channel closes:
 *   the worker stops gracefully and exits anyway after `parentGraceMs`. A forced exit is a
 *   crash to the trading store, which is built to recover from one without replaying.
 */
export function installSolanaWorkerStop(host: SolanaWorkerStopHost, options: SolanaWorkerStopOptions): { finished(): void } {
  let signals = 0, stopping = false, finished = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    options.write(`[solana-worker] ${why}: stopping after the current tick. Press Ctrl+C again to force.\n`);
    options.abort();
  };
  const force = (code: number) => {
    options.write("[solana-worker] forced stop without waiting for the current tick.\n");
    options.exit(code);
  };
  for (const signal of STOP_SIGNALS) {
    host.on(signal, () => {
      signals++;
      if (signals >= 2) force(128 + (constants.signals[signal] ?? 0));
      else stop(`${signal} received`);
    });
  }
  if (host.connected) {
    host.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== SOLANA_WORKER_STOP_MESSAGE) return;
      if ((message as { force?: unknown }).force === true) force(130);
      else stop("stop requested by merrymen solana-agent");
    });
    host.on("disconnect", () => {
      if (finished) return;
      stop("the merrymen solana-agent command that started this worker is gone");
      options.setTimer(() => force(1), options.parentGraceMs ?? SOLANA_WORKER_PARENT_GRACE_MS).unref?.();
    });
  }
  return {
    finished() {
      finished = true;
      // An open IPC channel with listeners keeps this process alive.
      if (host.connected) host.disconnect?.();
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("merrymen solana-agent\nRuns explicitly enabled Solana rebalancing strategies in each account's selected paper or live mode. Configure the authenticated app, private RPC/Jupiter settings and shared storage first. Live mode additionally requires a verified immutable vault deployment and an owner-approved session.\nCtrl+C stops after the current tick; press it again to force.\n");
    return;
  }
  if (args.length) { process.stderr.write("Unsupported Solana worker arguments. Use --help.\n"); process.exitCode = 2; return; }
  const refusals = hostedSolanaRefusals(process.env);
  if (refusals.length) {
    for (const reason of refusals) process.stderr.write(`[solana-worker] refused: ${reason}\n`);
    process.exitCode = EX_CONFIG;
    return;
  }
  const controller = new AbortController();
  const stop = installSolanaWorkerStop(process, {
    abort: () => controller.abort(),
    exit: (code) => process.exit(code),
    write: (text) => { process.stderr.write(text); },
    setTimer: (callback, ms) => setTimeout(callback, ms),
  });
  runSolanaAgent(controller.signal).catch(() => {
    process.stderr.write("Solana worker could not start. Verify its private configuration and shared database.\n");
    process.exitCode = 1;
  }).finally(() => stop.finished());
}

// Run only as the entry point; tests import installSolanaWorkerStop without starting a worker.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntryPoint()) main();
