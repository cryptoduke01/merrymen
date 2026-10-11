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
  assert.ok(post.body.endsWith(` CA (Robinhood Chain): ${wallet.address}`));
  assert.equal(publicTokenStillAllowed(post, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "sell" }, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "intro" }, wallet), false);
  assert.equal(publicTokenStillAllowed(post, { ...wallet, chainId: 46630 }), false);
  assert.equal(publicTokenStillAllowed(post, null), false);
  assert.equal(appendPublicToken(`${prose} ${wallet.address}`, wallet), null);
});
