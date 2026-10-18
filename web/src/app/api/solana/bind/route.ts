import { solanaPaperAgentId } from "../../../../../../packages/core/src/solana";
import { authenticateSolana, consumeSolanaBindingProof, issueSolanaBindingChallenge, SolanaWebError } from "@/lib/solana-auth";
import { getSolanaBindingStore } from "@/lib/solana-binding-store";
import { solanaRequestBody, solanaResponse } from "@/lib/solana-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const owner = new URL(req.url).searchParams.get("owner") ?? "";
    solanaPaperAgentId(owner);
    return issueSolanaBindingChallenge(req, principal, owner);
  });
}
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const body = await solanaRequestBody(req, ["owner", "nonce", "signature"]);
    if (typeof body.owner !== "string" || typeof body.nonce !== "string" || body.nonce.length > 1024
      || typeof body.signature !== "string" || body.signature.length > 128) throw new SolanaWebError(400, "Invalid wallet proof.");
    solanaPaperAgentId(body.owner);
    await consumeSolanaBindingProof(req, principal, { owner: body.owner, nonce: body.nonce, signature: body.signature });
    return { binding: await getSolanaBindingStore().bind(principal.tenant, principal.did, body.owner) };
  });
}
