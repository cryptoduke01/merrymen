/** Live RPC transport. Reads may fail over; a signed submission is sent ONCE. */
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, isFullySignedTransaction, isSignature } from "@solana/kit";
import {
  readSolanaJson, readSolanaMainnetRpcConfig, SOLANA_MAINNET_GENESIS_HASH,
  SolanaRpcError, withSolanaReadDeadline,
} from "./solana-rpc";

const READ_METHODS = ["getAccountInfo", "getMultipleAccounts", "getSlot", "getLatestBlockhash",
  "getBlockHeight", "isBlockhashValid", "getFeeForMessage", "getMinimumBalanceForRentExemption", "simulateTransaction",
  "getSignatureStatuses", "getTransaction"] as const;
export type SolanaLiveReadMethod = typeof READ_METHODS[number];
export type SolanaLiveRead = (method: SolanaLiveReadMethod, params?: readonly unknown[]) => Promise<unknown>;
export interface SolanaLiveRpc {
  read<T>(operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T>;
  send(signedTransactionBase64: string, minContextSlot: number, signal?: AbortSignal): Promise<string>;
}

export function createSolanaLiveRpc(options: {
  env?: Readonly<Record<string, string | undefined>>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
} = {}): SolanaLiveRpc {
  const config = readSolanaMainnetRpcConfig(options.env);
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = async <T>(url: string, operation: (rpc: (method: string, params?: readonly unknown[]) => Promise<unknown>) => Promise<T>, cancellation?: AbortSignal) =>
    withSolanaReadDeadline(async deadlineSignal => {
      const signal = cancellation ? AbortSignal.any([deadlineSignal, cancellation]) : deadlineSignal;
      const checkAbort = () => { if (signal.aborted) throw new SolanaRpcError(cancellation?.aborted ? "cancelled" : "timeout"); };
      let nextId = 0;
      const rpc = async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
        checkAbort();
        const id = ++nextId;
        let response: Response;
        try {
          response = await request(url, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error", signal });
        } catch { throw new SolanaRpcError(cancellation?.aborted ? "cancelled" : signal.aborted ? "timeout" : "network"); }
        checkAbort();
        const value = await readSolanaJson(response, signal);
        checkAbort();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new SolanaRpcError("malformed");
        const data = value as Record<string, unknown>;
        if (data.id !== id || data.jsonrpc !== "2.0" || !Object.hasOwn(data, "result")) throw new SolanaRpcError("malformed");
        if (Object.hasOwn(data, "error")) throw new SolanaRpcError("rpc");
        return data.result;
      };
      if (await rpc("getGenesisHash") !== SOLANA_MAINNET_GENESIS_HASH) throw new SolanaRpcError("wrong-network");
      checkAbort();
      return operation(rpc);
    }, options.timeoutMs ?? 10_000);
  return {
    async read(operation) {
      const run = (url: string) => endpoint(url, rpc => operation((method, params) => {
        if (!(READ_METHODS as readonly string[]).includes(method)) throw new SolanaRpcError("unsupported-method");
        return rpc(method, params);
      }));
      try { return await run(config.url); }
      catch (error) {
        if (!config.fallbackUrl || !(error instanceof SolanaRpcError) || error.code === "unsupported-method") throw error;
        return run(config.fallbackUrl);
      }
    },
    async send(wire, minContextSlot, signal) {
      if (signal?.aborted) throw new SolanaRpcError("cancelled");
      const bytes = Buffer.from(wire, "base64");
      if (!wire || wire.length > 1644 || bytes.length > 1232 || bytes.toString("base64") !== wire ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 1) throw new SolanaRpcError("malformed");
      try {
        const transaction = getTransactionDecoder().decode(bytes);
        if (!isFullySignedTransaction(transaction) || getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).version !== 0) {
          throw new Error();
        }
      } catch { throw new SolanaRpcError("malformed"); }
      // No automatic retry or fallback here, including genesis/send ambiguity.
      return endpoint(config.url, async rpc => {
        const result = await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false,
          preflightCommitment: "confirmed", maxRetries: 0, minContextSlot }]);
        if (typeof result !== "string" || !isSignature(result)) throw new SolanaRpcError("malformed");
        return result;
      }, signal);
    },
  };
}
