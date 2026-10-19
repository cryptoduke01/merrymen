/**
 * Live RPC transport. Two providers on different hostnames are required, and
 * every session with either one first proves it serves mainnet-beta.
 *
 * - read: one provider's answer, failing over to the other on transport errors.
 * - readEach / readSolanaQuorum: every provider's answer. Booking a fill or an
 *   expiry needs both to agree; one provider's word is never enough.
 * - send: a signed submission is sent ONCE, to the primary.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, isFullySignedTransaction, isSignature } from "@solana/kit";
import {
  readSolanaJson, readSolanaLiveRpcConfig, SOLANA_MAINNET_GENESIS_HASH,
  SolanaRpcError, withSolanaReadDeadline,
} from "./solana-rpc";

const READ_METHODS = ["getAccountInfo", "getMultipleAccounts", "getSlot", "getLatestBlockhash",
  "getBlockHeight", "getEpochInfo", "isBlockhashValid", "getFeeForMessage", "getMinimumBalanceForRentExemption", "simulateTransaction",
  "getSignatureStatuses", "getTransaction"] as const;
export type SolanaLiveReadMethod = typeof READ_METHODS[number];
export type SolanaLiveRead = (method: SolanaLiveReadMethod, params?: readonly unknown[]) => Promise<unknown>;
export interface SolanaLiveRpc {
  read<T>(operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T>;
  /**
   * Runs `operation` once against every configured provider (primary first),
   * each in its own mainnet-verified session. Rejects if any provider fails.
   * The production transport always has two; use readSolanaQuorum to compare.
   */
  readEach?<T>(operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T[]>;
  send(signedTransactionBase64: string, minContextSlot: number, signal?: AbortSignal): Promise<string>;
  /** In-process cache key for this provider pair. Not derived reversibly from the URLs. */
  readonly providerKey?: string;
}

const PROCESS_SALT = randomBytes(32);

/** Every provider's answer. A hand-built transport without readEach counts as one provider. */
export async function readSolanaEachProvider<T>(rpc: SolanaLiveRpc, operation: (rpc: SolanaLiveRead) => Promise<T>): Promise<T[]> {
  if (typeof rpc.readEach !== "function") return [await rpc.read(operation)];
  const values = await rpc.readEach(operation);
  if (!Array.isArray(values) || values.length < 1) throw new SolanaRpcError("no-quorum");
  return values;
}

export type SolanaQuorum<T> =
  | { agreed: true; value: T; values: readonly T[] }
  | { agreed: false; values: readonly T[] };
/**
 * Quorum read for anything that books money or frees a reservation.
 *
 * Runs `operation` independently on every provider (at least two, or it throws
 * "no-quorum") and compares the answers by `key`. `agreed` is true only when
 * every key is identical; `value` is then the primary's answer. Disagreement is
 * not an error: the caller keeps the record pending and asks again later. A
 * provider that errors makes the whole read reject, which also keeps it pending.
 *
 * Choose `key` to cover everything the booking depends on and nothing that
 * legitimately differs between providers (for example, each provider's own
 * current block height in an expiry proof).
 */
export async function readSolanaQuorum<T>(
  rpc: SolanaLiveRpc, operation: (rpc: SolanaLiveRead) => Promise<T>, key: (value: T) => string = value => JSON.stringify(value),
): Promise<SolanaQuorum<T>> {
  if (typeof rpc.readEach !== "function") throw new SolanaRpcError("no-quorum");
  const values = await rpc.readEach(operation);
  if (!Array.isArray(values) || values.length < 2) throw new SolanaRpcError("no-quorum");
  const keys = values.map(key);
  return keys.every(item => item === keys[0]) ? { agreed: true, value: values[0]!, values } : { agreed: false, values };
}

export function createSolanaLiveRpc(options: {
  env?: Readonly<Record<string, string | undefined>>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
} = {}): SolanaLiveRpc {
  const config = readSolanaLiveRpcConfig(options.env);
  const endpoints = [config.url, config.fallbackUrl] as const;
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
  const reader = (url: string) => <T>(operation: (rpc: SolanaLiveRead) => Promise<T>) => endpoint(url, rpc => operation((method, params) => {
    if (!(READ_METHODS as readonly string[]).includes(method)) throw new SolanaRpcError("unsupported-method");
    return rpc(method, params);
  }));
  return {
    providerKey: createHmac("sha256", PROCESS_SALT).update(`${config.url}\n${config.fallbackUrl}`).digest("hex"),
    async read(operation) {
      try { return await reader(config.url)(operation); }
      catch (error) {
        if (!(error instanceof SolanaRpcError) || error.code === "unsupported-method") throw error;
        return reader(config.fallbackUrl)(operation);
      }
    },
    async readEach(operation) {
      return Promise.all(endpoints.map(url => reader(url)(operation)));
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
