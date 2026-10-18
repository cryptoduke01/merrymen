/**
 * Builds one bounded CPI, never a provider transaction. V1 is deliberate:
 * /quote supplies contextSlot and /swap-instructions consumes that exact quote.
 * V2 /build has no quote contextSlot and uses a different instruction ABI.
 * https://developers.jup.ag/docs/api-reference/swap/v1/swap-instructions
 */
import { address } from "@solana/kit";
import { CHAINS } from "../../packages/core/src/ids";
import { SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR } from "../../packages/core/src/solana-live";
import { parseSolanaRawAmount, parseSolanaSwapIntent, validateSolanaQuote, type SolanaQuote } from "../../packages/core/src/solana";
import { createSolanaMarket, validSolanaJupiterRoute } from "./solana-market";
import { readSolanaJson, requireSolanaSlot, SolanaRpcError, withSolanaReadDeadline } from "./solana-rpc";
import type { SolanaLiveRpc } from "./solana-live-rpc";

export const JUPITER_SWAP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Anchor sha256("global:shared_accounts_route")[0..8].
const ROUTE_DISCRIMINATOR = Buffer.from(SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR);
export interface JupiterCpiAccount { address: string; isSigner: boolean; isWritable: boolean }
export interface JupiterCpiRoute {
  quote: SolanaQuote;
  dataBase64: string;
  accounts: readonly JupiterCpiAccount[];
  lookupTableAddresses: readonly string[];
}
export interface SolanaCpiBuildRequest {
  requestId: string; inputMint: string; outputMint: string; amountRaw: string; slippageBps: number;
  swapAuthority: string; sourceTokenAccount: string; destinationTokenAccount: string;
  inputTokenProgram: string; outputTokenProgram: string;
}
export class SolanaLiveMarketError extends Error {
  constructor() { super("Jupiter did not return a supported bounded vault swap."); this.name = "SolanaLiveMarketError"; }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(): never { throw new SolanaLiveMarketError(); }
function key(value: unknown): string {
  try { if (typeof value === "string" && address(value) === value) return value; } catch { /* Safe error below. */ }
  return fail();
}

/** Pinned sharedAccountsRoute, ExactIn, fee-free, no token-ledger variants. */
export function validateJupiterCpi(raw: unknown, expected: SolanaCpiBuildRequest, quote: SolanaQuote): Omit<JupiterCpiRoute, "quote"> {
  if (!object(raw) || !object(raw.swapInstruction)) return fail();
  const ix = raw.swapInstruction;
  if (ix.programId !== JUPITER_SWAP_PROGRAM || typeof ix.data !== "string" || ix.data.length > 1200 ||
      !Array.isArray(ix.accounts) || ix.accounts.length < 11 || ix.accounts.length > 64) return fail();
  const data = Buffer.from(ix.data, "base64");
  if (data.toString("base64") !== ix.data || data.length < 36 || !data.subarray(0, 8).equals(ROUTE_DISCRIMINATOR)) return fail();
  const tail = data.length - 19;
  if (data.readBigUInt64LE(tail).toString() !== expected.amountRaw ||
      data.readBigUInt64LE(tail + 8).toString() !== quote.outAmount ||
      data.readUInt16LE(tail + 16) !== expected.slippageBps || data[tail + 18] !== 0) return fail();
  const routeCount = data.readUInt32LE(9);
  if (routeCount < 1 || routeCount > 64 || tail < 13 + routeCount * 4) return fail();
  const accounts = ix.accounts.map((rawAccount): JupiterCpiAccount => {
    if (!object(rawAccount) || typeof rawAccount.isSigner !== "boolean" || typeof rawAccount.isWritable !== "boolean") return fail();
    return { address: key(rawAccount.pubkey), isSigner: rawAccount.isSigner, isWritable: rawAccount.isWritable };
  });
  if (accounts[2]!.address !== expected.swapAuthority || !accounts[2]!.isSigner ||
      accounts[3]!.address !== expected.sourceTokenAccount || !accounts[3]!.isWritable ||
      accounts[6]!.address !== expected.destinationTokenAccount || !accounts[6]!.isWritable ||
      accounts[7]!.address !== expected.inputMint || accounts[8]!.address !== expected.outputMint ||
      accounts[9]!.address !== JUPITER_SWAP_PROGRAM ||
      accounts.some((account, index) => account.isSigner !== (index === 2))) return fail();
  // SPL Token is always account 0; Token-2022 is optional account 10.
  if (accounts[0]!.address !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
      accounts[10]!.address !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") return fail();
  if (!Array.isArray(raw.addressLookupTableAddresses) || raw.addressLookupTableAddresses.length > 8) return fail();
  const lookupTableAddresses = raw.addressLookupTableAddresses.map(key);
  if (new Set(lookupTableAddresses).size !== lookupTableAddresses.length) return fail();
  // No provider setup/cleanup/compute/tip/other instructions are consumed.
  // The vault creates and closes its temporary input ATA itself.
  return { dataBase64: ix.data, accounts, lookupTableAddresses };
}

export function createSolanaLiveMarket(options: {
  rpc: SolanaLiveRpc; env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
}): { build(request: SolanaCpiBuildRequest): Promise<JupiterCpiRoute>; readMint: ReturnType<typeof createSolanaMarket>["readMint"] } {
  const env = options.env ?? process.env;
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    readMint: createSolanaMarket(options).readMint,
    async build(request) {
      const intent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper",
        requestId: request.requestId, inputMint: request.inputMint, outputMint: request.outputMint,
        amountRaw: request.amountRaw, slippageBps: request.slippageBps });
      for (const value of [request.swapAuthority, request.sourceTokenAccount, request.destinationTokenAccount,
        request.inputTokenProgram, request.outputTokenProgram]) key(value);
      const apiKey = env.MERRYMEN_JUPITER_API_KEY?.trim();
      if (!apiKey || apiKey.length > 1024 || /[^\x21-\x7e]/.test(apiKey)) return fail();
      const json = (url: string, body?: unknown) => withSolanaReadDeadline(async signal => {
        let response: Response;
        try { response = await fetch(url, { method: body === undefined ? "GET" : "POST",
          headers: { "x-api-key": apiKey, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal }); }
        catch { throw new SolanaRpcError(signal.aborted ? "timeout" : "network"); }
        return readSolanaJson(response, signal);
      }, options.timeoutMs);
      const params = new URLSearchParams({ inputMint: intent.inputMint, outputMint: intent.outputMint,
        amount: intent.amountRaw, slippageBps: String(intent.slippageBps), swapMode: "ExactIn",
        restrictIntermediateTokens: "true", platformFeeBps: "0", instructionVersion: "V1" });
      const quotedAtMs = now();
      const raw = await json(`https://api.jup.ag/swap/v1/quote?${params}`);
      if (!object(raw) || raw.swapMode !== "ExactIn" || typeof raw.outAmount !== "string") return fail();
      parseSolanaRawAmount(raw.outAmount);
      if (
          !validSolanaJupiterRoute(raw.routePlan, intent, raw.outAmount) ||
          !(raw.platformFee === undefined || raw.platformFee === null ||
            (object(raw.platformFee) && raw.platformFee.amount === "0" && raw.platformFee.feeBps === 0))) return fail();
      const quote: SolanaQuote = { source: "jupiter", inputMint: raw.inputMint as string,
        outputMint: raw.outputMint as string, inAmount: raw.inAmount as string, outAmount: raw.outAmount,
        minOutAmount: raw.otherAmountThreshold as string, slippageBps: raw.slippageBps as number,
        contextSlot: raw.contextSlot as number, quotedAtMs, expiresAtMs: quotedAtMs + 30_000 };
      validateSolanaQuote(quote, intent, now());
      const built = await json("https://api.jup.ag/swap/v1/swap-instructions", {
        userPublicKey: request.swapAuthority, quoteResponse: raw,
        destinationTokenAccount: request.destinationTokenAccount, wrapAndUnwrapSol: false,
        useSharedAccounts: true, dynamicSlippage: false, dynamicComputeUnitLimit: false,
        skipUserAccountsRpcCalls: true, computeUnitPriceMicroLamports: 0,
      });
      const slot = await options.rpc.read(async rpc => requireSolanaSlot(await rpc("getSlot", [{ commitment: "confirmed" }])));
      if (quote.contextSlot < slot - 75 || quote.contextSlot > slot + 32) return fail();
      validateSolanaQuote(quote, intent, now());
      return { quote, ...validateJupiterCpi(built, request, quote) };
    },
  };
}
