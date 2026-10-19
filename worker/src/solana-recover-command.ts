/** `merrymen solana-recover`: argument parsing and key input for the owner recovery tool. */
import { readFileSync, statSync } from "node:fs";
import { base58Decode } from "../../packages/core/src/ids";
import { createSolanaLiveRpc } from "./solana-live-rpc";
import { readSolanaOwnerKey, runSolanaRecovery, SOLANA_RECOVER_KEY_MAX_BYTES, SolanaRecoverError, type SolanaRecoveryResult } from "./solana-recover";

export const SOLANA_RECOVER_HELP = `Solana vault recovery: withdraw everything from your Merrymen Solana vault
with your own wallet key, without the Merrymen app or server.

solana-recover --program PROGRAM_ID --rpc HTTPS_URL --owner PUBLIC_KEY
    Show the plan: vault, balances and the transactions it would send.
solana-recover --program PROGRAM_ID --rpc HTTPS_URL --key-file PATH --send
    Sign and send. Use --key-file - to read the key from standard input,
    for example: pbpaste | merrymen solana-recover ... --key-file - --send
Options: --program-sha256 HEX verifies the deployed program binary first.

Steps: (1) revoke_all, alone, waiting until it is finalized, so no session
key can trade; (2) from finalized balances, create your USDG and WSOL token
accounts if needed and withdraw all USDG, all WSOL and the vault's spare
SOL to your wallet. Funds only ever move from the vault to the owner.
Nothing is sent without --send. Each transaction is sent once; if one does
not finalize, run the command again: it re-reads the chain first.

The key is your exported Solana wallet secret key (base58, or a
solana-keygen JSON file). It is read only from the file or standard input,
never from the command line, and is never printed, logged or sent anywhere.
Delete the key file when you are done. PROGRAM_ID is the program shown
next to your vault in Merrymen (the owner of the vault account). The RPC
must be a mainnet-beta HTTPS endpoint you trust; the owner pays the fees.`;

const VALUE_FLAGS = new Set(["program", "rpc", "key-file", "owner", "program-sha256"]);
const BOOLEAN_FLAGS = new Set(["send"]);

/** True for text that decodes as a 64-byte secret key, in either export format. */
function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (text.startsWith("[")) return text.split(",").length >= 32;
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(text)) return false;
  return base58Decode(text)?.length === 64;
}

function parse(args: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = Object.create(null);
  const refuse = (): never => {
    // Never echo an argument: a pasted key must not reach the terminal or logs.
    const leaked = args.some(looksLikeSecret);
    throw new SolanaRecoverError("Unsupported, repeated or missing option. The key is read only from --key-file PATH or --key-file - (standard input), never from the command line. Run solana-recover --help."
      + (leaked ? " A secret key appears in the command line: clear it from your shell history and treat that key as exposed." : ""));
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) refuse();
    const key = arg.slice(2);
    if (Object.hasOwn(flags, key)) refuse();
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const value = args[i + 1];
    if (!VALUE_FLAGS.has(key) || value === undefined || value.startsWith("--") || !value.length || value.length > 2048) refuse();
    if (key !== "key-file" && looksLikeSecret(value!)) refuse();
    flags[key] = value!;
    i++;
  }
  return flags;
}

export interface SolanaRecoverCommandDeps {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Standard input, read only for --key-file -. */
  stdin?: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  pollMs?: number;
}

async function readKeyText(source: string, deps: SolanaRecoverCommandDeps): Promise<string> {
  const tooLarge = () => { throw new SolanaRecoverError("The key input is too large to be a Solana secret key."); };
  if (source === "-") {
    const stdin = deps.stdin ?? process.stdin;
    if (stdin.isTTY) throw new SolanaRecoverError("Standard input is a terminal. Pipe the key in (for example: pbpaste | merrymen solana-recover ... --key-file -) or pass a file path.");
    let text = "";
    for await (const chunk of stdin) {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(text) > SOLANA_RECOVER_KEY_MAX_BYTES) tooLarge();
    }
    return text;
  }
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(source); } catch { throw new SolanaRecoverError("The key file could not be read."); }
  if (!stats.isFile()) throw new SolanaRecoverError("The key file could not be read.");
  if (stats.size > SOLANA_RECOVER_KEY_MAX_BYTES) tooLarge();
  if (process.platform !== "win32" && (Number(stats.mode) & 0o077)) {
    (deps.warn ?? console.error)("Warning: the key file can be read by other users on this machine. Delete it when you are done.");
  }
  try { return readFileSync(source, "utf8"); } catch { throw new SolanaRecoverError("The key file could not be read."); }
}

export async function runSolanaRecoverCommand(args: readonly string[], deps: SolanaRecoverCommandDeps = {}): Promise<SolanaRecoveryResult | string> {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) return SOLANA_RECOVER_HELP;
  if (!args.length) return SOLANA_RECOVER_HELP;
  const flags = parse(args);
  const text = (key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const programId = text("program"), rpcUrl = text("rpc"), keyFile = text("key-file"), expectedOwner = text("owner");
  const send = flags.send === true;
  if (!programId) throw new SolanaRecoverError("--program is required: the program shown next to your vault in Merrymen.");
  if (!rpcUrl) throw new SolanaRecoverError("--rpc is required: a mainnet-beta HTTPS RPC endpoint you trust.");
  if (send && !keyFile) throw new SolanaRecoverError("--send needs --key-file PATH (or --key-file - for standard input).");
  if (!keyFile && !expectedOwner) throw new SolanaRecoverError("Give --owner PUBLIC_KEY for a plan, or --key-file to derive it from your key.");
  const sha = text("program-sha256");
  if (sha !== undefined && !/^[a-f0-9]{64}$/.test(sha)) throw new SolanaRecoverError("--program-sha256 must be 64 lowercase hex characters.");
  // The RPC URL can carry an API key: it is validated, used, and never printed.
  const rpc = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: rpcUrl }, fetch: deps.fetch, timeoutMs: 15_000 });

  let key: Awaited<ReturnType<typeof readSolanaOwnerKey>> | undefined;
  if (keyFile) {
    key = await readSolanaOwnerKey(await readKeyText(keyFile, deps));
    if (expectedOwner !== undefined && expectedOwner !== key.owner) {
      throw new SolanaRecoverError(`The key belongs to ${key.owner}, not to --owner ${expectedOwner}. Nothing was sent.`);
    }
  }
  const log = deps.log ?? ((line: string) => console.log(line));
  const result = await runSolanaRecovery({ rpc, programId, owner: key?.owner ?? expectedOwner!, keyPair: key?.keyPair, send, programSha256: sha },
    { log, sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), maxWaitMs: deps.maxWaitMs, pollMs: deps.pollMs });
  if (keyFile && keyFile !== "-") log("Delete the exported key file now: anyone who has it controls this wallet.");
  return result;
}
