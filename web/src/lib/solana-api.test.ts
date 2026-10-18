import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SolanaAppRuntimeError } from "../../../worker/src/solana-app-runtime";
import { SolanaMarketError } from "../../../worker/src/solana-market";
import { SolanaRpcError } from "../../../worker/src/solana-rpc";
import { solanaRequestBody, solanaResponse } from "./solana-api";
import { SolanaWebError } from "./solana-auth";

const flag = process.env.MERRYMEN_SOLANA;
before(() => { process.env.MERRYMEN_SOLANA = "1"; });
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });

test("Solana routes reject authority fields and oversized bodies", async () => {
  for (const value of [null, [], { owner: "untrusted", amount: "1" }, { tenant: "other" }]) {
    await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify(value) }), ["amount"]));
  }
  await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify({ amount: "x".repeat(20_000) }) }), ["amount"]), (e: unknown) => e instanceof SolanaWebError && e.status === 413);
  assert.deepEqual(await solanaRequestBody(new Request("https://example.test", { method: "POST", body: '{"amount":"1"}' }), ["amount"]), { amount: "1" });
});
test("unexpected errors cannot reflect RPC credentials, session seeds or SQL values", async () => {
  const response = await solanaResponse(async () => { throw new Error("https://rpc.example?api-key=secret sessionSecretKey=private SQL value"); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.text();
  for (const secret of ["rpc.example", "api-key", "sessionSecretKey", "SQL value"]) assert.ok(!body.includes(secret));
});
test("setup errors answer as unavailable, never naming a setting", async () => {
  for (const error of [new SolanaMarketError("missing-jupiter-key"), new SolanaMarketError("invalid-jupiter-key"),
    new SolanaRpcError("missing-config"), new SolanaRpcError("invalid-config"),
    new SolanaAppRuntimeError("configuration", "Configure the separate Solana network fee payer before live trading.")]) {
    const response = await solanaResponse(async () => { throw error; });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true }, error.message);
  }
  // A problem with the request itself still says what it is.
  const quote = await solanaResponse(async () => { throw new SolanaMarketError("invalid-quote"); });
  assert.equal((await quote.json()).error, "Jupiter did not return a valid quote for the requested swap.");
});
test("with Solana off the response refuses before the action runs", async () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = value;
    let ran = false;
    const response = await solanaResponse(async () => { ran = true; return { ok: true }; });
    assert.equal(response.status, 404, String(value));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true });
    assert.equal(ran, false);
  }
  process.env.MERRYMEN_SOLANA = "1";
  assert.equal((await solanaResponse(async () => ({ ok: true }))).status, 200);
});
