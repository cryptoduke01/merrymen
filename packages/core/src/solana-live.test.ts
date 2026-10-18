import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  base58Decode,
  base58Encode,
  SOLANA_USDG_MINT,
  TOKEN_2022_PROGRAM,
} from "./ids";
import * as live from "./solana-live";
const owner = base58Encode(new Uint8Array(32).fill(3));
const session = base58Encode(new Uint8Array(32).fill(4));
const feePayer = base58Encode(new Uint8Array(32).fill(5));
const programAddress = live.SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const key = (s: string) => base58Decode(s)!;
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const disc = (s: string) =>
  new Uint8Array(createHash("sha256").update(s).digest().subarray(0, 8));
const join = (...xs: Uint8Array[]) =>
  Uint8Array.from(xs.flatMap((x) => Array.from(x)));
describe("Solana live shared ABI", () => {
  it("pins the official Jupiter shared_accounts_route discriminator", () => {
    assert.deepEqual(
      live.SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR,
      disc("global:shared_accounts_route"),
    );
  });
  it("encodes native recovery with only owner authority", () => {
    const ix = live.buildWithdrawSolanaNativeInstruction({
      programAddress,
      vault: programAddress,
      owner,
      amount: 100n,
    });
    assert.deepEqual(
      Array.from(ix.data!.slice(0, 8)),
      Array.from(disc("global:withdraw_sol")),
    );
    assert.deepEqual(
      ix.accounts!.map((a) => a.role),
      [1, 3],
    );
    assert.throws(
      () =>
        live.buildWithdrawSolanaNativeInstruction({
          programAddress,
          vault: programAddress,
          owner,
          amount: 0n,
        }),
      live.SolanaVaultValidationError,
    );
  });

  it("derives separate owner and per-sequence authorities deterministically", async () => {
    const vault = await live.deriveSolanaVaultAddress(programAddress, owner);
    assert.equal(
      vault,
      await live.deriveSolanaVaultAddress(programAddress, owner),
    );
    assert.notEqual(
      vault,
      await live.deriveSolanaVaultAddress(programAddress, session),
    );
    assert.notEqual(
      await live.deriveSolanaSwapAuthority(programAddress, vault, 0n),
      await live.deriveSolanaSwapAuthority(programAddress, vault, 1n),
    );
    assert.notEqual(
      await live.deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
      await live.deriveSolanaAta(
        vault,
        SOLANA_USDG_MINT,
        live.SOLANA_CLASSIC_TOKEN_PROGRAM,
      ),
    );
  });
  it("encodes Anchor session instruction without lossy number conversion", () => {
    const ix = live.buildCreateSolanaSessionInstruction({
      programAddress,
      vault: programAddress,
      owner,
      session,
      perTrade: 9007199254740993n,
      daily: 9007199254740999n,
      maxOps: 96,
      expiresAt: 2000000000n,
    });
    assert.deepEqual(
      Array.from(ix.data!.slice(0, 8)),
      Array.from(disc("global:create_session")),
    );
    assert.equal(
      new DataView(Uint8Array.from(ix.data!).buffer).getBigUint64(40, true),
      9007199254740993n,
    );
    assert.deepEqual(
      ix.accounts!.map((a) => a.role),
      [1, 2],
    );
  });
  it("rejects invalid public keys, overflowing integers and unsafe limits", async () => {
    assert.throws(
      () =>
        live.buildInitializeSolanaVaultInstruction({
          programAddress,
          vault: programAddress,
          owner: " invalid",
        }),
      live.SolanaVaultValidationError,
    );
    await assert.rejects(
      live.deriveSolanaSwapAuthority(programAddress, owner, 1n << 64n),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () =>
        live.buildCreateSolanaSessionInstruction({
          programAddress,
          vault: programAddress,
          owner,
          session,
          perTrade: 2n,
          daily: 1n,
          maxOps: 1,
          expiresAt: 100n,
        }),
      live.SolanaVaultValidationError,
    );
  });
  it("decodes bounded vault data including retained Anchor Vec capacity", () => {
    const data = new Uint8Array(live.SOLANA_VAULT_ACCOUNT_SIZE);
    const prefix = join(
      disc("account:Vault"),
      Uint8Array.of(1, 254),
      key(owner),
      key(session),
      u64(2n),
      u64(9007199254740993n),
      u64(2000000000n),
      u64(1000000n),
      u64(2000000n),
      Uint8Array.of(96, 0, 1),
      Uint8Array.of(1, 0, 0, 0),
      u64(100n),
      u64(200n),
    );
    data.set(prefix);
    data[data.length - 1] = 42;
    const value = live.decodeSolanaVaultAccount(data);
    assert.deepEqual(live.decodeSolanaVaultAccount(Buffer.from(data)), value);
    const padded = Buffer.concat([Buffer.alloc(19, 99), Buffer.from(data)]);
    assert.deepEqual(live.decodeSolanaVaultAccount(padded.subarray(19)), value);
    assert.equal(value.seq, 9007199254740993n);
    assert.equal(value.paused, true);
    assert.deepEqual(value.debits, [{ timestamp: 100n, notional: 200n }]);
    const wrongCount = data.slice();
    wrongCount[117] = 97;
    assert.throws(
      () => live.decodeSolanaVaultAccount(wrongCount),
      live.SolanaVaultValidationError,
    );
    const wrongBool = data.slice();
    wrongBool[116] = 2;
    assert.throws(
      () => live.decodeSolanaVaultAccount(wrongBool),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () => live.decodeSolanaVaultAccount(data.slice(1)),
      live.SolanaVaultValidationError,
    );
  });
  it("decodes exact event provenance and rejects suffixes", () => {
    const data = join(
      disc("event:SwapExecuted"),
      key(programAddress),
      key(owner),
      key(session),
      u64(4n),
      u64(5n),
      key(SOLANA_USDG_MINT),
      key(live.SOLANA_WRAPPED_SOL_MINT),
      u64(100n),
      u64(200n),
      u64(1000n),
    );
    assert.equal(data.length, 208);
    assert.deepEqual(
      live.decodeSolanaSwapEvent(Buffer.from(data)),
      live.decodeSolanaSwapEvent(data),
    );
    const padded = Buffer.concat([Buffer.alloc(7, 255), Buffer.from(data)]);
    assert.deepEqual(
      live.decodeSolanaSwapEvent(padded.subarray(7)),
      live.decodeSolanaSwapEvent(data),
    );
    assert.deepEqual(live.decodeSolanaSwapEvent(data), {
      vault: programAddress,
      owner,
      session,
      sessionEpoch: 4n,
      seq: 5n,
      inputMint: SOLANA_USDG_MINT,
      outputMint: live.SOLANA_WRAPPED_SOL_MINT,
      amountIn: 100n,
      amountOut: 200n,
      timestamp: 1000n,
    });
    assert.throws(
      () => live.decodeSolanaSwapEvent(join(data, Uint8Array.of(0))),
      live.SolanaVaultValidationError,
    );
  });
  it("forwards no provider signer privilege into execute_swap", () => {
    const ix = live.buildExecuteSolanaSwapInstruction({
      programAddress,
      vault: owner,
      sessionSigner: session,
      feePayer,
      inputMint: SOLANA_USDG_MINT,
      outputMint: live.SOLANA_WRAPPED_SOL_MINT,
      vaultInput: owner,
      vaultOutput: owner,
      swapAuthority: owner,
      tempInput: owner,
      ownerRefund: owner,
      inputTokenProgram: TOKEN_2022_PROGRAM,
      outputTokenProgram: live.SOLANA_CLASSIC_TOKEN_PROGRAM,
      expectedSeq: 3n,
      sessionEpoch: 4n,
      amountIn: 5n,
      minOut: 6n,
      deadline: 100n,
      slippageBps: 100,
      routeData: new Uint8Array(32),
      routeAccounts: Array.from({ length: 11 }, () => ({
        address: owner,
        role: 3 as const,
      })),
    });
    assert.deepEqual(
      ix.accounts!.slice(15).map((a) => a.role),
      new Array(11).fill(1),
    );
    assert.deepEqual(
      ix.accounts!.slice(0, 3).map((a) => a.role),
      [1, 2, 3],
    );
    assert.equal(
      new DataView(Uint8Array.from(ix.data!).buffer).getBigUint64(8, true),
      3n,
    );
  });
});
