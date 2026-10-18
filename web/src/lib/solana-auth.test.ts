import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { authenticateSolana, solanaBindingMessage, verifySolanaBindingSignature, SolanaWebError, type SolanaAuthDependencies } from "./solana-auth";

const TENANT = `0x${"11".repeat(20)}` as const;
const OTHER = `0x${"22".repeat(20)}` as const;
const principal = { tenant: TENANT, did: "did:privy:alice" };
const seed = new Uint8Array(32).fill(42);
const OWNER = base58Encode(ed25519.getPublicKey(seed));
const OTHER_OWNER = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(43)));
const origin = "https://app.example.test", nonce = "test-origin-bound-nonce";
const signature = base58Encode(ed25519.sign(new TextEncoder().encode(solanaBindingMessage(principal, OWNER, origin, nonce)), seed));
const request = (headers = {}) => new Request(origin + "/api/solana/status", { headers: { authorization: "Bearer fixture", ...headers } });
const dependencies = (overrides: Partial<SolanaAuthDependencies> = {}): SolanaAuthDependencies => ({
  tenant: () => TENANT, verifyToken: async () => ({ ok: true, identity: { did: principal.did } }),
  tenantForDid: async () => TENANT, ...overrides,
});
test("binding signatures prove exact owner, tenant, DID, origin, nonce and purpose", () => {
  assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, signature), true);
  for (const [identity, owner, site, challenge] of [
    [{ ...principal, tenant: OTHER }, OWNER, origin, nonce],
    [{ ...principal, did: "did:privy:bob" }, OWNER, origin, nonce],
    [principal, OTHER_OWNER, origin, nonce], [principal, OWNER, "https://evil.example", nonce],
    [principal, OWNER, origin, "other-nonce"],
  ] as const) assert.equal(verifySolanaBindingSignature(identity, owner, site, challenge, signature), false);
  const loginSignature = base58Encode(ed25519.sign(new TextEncoder().encode("Sign in to Merrymen"), seed));
  assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, loginSignature), false);
});
test("invalid and noncanonical wallet proofs fail closed", () => {
  for (const invalid of ["", signature.slice(1), signature + "1", " " + signature, "0x" + "a".repeat(128)]) {
    assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, invalid), false);
  }
  assert.equal(verifySolanaBindingSignature(principal, OWNER.toLowerCase(), origin, nonce, signature), false);
  assert.equal(verifySolanaBindingSignature(principal, " " + OWNER, origin, nonce, signature), false);
});
test("Solana authentication requires the current cookie and verified DID to name the same tenant", async () => {
  assert.deepEqual(await authenticateSolana(request(), dependencies()), principal);
  await assert.rejects(authenticateSolana(request(), dependencies({ tenant: () => null })), (e: unknown) => e instanceof SolanaWebError && e.status === 401);
  await assert.rejects(authenticateSolana(request(), dependencies({ verifyToken: async () => ({ ok: false }) })), (e: unknown) => e instanceof SolanaWebError && e.status === 401);
  for (const mapped of [OTHER, null]) await assert.rejects(authenticateSolana(request(), dependencies({ tenantForDid: async () => mapped })), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
});
test("browser cross-origin requests cannot mutate a bound Solana account", async () => {
  await assert.rejects(authenticateSolana(request({ origin: "https://evil.example" }), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
  assert.deepEqual(await authenticateSolana(request({ origin }), dependencies()), principal);
});
test("a delayed token from a different login cannot satisfy the browser's expected identity", async () => {
  await assert.rejects(authenticateSolana(request({ "x-merrymen-privy-did": "did:privy:bob" }), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
  assert.deepEqual(await authenticateSolana(request({ "x-merrymen-privy-did": principal.did }), dependencies()), principal);
});
