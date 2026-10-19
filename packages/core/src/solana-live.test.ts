import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
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
      perTradeWsol: 250_000_000n,
      dailyWsol: 1_000_000_000n,
      maxOps: 96,
      expiresAt: 2000000000n,
    });
    // Argument order is the program's: session, per_trade, daily,
    // per_trade_wsol, daily_wsol, max_ops, expires_at.
    assert.deepEqual(
      Array.from(ix.data!),
      Array.from(
        join(
          disc("global:create_session"),
          key(session),
          u64(9007199254740993n),
          u64(9007199254740999n),
          u64(250_000_000n),
          u64(1_000_000_000n),
          Uint8Array.of(96, 0),
          u64(2000000000n),
        ),
      ),
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
          perTradeWsol: 1n,
          dailyWsol: 1n,
          maxOps: 1,
          expiresAt: 100n,
        }),
      live.SolanaVaultValidationError,
    );
    // A session with no WSOL input bound would let sells drain the position.
    for (const [perTradeWsol, dailyWsol] of [
      [0n, 1n],
      [2n, 1n],
    ] as const) {
      assert.throws(
        () =>
          live.buildCreateSolanaSessionInstruction({
            programAddress,
            vault: programAddress,
            owner,
            session,
            perTrade: 1n,
            daily: 1n,
            perTradeWsol,
            dailyWsol,
            maxOps: 1,
            expiresAt: 100n,
          }),
        live.SolanaVaultValidationError,
      );
    }
  });
  it("decodes bounded vault data including retained Anchor Vec capacity", () => {
    const data = new Uint8Array(live.SOLANA_VAULT_ACCOUNT_SIZE);
    const prefix = join(
      disc("account:Vault"),
      Uint8Array.of(2, 254),
      key(owner),
      key(session),
      u64(2n),
      u64(9007199254740993n),
      u64(2000000000n),
      u64(1000000n),
      u64(2000000n),
      u64(300n),
      u64(900n),
      Uint8Array.of(96, 0, 1),
      Uint8Array.of(1, 0, 0, 0),
      u64(100n),
      u64(200n),
      u64(300n),
    );
    data.set(prefix);
    data[data.length - 1] = 42;
    const value = live.decodeSolanaVaultAccount(data);
    assert.deepEqual(live.decodeSolanaVaultAccount(Buffer.from(data)), value);
    const padded = Buffer.concat([Buffer.alloc(19, 99), Buffer.from(data)]);
    assert.deepEqual(live.decodeSolanaVaultAccount(padded.subarray(19)), value);
    assert.equal(value.seq, 9007199254740993n);
    assert.equal(value.paused, true);
    assert.equal(value.perTradeWsol, 300n);
    assert.equal(value.dailyWsol, 900n);
    assert.deepEqual(value.debits, [
      { timestamp: 100n, notional: 200n, wsol: 300n },
    ]);
    // Version 1 accounts have no WSOL caps and must never be read as capped.
    const v1 = data.slice();
    v1[8] = 1;
    assert.throws(
      () => live.decodeSolanaVaultAccount(v1),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () => live.decodeSolanaVaultAccount(data.slice(0, 1657)),
      live.SolanaVaultValidationError,
    );
    const wrongCount = data.slice();
    wrongCount[133] = 97;
    assert.throws(
      () => live.decodeSolanaVaultAccount(wrongCount),
      live.SolanaVaultValidationError,
    );
    const wrongBool = data.slice();
    wrongBool[132] = 2;
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
  it("encodes a left-out owner refund account as Anchor's absent optional account", () => {
    // Audit VAULT-2: the owner's input ATA is needed only to return a donation, so an
    // owner who closed it must not block swaps. Absent is the program ID, read-only.
    const base = {
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
        role: 1 as const,
      })),
    };
    const absent = live.buildExecuteSolanaSwapInstruction({
      ...base,
      ownerRefund: null,
    });
    assert.deepEqual(absent.accounts![14], { address: programAddress, role: 0 });
    const present = live.buildExecuteSolanaSwapInstruction({
      ...base,
      ownerRefund: feePayer,
    });
    assert.deepEqual(present.accounts![14], { address: feePayer, role: 1 });
    assert.deepEqual(absent.data, present.data);
    assert.equal(absent.accounts!.length, 26);
    // An explicit program ID would be a writable program account, and a route
    // shorter than the program's 32-byte minimum can never execute.
    for (const bad of [
      { ...base, ownerRefund: programAddress },
      { ...base, ownerRefund: null, routeData: new Uint8Array(31) },
    ])
      assert.throws(
        () => live.buildExecuteSolanaSwapInstruction(bad),
        live.SolanaVaultValidationError,
      );
  });
});

const CONTRACT = pathJoin(import.meta.dirname, "..", "..", "..", "contracts", "solana");
const contractFile = (p: string) => readFileSync(pathJoin(CONTRACT, p), "utf8");
/** Active `key = value` lines of one TOML table, comments dropped. */
function tomlTable(text: string, table: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) inside = line === `[${table}]`;
    else if (inside && line.includes("=")) {
      const at = line.indexOf("=");
      out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return out;
}

describe("Solana custody build configuration", () => {
  it("claims no LTO the build cannot apply and keeps overflow checks", () => {
    // Audit GAP4-5: cargo never runs LTO on a cdylib/rlib pair, so `lto = "fat"` beside
    // crate-type ["cdylib", "lib"] was silently ignored. Real LTO needs a cdylib-only build.
    const workspace = contractFile("Cargo.toml");
    const program = contractFile("programs/merrymen-vault/Cargo.toml");
    const crateTypes = tomlTable(program, "lib").get("crate-type");
    assert.equal(crateTypes, '["cdylib", "lib"]');
    for (const text of [workspace, program])
      for (const table of ["profile.release", "profile.release.package.merrymen-vault"])
        assert.equal(tomlTable(text, table).has("lto"), false, `${table} sets lto`);
    const release = tomlTable(workspace, "profile.release");
    assert.equal(release.get("overflow-checks"), "true");
    assert.equal(release.get("codegen-units"), "1");
  });
});
