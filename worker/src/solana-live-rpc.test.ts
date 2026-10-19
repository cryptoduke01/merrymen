import test from "node:test";
import assert from "node:assert/strict";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, createTransactionMessage,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, compileTransaction,
  signTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, blockhash } from "@solana/kit";
import { createSolanaLiveRpc, readSolanaQuorum, type SolanaLiveRead, type SolanaLiveRpc } from "./solana-live-rpc";
import { SOLANA_MAINNET_GENESIS_HASH, SolanaRpcError } from "./solana-rpc";
const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/?api-key=secret-primary",
  MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/?api-key=secret-fallback" };
const BLOCKHASH = "11111111111111111111111111111111";
async function signed() {
  const pair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const payer = await getAddressFromPublicKey(pair.publicKey);
  const tx = await signTransaction([pair], compileTransaction(setTransactionMessageLifetimeUsingBlockhash({
    blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 1000n,
  }, setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 })))));
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}

test("live trading refuses to start without an independent fallback on a different hostname (audit G3-6)", () => {
  for (const fallback of [undefined, "", "https://primary.example/other?api-key=x", "https://PRIMARY.example/", "https://primary.example./"]) {
    assert.throws(() => createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: env.MERRYMEN_SOLANA_RPC_MAINNET, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: fallback } }),
      error => error instanceof SolanaRpcError && error.code === "invalid-fallback" && !error.message.includes("secret"), String(fallback));
  }
  assert.throws(() => createSolanaLiveRpc({ env: { ...env, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "http://fallback.example/" } }), /HTTPS/);
  assert.ok(createSolanaLiveRpc({ env }).providerKey);
});
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
test("readEach asks every provider in its own mainnet-verified session (audit G3-1, G3-6)", async () => {
  for (const fallbackGenesis of [SOLANA_MAINNET_GENESIS_HASH, "devnet"]) {
    const seen: string[] = [];
    const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
      const body = JSON.parse(init!.body as string); const host = new URL(String(url)).hostname;
      seen.push(`${host}:${body.method}`);
      const result = body.method === "getGenesisHash" ? host === "primary.example" ? SOLANA_MAINNET_GENESIS_HASH : fallbackGenesis : host;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    } });
    if (fallbackGenesis === "devnet") {
      await assert.rejects(rpc.readEach!(read => read("getSlot")), /mainnet/);
      assert.ok(!seen.includes("fallback.example:getSlot"));
      await assert.rejects(readSolanaQuorum(rpc, read => read("getSlot")), /mainnet/);
    } else {
      assert.deepEqual(await rpc.readEach!(read => read("getSlot")), ["primary.example", "fallback.example"]);
      assert.deepEqual(seen.sort(), ["fallback.example:getGenesisHash", "fallback.example:getSlot", "primary.example:getGenesisHash", "primary.example:getSlot"]);
      // The two providers answer differently here, so they do not agree.
      assert.deepEqual(await readSolanaQuorum(rpc, read => read("getSlot")), { agreed: false, values: ["primary.example", "fallback.example"] });
      assert.deepEqual(await readSolanaQuorum(rpc, async read => typeof await read("getSlot")),
        { agreed: true, value: "string", values: ["string", "string"] });
    }
  }
});
test("readSolanaQuorum needs at least two providers and compares by the caller's key", async () => {
  const read: SolanaLiveRead = async () => 1;
  const one: SolanaLiveRpc = { read: callback => callback(read), send: async () => "" };
  await assert.rejects(readSolanaQuorum(one, r => r("getSlot")), error => error instanceof SolanaRpcError && error.code === "no-quorum");
  const lonely: SolanaLiveRpc = { ...one, readEach: async callback => [await callback(read)] };
  await assert.rejects(readSolanaQuorum(lonely, r => r("getSlot")), /two independent/);
  let call = 0;
  const pair: SolanaLiveRpc = { ...one, readEach: async <T,>(callback: (r: SolanaLiveRead) => Promise<T>) =>
    [await callback(read), await callback(read)].map(() => ({ height: ++call, outcome: "expired" })) as unknown as T[] };
  const quorum = await readSolanaQuorum(pair, async () => ({ height: 0, outcome: "" }), value => value.outcome);
  assert.equal(quorum.agreed, true);
  assert.deepEqual(quorum.agreed && quorum.value, { height: 1, outcome: "expired" });
  assert.equal((await readSolanaQuorum(pair, async () => ({ height: 0, outcome: "" }))).agreed, false);
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
