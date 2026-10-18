import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaRequestBody, solanaResponse } from "./solana-api";
import { SolanaWebError } from "./solana-auth";

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
