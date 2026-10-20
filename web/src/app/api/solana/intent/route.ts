import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { takeSolanaIntentToken } from "./throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { principal, binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mode", "intent", "action"]);
    if ((body.mode !== "paper" && body.mode !== "live") || body.mode !== binding.requestedMode
      || (body.action !== "preview" && body.action !== "trade")) throw new SolanaWebError(409, "Refresh and confirm the current Solana trading mode before placing this request.");
    const action = body.action;
    const wait = takeSolanaIntentToken(principal.tenant, action);
    if (wait !== null) {
      const seconds = `${wait} second${wait === 1 ? "" : "s"}`;
      throw new SolanaWebError(429, action === "preview" ? `Too many Solana previews. Try again in ${seconds}.`
        : `Too many Solana trade requests. Nothing was sent. Try again in ${seconds}.`);
    }
    const app = getSolanaAppRuntime();
    const input: { mode: "paper" | "live"; intent: unknown } = { mode: body.mode, intent: body.intent };
    return action === "preview" ? { preview: await app.preview(scope, input) } : { receipt: await app.trade(scope, input) };
  });
}
