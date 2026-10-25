/**
 * The Perps half of `merrymen kill` (cli/bin.mjs), which cannot import the
 * worker: the local Perps wallet's grant is archived and revoked, as the
 * dashboard's and Telegram's self-hosted kills do (stopLocalPerpsForKill).
 * Prints "stopped" or "none"; exits 1 with the reason when it could not.
 */
import { guardStdio } from "./redact-stdio";
import { PerpsKillIncomplete, stopLocalPerpsForKill } from "./perps-kill";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  console.log(await stopLocalPerpsForKill());
} catch (e) {
  console.error(e instanceof PerpsKillIncomplete ? e.message : "The local Perps wallet's grant could not be revoked. Check ~/.merrymen/accounts/perps/.");
  process.exitCode = 1;
}
