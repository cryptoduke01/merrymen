import { probeSolanaMainnetRpc, readSolanaMainnetRpcConfig, SolanaRpcError } from "./solana-rpc";

try {
  const result = await probeSolanaMainnetRpc(readSolanaMainnetRpcConfig());
  console.log(`Solana RPC: ${result.cluster} identity verified; healthy; finalized slot ${result.slot}.`);
  console.log("This read-only check does not enable Solana trading or verify trade readiness.");
} catch (error) {
  // The diagnostic must never print credentials, provider text, or stack traces.
  console.error(error instanceof SolanaRpcError ? error.message : "Solana RPC check failed.");
  process.exitCode = 1;
}
