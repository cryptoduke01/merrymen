/**
 * Owner recovery against an in-process fake mainnet. Nothing leaves the test:
 * every RPC call is answered by FakeChain, which decodes each sent
 * transaction, verifies the owner's signature, and applies the vault
 * program's own account constraints (contracts/solana lib.rs: revoke_all,
 * withdraw, withdraw_sol) plus the ATA and SyncNative semantics recovery uses.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { base58Decode, base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import {
  buildRevokeSolanaSessionsInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR, SOLANA_WRAPPED_SOL_MINT,
} from "../../packages/core/src/solana-live";
import { SOLANA_VAULT_RELEASES as CORE_SOLANA_VAULT_RELEASES } from "../../packages/core/src/solana-live";
import {
  readSolanaOwnerKey, SOLANA_VAULT_RELEASES, SolanaRecoverError, solanaRecoveryProgramTrust, solanaRecoveryRevokeInstructions,
  solanaRecoveryWithdrawLegs, type SolanaRecoveryResult,
} from "./solana-recover";
import { runSolanaRecoverCommand, type SolanaRecoverCommandDeps } from "./solana-recover-command";
import { SOLANA_MAINNET_GENESIS_HASH, SolanaRpcError } from "./solana-rpc";

const RPC = "https://rpc.example.test/?api-key=fixture-rpc-secret";
const key = (fill: number) => base58Encode(new Uint8Array(32).fill(fill));
const PROGRAM = key(71);
const SESSION = key(72);
const SEED = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255);
const OWNER = base58Encode(ed25519.getPublicKey(SEED));
const SECRET64 = new Uint8Array([...SEED, ...ed25519.getPublicKey(SEED)]);
const SECRET_BASE58 = base58Encode(SECRET64);
const SECRET_JSON = JSON.stringify([...SECRET64]);
const OTHER_SEED = new Uint8Array(32).fill(5);
const OTHER_OWNER = base58Encode(ed25519.getPublicKey(OTHER_SEED));

const rent = (size: number) => BigInt(size + 128) * 6_960n;
const DISC = {
  revoke: [147, 196, 234, 31, 86, 199, 8, 234], withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  withdrawSol: [145, 131, 74, 136, 65, 137, 42, 38],
};
type Account = { owner: string; lamports: bigint; data: Buffer; executable?: boolean };
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const BINARY = Buffer.from("merrymen-vault-fixture-binary".repeat(10));
const BINARY_SHA = createHash("sha256").update(BINARY).digest("hex");
/** Tests run as if PROGRAM were a released program with BINARY deployed, unless they say otherwise. */
const RELEASED = [{ programId: PROGRAM, sha256: BINARY_SHA }];
type Decoded = { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; data: Buffer };

function vaultData(owner: string, session: string, fields: { epoch?: bigint; seq?: bigint; expiresAt?: bigint; paused?: boolean } = {}): Buffer {
  const data = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE);
  Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(data, 0);
  data[8] = 2; data[9] = 254;
  Buffer.from(base58Decode(owner)!).copy(data, 10);
  Buffer.from(base58Decode(session)!).copy(data, 42);
  data.writeBigUInt64LE(fields.epoch ?? 3n, 74); data.writeBigUInt64LE(fields.seq ?? 40n, 82);
  data.writeBigInt64LE(fields.expiresAt ?? 1_900_000_000n, 90);
  data.writeBigUInt64LE(25_000_000n, 98); data.writeBigUInt64LE(100_000_000n, 106);
  data.writeBigUInt64LE(1_000_000_000n, 114); data.writeBigUInt64LE(4_000_000_000n, 122);
  data.writeUInt16LE(20, 130); data[132] = fields.paused ? 1 : 0; data.writeUInt32LE(0, 133);
  return data;
}
function tokenData(mint: string, authority: string, amount: bigint, options: { nativeReserve?: bigint; frozen?: boolean; size?: number } = {}): Buffer {
  const data = Buffer.alloc(options.size ?? 165);
  Buffer.from(base58Decode(mint)!).copy(data, 0);
  Buffer.from(base58Decode(authority)!).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = options.frozen ? 2 : 1;
  if (options.nativeReserve !== undefined) { data.writeUInt32LE(1, 109); data.writeBigUInt64LE(options.nativeReserve, 113); }
  if (data.length > 165) data[165] = 2;
  return data;
}

/** A fake mainnet that executes recovery transactions with the program's constraints. */
/** Blocks the finalized commitment trails the tip by. */
const FINALITY_LAG = 32;
type Behavior = "land" | "drop" | "fail" | "reject" | "late";
class FakeChain {
  accounts = new Map<string, Account>();
  slot = 1_000; height = 5_000;
  genesis = SOLANA_MAINNET_GENESIS_HASH;
  /** Distinct transactions, in the order first submitted. Rebroadcasts of the same bytes are counted in `broadcasts`. */
  sent: { signature: string; instructions: Decoded[]; wire: string }[] = [];
  broadcasts = 0;
  calls: string[] = [];
  statuses = new Map<string, { slot: number; err: unknown; polls: number }>();
  /**
   * Per transaction, in the order first submitted: land (default, at once), drop
   * (accepted, never lands), fail (lands with an error), reject (refused every
   * time, as by a failed simulation) or late (accepted, lands one block before
   * its blockhash expires). Rebroadcasts of identical bytes are the same transaction.
   */
  behaviors: Behavior[] = [];
  behaviorOf = new Map<string, Behavior>();
  pending = new Map<string, { instructions: Decoded[]; landAt: number; lastValid: number }>();
  /** Last valid block height of every blockhash handed out. */
  blockhashes = new Map<string, number>();
  /** Runs before each new transaction executes, e.g. a session trade racing the revoke. */
  beforeSend?: (index: number) => void;
  /** Statuses report "confirmed" to this many owner polls before "finalized". */
  confirmedPolls = 1;
  /** Never report "finalized". */
  holdFinality = false;
  vault = "";
  constructor(readonly program: string = PROGRAM) {}

  async setup(options: { session?: string; usdg?: bigint; wsol?: bigint; unsynced?: bigint; solExcess?: bigint; ownerLamports?: bigint;
    frozenUsdg?: boolean; noWsolAccount?: boolean; ownerAtas?: boolean;
    /** The program account: an immutable deployment (default), an upgradeable one, or none at all. */
    deployment?: "immutable" | "upgradeable" | "none"; binary?: Buffer } = {}) {
    if ((options.deployment ?? "immutable") !== "none") this.deploy(options.deployment === "upgradeable", options.binary ?? BINARY);
    this.vault = await deriveSolanaVaultAddress(this.program, OWNER);
    this.accounts.set(this.vault, { owner: this.program, lamports: rent(SOLANA_VAULT_ACCOUNT_SIZE) + (options.solExcess ?? 3_000_000n), data: vaultData(OWNER, options.session ?? SESSION) });
    const usdgAta = await deriveSolanaAta(this.vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
    this.accounts.set(usdgAta, { owner: TOKEN_2022_PROGRAM, lamports: rent(170), data: tokenData(SOLANA_USDG_MINT, this.vault, options.usdg ?? 12_345_678n, { size: 170, frozen: options.frozenUsdg }) });
    if (!options.noWsolAccount) {
      const wsolAta = await deriveSolanaAta(this.vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
      const wsol = options.wsol ?? 500_000_000n;
      this.accounts.set(wsolAta, { owner: SOLANA_CLASSIC_TOKEN_PROGRAM, lamports: rent(165) + wsol + (options.unsynced ?? 100_000_000n),
        data: tokenData(SOLANA_WRAPPED_SOL_MINT, this.vault, wsol, { nativeReserve: rent(165) }) });
    }
    this.accounts.set(OWNER, { owner: SOLANA_SYSTEM_PROGRAM, lamports: options.ownerLamports ?? 50_000_000n, data: Buffer.alloc(0) });
    if (options.ownerAtas) {
      for (const [mint, program, size] of [[SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, 170], [SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 165]] as const) {
        this.accounts.set(await deriveSolanaAta(OWNER, mint, program), { owner: program, lamports: rent(size),
          data: tokenData(mint, OWNER, 0n, { size, ...(mint === SOLANA_WRAPPED_SOL_MINT ? { nativeReserve: rent(165) } : {}) }) });
      }
    }
    return this;
  }
  /** An upgradeable-loader program account and its ProgramData (immutable when the upgrade authority is None). */
  deploy(upgradeable: boolean, binary: Buffer) {
    const dataAddress = key(75);
    const program = Buffer.alloc(36); program.writeUInt32LE(2, 0); Buffer.from(base58Decode(dataAddress)!).copy(program, 4);
    this.accounts.set(this.program, { owner: LOADER, lamports: 1n, data: program, executable: true });
    const header = Buffer.alloc(45); header.writeUInt32LE(3, 0); header[12] = upgradeable ? 1 : 0;
    this.accounts.set(dataAddress, { owner: LOADER, lamports: 1n, data: Buffer.concat([header, binary]) });
  }
  token(address: string) { const a = this.accounts.get(address); return a ? a.data.readBigUInt64LE(64) : null; }
  /** Time passes: about one block per 400 ms, at least one block per wait. Late transactions land when their block comes. */
  tick(ms: number) {
    for (let blocks = Math.max(1, Math.ceil(ms / 400)); blocks > 0; blocks--) {
      this.slot++; this.height++;
      for (const [signature, tx] of this.pending) {
        if (this.height > tx.lastValid) { this.pending.delete(signature); continue; }
        if (this.height >= tx.landAt) { this.pending.delete(signature); this.land(signature, tx.instructions, "land"); }
      }
    }
  }
  /** Executes a transaction in a block. Returns false when it cannot pass simulation. */
  land(signature: string, instructions: Decoded[], behavior: "land" | "fail"): boolean {
    const snapshot = new Map([...this.accounts].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }]));
    let err: unknown = null;
    try { for (const ix of instructions) this.execute(ix); }
    catch { this.accounts = snapshot; err = { InstructionError: [0, { Custom: 1 }] }; }
    if (behavior === "fail") { this.accounts = snapshot; err = { InstructionError: [0, { Custom: 6000 }] }; }
    if (err === null) this.accounts.get(OWNER)!.lamports -= 5_000n;
    this.statuses.set(signature, { slot: ++this.slot, err, polls: 0 });
    this.height++;
    return true;
  }
  vaultField() { const d = this.accounts.get(this.vault)!.data; return { session: base58Encode(d.subarray(42, 74)), epoch: d.readBigUInt64LE(74), paused: d[132] === 1, expiresAt: d.readBigInt64LE(90), seq: d.readBigUInt64LE(82) }; }

  fetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), RPC, "only the RPC the owner supplied is contacted");
    const body = JSON.parse(String(init?.body));
    this.calls.push(body.method);
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    const error = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "simulation failed" } }));
    const encode = (a: Account | undefined) => a ? { owner: a.owner, lamports: Number(a.lamports), data: [a.data.toString("base64"), "base64"],
      executable: !!a.executable, rentEpoch: 0, space: a.data.length } : null;
    const p = body.params ?? [];
    switch (body.method) {
      case "getGenesisHash": return reply(this.genesis);
      case "getSlot": {
        const options = p[0] as { commitment?: string; minContextSlot?: number } | undefined;
        const current = options?.commitment === "finalized" ? this.slot - 32 : this.slot;
        // Like a real RPC: a context floor above the requested commitment's tip is an error.
        if ((options?.minContextSlot ?? 0) > current) return error();
        return reply(current);
      }
      case "getBlockHeight": return reply((p[0] as { commitment?: string } | undefined)?.commitment === "finalized" ? this.height - FINALITY_LAG : this.height);
      case "isBlockhashValid": {
        const lastValid = this.blockhashes.get(String(p[0]));
        return reply({ context: { slot: this.slot }, value: lastValid !== undefined && this.height <= lastValid });
      }
      case "getMinimumBalanceForRentExemption": return reply(Number(rent(p[0])));
      case "getMultipleAccounts": return reply({ context: { slot: this.slot }, value: (p[0] as string[]).map((k) => encode(this.accounts.get(k))) });
      case "getAccountInfo": {
        const account = this.accounts.get(p[0]), slice = p[1]?.dataSlice as { offset: number; length: number } | undefined;
        const value = encode(account && slice ? { ...account, data: account.data.subarray(slice.offset, slice.offset + slice.length) } : account);
        return reply({ context: { slot: this.slot }, value: value && account ? { ...value, space: account.data.length } : value });
      }
      case "getLatestBlockhash": {
        const blockhash = key(90 + this.sent.length);
        this.blockhashes.set(blockhash, this.height + 150);
        return reply({ context: { slot: this.slot }, value: { blockhash, lastValidBlockHeight: this.height + 150 } });
      }
      case "getSignatureStatuses": {
        const status = this.statuses.get(p[0][0]);
        if (!status) return reply({ context: { slot: this.slot }, value: [null] });
        // Only the owner tool's polls (with history search) count; the transport's rebroadcast checks do not.
        const polls = p[1]?.searchTransactionHistory === true ? status.polls++ : status.polls;
        const finalized = !this.holdFinality && polls >= this.confirmedPolls;
        // Once a slot is reported finalized, the finalized tip has reached it.
        if (finalized) this.slot = Math.max(this.slot, status.slot + 32);
        return reply({ context: { slot: this.slot }, value: [{ slot: status.slot, confirmations: finalized ? null : 1, err: status.err,
          confirmationStatus: finalized ? "finalized" : "confirmed" }] });
      }
      case "sendTransaction": {
        this.broadcasts++;
        const wire = String(p[0]);
        const { signature, instructions, blockhash } = this.decode(wire);
        if (!this.behaviorOf.has(signature)) {
          const index = this.sent.length;
          this.beforeSend?.(index);
          this.sent.push({ signature, instructions, wire });
          this.behaviorOf.set(signature, this.behaviors[index] ?? "land");
        }
        const behavior = this.behaviorOf.get(signature)!;
        // Like a real RPC with preflight: a copy that already landed, or one
        // whose blockhash expired, is refused.
        if (this.statuses.has(signature)) return error();
        const lastValid = this.blockhashes.get(blockhash);
        if (lastValid === undefined || this.height > lastValid) return error();
        if (behavior === "reject") return error();
        if (behavior === "drop") return reply(signature);
        if (behavior === "late") {
          if (!this.pending.has(signature)) this.pending.set(signature, { instructions, landAt: lastValid - 1, lastValid });
          return reply(signature);
        }
        // Simulation first: a transaction that would fail is refused, not landed.
        const snapshot = new Map([...this.accounts].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }]));
        try { for (const ix of instructions) this.execute(ix); }
        catch { this.accounts = snapshot; return error(); }
        this.accounts = snapshot;
        this.land(signature, instructions, behavior);
        return reply(signature);
      }
      default: throw new Error(`unexpected RPC method ${body.method}`);
    }
  };

  decode(wire: string): { signature: string; instructions: Decoded[]; blockhash: string } {
    const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
    const keys = message.staticAccounts.map(String);
    assert.equal(keys[0], OWNER, "the owner pays the fees");
    assert.deepEqual(Object.keys(tx.signatures), keys.slice(0, numSignerAccounts));
    assert.equal(numSignerAccounts, 1, "the owner is the only signer");
    for (const signer of keys.slice(0, numSignerAccounts)) {
      const bytes = tx.signatures[signer as keyof typeof tx.signatures];
      assert.ok(bytes && ed25519.verify(new Uint8Array(bytes), new Uint8Array(tx.messageBytes), base58Decode(signer)!), "valid owner signature");
    }
    const role = (i: number) => ({ signer: i < numSignerAccounts,
      writable: i < numSignerAccounts - numReadonlySignerAccounts || (i >= numSignerAccounts && i < keys.length - numReadonlyNonSignerAccounts) });
    const instructions = message.instructions.map((ix) => ({ program: keys[ix.programAddressIndex]!,
      accounts: (ix.accountIndices ?? []).map((i) => ({ address: keys[i]!, ...role(i) })), data: Buffer.from(ix.data ?? []) }));
    const first = tx.signatures[keys[0] as keyof typeof tx.signatures]!;
    return { signature: base58Encode(new Uint8Array(first)), instructions, blockhash: String(message.lifetimeToken) };
  }

  /** Program semantics, failing like the real programs would. */
  execute(ix: Decoded) {
    const need = (ok: boolean, why: string) => { if (!ok) throw new Error(why); };
    const acct = (i: number, writable = false, signer = false) => {
      const meta = ix.accounts[i]; need(!!meta, "missing account");
      need(!writable || meta!.writable, "account must be writable"); need(!signer || meta!.signer, "account must sign");
      return meta!.address;
    };
    const atas = this.atas;
    if (ix.program === SOLANA_ASSOCIATED_TOKEN_PROGRAM) {
      need(ix.data.length === 1 && ix.data[0] === 1, "only CreateIdempotent");
      const payer = acct(0, true, true), ata = acct(1, true), wallet = acct(2), mint = acct(3), program = acct(5);
      need(acct(4) === SOLANA_SYSTEM_PROGRAM, "system program");
      need(atas.get(`${wallet}:${mint}:${program}`) === ata, "ATA address");
      if (this.accounts.has(ata)) return;
      const size = program === TOKEN_2022_PROGRAM ? 170 : 165;
      this.accounts.get(payer)!.lamports -= rent(size);
      this.accounts.set(ata, { owner: program, lamports: rent(size),
        data: tokenData(mint, wallet, 0n, { size, ...(mint === SOLANA_WRAPPED_SOL_MINT ? { nativeReserve: rent(165) } : {}) }) });
      return;
    }
    if (ix.program === SOLANA_CLASSIC_TOKEN_PROGRAM) {
      need(ix.data.length === 1 && ix.data[0] === 17 && ix.accounts.length === 1, "only SyncNative");
      const native = this.accounts.get(acct(0, true))!;
      need(native.data.readUInt32LE(109) === 1, "native account");
      native.data.writeBigUInt64LE(native.lamports - native.data.readBigUInt64LE(113), 64);
      return;
    }
    need(ix.program === this.program, "unexpected program");
    const disc = [...ix.data.subarray(0, 8)];
    const vaultKey = acct(0, true), vault = this.accounts.get(vaultKey)!;
    need(vaultKey === this.vault, "vault PDA seeds");
    const owner = acct(1, disc.join() === DISC.withdrawSol.join(), true);
    need(base58Encode(vault.data.subarray(10, 42)) === owner, "has_one owner");
    const bumpSeq = () => vault.data.writeBigUInt64LE(vault.data.readBigUInt64LE(82) + 1n, 82);
    if (disc.join() === DISC.revoke.join()) {
      need(ix.accounts.length === 2, "revoke accounts");
      vault.data.writeBigUInt64LE(vault.data.readBigUInt64LE(74) + 1n, 74);
      Buffer.alloc(32).copy(vault.data, 42); vault.data.writeBigInt64LE(0n, 90); vault.data[132] = 1;
      return;
    }
    const amount = ix.data.readBigUInt64LE(8);
    need(amount > 0n, "amount");
    if (disc.join() === DISC.withdrawSol.join()) {
      need(amount <= vault.lamports - rent(vault.data.length), "withdraw_sol above the rent reserve");
      vault.lamports -= amount; this.accounts.get(owner)!.lamports += amount; bumpSeq();
      return;
    }
    need(disc.join() === DISC.withdraw.join() && ix.accounts.length === 6, "withdraw");
    const mint = acct(2), vaultTokenKey = acct(3, true), ownerTokenKey = acct(4, true), program = acct(5);
    need(atas.get(`${vaultKey}:${mint}:${program}`) === vaultTokenKey, "vault_token is the vault ATA");
    need(atas.get(`${owner}:${mint}:${program}`) === ownerTokenKey, "owner_token is the owner ATA");
    const from = this.accounts.get(vaultTokenKey), to = this.accounts.get(ownerTokenKey);
    need(!!from && !!to, "token accounts exist");
    need(from!.data[108] === 1 && to!.data[108] === 1, "not frozen");
    const balance = from!.data.readBigUInt64LE(64);
    need(amount <= balance, "insufficient funds");
    from!.data.writeBigUInt64LE(balance - amount, 64);
    to!.data.writeBigUInt64LE(to!.data.readBigUInt64LE(64) + amount, 64);
    if (mint === SOLANA_WRAPPED_SOL_MINT) { from!.lamports -= amount; to!.lamports += amount; }
    bumpSeq();
  }
  atas = new Map<string, string>();
  async indexAtas() {
    for (const wallet of [OWNER, this.vault]) {
      for (const [mint, program] of [[SOLANA_USDG_MINT, TOKEN_2022_PROGRAM], [SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM]] as const) {
        this.atas.set(`${wallet}:${mint}:${program}`, await deriveSolanaAta(wallet, mint, program));
      }
    }
    return this;
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function keyFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "solana-recover-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owner-key.txt");
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  return file;
}
async function chain(options: Parameters<FakeChain["setup"]>[0] = {}) {
  return (await (await new FakeChain().setup(options)).indexAtas());
}
async function run(fake: FakeChain, args: string[], extra: Partial<SolanaRecoverCommandDeps> = {}) {
  const out: string[] = [], warnings: string[] = [];
  // Waits are fake time: they advance the chain instead of the clock.
  const deps: SolanaRecoverCommandDeps = { fetch: fake.fetch, log: (l) => out.push(l), warn: (l) => warnings.push(l), sleep: async (ms) => fake.tick(ms),
    pollMs: 2_000, releases: RELEASED, ...extra };
  try {
    const result = await runSolanaRecoverCommand(args, deps);
    return { result: result as SolanaRecoveryResult, out: out.join("\n"), warnings: warnings.join("\n"), error: null as unknown };
  } catch (error) {
    return { result: null, out: out.join("\n"), warnings: warnings.join("\n"), error };
  }
}
function noSecrets(...texts: string[]) {
  for (const text of texts) {
    assert.ok(!text.includes(SECRET_BASE58), "the secret key was printed");
    assert.ok(!text.includes(base58Encode(SEED)), "the secret seed was printed");
    assert.ok(!text.includes(SECRET_JSON.slice(1, 40)), "the secret key array was printed");
    assert.ok(!text.includes("fixture-rpc-secret"), "the RPC URL's API key was printed");
  }
}
const base = ["--program", PROGRAM, "--rpc", RPC];

describe("owner key input", () => {
  it("accepts a wallet export, a seed and a solana-keygen array, and they name the same owner", async () => {
    for (const text of [SECRET_BASE58, `  ${SECRET_BASE58}\n`, base58Encode(SEED), SECRET_JSON, `${SECRET_JSON}\n`]) {
      const { owner, keyPair } = await readSolanaOwnerKey(text);
      assert.equal(owner, OWNER);
      assert.equal(keyPair.privateKey.extractable, false, "the imported key cannot be exported again");
    }
  });
  it("refuses a key whose public half does not match, and anything else, without echoing it", async () => {
    const mismatched = base58Encode(new Uint8Array([...SEED, ...ed25519.getPublicKey(OTHER_SEED)]));
    for (const text of [mismatched, "", "not a key", SECRET_BASE58.slice(0, 60), JSON.stringify([...SECRET64.slice(0, 63)]),
      JSON.stringify([...SECRET64.slice(0, 63), 256]), "x".repeat(5000), `0x${Buffer.from(SECRET64).toString("hex")}`]) {
      await assert.rejects(readSolanaOwnerKey(text), (error: unknown) => {
        assert.ok(error instanceof SolanaRecoverError);
        assert.match(error.message, /does not contain a Solana secret key/);
        noSecrets(error.message, String(error.stack)); assert.ok(!text || !error.message.includes(text.slice(0, 20)));
        return true;
      });
    }
  });
});

describe("solana-recover", () => {
  it("plans from a public key alone: reads only, signs and sends nothing", async () => {
    const fake = await chain();
    const { result, out, error } = await run(fake, [...base, "--owner", OWNER]);
    assert.equal(error, null, String(error));
    assert.equal(result!.sent, false);
    assert.equal(fake.sent.length, 0);
    assert.ok(!fake.calls.includes("sendTransaction") && !fake.calls.includes("getLatestBlockhash"));
    assert.match(out, /PLAN ONLY\. Nothing was signed or sent; add --send/);
    assert.match(out, new RegExp(`Vault:\\s+${fake.vault}`));
    assert.match(out, /USDG\s+12\.345678/);
    assert.match(out, /WSOL\s+0\.6 \(includes 0\.1 unsynced\)/);
    assert.match(out, /SOL\s+0\.003 above the vault account's rent reserve/);
    assert.match(out, /1\. revoke_all/);
    assert.match(out, /2\. withdraw 12\.345678 USDG, 0\.6 WSOL, 0\.003 SOL to the owner/);
    noSecrets(out);
  });

  it("revokes alone and finalized, then withdraws every unit to the owner from finalized balances", async () => {
    const fake = await chain();
    fake.confirmedPolls = 2;
    // The session trades while the revoke is in flight: step 2 must use the
    // post-revoke balances, not the plan's.
    fake.beforeSend = (index) => {
      if (index !== 0) return;
      const usdg = fake.atas.get(`${fake.vault}:${SOLANA_USDG_MINT}:${TOKEN_2022_PROGRAM}`)!;
      fake.accounts.get(usdg)!.data.writeBigUInt64LE(2_345_678n, 64);
    };
    const file = keyFile(`${SECRET_BASE58}\n`);
    const { result, out, warnings, error } = await run(fake, [...base, "--key-file", file, "--send"]);
    assert.equal(error, null, String(error));
    assert.equal(fake.sent.length, 4, "the revoke, then one transaction per asset");

    const [revoke, solLeg, usdgLeg, wsolLeg] = fake.sent;
    const expectedRevoke = buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault: fake.vault, owner: OWNER });
    assert.equal(revoke!.instructions.length, 1, "revoke_all is sent alone");
    assert.deepEqual([...revoke!.instructions[0]!.data], [...expectedRevoke.data!]);
    assert.deepEqual(revoke!.instructions[0]!.accounts.map((a) => a.address), [fake.vault, OWNER]);
    assert.equal(result!.revoke?.status, "finalized");

    const ownerUsdg = await deriveSolanaAta(OWNER, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
    const ownerWsol = await deriveSolanaAta(OWNER, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
    const vaultUsdg = await deriveSolanaAta(fake.vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
    const vaultWsol = await deriveSolanaAta(fake.vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
    // SOL first, then USDG, then WSOL; no transaction touches two assets.
    assert.deepEqual(solLeg!.instructions.map((ix) => ix.program), [PROGRAM]);
    assert.deepEqual(usdgLeg!.instructions.map((ix) => ix.program), [SOLANA_ASSOCIATED_TOKEN_PROGRAM, PROGRAM]);
    assert.deepEqual(wsolLeg!.instructions.map((ix) => ix.program), [SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, PROGRAM]);
    const usdgIx = buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault: fake.vault, owner: OWNER, mint: SOLANA_USDG_MINT,
      vaultToken: vaultUsdg, ownerToken: ownerUsdg, tokenProgram: TOKEN_2022_PROGRAM, amount: 2_345_678n });
    const wsolIx = buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault: fake.vault, owner: OWNER, mint: SOLANA_WRAPPED_SOL_MINT,
      vaultToken: vaultWsol, ownerToken: ownerWsol, tokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, amount: 600_000_000n });
    const solIx = buildWithdrawSolanaNativeInstruction({ programAddress: PROGRAM, vault: fake.vault, owner: OWNER, amount: 3_000_000n });
    for (const [sentIx, built] of [[usdgLeg!.instructions[1]!, usdgIx], [wsolLeg!.instructions[2]!, wsolIx], [solLeg!.instructions[0]!, solIx]] as const) {
      assert.deepEqual([...sentIx.data], [...built.data!], "the instruction matches the packages/core builder");
      assert.deepEqual(sentIx.accounts.map((a) => a.address), built.accounts!.map((a) => String(a.address)));
    }
    assert.deepEqual(result!.withdrawals!.map((w) => [w.asset, w.amountRaw, w.outcome?.status, w.error]),
      [["SOL", 3_000_000n, "finalized", undefined], ["USDG", 2_345_678n, "finalized", undefined], ["WSOL", 600_000_000n, "finalized", undefined]]);

    // Everything moved to the owner; only rent stays.
    assert.equal(fake.token(vaultUsdg), 0n);
    assert.equal(fake.token(vaultWsol), 0n);
    assert.equal(fake.accounts.get(vaultWsol)!.lamports, rent(165));
    assert.equal(fake.accounts.get(fake.vault)!.lamports, rent(SOLANA_VAULT_ACCOUNT_SIZE));
    assert.equal(fake.token(ownerUsdg), 2_345_678n);
    assert.equal(fake.token(ownerWsol), 600_000_000n);
    assert.deepEqual({ session: fake.vaultField().session, paused: fake.vaultField().paused, expiresAt: fake.vaultField().expiresAt },
      { session: SOLANA_SYSTEM_PROGRAM, paused: true, expiresAt: 0n });
    assert.match(out, /Step 2 \(withdraw\): 2\.345678 USDG, 0\.6 WSOL, 0\.003 SOL, from finalized slot \d+, one transaction per asset/);
    assert.match(out, /One transaction per asset \(SOL, then USDG, then WSOL\)/);
    assert.match(out, /Left in the vault: 0 USDG, 0 WSOL, 0 SOL above rent/);
    assert.match(out, /Delete the exported key file now/);
    assert.equal(warnings, "");
    noSecrets(out, warnings);

    // Running again finds nothing to do and sends nothing.
    const again = await run(fake, [...base, "--key-file", file, "--send"]);
    assert.equal(again.error, null, String(again.error));
    assert.equal(fake.sent.length, 4);
    assert.match(again.out, /revoke_all: not needed/);
    assert.match(again.out, /nothing left to withdraw/);
  });

  it("reads the key from standard input, and refuses a terminal", async () => {
    const fake = await chain({ session: SOLANA_SYSTEM_PROGRAM, ownerAtas: true });
    const piped = await run(fake, [...base, "--key-file", "-", "--send"], { stdin: Readable.from([Buffer.from(SECRET_JSON)]) });
    assert.equal(piped.error, null, String(piped.error));
    assert.equal(fake.sent.length, 3, "no revoke is needed without a session; one withdrawal per asset");
    assert.doesNotMatch(piped.out, /Delete the exported key file/);
    noSecrets(piped.out);
    const terminal = Object.assign(Readable.from([]), { isTTY: true });
    const refused = await run(fake, [...base, "--key-file", "-", "--send"], { stdin: terminal });
    assert.match(String((refused.error as Error).message), /Standard input is a terminal/);
  });

  it("never takes a key from the command line, and warns when one was pasted there", async () => {
    for (const [args, leaked] of [
      [[...base, "--key", SECRET_BASE58, "--send"], true], [[...base, SECRET_BASE58], true], [[...base, "--owner", SECRET_BASE58], true],
      [[...base, "--key-file", SECRET_BASE58, "--send"], true], [[...base, "--key-file", SECRET_JSON], true],
      [[...base, "--secret-key", "x"], false], [[...base, "--owner", OWNER, "--owner", OWNER], false], [[...base, "--send", "yes"], false],
    ] as const) {
      const fake = await chain();
      const { error, out } = await run(fake, [...args]);
      assert.ok(error instanceof SolanaRecoverError, String(error));
      assert.match(error.message, /never from the command line/);
      assert.equal(/clear it from your shell history/.test(error.message), leaked, args.join(" ").slice(0, 40));
      noSecrets(error.message, out);
      assert.deepEqual(fake.calls, [], "refused before any network call");
    }
  });

  it("refuses to send without a key, or with a key for a different owner, before any network call", async () => {
    const fake = await chain();
    const noKey = await run(fake, [...base, "--owner", OWNER, "--send"]);
    assert.match((noKey.error as Error).message, /--send needs --key-file/);
    const mismatch = await run(fake, [...base, "--owner", OTHER_OWNER, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.match((mismatch.error as Error).message, new RegExp(`The key belongs to ${OWNER}, not to --owner ${OTHER_OWNER}`));
    for (const args of [["--rpc", RPC, "--owner", OWNER], ["--program", PROGRAM, "--owner", OWNER], [...base], [...base, "--owner", OWNER, "--program-sha256", "ABC"]]) {
      assert.ok((await run(fake, args)).error instanceof SolanaRecoverError, args.join(" "));
    }
    const insecure = await run(fake, ["--program", PROGRAM, "--rpc", "http://rpc.example.test/", "--owner", OWNER]);
    assert.ok(insecure.error instanceof SolanaRpcError);
    assert.deepEqual(fake.calls, []);
  });

  it("warns about a key file other users can read", { skip: process.platform === "win32" }, async () => {
    const fake = await chain();
    const { warnings, error } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58, 0o644)]);
    assert.equal(error, null, String(error));
    assert.match(warnings, /can be read by other users/);
  });

  it("stops after a revoke that expires or fails, and never sends the withdrawal", async () => {
    for (const behavior of ["drop", "fail"] as const) {
      const fake = await chain();
      fake.behaviors = [behavior];
      const before = fake.token(fake.atas.get(`${fake.vault}:${SOLANA_USDG_MINT}:${TOKEN_2022_PROGRAM}`)!);
      const { error, out } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
      assert.ok(error instanceof SolanaRecoverError, String(error));
      assert.match(error.message, behavior === "drop" ? /expired without landing.*Nothing after it was sent/ : /failed on chain.*Nothing after it was sent/);
      assert.equal(fake.sent.length, 1, "the withdrawal was not sent");
      if (behavior === "drop") assert.ok(fake.broadcasts > 2, "the same signed revoke was rebroadcast until its blockhash expired");
      assert.equal(fake.token(fake.atas.get(`${fake.vault}:${SOLANA_USDG_MINT}:${TOKEN_2022_PROGRAM}`)!), before);
      noSecrets(out, error.message);
    }
  });

  it("rebroadcasts the same signed bytes until they land, and never signs a step twice", async () => {
    const fake = await chain();
    fake.behaviors = ["late", "late"];
    const { error, out } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.equal(error, null, String(error));
    assert.equal(fake.sent.length, 4, "one revoke and three asset withdrawals, each signed once");
    assert.ok(fake.broadcasts > 4, "both were rebroadcast while pending");
    assert.match(out, /Step 1 \(revoke_all\): finalized/);
    assert.match(out, /Left in the vault: 0 USDG, 0 WSOL, 0 SOL above rent/);
  });

  it("reports a refusal from the first broadcast at once, without rebroadcasting it", async () => {
    const fake = await chain();
    fake.behaviors = ["reject"];
    const { error } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.match((error as Error).message, /Step 1 \(revoke_all\) was not confirmed as submitted/);
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.broadcasts, 1);
  });

  it("refuses a missing vault, a foreign program account, a non-mainnet RPC and an owner with no SOL", async () => {
    const wrongProgram = await chain();
    const missing = await run(wrongProgram, ["--program", key(73), "--rpc", RPC, "--owner", OWNER]);
    assert.match((missing.error as Error).message, /No Merrymen vault exists for owner .* under program/);
    const foreign = await chain();
    foreign.accounts.get(foreign.vault)!.owner = key(74);
    assert.match(((await run(foreign, [...base, "--owner", OWNER])).error as Error).message, /not an account of the given program/);
    const devnet = await chain();
    devnet.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    const wrongNetwork = await run(devnet, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.ok(wrongNetwork.error instanceof SolanaRpcError && wrongNetwork.error.code === "wrong-network");
    assert.equal(devnet.sent.length, 0);
    const broke = await chain({ ownerLamports: 0n });
    const noFees = await run(broke, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.match((noFees.error as Error).message, /no SOL for fees/);
    assert.equal(broke.sent.length, 0);
  });

  it("one asset that cannot move, refused or failed on chain, does not stop the others", async () => {
    for (const behavior of ["reject", "fail", "drop"] as const) {
      const fake = await chain();
      // The revoke and the SOL leg land; the USDG leg is blocked; the WSOL leg lands.
      fake.behaviors = ["land", "land", behavior];
      const vaultUsdg = fake.atas.get(`${fake.vault}:${SOLANA_USDG_MINT}:${TOKEN_2022_PROGRAM}`)!;
      const vaultWsol = fake.atas.get(`${fake.vault}:${SOLANA_WRAPPED_SOL_MINT}:${SOLANA_CLASSIC_TOKEN_PROGRAM}`)!;
      const { error, out } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
      assert.ok(error instanceof SolanaRecoverError, behavior);
      assert.match(error.message, /Step 2 did not finish for 12\.345678 USDG; every other asset was withdrawn\..*run the command again/);
      assert.match(out, behavior === "reject" ? /Step 2 \(USDG\): NOT withdrawn\. Step 2 \(USDG\) was not confirmed as submitted .*The other assets are sent separately/
        : behavior === "fail" ? /Step 2 \(USDG\): NOT withdrawn\. Step 2 \(USDG\) failed on chain .*The other assets are sent separately/
          : /Step 2 \(USDG\): NOT withdrawn\. Step 2 \(USDG\) expired without landing/);
      assert.equal(fake.sent.length, 4, "the WSOL leg was still sent");
      assert.equal(fake.token(vaultUsdg), 12_345_678n, "the blocked USDG stays in the vault");
      assert.equal(fake.token(vaultWsol), 0n, "WSOL was withdrawn");
      assert.equal(fake.accounts.get(fake.vault)!.lamports, rent(SOLANA_VAULT_ACCOUNT_SIZE), "spare SOL was withdrawn");
      assert.match(out, /Left in the vault: 12\.345678 USDG, 0 WSOL, 0 SOL above rent/);
      noSecrets(out, error.message);
      // A rerun retries only what is left.
      fake.behaviors = [];
      const again = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
      assert.equal(again.error, null, String(again.error));
      assert.equal(fake.sent.length, 5);
      assert.deepEqual(fake.sent[4]!.instructions.map((ix) => ix.program), [SOLANA_ASSOCIATED_TOKEN_PROGRAM, PROGRAM]);
      assert.equal(fake.token(vaultUsdg), 0n);
    }
  });

  it("reports a revoke that does not finalize in time, and sends nothing after it", async () => {
    const slow = await chain();
    slow.holdFinality = true;
    const pending = await run(slow, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"], { maxWaitMs: 0 });
    assert.match((pending.error as Error).message, /Step 1 \(revoke_all\) is not finalized yet .* re-reads the chain first/);
    assert.equal(slow.sent.length, 1, "nothing is sent while the revoke is unconfirmed");
  });

  it("skips USDG when the owner's own USDG account is frozen, and still recovers WSOL and SOL", async () => {
    const fake = await chain({ session: SOLANA_SYSTEM_PROGRAM, ownerAtas: true });
    const ownerUsdg = await deriveSolanaAta(OWNER, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
    const vaultUsdg = await deriveSolanaAta(fake.vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
    const vaultWsol = await deriveSolanaAta(fake.vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
    fake.accounts.get(ownerUsdg)!.data[108] = 2; // the issuer froze the owner's USDG account
    const { error, out } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.equal(error, null, String(error));
    assert.match(out, new RegExp(`Note: USDG: your USDG account ${ownerUsdg} is frozen by the issuer`));
    assert.match(out, /2\. withdraw 0\.6 WSOL, 0\.003 SOL to the owner/);
    assert.equal(fake.sent.length, 2);
    assert.deepEqual(fake.sent.map((tx) => tx.instructions.map((ix) => ix.program)),
      [[PROGRAM], [SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, PROGRAM]], "no USDG transfer into the frozen account");
    assert.equal(fake.token(vaultUsdg), 12_345_678n, "USDG stays in the vault");
    assert.equal(fake.token(vaultWsol), 0n);
    assert.equal(fake.accounts.get(fake.vault)!.lamports, rent(SOLANA_VAULT_ACCOUNT_SIZE));
  });

  it("skips a frozen USDG account with a note and still recovers the rest; no WSOL account means no WSOL step", async () => {
    const fake = await chain({ frozenUsdg: true, noWsolAccount: true, session: SOLANA_SYSTEM_PROGRAM });
    const { error, out } = await run(fake, [...base, "--key-file", keyFile(SECRET_BASE58), "--send"]);
    assert.equal(error, null, String(error));
    assert.match(out, /frozen by the issuer/);
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(fake.sent[0]!.instructions.map((ix) => ix.program), [PROGRAM], "only withdraw_sol");
    assert.equal(fake.accounts.get(fake.vault)!.lamports, rent(SOLANA_VAULT_ACCOUNT_SIZE));
  });
});

describe("solana-recover program trust", () => {
  const send = () => [...base, "--key-file", keyFile(SECRET_BASE58), "--send"];

  it("refuses --send for a program that is not released unless both --program-sha256 and --unlisted-program are given, before any RPC call", async () => {
    for (const deployment of ["none", "immutable"] as const) {
      for (const extra of [[], ["--program-sha256", BINARY_SHA], ["--unlisted-program"]]) {
        const fake = await chain({ deployment });
        const { error, out } = await run(fake, [...send(), ...extra], { releases: [] });
        assert.ok(error instanceof SolanaRecoverError, String(error));
        assert.match(error.message, new RegExp(`Program ${PROGRAM} is not a released Merrymen vault program \\(none is released yet\\)\\. Nothing was signed or sent`));
        assert.match(error.message, /take the SOL in this wallet and the tokens in its USDG and WSOL accounts/);
        assert.match(error.message, /add --program-sha256 with its binary hash and --unlisted-program/);
        assert.deepEqual(fake.calls, [], "refused before any RPC call");
        assert.equal(fake.sent.length, 0);
        noSecrets(out, error.message);
      }
    }
    // The shipped release list: until the program is released, the bare command
    // a support scam would hand out signs nothing, even for a program that does not exist.
    const fake = await chain({ deployment: "none" });
    const shipped = await run(fake, send(), { releases: undefined });
    assert.match((shipped.error as Error).message, /is not a released Merrymen vault program/);
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.sent.length, 0);
    const listed = await chain();
    const other = await run(listed, send(), { releases: [{ programId: key(76), sha256: BINARY_SHA }] });
    assert.match((other.error as Error).message, /is not a released Merrymen vault program\. Nothing was signed/);
    assert.deepEqual(listed.calls, []);
  });

  it("with --unlisted-program, refuses a missing, upgradeable or different binary before signing", async () => {
    for (const [deployment, sha] of [["none", BINARY_SHA], ["upgradeable", BINARY_SHA], ["immutable", "0".repeat(64)]] as const) {
      const fake = await chain({ deployment });
      const { error } = await run(fake, [...send(), "--program-sha256", sha, "--unlisted-program"], { releases: [] });
      assert.match((error as Error).message, /not the immutable binary with the given SHA-256\. Nothing was signed or sent/, deployment);
      assert.equal(fake.sent.length, 0);
      assert.ok(!fake.calls.includes("getMultipleAccounts") && !fake.calls.includes("getLatestBlockhash"), "verification comes before the plan");
    }
  });

  it("with --unlisted-program and a matching immutable binary, warns and pauses before the first signature", async () => {
    const fake = await chain();
    const pauses: { ms: number; callsBefore: string[] }[] = [];
    const { error, out } = await run(fake, [...send(), "--program-sha256", BINARY_SHA, "--unlisted-program"],
      { releases: [], sleep: async (ms) => { pauses.push({ ms, callsBefore: [...fake.calls] }); } });
    assert.equal(error, null, String(error));
    assert.equal(fake.sent.length, 4);
    assert.match(out, /verified against the given SHA-256 \(immutable\)\. It is NOT a released Merrymen vault program/);
    assert.match(out, new RegExp(`WARNING: ${PROGRAM} is not a released Merrymen vault program`));
    assert.match(out, /Merrymen support never asks you to\nuse --unlisted-program/);
    assert.equal(pauses[0]!.ms, 15_000);
    assert.ok(!pauses[0]!.callsBefore.includes("getLatestBlockhash") && !pauses[0]!.callsBefore.includes("sendTransaction"), "paused before signing");
    assert.ok(out.indexOf("WARNING") < out.indexOf("Step 1 (revoke_all): sending"));
  });

  it("verifies a released program by default, and refuses a different hash or binary at that address before signing", async () => {
    const fake = await chain();
    const verified = await run(fake, send());
    assert.equal(verified.error, null, String(verified.error));
    assert.match(verified.out, /Program binary verified: the released Merrymen vault program, immutable, SHA-256 matches/);
    assert.doesNotMatch(verified.out, /WARNING/);
    assert.ok(fake.calls.indexOf("getAccountInfo") < fake.calls.indexOf("getMultipleAccounts"), "verified before the plan");

    const wrongHash = await chain();
    const differs = await run(wrongHash, [...send(), "--program-sha256", "0".repeat(64)]);
    assert.match((differs.error as Error).message, /differs from the released binary of this program\. Nothing was signed or sent/);
    assert.deepEqual(wrongHash.calls, []);
    for (const options of [{ binary: Buffer.from("look-alike program") }, { deployment: "upgradeable" as const }]) {
      const swapped = await chain(options);
      const { error } = await run(swapped, [...send(), "--unlisted-program"]);
      assert.match((error as Error).message, /not the immutable released binary\. Nothing was signed or sent/);
      assert.equal(swapped.sent.length, 0);
      assert.ok(!swapped.calls.includes("getLatestBlockhash"));
    }
  });

  it("verifies the binary afresh on every run, even after a success through the same RPC in this process", async () => {
    const good = await chain();
    assert.equal((await run(good, send())).error, null);
    for (const options of [{ deployment: "upgradeable" as const }, { binary: Buffer.from("look-alike program") }, { deployment: "none" as const }]) {
      const swapped = await chain(options);
      const { error } = await run(swapped, send());
      assert.match((error as Error).message, /not the immutable released binary\. Nothing was signed or sent/, JSON.stringify(options));
      assert.equal(swapped.sent.length, 0);
      assert.ok(swapped.calls.includes("getAccountInfo"), "the program account was read again");
    }
  });

  it("pins releases in packages/core: the tool's default list is the shared one, frozen and well formed", () => {
    assert.equal(SOLANA_VAULT_RELEASES, CORE_SOLANA_VAULT_RELEASES, "the recovery tool trusts exactly the packages/core release pin");
    assert.ok(Object.isFrozen(CORE_SOLANA_VAULT_RELEASES));
    const ids = new Set<string>();
    for (const release of CORE_SOLANA_VAULT_RELEASES) {
      assert.ok(Object.isFrozen(release), "each release entry is frozen");
      assert.deepEqual(Object.keys(release).sort(), ["programId", "sha256"]);
      const bytes = base58Decode(release.programId);
      assert.ok(bytes?.length === 32 && base58Encode(bytes) === release.programId, `${release.programId} is a canonical program ID`);
      assert.match(release.sha256, /^[a-f0-9]{64}$/);
      assert.ok(!ids.has(release.programId), "one hash per program");
      ids.add(release.programId);
    }
    // With no option, the trust decision reads the core list.
    for (const release of CORE_SOLANA_VAULT_RELEASES) assert.deepEqual(solanaRecoveryProgramTrust({ programId: release.programId, send: true }), { listed: true, sha256: release.sha256 });
    if (!CORE_SOLANA_VAULT_RELEASES.length) assert.throws(() => solanaRecoveryProgramTrust({ programId: PROGRAM, send: true }), /none is released yet/);
  });

  it("plans for any program, says when its binary is not verified, and checks it when a hash is given", async () => {
    const fake = await chain({ deployment: "none" });
    const plan = await run(fake, [...base, "--owner", OWNER], { releases: [] });
    assert.equal(plan.error, null, String(plan.error));
    assert.match(plan.out, /Program binary NOT VERIFIED: not a released Merrymen vault program and no --program-sha256 given/);
    assert.equal(fake.sent.length, 0);
    const checked = await chain({ session: SOLANA_SYSTEM_PROGRAM });
    const verified = await run(checked, [...base, "--owner", OWNER, "--program-sha256", BINARY_SHA], { releases: [] });
    assert.equal(verified.error, null, String(verified.error));
    assert.match(verified.out, /Program binary verified against the given SHA-256/);
    assert.ok(!checked.calls.includes("getLatestBlockhash"));
  });
});

/**
 * The owner recovery transactions that contracts/solana/runtime-tests/tests/recovery.rs
 * executes against the compiled vault program and solana-program-test's bundled SPL Token,
 * Token-2022 and ATA programs: the exact bytes this tool signs and sends for a funded vault
 * with a live session and no owner token accounts yet.
 */
const VAULT_PROGRAM_ID = "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU"; // declare_id! in contracts/solana
const RECOVERY_FIXTURE = fileURLToPath(new URL("../../contracts/solana/runtime-tests/fixtures/recovery-transactions.txt", import.meta.url));
const FUNDED = { usdg: 12_345_678n, wsol: 500_000_000n, unsynced: 100_000_000n, solExcess: 3_000_000n };

async function recoveryFixture(): Promise<string> {
  const fake = await (await new FakeChain(VAULT_PROGRAM_ID).setup(FUNDED)).indexAtas();
  const { result, error } = await run(fake, ["--program", VAULT_PROGRAM_ID, "--rpc", RPC, "--key-file", keyFile(SECRET_BASE58), "--send"],
    { releases: [{ programId: VAULT_PROGRAM_ID, sha256: BINARY_SHA }] });
  assert.equal(error, null, String(error));
  assert.equal(fake.sent.length, 4);
  const [revoke, sol, usdg, wsol] = fake.sent as FakeChain["sent"][number][];
  // The sent transactions carry exactly the exported step builders' instructions.
  const legs = solanaRecoveryWithdrawLegs(result!.plan);
  assert.deepEqual(legs.map((leg) => leg.asset), ["SOL", "USDG", "WSOL"]);
  const shape = (ixs: { program: string; accounts: string[]; data: number[] }[]) => ixs;
  for (const [sent, built] of [[revoke!, solanaRecoveryRevokeInstructions(result!.plan)], [sol!, legs[0]!.instructions],
    [usdg!, legs[1]!.instructions], [wsol!, legs[2]!.instructions]] as const) {
    assert.deepEqual(shape(sent.instructions.map((ix) => ({ program: ix.program, accounts: ix.accounts.map((a) => a.address), data: [...ix.data] }))),
      shape(built.map((ix) => ({ program: String(ix.programAddress), accounts: (ix.accounts ?? []).map((a) => String(a.address)), data: [...(ix.data ?? [])] }))));
  }
  assert.deepEqual([sol!, usdg!, wsol!].map((tx) => tx.instructions.length), [1, 2, 3],
    "withdraw_sol; CreateIdempotent and the USDG withdraw; CreateIdempotent, SyncNative and the WSOL withdraw");
  return [
    "# merrymen solana-recover, as signed and sent by worker/src/solana-recover.ts for a vault with a live",
    "# session, USDG, synced and unsynced WSOL, spare SOL, and no owner token accounts yet: revoke_all, then",
    "# one withdrawal transaction per asset (SOL, USDG, WSOL). Written by",
    "# worker/src/solana-recover.test.ts (MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1 rewrites it) and executed",
    "# by tests/recovery.rs against the compiled program. The owner seed is a public test key.",
    `program ${VAULT_PROGRAM_ID}`,
    `owner ${OWNER}`,
    `owner_seed_hex ${Buffer.from(SEED).toString("hex")}`,
    `session ${SESSION}`,
    `vault ${fake.vault}`,
    `usdg_raw ${FUNDED.usdg}`,
    `wsol_synced_raw ${FUNDED.wsol}`,
    `wsol_unsynced_lamports ${FUNDED.unsynced}`,
    `sol_excess_lamports ${FUNDED.solExcess}`,
    `revoke_tx ${revoke!.wire}`,
    `withdraw_sol_tx ${sol!.wire}`,
    `withdraw_usdg_tx ${usdg!.wire}`,
    `withdraw_wsol_tx ${wsol!.wire}`,
    "",
  ].join("\n");
}

describe("solana-recover runtime fixture", () => {
  it("holds the tool's current recovery transactions for the compiled-program test", async () => {
    const expected = await recoveryFixture();
    assert.equal(await recoveryFixture(), expected, "the fixture is deterministic");
    if (process.env.MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE === "1") writeFileSync(RECOVERY_FIXTURE, expected);
    assert.equal(readFileSync(RECOVERY_FIXTURE, "utf8"), expected,
      "contracts/solana/runtime-tests/fixtures/recovery-transactions.txt is stale: rerun with MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1 and run contracts/solana/test.sh");
  });
});
