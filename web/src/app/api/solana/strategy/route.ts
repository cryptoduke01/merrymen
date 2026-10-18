import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { validateSolanaStrategy } from "@/lib/solana-binding-store";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { principal, store, binding } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["strategy", "revision"]);
    if (typeof body.revision !== "number") throw new SolanaWebError(400, "Refresh before saving your Solana strategy.");
    const strategy = validateSolanaStrategy(body.strategy);
    if (strategy.enabled && (!binding.limits || BigInt(strategy.tradeUsdgRaw) > BigInt(binding.limits.perTradeUsdg))) {
      throw new SolanaWebError(400, "Save trading limits first and keep each strategy trade within the per-trade limit.");
    }
    return { binding: await store.strategy(principal.tenant, binding.owner, body.revision, strategy) };
  });
}
