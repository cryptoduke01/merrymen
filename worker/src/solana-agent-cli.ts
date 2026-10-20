import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { runSolanaAgent } from "./solana-agent";
import { EX_CONFIG, hostedSolanaRefusals } from "./deploy-guard-checks";

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** IPC message from `merrymen solana-agent`: one per stop request (press) the command itself received. */
export const SOLANA_WORKER_STOP_MESSAGE = "merrymen-solana-worker-stop";
/** After the parent command is gone, how long the current tick may still run before the worker exits anyway. */
export const SOLANA_WORKER_PARENT_GRACE_MS = 60_000;
/**
 * Signals closer together than this are one press delivered twice. A terminal
 * sends Ctrl+C to the whole process group, and a launcher in that group (npm
 * run, npx, a shell wrapper) may forward its own copy within milliseconds: that
 * copy must not force a stop mid-tick. A deliberate second press comes later.
 */
export const SOLANA_WORKER_REPEAT_MS = 500;
/**
 * Set by `merrymen solana-agent` to its own pid for the worker it spawns with
 * an IPC channel. A worker that has this, but whose parent is no longer that
 * process or whose channel is already closed when it starts, was orphaned
 * before it could listen for the close, so it never opens storage or trades.
 */
export const SOLANA_WORKER_IPC_ENV = "MERRYMEN_SOLANA_WORKER_IPC";

/**
 * The command pid a worker must still be the child of (SOLANA_WORKER_IPC_ENV),
 * or undefined when it was not started by `merrymen solana-agent`. A value
 * that is not a pid matches no parent, so the worker refuses to start.
 */
export function solanaWorkerParentPid(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const value = env[SOLANA_WORKER_IPC_ENV];
  if (value === undefined) return undefined;
  return /^[1-9][0-9]{0,9}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : -1;
}

export interface SolanaWorkerStopHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** True while an IPC channel to the parent command is open (until the event loop reads its close). */
  readonly connected?: boolean;
  /** The current parent pid, read when the worker starts; an orphan is re-parented (pid 1 or a subreaper). */
  readonly ppid?: number;
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
  /** Monotonic enough to compare signal times; defaults to Date.now. */
  now?(): number;
  repeatMs?: number;
  /**
   * Started by `merrymen solana-agent` with this pid (solanaWorkerParentPid): a
   * different parent or a closed channel means the command is already gone.
   */
  parentPid?: number;
  /** The finished run's own exit code, used when a stop arrives after the run ended. Defaults to 0. */
  finishedExitCode?(): number;
}

/**
 * Stop handling for the Solana worker.
 *
 * - The first stop request is graceful: the current tick finishes, then the loop exits.
 * - A second signal delivered to this worker forces an exit; a signal within
 *   `repeatMs` of the press it follows is the same press delivered twice and is
 *   ignored. Under `merrymen solana-agent`, the command does not forward signals
 *   as signals; it sends one IPC message per press it received, so a terminal
 *   Ctrl+C (which reaches both processes) still counts once here, and the
 *   command sends `force` on the second press.
 * - When the parent command dies without a signal (SIGKILL, OOM), its IPC channel
 *   closes: the worker stops gracefully and exits anyway after `parentGraceMs`.
 *   The worker learns of the close only when its event loop reads the channel,
 *   which a tick that never yields to it can delay, so the start does not rely
 *   on it: a worker whose parent is no longer the command that started it
 *   (`parentPid`; an orphan is re-parented), or whose channel already reads as
 *   closed, stops at once, and main() never opens storage for it. A command
 *   that dies after that check is a parent lost mid-run, handled as above.
 * - Once the run has finished, nothing is in flight: a stop exits at once with
 *   the run's own exit code, so a late duplicate never turns a clean stop into 130.
 *
 * A forced exit is a crash to the trading store, which is built for one: a
 * paper fill is one database transaction (rolled back if cut short), and a
 * live swap is persisted as signed bytes before it is sent, so a restart only
 * reconciles or rebroadcasts those same bytes. Request IDs come from the
 * durable attempt schedule, so nothing is replayed.
 */
export function installSolanaWorkerStop(host: SolanaWorkerStopHost, options: SolanaWorkerStopOptions): { parentLost(): boolean; finished(): void } {
  const now = options.now ?? Date.now, repeatMs = options.repeatMs ?? SOLANA_WORKER_REPEAT_MS;
  let presses = 0, lastPressAt = 0, stopping = false, finished = false, parentLost = false;
  const stop = (why: string, hint = " Press Ctrl+C again to force.") => {
    if (stopping) return;
    stopping = true;
    options.write(`[solana-worker] ${why}: stopping after the current tick.${hint}\n`);
    options.abort();
  };
  const force = (code: number) => {
    options.write("[solana-worker] forced stop without waiting for the current tick.\n");
    options.exit(code);
  };
  const exitFinished = () => options.exit(options.finishedExitCode?.() ?? 0);
  for (const signal of STOP_SIGNALS) {
    host.on(signal, () => {
      if (finished) return exitFinished();
      const at = now();
      if (presses > 0 && at - lastPressAt < repeatMs) return;
      presses++; lastPressAt = at;
      if (presses >= 2) force(128 + (constants.signals[signal] ?? 0));
      else stop(`${signal} received`);
    });
  }
  const lostParent = () => {
    if (finished || parentLost) return;
    parentLost = true;
    stop("the merrymen solana-agent command that started this worker is gone", ` Exiting in at most ${Math.round((options.parentGraceMs ?? SOLANA_WORKER_PARENT_GRACE_MS) / 1000)} s.`);
    // A run that finished in the meantime has nothing in flight: it ends with its own exit code.
    options.setTimer(() => finished ? exitFinished() : force(1), options.parentGraceMs ?? SOLANA_WORKER_PARENT_GRACE_MS).unref?.();
  };
  if (host.connected) {
    host.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== SOLANA_WORKER_STOP_MESSAGE) return;
      if (finished) return exitFinished();
      if ((message as { force?: unknown }).force === true) force(130);
      else stop("stop requested by merrymen solana-agent");
    });
    host.on("disconnect", lostParent);
  }
  // Orphaned before these listeners existed: re-parented, or the close was already read.
  if (options.parentPid !== undefined && (!host.connected || host.ppid !== options.parentPid)) lostParent();
  return {
    /** True once the command that started this worker is known to be gone. */
    parentLost: () => parentLost,
    finished() {
      finished = true;
      // An open IPC channel with listeners keeps this process alive.
      if (host.connected) host.disconnect?.();
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("merrymen solana-agent\nRuns explicitly enabled Solana rebalancing strategies in each account's selected paper or live mode. Configure the authenticated app, private RPC/Jupiter settings and shared storage first. Live mode additionally requires a verified immutable vault deployment and an owner-approved session.\n"
      + "Stopping: Ctrl+C (or SIGTERM/SIGHUP) stops after the current tick; press it again to force a stop, which the trading store recovers from like a crash. "
      + "If the merrymen command that started the worker is killed, the worker stops after its tick and exits within 60 s.\n");
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
    parentPid: solanaWorkerParentPid(process.env),
    finishedExitCode: () => typeof process.exitCode === "number" ? process.exitCode : 0,
  });
  // One turn of the event loop before storage opens: a channel close that is
  // already readable is read now (the parent check above is the sure one).
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Orphaned before it started (its command is already gone), or stopped
  // already: never open storage or trade.
  if (controller.signal.aborted) { if (stop.parentLost()) process.exitCode = 1; stop.finished(); return; }
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
if (isEntryPoint()) await main();
