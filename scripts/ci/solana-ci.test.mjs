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

import {
  anchorProgramIds, base58Decode, declaredProgramId, programRecord, provenance, readToolchain, releaseStatus, RELEASE_RULE,
} from "./solana-program-record.mjs";
import { checkRuntimeTests, countTests, parseResults, runtimeTargets } from "./solana-runtime-tests.mjs";
import { decide, solanaPaths } from "./solana-paths.mjs";

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
/** Every job id in ci.yml. */
function jobIds() {
  const jobs = /^jobs:\n([\s\S]*)$/m.exec(ci)?.[1] ?? "";
  return [...jobs.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
}
/** A job's steps, each the text from its `      - ` line to the next. */
function steps(body) {
  const at = body.indexOf("    steps:\n");
  if (at < 0) return [];
  return body.slice(at + "    steps:\n".length).split(/^(?= {6}- )/m)
    .map(t => t.replace(/^(?: {6}#.*\n|\n)+/, "").replace(/(?:\n {6}#.*|\n)+$/, ""))
    .filter(t => t.startsWith("      - "));
}
/** The app job's aggregation script, as bash will run it once Actions fills in the needs results. */
function appScript(results) {
  const body = job("app");
  const block = /run: \|\n((?: {10}.*\n|\n)*)/.exec(body)?.[1] ?? "";
  return block.split("\n").map(l => l.slice(10)).join("\n")
    .replace(/\$\{\{ needs\.([a-z0-9-]+)\.result \}\}/g, (_, id) => {
      assert.ok(Object.hasOwn(results, id), `no result given for ${id}`);
      return results[id];
    });
}

const scratch = mkdtempSync(join(tmpdir(), "merrymen-solana-ci-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = label => {
  const dir = join(scratch, `${label}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
};

/**
 * The environment for a script under test: none of the real job's GITHUB_*
 * variables (its output files, event, ref or commit), only what a test passes.
 */
function env(extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_")));
  return { ...e, ...extra };
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
      "contracts/solana/test.sh 2>&1 | tee \"$RUNNER_TEMP/solana-test.log\"",
      "run: node scripts/ci/solana-runtime-tests.mjs \"$RUNNER_TEMP/solana-test.log\" contracts/solana/runtime-tests",
      "run: scripts/ci/solana-toolchain.sh check",
      "node scripts/ci/solana-program-record.mjs contracts/solana contracts/solana/target/deploy/merrymen_vault.so ",
      "uses: actions/upload-artifact@",
    ].map(s => [s, test.indexOf(s)]);
    for (const [s, at] of order) assert.ok(at >= 0, `solana-test lacks ${s}`);
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must come before ${order[i][0]}`);
    assert.match(test, /^ {4}outputs:\n {6}sha256: \$\{\{ steps\.record\.outputs\.sha256 \}\}$/m);
    assert.match(test, /CARGO_HOME=\$\(realpath /);
    // Without pipefail the step would take tee's status, and a failing test.sh would pass.
    assert.match(test, /run: \|\n {10}set -o pipefail\n {10}contracts\/solana\/test\.sh 2>&1 \| tee "\$RUNNER_TEMP\/solana-test\.log"\n/);
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

  it("names the artifact for its commit and run, and as a release candidate only from a run on main", () => {
    // The release rule says CI never runs on a tag push. Pushes run on main only.
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(on, /^ {2}push:\n {4}branches: \[main\]\n(?! {4})/m);
    assert.doesNotMatch(on, /tags/);
    const upload = /uses: actions\/upload-artifact@\S+.*\n((?: {8}.*\n)*)/.exec(test)?.[1] ?? "";
    assert.match(upload, /^ {10}name: merrymen-vault-sbf-\$\{\{ steps\.record\.outputs\.release \}\}-\$\{\{ github\.sha \}\}-run\$\{\{ github\.run_id \}\}\.\$\{\{ github\.run_attempt \}\}$/m);
    // The label comes from the record, and nothing but its two values reaches the name.
    const record = steps(test).find(s => s.includes("id: record")) ?? "";
    assert.match(record, /release=\$\(node -p 'require\(process\.argv\[1\]\)\.release\.label' "\$PWD\/contracts\/solana\/target\/deploy\/merrymen_vault\.build\.json"\)/);
    assert.match(record, /case "\$release" in release-candidate\|not-a-release\) ;; \*\) echo "::error::[^"]*"; exit 1 ;; esac\n {10}echo "release=\$release" >> "\$GITHUB_OUTPUT"/);
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

  it("neither job can be skipped, softened or filtered away: only their steps wait on solana · paths", () => {
    for (const body of [test, rebuild]) {
      assert.doesNotMatch(body, /continue-on-error/);
      // No job-level `if:`: a skipped job never concludes success (see the Kaka test below).
      assert.doesNotMatch(body, /^ {4}if:/m);
      assert.match(body, /^ {4}runs-on: ubuntu-24\.04$/m);
      assert.match(body, /^ {4}needs: \[solana-paths\]$/m);
      const [notice, ...rest] = steps(body);
      // First, a notice that does nothing but say why nothing else ran.
      assert.match(notice, /^ {6}- name: Not needed for this change\n {8}if: needs\.solana-paths\.outputs\.run != 'true'\n {8}run: echo "[^"$`]*"$/, notice);
      assert.ok(rest.length >= 4);
      // Every other step runs exactly when solana · paths said "true", under no other condition.
      for (const step of rest) {
        const conditions = [...step.matchAll(/^ {8}if: (.*)$/gm)].map(m => m[1]);
        assert.deepEqual(conditions, ["needs.solana-paths.outputs.run == 'true'"], step);
      }
    }
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(on, /^ {2}pull_request:/m);
    // A workflow-level paths filter would skip the whole run, `app` included.
    assert.doesNotMatch(on, /paths/);
  });

  it("solana · paths decides from the test merge commit and both its parents", () => {
    const paths = job("solana-paths");
    assert.ok(paths, "ci.yml has no solana-paths job");
    assert.doesNotMatch(paths, /^ {4}(if|needs|continue-on-error):/m);
    assert.match(paths, /^ {4}outputs:\n {6}run: \$\{\{ steps\.paths\.outputs\.run \}\}$/m);
    const [checkout, , decide] = steps(paths);
    assert.match(checkout, /uses: actions\/checkout@\S+.*\n {8}with:\n {10}fetch-depth: 2$/);
    assert.doesNotMatch(checkout, /ref:/, "the default ref of a pull_request run is the test merge commit");
    assert.match(decide, /^ {8}id: paths\n {8}run: node scripts\/ci\/solana-paths\.mjs$/m);
  });

  it("app, the required check, needs all three Solana jobs, and equal hashes whenever the vault was built", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(app)?.[1].split(",").map(s => s.trim()) ?? [];
    for (const id of ["solana-paths", "solana-test", "solana-rebuild"]) assert.ok(needs.includes(id), needs.join(","));
    assert.match(app, /^ {4}if: always\(\)$/m);
    for (const id of ["solana-paths", "solana-test", "solana-rebuild"]) {
      assert.match(app, new RegExp(`test "\\$\\{\\{ needs\\.${id}\\.result \\}\\}" = success`));
    }
    assert.match(app, /SOLANA_BUILD: \$\{\{ needs\.solana-paths\.outputs\.run \}\}/);
    assert.match(app, /VAULT_TESTED_SHA256: \$\{\{ needs\.solana-test\.outputs\.sha256 \}\}/);
    assert.match(app, /VAULT_REBUILT_SHA256: \$\{\{ needs\.solana-rebuild\.outputs\.sha256 \}\}/);
    // Explicit exits: bash 3.2 does not apply errexit to a failing [[ ]].
    assert.match(app, /\[\[ "\$VAULT_TESTED_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\] \|\| \{ .*exit 1; \}$/m);
    assert.match(app, /test "\$VAULT_TESTED_SHA256" = "\$VAULT_REBUILT_SHA256" \|\| \{ .*exit 1; \}$/m);
    // Job outputs reach the script through env, never pasted into its text.
    const at = app.indexOf("run: |");
    assert.ok(at >= 0);
    const script = app.slice(at);
    assert.doesNotMatch(script, /\$\{\{ needs\.[a-z-]+\.outputs/);
  });

  it("app's script passes exactly the runs it should", () => {
    const success = { "app-typecheck": "success", "app-build": "success", "app-test": "success", "app-postgres": "success", "solana-paths": "success", "solana-test": "success", "solana-rebuild": "success" };
    const a = "a".repeat(64), b = "b".repeat(64);
    const cases = [
      ["the vault built, tested and rebuilt to the same bytes", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 0],
      ["no Solana-relevant change, and no hashes", {}, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 0],
      ["the vault built but no hash came out", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["the rebuild differs", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: b }, 1],
      ["a short hash", {}, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: "abc", VAULT_REBUILT_SHA256: "abc" }, 1],
      ["hashes from a run said to need no build", {}, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 1],
      ["no decision from solana · paths", {}, { SOLANA_BUILD: "", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · paths failed", { "solana-paths": "failure" }, { SOLANA_BUILD: "", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · test skipped", { "solana-test": "skipped" }, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
      ["solana · rebuild cancelled", { "solana-rebuild": "cancelled" }, { SOLANA_BUILD: "true", VAULT_TESTED_SHA256: a, VAULT_REBUILT_SHA256: a }, 1],
      ["an app part failed on a docs-only run", { "app-test": "failure" }, { SOLANA_BUILD: "false", VAULT_TESTED_SHA256: "", VAULT_REBUILT_SHA256: "" }, 1],
    ];
    const dir = fresh("app");
    for (const [label, results, vars, status] of cases) {
      const file = join(dir, "app.sh");
      writeFileSync(file, appScript({ ...success, ...results }));
      // The shell Actions uses for a `run:` with no `shell:` key.
      const r = run("bash", ["--noprofile", "--norc", "-e", file], vars);
      assert.equal(r.status, status, `${label}: ${r.stdout}${r.stderr}`);
    }
  });

  it("keeps the Kaka docs-only lane open: no job of the run can conclude skipped", async () => {
    // gate.cjs merges only when every job of the PR's CI run concluded success.
    const { createRequire } = await import("node:module");
    const { greenJobs } = createRequire(import.meta.url)(join(repo, ".github/kaka/gate.cjs"));
    const ids = jobIds();
    assert.ok(ids.includes("solana-paths") && ids.includes("app"));
    for (const id of ids) {
      const conditions = [...job(id).matchAll(/^ {4}if: (.*)$/gm)].map(m => m[1]);
      assert.deepEqual(conditions, id === "app" ? ["always()"] : [], `${id} has a job-level if`);
    }
    const names = ids.map(id => /^ {4}name: (.*)$/m.exec(job(id))?.[1] ?? id);
    const docsOnly = names.map(name => ({ name, status: "completed", conclusion: "success" }));
    assert.equal(greenJobs(docsOnly), true);
    const skipped = docsOnly.map(j => (j.name.startsWith("solana ·") && j.name !== "solana · paths" ? { ...j, conclusion: "skipped" } : j));
    assert.equal(greenJobs(skipped), false, "why the Solana jobs skip their steps, not themselves");
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

describe("solana-paths.mjs", () => {
  const script = join(here, "solana-paths.mjs");

  it("counts the vault, its CI and the Solana worker and core sources, nothing else", () => {
    const relevant = [
      "contracts/solana/programs/merrymen-vault/src/risk.rs",
      "contracts/solana/runtime-tests/fixtures/ts-instructions.json",
      "contracts/solana/build-manifests/Linux-x86_64.json",
      "scripts/ci/solana-toolchain.env",
      "scripts/ci/fetch-verified.sh",
      ".github/workflows/ci.yml",
      "packages/core/src/solana-live.ts",
      "packages/core/src/solana.ts",
      "worker/src/solana-executor.ts",
      "worker/src/solana-recover.ts",
    ];
    const unrelated = [
      "README.md",
      "docs/solana-integration.md",
      "docs/hosted-deploy.md",
      "web/src/app/globals.css",
      "web/src/terminal/SolanaScreen.tsx",
      "contracts/src/TrencherVault.sol",
      "contracts/solanaish.txt",
      "worker/src/trading.ts",
      "packages/core/src/ids.ts",
      ".github/workflows/android.yml",
      ".github/kaka/gate.cjs",
      "package.json",
      "xcontracts/solana/a.rs",
    ];
    assert.deepEqual(solanaPaths([...relevant, ...unrelated]), relevant);
  });

  it("builds on every run that is not a pull request, and on any pull request it cannot bound", () => {
    const never = () => assert.fail("no git call expected");
    for (const event of ["push", "workflow_dispatch", "schedule", undefined, ""]) {
      assert.equal(decide({ event, git: never }).run, true, String(event));
    }
    const git = (parents, diff) => args => (args[0] === "rev-list" ? ["head", ...parents].join(" ") + "\n" : diff);
    assert.equal(decide({ event: "pull_request", git: git(["base"], "") }).run, true, "not a merge commit");
    assert.equal(decide({ event: "pull_request", git: git(["a", "b", "c"], "") }).run, true, "an octopus");
    const docs = decide({ event: "pull_request", git: git(["base", "head"], "docs/a.md\0README.md\0") });
    assert.deepEqual([docs.run, docs.changed, docs.matched], [false, 2, []]);
    const vault = decide({ event: "pull_request", git: git(["base", "head"], "docs/a.md\0contracts/solana/build.sh\0") });
    assert.deepEqual([vault.run, vault.matched], [true, ["contracts/solana/build.sh"]]);
    // The diff is taken against the first parent, the base branch.
    const calls = [];
    decide({ event: "pull_request", git: args => (calls.push(args), args[0] === "rev-list" ? "m base head\n" : "") });
    assert.deepEqual(calls[1], ["diff", "--name-only", "--no-renames", "-z", "base", "HEAD"]);
  });

  it("as a command, on a depth-2 clone of a test merge commit: false only for a change the vault cannot see", () => {
    const origin = fresh("origin");
    const gitIn = (cwd, ...args) => {
      const r = run("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      }, cwd);
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const put = (path, text) => {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), text);
    };
    gitIn(origin, "init", "-q");
    put("README.md", "readme\n");
    put("docs/guide.md", "guide\n");
    put("contracts/solana/programs/merrymen-vault/src/lib.rs", "// vault\n");
    gitIn(origin, "add", "-A");
    gitIn(origin, "commit", "-q", "-m", "base");
    let prs = 0;
    /** A pull request branch off main, merged into main as GitHub's test merge commit would be. */
    const decideFor = change => {
      const branch = `pr-${++prs}`;
      gitIn(origin, "checkout", "-q", "-b", branch, "main");
      change();
      gitIn(origin, "add", "-A");
      gitIn(origin, "commit", "-q", "-m", branch);
      gitIn(origin, "checkout", "-q", "main");
      // main moves on meanwhile, so the merge commit differs from the PR head.
      put(`main-${prs}.txt`, "main\n");
      gitIn(origin, "add", "-A");
      gitIn(origin, "commit", "-q", "-m", `main ${prs}`);
      gitIn(origin, "checkout", "-q", "-b", `merge-${prs}`, "main");
      gitIn(origin, "merge", "-q", "--no-ff", "-m", "test merge", branch);
      const clone = fresh("clone");
      gitIn(clone, "clone", "-q", "--depth", "2", "--branch", `merge-${prs}`, `file://${origin}`, ".");
      gitIn(origin, "checkout", "-q", "main");
      const out = join(clone, "github-output");
      const r = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: out }, clone);
      assert.equal(r.status, 0, r.stderr);
      return { output: readFileSync(out, "utf8"), stdout: r.stdout };
    };
    const docs = decideFor(() => put("docs/guide.md", "better guide\n"));
    assert.equal(docs.output, "run=false\n");
    assert.match(docs.stdout, /^run=false \(none of the 1 changed path\(s\) is Solana-relevant\)$/m);
    const vault = decideFor(() => put("contracts/solana/programs/merrymen-vault/src/lib.rs", "// changed\n"));
    assert.equal(vault.output, "run=true\n");
    assert.match(vault.stdout, /contracts\/solana\/programs\/merrymen-vault\/src\/lib\.rs/);
    // A file moved out of contracts/solana is a vault change, so renames count on both sides.
    const moved = decideFor(() => gitIn(origin, "mv", "contracts/solana/programs/merrymen-vault/src/lib.rs", "docs/lib.rs"));
    assert.equal(moved.output, "run=true\n");
    // Not a merge commit (the job checked out something else): build.
    const plain = fresh("plain");
    gitIn(plain, "clone", "-q", "--depth", "2", `file://${origin}`, ".");
    const out = join(plain, "github-output");
    const r = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: out }, plain);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "run=true\n");
    // Outside a git checkout it fails rather than guessing.
    const bare = fresh("not-git");
    const failed = run(process.execPath, [script], { GITHUB_EVENT_NAME: "pull_request", GIT_CEILING_DIRECTORIES: dirname(bare) }, bare);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /::error::/);
  });
});

describe("test.sh, the one vault test recipe", () => {
  const testSh = readFileSync(join(repo, "contracts/solana/test.sh"), "utf8");
  const buildSh = readFileSync(join(repo, "contracts/solana/build.sh"), "utf8");
  const rebuildSh = readFileSync(join(here, "solana-rebuild.sh"), "utf8");
  const commands = testSh.split("\n").filter(l => l && !l.startsWith("#"));

  it("runs the native tests, then build.sh, then every runtime target against that artifact, ignored or not", () => {
    const lib = commands.findIndex(l => /^cargo test --locked .*--manifest-path "\$script_dir\/Cargo\.toml" --lib$/.test(l));
    const build = commands.indexOf('"$script_dir/build.sh" "$@"');
    const runtime = commands.findIndex(l => l.includes('--manifest-path "$script_dir/runtime-tests/Cargo.toml"'));
    assert.ok(lib >= 0 && lib < build && build < runtime, commands.join("\n"));
    const line = commands[runtime];
    assert.ok(line.startsWith('BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked '), line);
    // custody and the owner recovery transactions, and --include-ignored rather
    // than --ignored: a test whose #[ignore] is dropped still runs.
    assert.match(line, / --test custody --test recovery -- --include-ignored$/);
    assert.doesNotMatch(testSh, /-- --ignored\b/);
    assert.match(testSh, /^set -euo pipefail$/m);
  });

  it("builds with exactly the toolchain and flags scripts/ci/solana-toolchain.env pins, as the rebuild does", () => {
    const pin = name => new RegExp(`^${name}="([^"]+)"$`, "m").exec(buildSh)?.[1];
    assert.equal(`v${pin("AGAVE_VERSION")}`, pins.AGAVE_VERSION);
    assert.equal(pin("PLATFORM_TOOLS_VERSION"), pins.PLATFORM_TOOLS_VERSION);
    assert.equal(pin("SBF_ARCH"), pins.SBF_ARCH);
    assert.equal(pin("RUSTC_VERSION"), `rustc ${pins.PLATFORM_TOOLS_RUSTC}-dev`);
    // The cargo-build-sbf arguments, in order, with build.sh's extra arguments
    // (none in CI) removed: the same as solana-rebuild.sh's.
    const flags = text => (/cargo-build-sbf"? \\\n([\s\S]*?-- --locked)/.exec(text)?.[1] ?? "")
      .replace(/\\\n/g, " ").replace(/\$\{extra_args\[@\]\+"\$\{extra_args\[@\]\}"\}/, "").split(/\s+/).filter(Boolean);
    const built = flags(buildSh.replaceAll('"$build_sbf"', "cargo-build-sbf"));
    const rebuilt = flags(rebuildSh);
    assert.deepEqual(built.filter(f => !f.startsWith('"$')), ["--tools-version", "--arch", "--manifest-path", "--sbf-out-dir", "--", "--locked"]);
    assert.deepEqual(built.slice(0, 4), ['--tools-version', '"$PLATFORM_TOOLS_VERSION"', "--arch", '"$SBF_ARCH"']);
    assert.deepEqual(rebuilt.filter(f => !f.startsWith('"$')), built.filter(f => !f.startsWith('"$')));
    assert.deepEqual(rebuilt.slice(0, 4), built.slice(0, 4));
    assert.doesNotMatch(buildSh + rebuildSh + testSh, /--force-tools-install|cargo-test-sbf/);
  });
});

describe("solana-runtime-tests.mjs", () => {
  const script = join(here, "solana-runtime-tests.mjs");
  const runtimeDir = join(repo, "contracts/solana/runtime-tests");
  const result = (n, { failed = 0, ignored = 0, filtered = 0, status = failed ? "FAILED" : "ok" } = {}) =>
    `test result: ${status}. ${n} passed; ${failed} failed; ${ignored} ignored; 0 measured; ${filtered} filtered out; finished in 1.00s`;
  const target = (path, body) => [`     Running ${path} (contracts/solana/target/debug/deps/x-0123456789abcdef)`, "", "[INFO solana_program_test] noise on stderr", body, ""].join("\n");
  const lib = [target("unittests src/lib.rs", "running 14 tests\n" + result(14))];
  const sources = { "custody.rs": "#[tokio::test]\n#[ignore = \"x\"]\nasync fn a() {}\n#[tokio::test]\nasync fn b() {}\n", "tests/recovery.rs": "#[tokio::test]\nasync fn c() {}\n" };
  const targets = [{ name: "custody", path: "custody.rs" }, { name: "recovery", path: "tests/recovery.rs" }];
  const good = [...lib, target("custody.rs", "running 2 tests\n" + result(2)), target("tests/recovery.rs", "running 1 test\n" + result(1))].join("\n");

  it("finds the committed runtime targets: custody.rs and every tests/*.rs", () => {
    const testFiles = readdirSync(join(runtimeDir, "tests")).filter(f => f.endsWith(".rs")).sort();
    const found = runtimeTargets(readFileSync(join(runtimeDir, "Cargo.toml"), "utf8"), testFiles);
    assert.deepEqual(found.slice(0, 2), targets);
    assert.equal(found.length, 1 + testFiles.length);
    assert.deepEqual(runtimeTargets("[package]\nautotests = false\n", ["x.rs"]), []);
    assert.ok(countTests(readFileSync(join(runtimeDir, "custody.rs"), "utf8")) >= 25);
    assert.ok(countTests(readFileSync(join(runtimeDir, "tests/recovery.rs"), "utf8")) >= 1);
    assert.equal(countTests("#[test]\nfn a() {}\n#[tokio::test(flavor = \"multi_thread\")]\nasync fn b() {}\n// #[test] in a comment\n"), 2);
  });

  it("passes only when each target ran once and passed exactly its test functions", () => {
    assert.deepEqual(checkRuntimeTests({ log: good, targets, sources }).map(c => [c.name, c.passed]), [["custody", 2], ["recovery", 1]]);
    assert.equal(parseResults(good).get("unittests src/lib.rs").passed, 14);
  });

  it("fails a run that skipped, filtered, ignored or failed any runtime test", () => {
    const cases = {
      // `-- --ignored` after a test lost its #[ignore]: it is filtered out, not run.
      "a dropped #[ignore] under --ignored": [[...lib, target("custody.rs", result(1, { filtered: 1 })), target("tests/recovery.rs", result(1))], /1 filtered out/],
      "an ignored test": [[...lib, target("custody.rs", result(1, { ignored: 1 })), target("tests/recovery.rs", result(1))], /1 ignored/],
      "fewer tests than the source has": [[...lib, target("custody.rs", result(1)), target("tests/recovery.rs", result(1))], /1 passed, but custody\.rs has 2/],
      "a target test.sh does not name": [[...lib, target("custody.rs", result(2))], /recovery \(tests\/recovery\.rs\) never ran/],
      "a failure": [[...lib, target("custody.rs", result(1, { failed: 1 })), target("tests/recovery.rs", result(1))], /1 failed/],
      "no result line": [[...lib, target("custody.rs", "running 2 tests\nerror: test failed, to rerun pass `--test custody`"), target("tests/recovery.rs", result(1))], /printed no test result/],
      "a target run twice": [[...lib, target("custody.rs", result(2)), target("custody.rs", result(2)), target("tests/recovery.rs", result(1))], /ran more than once/],
    };
    for (const [label, [parts, error]] of Object.entries(cases)) {
      assert.throws(() => checkRuntimeTests({ log: parts.join("\n"), targets, sources }), error, label);
    }
    assert.throws(() => checkRuntimeTests({ log: good, targets: [], sources }), /no test targets/);
    assert.throws(() => checkRuntimeTests({ log: good, targets, sources: { ...sources, "tests/recovery.rs": "fn c() {}\n" } }), /no #\[test\]/);
  });

  it("as a command: reads the log and the runtime-tests directory, exit 1 on a gap", () => {
    const dir = fresh("runtime");
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"t\"\n\n[[test]]\nname = \"custody\"\npath = \"custody.rs\"\n");
    writeFileSync(join(dir, "custody.rs"), sources["custody.rs"]);
    writeFileSync(join(dir, "tests/recovery.rs"), sources["tests/recovery.rs"]);
    const log = join(dir, "test.log");
    writeFileSync(log, good);
    const ok = run(process.execPath, [script, log, dir]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^custody: all 2 runtime tests in custody\.rs ran and passed$/m);
    assert.match(ok.stdout, /^recovery: all 1 runtime tests in tests\/recovery\.rs ran and passed$/m);
    writeFileSync(join(dir, "tests/withdrawals.rs"), "#[tokio::test]\nasync fn d() {}\n");
    const missing = run(process.execPath, [script, log, dir]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /::error::runtime test target withdrawals \(tests\/withdrawals\.rs\) never ran; test\.sh must pass --test withdrawals/);
    assert.equal(run(process.execPath, [script, log]).status, 2);
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

  it("marks a release candidate only for a push or manual run on refs/heads/main of millw14/merrymen", () => {
    const main = { repository: "millw14/merrymen", event: "push", ref: "refs/heads/main" };
    const candidates = [main, { ...main, event: "workflow_dispatch" }];
    for (const p of candidates) assert.deepEqual(releaseStatus(p), { candidate: true, label: "release-candidate", rule: RELEASE_RULE }, JSON.stringify(p));
    const others = [
      { ...main, event: "pull_request", ref: "refs/pull/7/merge" },
      { ...main, event: "pull_request", ref: "refs/heads/main" },
      { ...main, repository: "someone/merrymen" },
      { ...main, ref: "refs/heads/feature" },
      { ...main, ref: "refs/heads/main-old" },
      { ...main, event: "workflow_dispatch", ref: "refs/heads/release" },
      // CI never runs on a tag push, and a manual run can be dispatched on a
      // tag whose commit was never merged: neither is a release.
      { ...main, ref: "refs/tags/vault-v1" },
      { ...main, event: "workflow_dispatch", ref: "refs/tags/vault-v1" },
      { ...main, ref: "refs/tags/" },
      { ...main, event: "schedule" },
      {},
      null,
    ];
    for (const p of others) assert.equal(releaseStatus(p).label, "not-a-release", JSON.stringify(p));
    assert.match(RELEASE_RULE, /^A release artifact comes only from a CI run on refs\/heads\/main of millw14\/merrymen: a push to main, or a manual \(workflow_dispatch\) run on main/);
    assert.match(RELEASE_RULE, /CI never runs on a tag push, and a manual run on a tag or another branch is not a release candidate\./);
    assert.doesNotMatch(RELEASE_RULE, /or a tag of/);
  });

  it("records the run: event, ref, commit, the pull request head, workflow and run", () => {
    const event = join(fresh("event"), "event.json");
    const head = "1".repeat(40);
    writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: head } } }));
    const p = provenance({
      GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge", GITHUB_SHA: "2".repeat(40),
      GITHUB_EVENT_PATH: event, GITHUB_WORKFLOW_SHA: "3".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
    });
    assert.deepEqual(p, {
      repository: "millw14/merrymen", event: "pull_request", ref: "refs/pull/7/merge", commit: "2".repeat(40), pullRequestHead: head,
      workflowSha: "3".repeat(40), runId: "123", runAttempt: "2",
    });
    assert.equal(provenance({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event }).pullRequestHead, null);
    assert.deepEqual(Object.values(provenance({})), [null, null, null, null, null, null, null, null]);
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
    // A pull request run: its record and summary say it is not a release artifact.
    const summary = join(root, "summary.md");
    rmSync(out, { force: true });
    const pr = run(process.execPath, [script, root, so, out], {
      GITHUB_SHA: "c0ffee", GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge",
      GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "1", GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(pr.status, 0, pr.stderr);
    const prRecord = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual([prRecord.release.candidate, prRecord.release.label], [false, "not-a-release"]);
    assert.deepEqual([prRecord.provenance.event, prRecord.provenance.runId], ["pull_request", "99"]);
    const text = readFileSync(summary, "utf8");
    assert.match(text, /- run: 99 attempt 1, pull_request on refs\/pull\/7\/merge of millw14\/merrymen/);
    assert.match(text, /- release: \*\*not a release artifact\*\*\. A release artifact comes only from a CI run on refs\/heads\/main of millw14\/merrymen: a push to main, or a manual \(workflow_dispatch\) run on main/);
    const mainRun = run(process.execPath, [script, root, so, out], { GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" });
    assert.equal(mainRun.status, 0, mainRun.stderr);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).release.label, "release-candidate");
    // A manual run on a tag: the record says it is not a release.
    const tagRun = run(process.execPath, [script, root, so, out], { GITHUB_REPOSITORY: "millw14/merrymen", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/vault-v1" });
    assert.equal(tagRun.status, 0, tagRun.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).release, { candidate: false, label: "not-a-release", rule: RELEASE_RULE });

    writeFileSync(so, elf(Buffer.alloc(32, 7)));
    const bad = run(process.execPath, [script, root, so, out]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /::error::the artifact does not contain the declared program ID/);
    assert.equal(bad.stdout, "");
  });
});
