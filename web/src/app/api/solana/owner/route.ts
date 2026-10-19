import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["stage", "action", "mint", "amountRaw", "signedTransactionBase64"]);
    const app = getSolanaAppRuntime();
    // Owner recovery is available even after live consent is disabled or its
    // session expires. The owner must still sign the exact prepared transaction.
    if (body.stage === "prepare" && (body.action === "revoke" || body.action === "resume-buys") && body.mint === undefined && body.amountRaw === undefined) {
      return { prepared: await app.prepareOwnerAction(scope, { action: body.action }) };
    }
    if (body.stage === "prepare" && body.action === "withdraw" && typeof body.mint === "string" && typeof body.amountRaw === "string") {
      return { prepared: await app.prepareOwnerAction(scope, { action: "withdraw", mint: body.mint, amountRaw: body.amountRaw }) };
    }
    // Native SOL held by the vault account itself (above its rent reserve), in lamports.
    if (body.stage === "prepare" && body.action === "withdraw-sol" && body.mint === undefined && typeof body.amountRaw === "string") {
      return { prepared: await app.prepareOwnerAction(scope, { action: "withdraw-sol", amountRaw: body.amountRaw }) };
    }
    if (body.stage === "submit" && typeof body.signedTransactionBase64 === "string") {
      return { result: await app.submitOwnerAction(scope, { signedTransactionBase64: body.signedTransactionBase64 }) };
    }
    throw new SolanaWebError(400, "Invalid Solana owner action.");
  });
}
