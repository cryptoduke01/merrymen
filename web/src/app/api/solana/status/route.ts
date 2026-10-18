import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { authenticateSolana, SolanaWebError } from "@/lib/solana-auth";
import { getSolanaBindingStore } from "@/lib/solana-binding-store";
import { solanaResponse } from "@/lib/solana-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const binding = await getSolanaBindingStore().get(principal.tenant);
    if (!binding) return { binding: null, runtime: null };
    if (binding.did !== principal.did) throw new SolanaWebError(403, "Your sign-in does not match this Solana account.");
    return { binding, runtime: await getSolanaAppRuntime().status({ tenant: principal.tenant, owner: binding.owner }) };
  });
}
