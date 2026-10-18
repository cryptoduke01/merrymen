import { runSolanaAgent } from "./solana-agent";
import { EX_CONFIG, hostedSolanaRefusals } from "./deploy-guard-checks";
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
  process.stdout.write("merrymen solana-agent\nRuns explicitly enabled Solana rebalancing strategies in each account's selected paper or live mode. Configure the authenticated app, private RPC/Jupiter settings and shared storage first. Live mode additionally requires a verified immutable vault deployment and an owner-approved session.\n");
} else if (args.length) {
  process.stderr.write("Unsupported Solana worker arguments. Use --help.\n"); process.exitCode = 2;
} else {
  const refusals = hostedSolanaRefusals(process.env);
  if (refusals.length) {
    for (const reason of refusals) process.stderr.write(`[solana-worker] refused: ${reason}\n`);
    process.exitCode = EX_CONFIG;
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    runSolanaAgent(controller.signal).catch(() => {
      process.stderr.write("Solana worker could not start. Verify its private configuration and shared database.\n");
      process.exitCode = 1;
    });
  }
}
