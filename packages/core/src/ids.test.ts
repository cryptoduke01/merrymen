import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CHAINS,
  SOLANA_USDG_MINT,
  allChains,
  base58Decode,
  base58Encode,
  canonicalId,
  chainInfo,
  chainOfEvmId,
  explorerUrl,
  idFamily,
  isSolanaKeypair,
  onchainIdIn,
  onchainIdsIn,
  requireChain,
  sameId,
  solanaSecretIn,
  solanaSecretsIn,
} from "./ids";
import { CASH } from "./tokens";

const EVM = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EVM_HASH = `0x${"Ab".repeat(32)}`;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** A real ed25519 keypair, its base58 secret, and a real signature by it. */
function keypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { pub: base58Encode(pub), secret, secretB58: base58Encode(secret), sig: base58Encode(sig) };
}

describe("the chain registry", () => {
  it("names Robinhood Chain and Solana, mainnet and test, and nothing else", () => {
    assert.deepEqual(allChains().map((c) => c.ref), [CHAINS.robinhood, CHAINS.robinhoodTestnet, CHAINS.solana, CHAINS.solanaDevnet]);
    assert.equal(chainInfo(CHAINS.solana)?.family, "solana");
    assert.equal(chainInfo(CHAINS.robinhood)?.evmChainId, 4663);
    assert.equal(chainInfo(CHAINS.solanaDevnet)?.realMoney, false);
  });

  it("is fail-closed: an unknown chain is null, never a default", () => {
    for (const bad of ["eip155:1", "solana:mainnet", "", null, 4663, "EIP155:4663"]) assert.equal(chainInfo(bad), null, String(bad));
    assert.throws(() => requireChain("eip155:8453"), /unknown chain/);
    assert.equal(chainOfEvmId(4663), CHAINS.robinhood);
    assert.equal(chainOfEvmId(46630), CHAINS.robinhoodTestnet);
    for (const id of [1, 8453, 0, -1, 4663.5, "4663"]) assert.equal(chainOfEvmId(id), null, String(id));
  });

  it("keeps the books in USDG on both chains, at 6 decimals", () => {
    assert.equal(chainInfo(CHAINS.robinhood)?.cash.address, CASH.USDG.toLowerCase());
    assert.equal(chainInfo(CHAINS.solana)?.cash.address, SOLANA_USDG_MINT);
    for (const c of allChains()) assert.equal(c.cash.decimals, 6);
    assert.equal(base58Decode(SOLANA_USDG_MINT)?.length, 32);
  });
});

describe("base58", () => {
  it("round-trips, leading zero bytes included", () => {
    assert.deepEqual(base58Decode(SYSTEM_PROGRAM), new Uint8Array(32));
    assert.equal(base58Encode(new Uint8Array(32)), SYSTEM_PROGRAM);
    for (const s of [SOLANA_USDG_MINT, keypair(7).pub, keypair(9).sig]) assert.equal(base58Encode(base58Decode(s)!), s);
  });

  it("refuses characters outside the alphabet (0, O, I, l)", () => {
    for (const s of ["0abc", "Oabc", "Iabc", "labc", "", "a b"]) assert.equal(base58Decode(s), null, s);
  });
});

describe("canonical ids", () => {
  it("lowercases EVM ids and keeps Solana ids exactly as written", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", EVM), EVM.toLowerCase());
    assert.equal(canonicalId(CHAINS.robinhood, "op", EVM_HASH), EVM_HASH.toLowerCase());
    assert.equal(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT), SOLANA_USDG_MINT);
    const { sig } = keypair(3);
    assert.equal(canonicalId(CHAINS.solana, "op", sig), sig);
  });

  it("never treats a case-folded Solana id as the same id", () => {
    assert.notEqual(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT.toLowerCase()), SOLANA_USDG_MINT);
    assert.equal(sameId(CHAINS.solana, "token", SOLANA_USDG_MINT, SOLANA_USDG_MINT.toLowerCase()), false);
    assert.equal(sameId(CHAINS.robinhood, "token", EVM, EVM.toLowerCase()), true);
  });

  it("refuses an id of the other family, the wrong length, or on an unknown chain", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", SOLANA_USDG_MINT), null);
    assert.equal(canonicalId(CHAINS.solana, "token", EVM), null);
    assert.equal(canonicalId(CHAINS.solana, "op", SOLANA_USDG_MINT), null, "a 32-byte key is not a signature");
    assert.equal(canonicalId(CHAINS.solana, "token", keypair(4).sig), null, "a signature is not a key");
    assert.equal(canonicalId("eip155:1", "token", EVM), null);
  });

  it("names the family of a bare id by its shape", () => {
    assert.equal(idFamily(EVM), "evm");
    assert.equal(idFamily(EVM_HASH), "evm");
    assert.equal(idFamily(SOLANA_USDG_MINT), "solana");
    assert.equal(idFamily("PEPE"), null);
  });
});

describe("explorer links", () => {
  it("Blockscout for Robinhood Chain, Solscan for Solana, the cluster for devnet", () => {
    assert.equal(explorerUrl(CHAINS.robinhood, "op", EVM_HASH), `https://robinhoodchain.blockscout.com/tx/${EVM_HASH.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "token", EVM), `https://robinhoodchain.blockscout.com/token/${EVM.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.solana, "token", SOLANA_USDG_MINT), `https://solscan.io/token/${SOLANA_USDG_MINT}`);
    assert.equal(explorerUrl(CHAINS.solanaDevnet, "account", SOLANA_USDG_MINT), `https://solscan.io/account/${SOLANA_USDG_MINT}?cluster=devnet`);
    assert.equal(explorerUrl(CHAINS.solana, "token", "not-a-mint"), null);
  });
});

describe("on-chain id detection", () => {
  it("finds EVM ids, Solana keys and signatures, and Solana explorer links", () => {
    const { sig } = keypair(5);
    const text = `bought ${SOLANA_USDG_MINT} at ${EVM} tx ${EVM_HASH} sig ${sig} https://solscan.io/tx/${sig}`;
    const hits = onchainIdsIn(text);
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "address" && h.value === SOLANA_USDG_MINT));
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "hash" && h.value === sig));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "address"));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "hash"));
    assert.ok(hits.some((h) => h.shape === "link"));
  });

  it("leaves ordinary prose alone", () => {
    for (const t of ["supercalifragilisticexpialidociousandmorewordsjoined", "the market is quiet today", "PEPE pumped 40% on the week", ""]) {
      assert.equal(onchainIdIn(t), false, t);
    }
  });
});

describe("Solana secret detection", () => {
  it("flags a keypair as base58 or as an id.json byte array", () => {
    const { secret, secretB58 } = keypair(11);
    assert.equal(isSolanaKeypair(secret), true);
    assert.equal(solanaSecretIn(`key: ${secretB58}`), true);
    assert.equal(solanaSecretIn(`[${[...secret].join(",")}]`), true);
    assert.equal(solanaSecretIn(JSON.stringify([...secret], null, 2)), true);
  });

  it("never mistakes a signature, a public key or random bytes for a secret", () => {
    const { sig, pub } = keypair(13);
    assert.equal(solanaSecretIn(`sig ${sig}`), false, "a signature is 64 bytes but no keypair");
    assert.equal(solanaSecretIn(`owner ${pub} ${SOLANA_USDG_MINT}`), false);
    const random = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(isSolanaKeypair(random), false);
    assert.equal(solanaSecretIn(`[${[...random].join(",")}]`), false);
  });

  it("solanaSecretsIn returns each secret exactly as written, and only secrets", () => {
    const a = keypair(17);
    const b = keypair(19);
    const array = JSON.stringify([...b.secret], null, 2);
    const text = `PRIVATE_KEY=${a.secretB58}\nsig ${a.sig} owner ${a.pub}\nid.json: ${array}`;
    assert.deepEqual(solanaSecretsIn(text), [a.secretB58, array]);
    for (const s of solanaSecretsIn(text)) assert.ok(text.includes(s));
    assert.deepEqual(solanaSecretsIn(`sig ${a.sig}`), []);
    for (const x of [null, undefined, 42, "", "short"]) assert.deepEqual(solanaSecretsIn(x), []);
  });
});
