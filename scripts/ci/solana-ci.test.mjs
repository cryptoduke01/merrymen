/**
 * CI BUILDS AND TESTS THE SOLANA VAULT PROGRAM, ON A TOOLCHAIN IT CHECKED.
 *
 * The 2026-10-18 audit (GAP4-1) found no workflow ran cargo or cargo-build-sbf:
 * the vault's native tests, SBF build and custody runtime tests ran only by
 * hand. These tests pin the CI jobs that now do (their steps, order, cache and
 * place in the required `app` check) and the scripts they call: downloads kept
 * only on a size and SHA-256 match, no unverified toolchain fetched later, the
 * rebuild done from tracked source elsewhere, and the artifact tied to the
 * program ID its source declares. No test here uses the network: curl and
 * cargo-build-sbf are replaced by stubs on PATH.
 *
 * Run by CI's `solana · test` job: node --test scripts/ci/solana-ci.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { anchorProgramIds, base58Decode, declaredProgramId, programRecord, readToolchain } from "./solana-program-record.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
const pinsText = readFileSync(join(here, "solana-toolchain.env"), "utf8");
const pins = Object.fromEntries(
  pinsText.split("\n").map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]),
);

/** A job's body: the lines indented under `  <name>:` up to the next top-level key. */
function job(name) {
  return new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(ci)?.[1] ?? "";
}

const scratch = mkdtempSync(join(tmpdir(), "merrymen-solana-ci-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = label => {
  const dir = join(scratch, `${label}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
};

/** The environment for a script under test: never the real job's output files. */
function env(extra = {}) {
  const e = { ...process.env, ...extra };
  for (const k of ["GITHUB_PATH", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) delete e[k];
  return e;
}
function run(cmd, args, extra = {}, cwd = repo) {
  return spawnSync(cmd, args, { cwd, env: env(extra), encoding: "utf8" });
}
function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

describe("the CI jobs", () => {
  const test = job("solana-test");
  const rebuild = job("solana-rebuild");
  const app = job("app");

  it("pins every action in ci.yml to a full commit SHA", () => {
    const uses = [...ci.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(m => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  });

  it("solana · test installs the checked toolchain, runs test.sh, then proves nothing unchecked was fetched", () => {
    assert.ok(test, "ci.yml has no solana-test job");
    const order = [
      "uses: actions/checkout@",
      "run: node --test scripts/ci/solana-ci.test.mjs",
      "run: scripts/ci/solana-toolchain.sh install ",
      "uses: actions/cache@",
      "run: contracts/solana/test.sh",
      "run: scripts/ci/solana-toolchain.sh check",
      "node scripts/ci/solana-program-record.mjs contracts/solana contracts/solana/target/deploy/merrymen_vault.so ",
      "uses: actions/upload-artifact@",
    ].map(s => [s, test.indexOf(s)]);
    for (const [s, at] of order) assert.ok(at >= 0, `solana-test lacks ${s}`);
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must come before ${order[i][0]}`);
    assert.match(test, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}$/m);
    assert.match(test, /CARGO_HOME=\$\(realpath /);
  });

  it("gives test.sh no environment override that build.sh refuses", () => {
    // build.sh stops on RUSTFLAGS, CARGO_ENCODED_RUSTFLAGS, CARGO_BUILD_RUSTFLAGS,
    // CARGO_BUILD_TARGET_DIR and any CARGO_PROFILE_* or CARGO_TARGET_* variable:
    // set anywhere in the job, the vault build fails before it starts.
    const build = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
    assert.match(build, /for name in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET_DIR; do/);
    assert.match(build, /\^CARGO_\(PROFILE\|TARGET\)_\[A-Z0-9_\]\+=/);
    const refused = /^\s+(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET_DIR|CARGO_PROFILE_[A-Z0-9_]+|CARGO_TARGET_[A-Z0-9_]+):/m;
    assert.doesNotMatch(test, refused);
    assert.doesNotMatch(test, /(RUSTFLAGS|CARGO_BUILD_TARGET_DIR|CARGO_PROFILE_[A-Z0-9_]+|CARGO_TARGET_[A-Z0-9_]+)=/);
    const top = /^env:\n((?: {2}.*\n)*)/m.exec(ci)?.[1] ?? "";
    assert.doesNotMatch(top, refused);
  });

  it("uploads only the artifact and its record, never the throwaway keypair beside them", () => {
    const upload = /uses: actions\/upload-artifact@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    assert.match(upload, /if-no-files-found: error/);
    const files = [...upload.matchAll(/^ {12}(\S+)$/gm)].map(m => m[1]);
    assert.deepEqual(files, [
      "contracts/solana/target/deploy/merrymen_vault.so",
      "contracts/solana/target/deploy/merrymen_vault.build.json",
    ]);
  });

  it("caches crates and the host test build, never the SBF build or its output", () => {
    const cache = /uses: actions\/cache@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    const paths = [...cache.matchAll(/^ {12}(\S+)$/gm)].map(m => m[1]);
    assert.ok(paths.includes("contracts/solana/target/debug"), paths.join(" "));
    for (const p of paths) assert.match(p, /^(\$\{\{ env\.CARGO_HOME \}\}\/(registry\/index|registry\/cache|git\/db)|contracts\/solana\/target\/debug)$/, p);
    assert.match(cache, /key: .*hashFiles\('scripts\/ci\/solana-toolchain\.env'\).*hashFiles\('contracts\/solana\/Cargo\.lock', 'contracts\/solana\/runtime-tests\/Cargo\.lock'\)/);
  });

  it("solana · rebuild builds again from tracked source elsewhere and reports its hash", () => {
    assert.ok(rebuild, "ci.yml has no solana-rebuild job");
    const install = rebuild.indexOf("run: scripts/ci/solana-toolchain.sh install ");
    const build = rebuild.indexOf("so=$(scripts/ci/solana-rebuild.sh ");
    const record = rebuild.indexOf("node scripts/ci/solana-program-record.mjs ");
    const check = rebuild.indexOf("run: scripts/ci/solana-toolchain.sh check");
    assert.ok(install >= 0 && install < build && build < record && record < check);
    assert.match(rebuild, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}$/m);
    assert.doesNotMatch(rebuild, /actions\/cache@/, "the rebuild must not reuse anything cached");
  });

  it("neither job can be skipped, softened or filtered away", () => {
    for (const body of [test, rebuild]) {
      assert.doesNotMatch(body, /continue-on-error|^\s+if:/m);
      assert.match(body, /^ {4}runs-on: ubuntu-24\.04$/m);
    }
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(on, /^ {2}pull_request:/m);
    assert.doesNotMatch(on, /paths/);
  });

  it("app, the required check, needs both jobs and equal artifact hashes", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(app)?.[1].split(",").map(s => s.trim()) ?? [];
    assert.ok(needs.includes("solana-test") && needs.includes("solana-rebuild"), needs.join(","));
    assert.match(app, /^ {4}if: always\(\)$/m);
    assert.match(app, /test "\$\{\{ needs\.solana-test\.result \}\}" = success/);
    assert.match(app, /test "\$\{\{ needs\.solana-rebuild\.result \}\}" = success/);
    assert.match(app, /VAULT_TESTED_SHA256: \$\{\{ needs\.solana-test\.outputs\.sha256 \}\}/);
    assert.match(app, /VAULT_REBUILT_SHA256: \$\{\{ needs\.solana-rebuild\.outputs\.sha256 \}\}/);
    // Explicit exits: bash 3.2 does not apply errexit to a failing [[ ]].
    assert.match(app, /\[\[ "\$VAULT_TESTED_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\] \|\| \{ .*exit 1; \}$/m);
    assert.match(app, /test "\$VAULT_TESTED_SHA256" = "\$VAULT_REBUILT_SHA256" \|\| \{ .*exit 1; \}$/m);
    // Job outputs reach the script through env, never pasted into its text.
    const at = app.indexOf("run: |");
    assert.ok(at >= 0);
    const script = app.slice(at);
    assert.doesNotMatch(script, /\$\{\{ needs\.solana-[a-z]+\.outputs/);
  });

  it("the scripts CI runs directly are executable", () => {
    for (const f of ["contracts/solana/test.sh", "scripts/ci/solana-toolchain.sh", "scripts/ci/fetch-verified.sh", "scripts/ci/solana-rebuild.sh"]) {
      assert.ok(statSync(join(repo, f)).mode & 0o100, `${f} is not executable`);
    }
  });
});

describe("the toolchain pins", () => {
  it("name agave v2.3.13 and platform-tools v1.48 by size and SHA-256, building for SBF v0", () => {
    assert.equal(pins.AGAVE_VERSION, "v2.3.13");
    assert.equal(pins.AGAVE_ASSET, "solana-release-x86_64-unknown-linux-gnu.tar.bz2");
    assert.equal(pins.PLATFORM_TOOLS_VERSION, "v1.48");
    assert.equal(pins.PLATFORM_TOOLS_ASSET, "platform-tools-linux-x86_64.tar.bz2");
    assert.equal(pins.PLATFORM_TOOLS_RUSTC, "1.84.1");
    assert.equal(pins.SBF_ARCH, "v0");
    for (const k of ["AGAVE_SHA256", "PLATFORM_TOOLS_SHA256"]) assert.match(pins[k], /^[0-9a-f]{64}$/, k);
    for (const k of ["AGAVE_BYTES", "PLATFORM_TOOLS_BYTES"]) assert.match(pins[k], /^[1-9][0-9]{6,}$/, k);
    assert.match(pins.HOST_RUST, /^1\.\d+\.\d+$/);
  });

  it("are plain KEY=value lines, safe for bash to source", () => {
    for (const line of pinsText.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      assert.match(line, /^[A-Z0-9_]+=[A-Za-z0-9._-]+$/, line);
    }
  });

  it("are what the build record names", () => {
    assert.deepEqual(readToolchain(pinsText), { agave: "v2.3.13", platformTools: "v1.48", platformToolsRustc: "1.84.1", arch: "v0", hostRust: pins.HOST_RUST });
  });
});

describe("the program's session cap", () => {
  // web-auth F4: the server grants at most 168 hours (plus clock skew) and the
  // program refuses a create_session ending later than 7 days plus its clock
  // allowance. If the two drifted, either the program would accept longer
  // sessions than the server means to, or refuse ones the server prepared.
  const risk = readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/risk.rs"), "utf8");
  const core = readFileSync(join(repo, "packages/core/src/solana.ts"), "utf8");
  /** A product of integer literals and constants already read, as these files write them. */
  const product = (text, known) => text.split("*").map(t => t.trim()).reduce((n, t) => {
    if (/^\d[\d_]*$/.test(t)) return n * Number(t.replaceAll("_", ""));
    assert.ok(Object.hasOwn(known, t), `unknown term ${t}`);
    return n * known[t];
  }, 1);
  const rustConst = (name, known) => {
    const m = new RegExp(`^pub const ${name}: i64 = ([^;]+);$`, "m").exec(risk);
    assert.ok(m, `risk.rs has no i64 ${name}`);
    return product(m[1], known);
  };
  const tsConst = name => {
    const m = new RegExp(`^export const ${name} = ([^;]+);$`, "m").exec(core);
    assert.ok(m, `solana.ts has no ${name}`);
    return product(m[1], {});
  };

  it("is the server's 168 hours, with an allowance wider than the server's clock skew", () => {
    const DAY = rustConst("DAY", {});
    assert.equal(DAY, 86_400);
    const maxSession = rustConst("MAX_SESSION", { DAY });
    const allowance = rustConst("SESSION_CLOCK_ALLOWANCE", { DAY });
    assert.equal(maxSession * 1000, tsConst("SOLANA_MAX_PERMISSION_MS"));
    assert.equal(maxSession, 7 * 86_400);
    const skewMs = tsConst("SOLANA_PERMISSION_CLOCK_SKEW_MS");
    assert.ok(allowance * 1000 > skewMs, "a session the server accepts at its skew limit must still fit on-chain");
    assert.ok(allowance <= 3_600, "the allowance stays small");
  });

  it("is applied by create_session, not by every trade", () => {
    const lib = readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8");
    const create = /pub fn create_session\([\s\S]*?\n {4}\}\n/.exec(lib)?.[0] ?? "";
    assert.match(create, /require!\(risk::session\(&limits, now\)\.is_ok\(\), VaultError::RiskLimit\);/);
    assert.equal((lib.match(/risk::session\(/g) ?? []).length, 1);
  });
});

describe("fetch-verified.sh", () => {
  const script = join(here, "fetch-verified.sh");
  // A curl that logs its arguments and "downloads" $PAYLOAD to --output.
  const bin = stub(fresh("bin"), "curl", [
    'printf "%s\\n" "$*" >> "$CURL_LOG"',
    'out=""',
    'while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2 ;; *) shift ;; esac; done',
    'cp "$PAYLOAD" "$out"',
  ].join("\n"));
  const payload = join(fresh("payload"), "asset.tar.bz2");
  writeFileSync(payload, "pretend toolchain bytes\n");
  const size = String(statSync(payload).size);
  const digest = sha256(readFileSync(payload));
  const call = (args, dir) => {
    const log = join(dir, "curl.log");
    const r = run("bash", [script, ...args], { PATH: `${bin}:${process.env.PATH}`, PAYLOAD: payload, CURL_LOG: log });
    return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };

  it("keeps a download whose size and SHA-256 match, fetched over HTTPS only", () => {
    const dir = fresh("ok");
    const out = join(dir, "asset.tar.bz2");
    const r = call(["https://example.invalid/asset.tar.bz2", size, digest, out], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "pretend toolchain bytes\n");
    assert.match(r.log, /--proto =https /);
    assert.deepEqual(readdirSync(dir).sort(), ["asset.tar.bz2", "curl.log"]);
  });

  it("deletes a download whose SHA-256 or size differs, leaving nothing to unpack", () => {
    for (const [bytes, hash] of [[size, "0".repeat(64)], [String(Number(size) + 1), digest]]) {
      const dir = fresh("bad");
      const out = join(dir, "asset.tar.bz2");
      writeFileSync(out, "stale file from an earlier run");
      const r = call(["https://example.invalid/asset.tar.bz2", bytes, hash, out], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /does not match its pin/);
      assert.deepEqual(readdirSync(dir), ["curl.log"]);
    }
  });

  it("refuses a non-HTTPS URL or a malformed pin before downloading anything", () => {
    for (const args of [
      ["http://example.invalid/asset.tar.bz2", size, digest],
      ["https://example.invalid/asset.tar.bz2", "0", digest],
      ["https://example.invalid/asset.tar.bz2", size, digest.toUpperCase()],
    ]) {
      const dir = fresh("refused");
      const r = call([...args, join(dir, "asset.tar.bz2")], dir);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.log, "");
      assert.deepEqual(readdirSync(dir), []);
    }
  });
});

describe("solana-toolchain.sh", () => {
  const script = join(here, "solana-toolchain.sh");
  const verifiedHome = () => {
    const home = fresh("home");
    const tools = join(home, ".cache/solana/v1.48/platform-tools");
    mkdirSync(join(tools, "rust/bin"), { recursive: true });
    writeFileSync(join(tools, ".merrymen-ci-verified-sha256"), `${pins.PLATFORM_TOOLS_SHA256}\n`);
    return home;
  };

  it("check passes when only the verified platform-tools are present", () => {
    const r = run("bash", [script, "check"], { HOME: verifiedHome() });
    assert.equal(r.status, 0, r.stderr);
  });

  it("check fails when a build fetched or reinstalled a toolchain the job did not verify", () => {
    const cases = {
      "another platform-tools version": h => mkdirSync(join(h, ".cache/solana/v1.51/platform-tools"), { recursive: true }),
      "a criterion download": h => mkdirSync(join(h, ".cache/solana/v1.48/criterion"), { recursive: true }),
      "a reinstall that dropped the marker": h => rmSync(join(h, ".cache/solana/v1.48/platform-tools/.merrymen-ci-verified-sha256")),
      "a marker for other bytes": h => writeFileSync(join(h, ".cache/solana/v1.48/platform-tools/.merrymen-ci-verified-sha256"), `${"1".repeat(64)}\n`),
    };
    for (const [label, spoil] of Object.entries(cases)) {
      const home = verifiedHome();
      spoil(home);
      const r = run("bash", [script, "check"], { HOME: home });
      assert.equal(r.status, 1, label);
      assert.match(r.stderr, /::error::/, label);
    }
  });

  it("install refuses a machine where ~/.cache/solana already exists", () => {
    const home = fresh("home");
    mkdirSync(join(home, ".cache/solana"), { recursive: true });
    const dest = fresh("dest");
    const r = run("bash", [script, "install", dest], { HOME: home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists; refusing to trust/);
    assert.deepEqual(readdirSync(dest), []);
  });

  it("install unpacks nothing when a download fails its check", () => {
    // On Linux x86_64 the stub curl's bytes fail the pin; elsewhere the
    // platform check refuses first. Either way nothing is installed.
    const bin = stub(fresh("bin"), "curl", 'out=""; while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2 ;; *) shift ;; esac; done; echo tampered > "$out"');
    const home = fresh("home");
    const dest = fresh("dest");
    const r = run("bash", [script, "install", dest], { HOME: home, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(home, ".cache")), false);
    assert.equal(existsSync(join(dest, "solana-release")), false);
    assert.ok(!existsSync(join(dest, "downloads")) || readdirSync(join(dest, "downloads")).length === 0);
  });

  it("rejects an unknown command", () => {
    assert.equal(run("bash", [script, "uninstall"]).status, 1);
  });
});

describe("solana-rebuild.sh", () => {
  const script = join(here, "solana-rebuild.sh");
  // A cargo-build-sbf that logs what it was given and writes a fake .so.
  const bin = stub(fresh("bin"), "cargo-build-sbf", [
    'printf "CARGO_HOME=%s\\nARGS=%s\\n" "$CARGO_HOME" "$*" >> "$SBF_LOG"',
    'out=""; manifest=""',
    'while [ $# -gt 0 ]; do case $1 in --sbf-out-dir) out=$2; shift 2 ;; --manifest-path) manifest=$2; shift 2 ;; *) shift ;; esac; done',
    'test -f "$manifest" || { echo "no manifest at $manifest" >&2; exit 3; }',
    'echo "compiling (stdout of the build)"',
    'mkdir -p "$out" && printf "\\177ELFfake" > "$out/merrymen_vault.so"',
  ].join("\n"));

  it("builds HEAD's tracked source at another path with a fresh canonical CARGO_HOME and the pinned flags", () => {
    const work = fresh("work");
    const log = join(fresh("log"), "sbf.log");
    const r = run("bash", [script, work], { PATH: `${bin}:${process.env.PATH}`, SBF_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    const src = join(work, "src/contracts/solana");
    assert.equal(r.stdout, `${src}/target/deploy/merrymen_vault.so\n`, "stdout carries only the artifact path");
    const logged = readFileSync(log, "utf8");
    assert.match(logged, new RegExp(`^CARGO_HOME=${work}/cargo-home$`, "m"));
    assert.ok(logged.includes(`ARGS=--tools-version ${pins.PLATFORM_TOOLS_VERSION} --arch ${pins.SBF_ARCH} --manifest-path ${src}/programs/merrymen-vault/Cargo.toml --sbf-out-dir ${src}/target/deploy -- --locked\n`), logged);
    assert.ok(!src.startsWith(realpathSync(repo)), "the rebuild must not run in the checkout");

    const tracked = run("git", ["ls-tree", "-r", "--name-only", "HEAD", "contracts/solana"]).stdout.trim().split("\n").sort();
    const copied = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), p);
        else copied.push(p);
      }
    };
    walk(join(work, "src"), "");
    const built = "contracts/solana/target/deploy/merrymen_vault.so";
    assert.deepEqual(copied.filter(p => p !== built).sort(), tracked, "exactly the tracked files, nothing untracked or ignored");
  });

  it("refuses a work directory that is not empty", () => {
    const work = fresh("work");
    writeFileSync(join(work, "left-over"), "");
    const r = run("bash", [script, work], { PATH: `${bin}:${process.env.PATH}`, SBF_LOG: join(work, "log") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not empty/);
  });
});

describe("solana-program-record.mjs", () => {
  const script = join(here, "solana-program-record.mjs");
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_BYTES = Buffer.from("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", "hex");
  const libRs = id => `use anchor_lang::prelude::*;\n\ndeclare_id!("${id}");\n\n#[program]\npub mod merrymen_vault {}\n`;
  const anchorToml = id => `[toolchain]\nanchor_version = "0.32.1"\n\n[programs.localnet]\nmerrymen_vault = "${id}"\n`;
  const elf = (...parts) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60), ...parts, Buffer.alloc(16)]);

  it("decodes base58 keys", () => {
    assert.deepEqual(base58Decode("11111111111111111111111111111111"), Buffer.alloc(32));
    assert.deepEqual(base58Decode(TOKEN_PROGRAM), TOKEN_BYTES);
    assert.throws(() => base58Decode("0OIl"), /not base58/);
  });

  it("records an artifact that carries the declared program ID", () => {
    const so = elf(TOKEN_BYTES);
    const r = programRecord({ libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so, toolchain: readToolchain(pinsText), commit: "c0ffee" });
    assert.equal(r.programId, TOKEN_PROGRAM);
    assert.equal(r.programIdOccurrences, 1);
    assert.equal(r.bytes, so.length);
    assert.equal(r.sha256, sha256(so));
    assert.equal(r.commit, "c0ffee");
    assert.equal(r.toolchain.platformTools, "v1.48");
  });

  it("refuses an artifact or source that does not agree on one program ID", () => {
    const ok = { libRs: libRs(TOKEN_PROGRAM), anchorToml: anchorToml(TOKEN_PROGRAM), so: elf(TOKEN_BYTES) };
    const refused = {
      "built for another ID": [{ ...ok, so: elf(Buffer.alloc(32, 7)) }, /does not contain the declared program ID/],
      "not an ELF file": [{ ...ok, so: Buffer.concat([Buffer.from("MZ"), TOKEN_BYTES]) }, /not an ELF file/],
      "Anchor.toml names another ID": [{ ...ok, anchorToml: anchorToml("11111111111111111111111111111111") }, /Anchor.toml \[programs.localnet\] names/],
      "a second cluster names another ID": [{ ...ok, anchorToml: `${anchorToml(TOKEN_PROGRAM)}\n[programs.mainnet]\nmerrymen_vault = "11111111111111111111111111111111"\n` }, /\[programs.mainnet\]/],
      "Anchor.toml names none": [{ ...ok, anchorToml: "[toolchain]\n" }, /names no merrymen_vault/],
      "two declarations": [{ ...ok, libRs: `${libRs(TOKEN_PROGRAM)}declare_id!("${TOKEN_PROGRAM}");\n` }, /exactly one program ID/],
      "a commented-out declaration only": [{ ...ok, libRs: `// declare_id!("${TOKEN_PROGRAM}");\n` }, /exactly one program ID/],
      "a short key": [{ ...ok, libRs: libRs("1111"), anchorToml: anchorToml("1111") }, /not 32/],
    };
    for (const [label, [input, error]] of Object.entries(refused)) assert.throws(() => programRecord(input), error, label);
  });

  it("finds the committed source consistent: lib.rs and Anchor.toml declare the same 32-byte ID", () => {
    const id = declaredProgramId(readFileSync(join(repo, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8"));
    assert.equal(base58Decode(id).length, 32);
    const named = anchorProgramIds(readFileSync(join(repo, "contracts/solana/Anchor.toml"), "utf8"), "merrymen_vault");
    assert.ok(named.length > 0);
    for (const { id: other } of named) assert.equal(other, id);
  });

  it("as a command: writes the record, prints the SHA-256, and fails with exit 1 on a mismatch", () => {
    const root = fresh("program");
    mkdirSync(join(root, "programs/merrymen-vault/src"), { recursive: true });
    writeFileSync(join(root, "programs/merrymen-vault/src/lib.rs"), libRs(TOKEN_PROGRAM));
    writeFileSync(join(root, "Anchor.toml"), anchorToml(TOKEN_PROGRAM));
    const so = join(root, "merrymen_vault.so");
    writeFileSync(so, elf(TOKEN_BYTES));
    const out = join(root, "record.json");
    // Through a symlink: a main-module check that compared unresolved paths
    // would skip main, print nothing and exit 0.
    const link = join(fresh("link"), "record.mjs");
    symlinkSync(script, link);
    for (const entry of [script, link]) {
      rmSync(out, { force: true });
      const r = run(process.execPath, [entry, root, so, out], { GITHUB_SHA: "c0ffee" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${sha256(readFileSync(so))}\n`);
      const record = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(record.programId, TOKEN_PROGRAM);
      assert.equal(record.commit, "c0ffee");
    }
    writeFileSync(so, elf(Buffer.alloc(32, 7)));
    const bad = run(process.execPath, [script, root, so, out]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error::the artifact does not contain the declared program ID/);
    assert.equal(bad.stdout, "");
  });
});
