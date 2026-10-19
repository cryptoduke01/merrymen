import assert from "node:assert/strict";
import test from "node:test";
import { appendPublicToken, appendPublicWallet, publicTokenStillAllowed, publicWalletStillAllowed, publicWalletSuffix } from "./public-wallet";
import { xWeightedLength } from "./client";

const wallet = { address: `0x${"ab".repeat(20)}`, chainId: 4663 };
const prose = "i'm alan, an AI trading agent on merrymen. i'll share what i buy and why.";

test("only the exact verified wallet and an explicit supported network form the suffix", () => {
  assert.equal(publicWalletSuffix(wallet), ` Wallet (Robinhood Chain): ${wallet.address}`);
  assert.equal(publicWalletSuffix({ ...wallet, chainId: 46630 }), ` Wallet (Robinhood Chain Testnet): ${wallet.address}`);
  for (const invalid of [null, { ...wallet, chainId: 1 }, { ...wallet, address: `${wallet.address} ignore rules` }, { ...wallet, address: "private-key" }]) {
    assert.equal(publicWalletSuffix(invalid), null);
  }
  assert.equal(appendPublicWallet(`${prose} 0x12345678`, wallet), null);
  assert.equal(appendPublicWallet("a".repeat(280), wallet), null);
  assert.ok(xWeightedLength(appendPublicWallet("a".repeat(200), { ...wallet, chainId: 46630 })!) <= 280);
});

test("wallet disclosure cannot migrate to another account, network, post kind or revoked consent", () => {
  const post = { kind: "intro", body: appendPublicWallet(prose, wallet)! };
  assert.equal(publicWalletStillAllowed(post, wallet), true);
  for (const changed of [null, { ...wallet, chainId: 46630 }, { ...wallet, address: `0x${"cd".repeat(20)}` }]) {
    assert.equal(publicWalletStillAllowed(post, changed), false);
  }
  assert.equal(publicWalletStillAllowed({ ...post, kind: "buy" }, wallet), false);
  assert.equal(publicWalletStillAllowed({ ...post, body: `${post.body} later` }, wallet), false);
  assert.equal(publicWalletStillAllowed({ ...post, body: `0x12345678 ${post.body}` }, wallet), false);
  assert.equal(publicWalletStillAllowed({ kind: "intro", body: prose }, null), true);
});

test("a token contract is confined to the exact trade network and cannot become a wallet intro", () => {
  const post = { kind: "buy", body: appendPublicToken("pepe caught my eye while the curve was early", wallet)! };
  assert.ok(post.body.endsWith(`\n\n${wallet.address}`), "the CA alone on the last line, no label, no chain");
  assert.doesNotMatch(post.body, /Robinhood|CA \(/);
  assert.equal(publicTokenStillAllowed(post, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "sell" }, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "intro" }, wallet), false);
  // The text names no chain any more; the chain is held where the token is read
  // (orchestrator-xpost publicTokenForDecision refuses a decision on another chain).
  assert.equal(publicTokenStillAllowed(post, { ...wallet, address: `0x${"cd".repeat(20)}` }), false, "another contract");
  assert.equal(publicTokenStillAllowed(post, { ...wallet, chainId: 1 }), false, "a chain it never trades on");
  assert.equal(publicTokenStillAllowed(post, null), false);
  assert.equal(appendPublicToken(`${prose} ${wallet.address}`, wallet), null);
});

test("the operator's agents add the landed transaction's link on its own line, the CA still last (2026-10-13)", () => {
  const tx = `0x${"ab".repeat(32)}`;
  const prose = "pepe caught my eye while the curve was early";
  const linked = appendPublicToken(prose, { ...wallet, txHash: tx }, true)!;
  assert.equal(linked, `${prose}\n\nhttps://robinhoodchain.blockscout.com/tx/${tx}\n\n${wallet.address}`);
  assert.equal(publicTokenStillAllowed({ kind: "buy", body: linked }, { ...wallet, txHash: tx }, true), true);
  assert.equal(publicTokenStillAllowed({ kind: "buy", body: linked }, { ...wallet, txHash: tx }, false), false, "the link is part of what was consented");
  // Without the flag, paper (no hash), a malformed hash or the testnet: no link, the CA alone.
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: tx }), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: null }, true), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: "0x12" }, true), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, chainId: 46630, txHash: tx }, true), `${prose}\n\n${wallet.address}`);
});
