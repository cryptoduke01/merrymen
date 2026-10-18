import { NextResponse } from "next/server";
import { SolanaPaperValidationError } from "../../../packages/core/src/solana";
import { SolanaPaperStoreError } from "../../../worker/src/solana-paper-store";
import { SolanaMarketError } from "../../../worker/src/solana-market";
import { SolanaRpcError } from "../../../worker/src/solana-rpc";
import { SolanaAppRuntimeError } from "../../../worker/src/solana-app-runtime";
import { SolanaTradingStoreError } from "../../../worker/src/solana-trading-store";
import { authenticateSolana, SolanaWebError } from "./solana-auth";
import { getSolanaBindingStore, SolanaBindingError } from "./solana-binding-store";

export async function solanaRequestBody(req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (!req.body) throw new SolanaWebError(400, "A JSON request is required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16_384) { await reader.cancel(); throw new SolanaWebError(413, "The Solana request is too large."); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SolanaWebError(400, "Invalid JSON request."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw new SolanaWebError(400, "Unsupported Solana request fields.");
  return body as Record<string, unknown>;
}
export async function solanaContext(req: Request) {
  const principal = await authenticateSolana(req);
  const store = getSolanaBindingStore();
  const binding = await store.get(principal.tenant);
  if (!binding) throw new SolanaWebError(409, "Connect and verify a Solana wallet first.");
  if (binding.did !== principal.did) throw new SolanaWebError(403, "Your sign-in does not match this Solana account.");
  return { principal, store, binding, scope: { tenant: principal.tenant, owner: binding.owner } };
}
export async function solanaResponse(action: () => Promise<unknown>) {
  try { return NextResponse.json(await action(), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) {
    let status = 503, message = "Solana is temporarily unavailable. Nothing was confirmed; refresh to check existing requests before retrying.";
    if (error instanceof SolanaWebError) { status = error.status; message = error.message; }
    else if (error instanceof SolanaBindingError) { status = error.code === "invalid" ? 400 : 409; message = error.message; }
    else if (error instanceof SolanaPaperValidationError || error instanceof SolanaPaperStoreError) { status = 400; message = error.message; }
    else if (error instanceof SolanaAppRuntimeError) { status = error.code === "invalid" ? 400 : error.code === "configuration" ? 503 : 409; message = error.message; }
    else if (error instanceof SolanaTradingStoreError) { status = 409; message = error.message; }
    else if (error instanceof SolanaMarketError || error instanceof SolanaRpcError) message = error.message;
    // Unknown provider/storage errors are never reflected: they may contain
    // endpoints, API keys, sealed session keys, SQL values or wallet material.
    return NextResponse.json({ error: message, ownerFacing: true }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
