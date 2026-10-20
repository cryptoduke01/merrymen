import { runSolanaResolveCommand, SolanaResolveError } from "./solana-resolve";
import { SolanaRpcError } from "./solana-rpc";
import { getSolanaRuntimeDb } from "./solana-runtime-db";

try {
  console.log(await runSolanaResolveCommand(process.argv.slice(2), { db: await getSolanaRuntimeDb(), postgres: !!process.env.DATABASE_URL }));
} catch (error) {
  // Fixed messages only: no connection strings, endpoint URLs, provider text or stack traces.
  const known = error instanceof SolanaResolveError || error instanceof SolanaRpcError;
  console.error(known ? error.message : "The pending Solana trade could not be read or resolved. Check the shared database and the RPC settings; nothing was booked.");
  process.exitCode = 1;
}
