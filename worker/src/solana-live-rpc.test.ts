import test from "node:test";
import assert from "node:assert/strict";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, createTransactionMessage,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, compileTransaction,
  signTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, blockhash } from "@solana/kit";
import { createSolanaLiveRpc } from "./solana-live-rpc";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/?api-key=secret-primary",
  MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/?api-key=secret-fallback" };
async function signed() {
  const pair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const payer = await getAddressFromPublicKey(pair.publicKey);
  const tx = await signTransaction([pair], compileTransaction(setTransactionMessageLifetimeUsingBlockhash({
    blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1000n,
  }, setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 })))));
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}
test("read failover independently verifies mainnet; read callback cannot submit", async () => {
  const seen: string[] = [];
  const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string); const host = new URL(String(url)).hostname;
    seen.push(`${host}:${body.method}`);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getGenesisHash"
      ? host === "primary.example" ? "devnet" : SOLANA_MAINNET_GENESIS_HASH : 44 });
  } });
  assert.equal(await rpc.read(read => read("getSlot")), 44);
  assert.deepEqual(seen, ["primary.example:getGenesisHash", "fallback.example:getGenesisHash", "fallback.example:getSlot"]);
  await assert.rejects(rpc.read(read => read("sendTransaction" as never)), /allowlisted/);
  assert.ok(!seen.some(value => value.endsWith(":sendTransaction")));
});
test("send uses primary once with preflight and minContextSlot, never retries a lost response", async () => {
  const tx = await signed(); const seen: { host: string; method: string; params: unknown[] }[] = [];
  const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string); seen.push({ host: new URL(String(url)).hostname, method: body.method, params: body.params });
    if (body.method === "sendTransaction") throw new Error("secret-primary provider URL");
    return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
  } });
  await assert.rejects(rpc.send(tx.wire, 99), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes("secret")); return true;
  });
  assert.deepEqual(seen.map(item => item.method), ["getGenesisHash", "sendTransaction"]);
  assert.ok(seen.every(item => item.host === "primary.example"));
  assert.deepEqual(seen[1]!.params[1], { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0, minContextSlot: 99 });
});
test("rejects unsigned garbage before network and wrong genesis before send", async () => {
  const tx = await signed(); let calls = 0;
  const rpc = createSolanaLiveRpc({ env, fetch: async (_url, init) => {
    calls++; const { id } = JSON.parse(init!.body as string); return Response.json({ jsonrpc: "2.0", id, result: "devnet" });
  } });
  await assert.rejects(rpc.send(Buffer.from("garbage").toString("base64"), 1)); assert.equal(calls, 0);
  await assert.rejects(rpc.send(tx.wire, 1), /mainnet/); assert.equal(calls, 1);
});
test("send deadlines and redirect errors stay bounded and do not expose provider bodies", async () => {
  const tx = await signed(); let calls = 0;
  const timed = createSolanaLiveRpc({ env, timeoutMs: 10, fetch: async (_url, init) => {
    calls++; const body = JSON.parse(init!.body as string);
    if (body.method === "sendTransaction") return new Promise<Response>(() => {});
    return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
  } });
  await assert.rejects(timed.send(tx.wire, 1), /timed out/); assert.equal(calls, 2);
  const redirects = createSolanaLiveRpc({ env, fetch: async () => new Response("secret-primary", { status: 302 }) });
  await assert.rejects(redirects.send(tx.wire, 1), /redirect/);
});
test("external abort fences genesis-to-send and reaches an in-flight fetch without fallback", async () => {
  const tx = await signed();
  for (const phase of ["before", "genesis", "send"] as const) {
    const controller = new AbortController(), seen: string[] = []; let transportAborted = false;
    if (phase === "before") controller.abort("private-reason");
    const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "primary.example");
      const body = JSON.parse(init!.body as string); seen.push(body.method);
      if (body.method === "getGenesisHash") {
        if (phase === "genesis") controller.abort("private-reason");
        return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
      }
      assert.equal(body.method, "sendTransaction");
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { transportAborted = true; reject(new Error("private-reason")); }, { once: true });
        controller.abort("private-reason");
      });
    } });
    await assert.rejects(rpc.send(tx.wire, 1, controller.signal), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /cancelled/); assert.ok(!error.message.includes("private")); return true;
    });
    assert.deepEqual(seen, phase === "before" ? [] : phase === "genesis" ? ["getGenesisHash"] : ["getGenesisHash", "sendTransaction"]);
    assert.equal(transportAborted, phase === "send");
  }
});
