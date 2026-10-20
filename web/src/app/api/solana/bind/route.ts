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
    const store = getSolanaBindingStore(), existing = await store.get(principal.tenant);
    // The tenant's verified identity changed since this owner key was bound, and the
    // same owner key just signed a fresh challenge naming the new identity: re-bind
    // (SOLANA OWNER KEY RECOVERY in solana-binding-store.ts). Another owner key stays a conflict.
    if (existing && existing.owner === body.owner && existing.did !== principal.did) {
      return { binding: await store.rebind(principal.tenant, principal.did, body.owner, existing.did) };
    }
    return { binding: await store.bind(principal.tenant, principal.did, body.owner) };
  });
}
