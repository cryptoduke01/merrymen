import { requireSolanaLiveSellLimits, validateSolanaPaperLimits } from "../../../../../../packages/core/src/solana";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { principal, store, binding } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mode", "limits", "revision", "liveConsent"]);
    if ((body.mode !== "paper" && body.mode !== "live") || typeof body.revision !== "number"
      || (body.mode === "live" && body.liveConsent !== true)) throw new SolanaWebError(400, "Review and explicitly confirm your Solana trading mode.");
    const limits = validateSolanaPaperLimits(body.limits, Date.now());
    if (body.mode === "live") {
      try { requireSolanaLiveSellLimits(limits); } catch { throw new SolanaWebError(400, "Set how much SOL a live trade and a live day may sell."); }
    }
    return { binding: await store.settings(principal.tenant, binding.owner, body.revision, body.mode, limits) };
  });
}
