import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mode", "intent", "action"]);
    if ((body.mode !== "paper" && body.mode !== "live") || body.mode !== binding.requestedMode
      || (body.action !== "preview" && body.action !== "trade")) throw new SolanaWebError(409, "Refresh and confirm the current Solana trading mode before placing this request.");
    const app = getSolanaAppRuntime();
    const input: { mode: "paper" | "live"; intent: unknown } = { mode: body.mode, intent: body.intent };
    return body.action === "preview" ? { preview: await app.preview(scope, input) } : { receipt: await app.trade(scope, input) };
  });
}
