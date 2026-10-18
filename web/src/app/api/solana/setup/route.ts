import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["stage", "sessionPublicKey", "signedTransactionBase64", "signature", "sessionSecretKey"]);
    if (binding.requestedMode !== "live" || !binding.limits) throw new SolanaWebError(409, "Review and save live mode and its limits before registering a trading permission.");
    const app = getSolanaAppRuntime();
    if (body.stage === "prepare" && typeof body.sessionPublicKey === "string") {
      return { setup: await app.prepareLive(scope, { limits: binding.limits, sessionPublicKey: body.sessionPublicKey }) };
    }
    if (body.stage === "submit" && typeof body.signedTransactionBase64 === "string") {
      return { registration: await app.submitSetup(scope, { signedTransactionBase64: body.signedTransactionBase64 }) };
    }
    if (body.stage === "activate" && typeof body.signature === "string" && typeof body.sessionSecretKey === "string") {
      return { live: await app.activateLive(scope, { signature: body.signature, sessionSecretKey: body.sessionSecretKey }) };
    }
    throw new SolanaWebError(400, "Invalid Solana permission registration request.");
  });
}
