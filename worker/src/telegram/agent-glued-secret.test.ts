/**
 * The Telegram agent's secret screen strips a Solana secret key glued to the
 * text around it, as it strips one standing alone (audit: "pk<K>",
 * "%22<K>%22", "<K>is mine" and "secret:<K>x" were left readable), and keeps
 * what was glued to it. A signature, glued or not, is never a secret.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { containsSecret, redactSecrets } from "./agent";

const seed = new Uint8Array(32).fill(41);
const KEY = base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
const SIG = base58Encode(ed25519.sign(new TextEncoder().encode("merrymen"), seed));

test("a glued Solana secret key is redacted and refused, and only the key goes", () => {
  for (const [text, safe] of [
    [`pk${KEY}`, "pk[redacted]"],
    [`url %22${KEY}%22 end`, "url %22[redacted]%22 end"],
    [`${KEY}is mine`, "[redacted]is mine"],
    [`secret:${KEY}x`, "secret:[redacted]x"],
  ] as const) {
    assert.equal(redactSecrets(text, []), safe);
    assert.equal(containsSecret(text, []), true, text.slice(0, 12));
  }
  for (const text of [`landed tx${SIG}done`, `sig ${SIG}`]) {
    assert.equal(redactSecrets(text, []), text);
    assert.equal(containsSecret(text, []), false);
  }
});
