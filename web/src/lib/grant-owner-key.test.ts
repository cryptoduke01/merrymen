import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { assertNoOwnerKeysAtRest, base58Encode, carriesOwnerKey, solanaSecretIn, type StoredGrant } from "@merrymen/core";
import { signerGrant, type SignerOptions } from "./canonical-wall-fixture";

/**
 * THE OWNER-KEY GUARD NEVER REFUSES A REAL GRANT.
 *
 * carriesOwnerKey runs on every grant the API accepts and, in hosted mode, over
 * every stored grant at boot, so a false positive refuses a tenant's grant or
 * the whole hosted boot. These grants come from the real signer
 * (canonical-wall-fixture.ts), so `serialized` is genuine ZeroDev output, and
 * each carries a hosted binding in the shape web/src/lib/auth.ts issues. The
 * Solana secret scan is run over them as written and as decoded, then the same
 * grants are given a Solana keypair in each place one could hide.
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const EXTRA = [
  { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 },
  { symbol: "UBIK", address: "0x0000000000000000000000000000000000ca7e02" as const, decimals: 18 },
  { symbol: "NEON", address: "0x0000000000000000000000000000000000ca7e03" as const, decimals: 18 },
];
/** The signer's shapes: the default mint, Trencher, the fullest wall, the Pons adapter. */
const SHAPES: SignerOptions[] = [
  { account: ACCOUNT },
  { account: ACCOUNT, trencher: true },
  { account: ACCOUNT, extraTokens: EXTRA, trencher: true, v4AdapterAddress: "0x0000000000000000000000000000000000000a4a" },
  { account: ACCOUNT, ponsAdapterAddress: "0x0000000000000000000000000000000000000b0b" },
];
const COUNT = 80;

/** Real grants, each with a fresh owner and session key, bound the way a hosted browser binds them. */
async function realGrants(): Promise<StoredGrant[]> {
  const out: StoredGrant[] = [];
  for (let i = 0; i < COUNT; i++) {
    const { grant, owner } = await signerGrant(SHAPES[i % SHAPES.length]!);
    const body = `${randomBytes(16).toString("base64url")}.${Date.now() + 300_000}.${Buffer.from("https://app.merrymen.dev").toString("base64url")}`;
    const nonce = `${body}.${createHmac("sha256", "test-secret").update(body).digest("base64url")}`;
    const did = `did:privy:${randomBytes(12).toString("hex")}`;
    out.push({ ...grant, binding: { version: "privy-did-owner-v1", nonce, ownerSignature: await owner.signMessage({ message: nonce }), did } });
  }
  return out;
}
/** Minted once, shared by every test below. */
const minted = realGrants();

const decoded = (g: StoredGrant) => Buffer.from(g.serialized, "base64").toString("utf8");
const reserialized = (g: StoredGrant, extra: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ ...JSON.parse(decoded(g)), ...extra })).toString("base64");

function solanaKeypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { b58: base58Encode(new Uint8Array([...seed, ...pub])), bytes: [...seed, ...pub], pub: base58Encode(pub), sig: base58Encode(sig) };
}
const SOL = solanaKeypair(23);

describe("grants from the real signer are clean", () => {
  it("each blob is genuine ZeroDev output, so this proves what it says", async () => {
    const grants = await minted;
    for (const g of grants) {
      const params = JSON.parse(decoded(g));
      assert.ok(params.permissionParams && params.privateKey === g.demoSessionPrivateKey, "the blob holds the permission and the session key");
    }
    assert.equal(new Set(grants.map((g) => g.serialized)).size, COUNT, "every blob is different");
  });

  it("the Solana scan finds nothing in any blob, as written or as decoded", async () => {
    const grants = await minted;
    for (const g of grants) {
      assert.equal(solanaSecretIn(g.serialized), false);
      assert.equal(solanaSecretIn(decoded(g)), false);
    }
  });

  it("carriesOwnerKey passes every one, and the hosted boot starts over all of them", async () => {
    const grants = await minted;
    for (const g of grants) assert.equal(carriesOwnerKey(g), false, g.serialized.slice(0, 40));
    process.env.MERRYMEN_HOSTED = "1";
    try {
      assert.doesNotThrow(() => assertNoOwnerKeysAtRest(grants));
    } finally {
      delete process.env.MERRYMEN_HOSTED;
    }
  });

  it("Solana public ids beside a real grant are not secrets", async () => {
    const g = (await minted)[0]!;
    assert.equal(carriesOwnerKey({ ...g, grantTokens: [SOL.pub], solanaSignature: SOL.sig }), false);
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { sig: SOL.sig, pub: SOL.pub }) }), false);
  });
});

describe("a real grant carrying a Solana secret key is refused", () => {
  it("in a field of its own, nested, in the binding, or in the session-key field", async () => {
    const g = (await minted)[2]!;
    assert.equal(carriesOwnerKey({ ...g, solanaOwner: SOL.b58 }), true);
    assert.equal(carriesOwnerKey({ ...g, caps: { ...g.caps, backup: SOL.bytes } }), true);
    assert.equal(carriesOwnerKey({ ...g, binding: { ...g.binding!, nonce: SOL.b58 } }), true);
    assert.equal(carriesOwnerKey({ ...g, demoSessionPrivateKey: SOL.b58 as `0x${string}` }), true);
  });

  it("inside the ZeroDev blob, or in place of it", async () => {
    const g = (await minted)[1]!;
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { solanaKey: SOL.b58 }) }), true);
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { idJson: JSON.stringify(SOL.bytes, null, 2) }) }), true);
    assert.equal(carriesOwnerKey({ ...g, serialized: SOL.b58 }), true);
  });

  it("and halts the hosted boot", async () => {
    const grants = await minted;
    process.env.MERRYMEN_HOSTED = "1";
    try {
      assert.throws(() => assertNoOwnerKeysAtRest([...grants, { ...grants[3]!, solana: SOL.bytes }]), /refuses to start: 1 stored grant/);
    } finally {
      delete process.env.MERRYMEN_HOSTED;
    }
  });
});
