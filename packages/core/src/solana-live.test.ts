import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join as pathJoin } from "node:path";
import { address, getProgramDerivedAddress } from "@solana/kit";
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
    assert.deepEqual(absent.accounts![14], {
      address: programAddress,
      role: 0,
    });
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

const CONTRACT = pathJoin(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "contracts",
  "solana",
);
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
      for (const table of [
        "profile.release",
        "profile.release.package.merrymen-vault",
      ])
        assert.equal(
          tomlTable(text, table).has("lto"),
          false,
          `${table} sets lto`,
        );
    const release = tomlTable(workspace, "profile.release");
    assert.equal(release.get("overflow-checks"), "true");
    assert.equal(release.get("codegen-units"), "1");
  });
});

/**
 * The instruction fixture that contracts/solana/runtime-tests/custody.rs executes against
 * the compiled program (audit core-abi-4). Every instruction below comes from this
 * module's builders; the Rust test only funds the accounts and signs. Identities are
 * local ed25519 keys from seeds of 32 equal bytes, unfunded anywhere else.
 */
const ABI_FIXTURE = pathJoin(
  CONTRACT,
  "runtime-tests",
  "fixtures",
  "ts-instructions.json",
);
const FIXTURE_SEEDS = { owner: 0x11, session: 0x22, feePayer: 0x33 } as const;
const FIXTURE_NOW = 1_800_000_000n;
function seededPublicKey(byte: number): string {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, byte),
  ]);
  const spki = createPublicKey(
    createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}
/** The mock Jupiter route bytes custody.rs understands: mode, input, quote, slippage. */
function fixtureRoute(
  mode: number,
  amountIn: bigint,
  quote: bigint,
  bps: number,
) {
  const data = new Uint8Array(32);
  data.set(live.SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR);
  data[8] = mode;
  const view = new DataView(data.buffer);
  view.setBigUint64(13, amountIn, true);
  view.setBigUint64(21, quote, true);
  view.setUint16(29, bps, true);
  return data;
}
async function buildAbiFixture(): Promise<string> {
  const program = programAddress;
  const usdg = SOLANA_USDG_MINT;
  const wsol = live.SOLANA_WRAPPED_SOL_MINT;
  const classic = live.SOLANA_CLASSIC_TOKEN_PROGRAM;
  const owner = seededPublicKey(FIXTURE_SEEDS.owner);
  const session = seededPublicKey(FIXTURE_SEEDS.session);
  const feePayer = seededPublicKey(FIXTURE_SEEDS.feePayer);
  const vault = await live.deriveSolanaVaultAddress(program, owner);
  const vaultUsdg = await live.deriveSolanaAta(vault, usdg, TOKEN_2022_PROGRAM);
  const vaultWsol = await live.deriveSolanaAta(vault, wsol, classic);
  const ownerUsdg = await live.deriveSolanaAta(owner, usdg, TOKEN_2022_PROGRAM);
  const poolUsdg = base58Encode(new Uint8Array(32).fill(0x44));
  const poolWsol = base58Encode(new Uint8Array(32).fill(0x55));
  const [jupiterAuthority] = await getProgramDerivedAddress({
    programAddress: address(live.SOLANA_JUPITER_PROGRAM),
    seeds: [new TextEncoder().encode("authority"), Uint8Array.of(0)],
  });
  const keys: Record<string, string> = {
    owner,
    session,
    feePayer,
    vault,
    vaultUsdg,
    vaultWsol,
    ownerUsdg,
    poolUsdg,
    poolWsol,
    jupiterAuthority,
  };
  const swap = async (
    seq: bigint,
    buy: boolean,
    quote: bigint,
    mode: number,
    ownerRefund: string | null,
  ) => {
    const swapAuthority = await live.deriveSolanaSwapAuthority(
      program,
      vault,
      seq,
    );
    const [inputMint, inputProgram] = buy
      ? [usdg, TOKEN_2022_PROGRAM]
      : [wsol, classic];
    const [outputMint, outputProgram] = buy
      ? [wsol, classic]
      : [usdg, TOKEN_2022_PROGRAM];
    const tempInput = await live.deriveSolanaAta(
      swapAuthority,
      inputMint,
      inputProgram,
    );
    keys[`swap${seq}`] = swapAuthority;
    keys[`temp${seq}`] = tempInput;
    const [vaultInput, vaultOutput] = buy
      ? [vaultUsdg, vaultWsol]
      : [vaultWsol, vaultUsdg];
    const [poolIn, poolOut] = buy ? [poolUsdg, poolWsol] : [poolWsol, poolUsdg];
    return live.buildExecuteSolanaSwapInstruction({
      programAddress: program,
      vault,
      sessionSigner: session,
      feePayer,
      inputMint,
      outputMint,
      vaultInput,
      vaultOutput,
      swapAuthority,
      tempInput,
      ownerRefund,
      inputTokenProgram: inputProgram,
      outputTokenProgram: outputProgram,
      expectedSeq: seq,
      sessionEpoch: 1n,
      amountIn: 100n,
      minOut: (quote * 99n) / 100n,
      deadline: FIXTURE_NOW + 20n,
      slippageBps: 100,
      routeData: fixtureRoute(mode, 100n, quote, 100),
      // Jupiter's own roles; the builder strips every signer flag, including the swap PDA's.
      routeAccounts: [
        { address: classic, role: 0 },
        { address: jupiterAuthority, role: 0 },
        { address: swapAuthority, role: 2 },
        { address: tempInput, role: 1 },
        { address: poolIn, role: 1 },
        { address: poolOut, role: 1 },
        { address: vaultOutput, role: 1 },
        { address: inputMint, role: 0 },
        { address: outputMint, role: 0 },
        { address: live.SOLANA_JUPITER_PROGRAM, role: 0 },
        { address: TOKEN_2022_PROGRAM, role: 0 },
      ],
    });
  };
  const steps: [string, string[], Awaited<ReturnType<typeof swap>>][] = [
    [
      "initialize_vault",
      ["owner"],
      live.buildInitializeSolanaVaultInstruction({
        programAddress: program,
        vault,
        owner,
      }),
    ],
    [
      "create_session",
      ["owner"],
      live.buildCreateSolanaSessionInstruction({
        programAddress: program,
        vault,
        owner,
        session,
        perTrade: 100n,
        daily: 300n,
        perTradeWsol: 100n,
        dailyWsol: 300n,
        maxOps: 10,
        expiresAt: FIXTURE_NOW + 86_400n,
      }),
    ],
    [
      "execute_swap_buy",
      ["feePayer", "session"],
      await swap(0n, true, 200n, 0, null),
    ],
    [
      "execute_swap_sell",
      ["feePayer", "session"],
      await swap(1n, false, 100n, 3, null),
    ],
    [
      "set_breaker_session_pause",
      ["session"],
      live.buildSetSolanaBreakerInstruction({
        programAddress: program,
        vault,
        authority: session,
        paused: true,
      }),
    ],
    [
      "set_breaker_owner_clear",
      ["owner"],
      live.buildSetSolanaBreakerInstruction({
        programAddress: program,
        vault,
        authority: owner,
        paused: false,
      }),
    ],
    // custody.rs donates 7 USDG to temp2 first, so the owner refund account is required.
    [
      "execute_swap_buy_refund",
      ["feePayer", "session"],
      await swap(2n, true, 200n, 0, ownerUsdg),
    ],
    [
      "withdraw",
      ["owner"],
      live.buildWithdrawSolanaVaultInstruction({
        programAddress: program,
        vault,
        owner,
        mint: usdg,
        vaultToken: vaultUsdg,
        ownerToken: ownerUsdg,
        tokenProgram: TOKEN_2022_PROGRAM,
        amount: 50n,
      }),
    ],
    // custody.rs first sends 1000 lamports to the vault.
    [
      "withdraw_sol",
      ["owner"],
      live.buildWithdrawSolanaNativeInstruction({
        programAddress: program,
        vault,
        owner,
        amount: 1000n,
      }),
    ],
    [
      "revoke_all",
      ["owner"],
      live.buildRevokeSolanaSessionsInstruction({
        programAddress: program,
        vault,
        owner,
      }),
    ],
  ];
  const fixture = {
    about:
      "Generated by packages/core/src/solana-live.test.ts from the TypeScript instruction builders " +
      "(MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 rewrites it). custody.rs executes every step against the " +
      "compiled program. Seeds are local test identities only.",
    program,
    now: Number(FIXTURE_NOW),
    seeds: FIXTURE_SEEDS,
    keys,
    steps: steps.map(([name, signers, ix]) => ({
      name,
      signers,
      programId: ix.programAddress,
      accounts: (ix.accounts ?? []).map((a) => ({
        pubkey: a.address,
        signer: a.role >= 2,
        writable: (a.role & 1) === 1,
      })),
      data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
    })),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

describe("Solana custody instruction fixture", () => {
  it("is current with the TypeScript builders the compiled program runs", async () => {
    // Audit core-abi-4: custody.rs runs these exact bytes and account metas against
    // the SBF program, so a reordered account or argument fails the runtime suite.
    const expected = await buildAbiFixture();
    if (process.env.MERRYMEN_WRITE_SOLANA_ABI_FIXTURE === "1")
      writeFileSync(ABI_FIXTURE, expected);
    assert.equal(
      readFileSync(ABI_FIXTURE, "utf8"),
      expected,
      "stale: rerun with MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1, then contracts/solana/test.sh",
    );
  });
  it("derives the seeded identities like ed25519", () => {
    // RFC 8032 test 1 secret key gives its public key; ours use the same derivation.
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "hex",
      ),
    ]);
    const spki = createPublicKey(
      createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
    ).export({ format: "der", type: "spki" });
    assert.equal(
      Buffer.from(spki.subarray(spki.length - 32)).toString("hex"),
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    assert.notEqual(seededPublicKey(0x11), seededPublicKey(0x22));
  });
  it("uses the program's Anchor discriminator in every builder", async () => {
    const vault = await live.deriveSolanaVaultAddress(programAddress, owner);
    const cases: [string, ArrayLike<number>][] = [
      [
        "initialize_vault",
        live.buildInitializeSolanaVaultInstruction({
          programAddress,
          vault,
          owner,
        }).data!,
      ],
      [
        "revoke_all",
        live.buildRevokeSolanaSessionsInstruction({
          programAddress,
          vault,
          owner,
        }).data!,
      ],
      [
        "set_breaker",
        live.buildSetSolanaBreakerInstruction({
          programAddress,
          vault,
          authority: owner,
          paused: true,
        }).data!,
      ],
      [
        "withdraw",
        live.buildWithdrawSolanaVaultInstruction({
          programAddress,
          vault,
          owner,
          mint: SOLANA_USDG_MINT,
          vaultToken: vault,
          ownerToken: owner,
          tokenProgram: TOKEN_2022_PROGRAM,
          amount: 1n,
        }).data!,
      ],
    ];
    for (const [name, data] of cases)
      assert.deepEqual(
        Array.from(data).slice(0, 8),
        Array.from(disc(`global:${name}`)),
        name,
      );
    const fixture = JSON.parse(readFileSync(ABI_FIXTURE, "utf8")) as {
      steps: { name: string; data: string }[];
    };
    const execute = fixture.steps.find((s) => s.name === "execute_swap_buy")!;
    assert.equal(
      execute.data.slice(0, 16),
      Buffer.from(disc("global:execute_swap")).toString("hex"),
    );
  });
});

/** The reviewed build inputs, hashed exactly as contracts/solana/build.sh --source-digest. */
function contractSourceDigest(): string {
  const sha = (data: Buffer | string) =>
    createHash("sha256").update(data).digest("hex");
  const walk = (dir: string): string[] =>
    readdirSync(pathJoin(CONTRACT, dir), { withFileTypes: true }).flatMap(
      (e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : e.isFile() && e.name.endsWith(".rs")
            ? [`${dir}/${e.name}`]
            : [],
    );
  const files = [
    "Cargo.toml",
    "Cargo.lock",
    "build.sh",
    "programs/merrymen-vault/Cargo.toml",
    ...walk("programs/merrymen-vault/src"),
  ].sort();
  return sha(
    files
      .map((f) => `${sha(readFileSync(pathJoin(CONTRACT, f)))}  ${f}\n`)
      .join(""),
  );
}

describe("Solana custody build manifest", () => {
  it("records a pinned, reproduced artifact for the current program source", () => {
    // Audit GAP4-2: tie the reviewed source to a toolchain-pinned artifact hash. A
    // program change without build.sh --record leaves every manifest stale here.
    const dir = pathJoin(CONTRACT, "build-manifests");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length > 0, "no build manifest recorded");
    const script = contractFile("build.sh");
    const pin = (name: string) =>
      script.match(new RegExp(`^${name}="([^"]+)"$`, "m"))?.[1];
    const declared = contractFile("programs/merrymen-vault/src/lib.rs").match(
      /^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);$/m,
    )?.[1];
    const digest = contractSourceDigest();
    for (const file of files) {
      const m = JSON.parse(readFileSync(pathJoin(dir, file), "utf8"));
      assert.equal(
        m.source.digest,
        digest,
        `${file} is stale: run contracts/solana/build.sh --record`,
      );
      assert.equal(`${m.toolchain.host}.json`, file);
      assert.equal(m.program.declaredId, declared);
      assert.equal(m.toolchain.agave, pin("AGAVE_VERSION"));
      assert.equal(m.toolchain.platformTools, pin("PLATFORM_TOOLS_VERSION"));
      assert.equal(m.toolchain.arch, pin("SBF_ARCH"));
      assert.equal(m.toolchain.rustSourceCommit, pin("RUST_SOURCE_COMMIT"));
      assert.match(m.artifact.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(m.artifact.bytes) && m.artifact.bytes > 0);
    }
  });
  it("hashes the source exactly as build.sh does", (t) => {
    const run = spawnSync(
      "bash",
      [pathJoin(CONTRACT, "build.sh"), "--source-digest"],
      { encoding: "utf8" },
    );
    if (run.error) return t.skip("bash is not available");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), contractSourceDigest());
  });
});
