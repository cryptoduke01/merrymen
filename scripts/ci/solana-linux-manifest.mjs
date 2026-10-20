#!/usr/bin/env node
// Checks the Linux build manifest CI just recorded: it must describe the
// artifact the tests ran against, and match the committed one if there is one.
//
//   node scripts/ci/solana-linux-manifest.mjs verify <contracts/solana dir> <tested sha256>
//   node scripts/ci/solana-linux-manifest.mjs compare <contracts/solana dir>
//
// `solana · test` runs verify right after `build.sh --record`, which built the
// source a second time from a copy in another directory, required identical
// bytes, and wrote build-manifests/Linux-x86_64.json for the pinned Linux
// build. The release artifact comes from that build (build.sh: platform-tools
// embeds its own paths, so a macOS manifest never describes it). verify
// refuses (exit 1) a manifest that is missing, unreadable, for another host,
// or not for the tested artifact: its artifact.sha256 must equal
// <tested sha256>, and target/deploy/merrymen_vault.so must still hash to it,
// so --record's in-place build left the bytes the runtime tests ran against
// untouched. Only then does the job upload the artifact and the manifest.
//
// compare runs last, after the upload, so a run whose manifest differs still
// hands it to the owner. It fails (exit 1) only when a Linux manifest is
// committed at HEAD and differs from the recorded one in any field (a stale
// one included: packages/core's manifest test fails on it too). With none
// committed it passes, and says (a notice and the step summary) that the
// uploaded artifact carries the manifest for the owner to review and commit.
// Committing it is what turns the comparison on.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LINUX_HOST = "Linux-x86_64";
export const LINUX_MANIFEST = `build-manifests/${LINUX_HOST}.json`;
export const ARTIFACT = "target/deploy/merrymen_vault.so";

const HEX64 = /^[0-9a-f]{64}$/;

/** Every leaf where two parsed manifests differ, as "<path>: committed <a>, recorded <b>". */
export function differences(committed, recorded, path = "") {
  const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObject(committed) && isObject(recorded)) {
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(recorded)])].sort();
    return keys.flatMap(k => differences(committed[k], recorded[k], path ? `${path}.${k}` : k));
  }
  if (JSON.stringify(committed) === JSON.stringify(recorded)) return [];
  const show = v => (v === undefined ? "(absent)" : JSON.stringify(v));
  return [`${path || "(manifest)"}: committed ${show(committed)}, recorded ${show(recorded)}`];
}

/** The recorded manifest, parsed and checked to be for this host and the tested artifact. */
export function verifyRecorded({ recorded, testedSha256, artifact }) {
  if (!HEX64.test(testedSha256 ?? "")) throw new Error(`no tested artifact SHA-256 to check the manifest against (${JSON.stringify(testedSha256)})`);
  const manifest = parseRecorded(recorded);
  if (manifest.artifact.sha256 !== testedSha256) {
    throw new Error(`the recorded manifest is for artifact ${manifest.artifact.sha256}, not the tested ${testedSha256}`);
  }
  const onDisk = createHash("sha256").update(artifact).digest("hex");
  if (onDisk !== testedSha256 || manifest.artifact.bytes !== artifact.length) {
    throw new Error(`${ARTIFACT} changed after the tests ran: now ${onDisk} (${artifact.length} bytes), tested ${testedSha256}`);
  }
  return manifest;
}

/**
 * The recorded manifest against the committed one (null when none is committed).
 * @returns {{ status: "matches" | "uncommitted", manifest: any }}
 */
export function compareCommitted({ recorded, committed }) {
  const manifest = parseRecorded(recorded);
  if (committed === null) return { status: "uncommitted", manifest };
  let ours;
  try {
    ours = JSON.parse(committed);
  } catch {
    throw new Error(`the committed ${LINUX_MANIFEST} is not JSON`);
  }
  const diff = differences(ours, manifest);
  if (diff.length > 0) {
    const shown = diff.slice(0, 12);
    if (diff.length > shown.length) shown.push(`and ${diff.length - shown.length} more`);
    throw new Error(`this pinned Linux build differs from the committed ${LINUX_MANIFEST}: ${shown.join("; ")}. `
      + "If the program or its toolchain changed on purpose, review the manifest this run uploaded and commit it unchanged; "
      + "the next run must then reproduce it.");
  }
  return { status: "matches", manifest };
}

function parseRecorded(recorded) {
  let manifest;
  try {
    manifest = JSON.parse(recorded);
  } catch {
    throw new Error(`the recorded ${LINUX_MANIFEST} is not JSON`);
  }
  if (manifest?.toolchain?.host !== LINUX_HOST) {
    throw new Error(`the recorded manifest is for host ${JSON.stringify(manifest?.toolchain?.host)}, not ${LINUX_HOST}`);
  }
  if (!HEX64.test(manifest?.source?.digest ?? "")) throw new Error("the recorded manifest has no source digest");
  if (manifest?.artifact?.file !== ARTIFACT) throw new Error(`the recorded manifest names ${JSON.stringify(manifest?.artifact?.file)}, not ${ARTIFACT}`);
  if (!HEX64.test(manifest.artifact.sha256 ?? "") || !Number.isSafeInteger(manifest.artifact.bytes) || manifest.artifact.bytes <= 0) {
    throw new Error("the recorded manifest has no artifact SHA-256 and size");
  }
  return manifest;
}

/** The committed manifest at HEAD, or null when HEAD has none. Fails outside a git checkout. */
function committedAtHead(dir) {
  const git = args => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  // Paths starting with ./ are relative to -C's directory.
  const listed = git(["ls-tree", "--name-only", "HEAD", "--", LINUX_MANIFEST]).trim();
  return listed ? git(["show", `HEAD:./${LINUX_MANIFEST}`]) : null;
}

const USAGE = "usage: solana-linux-manifest.mjs verify <contracts/solana dir> <tested sha256> | compare <contracts/solana dir>";

function main(argv) {
  const [command, dir, testedSha256] = argv;
  if (!(command === "verify" && argv.length === 3) && !(command === "compare" && argv.length === 2)) {
    console.error(USAGE);
    process.exit(2);
  }
  const path = join(dir, LINUX_MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${LINUX_MANIFEST}: build.sh --record did not write one for this host`);
  const recorded = readFileSync(path, "utf8");
  if (command === "verify") {
    const m = verifyRecorded({ recorded, testedSha256, artifact: readFileSync(join(dir, ARTIFACT)) });
    console.log(`${LINUX_MANIFEST} is for the tested artifact: source digest ${m.source.digest}, artifact ${m.artifact.sha256} (${m.artifact.bytes} bytes).`);
    return;
  }
  const result = compareCommitted({ recorded, committed: committedAtHead(dir) });
  const { digest } = result.manifest.source;
  const { sha256, bytes } = result.manifest.artifact;
  const line = result.status === "matches"
    ? `The pinned Linux build matches the committed ${LINUX_MANIFEST}: source digest ${digest}, artifact ${sha256} (${bytes} bytes).`
    : `No ${LINUX_MANIFEST} is committed, so nothing was compared. This run recorded source digest ${digest}, artifact ${sha256} (${bytes} bytes); `
      + "the manifest is in the uploaded vault artifact. Review it and commit it from a run whose app check passed: "
      + "from then on CI fails whenever the pinned Linux build differs from it.";
  if (result.status === "uncommitted") console.log(`::notice title=Linux build manifest::${line}`);
  else console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Linux build manifest", "", line, ""].join("\n"));
  }
}

// Real paths on both sides, as in solana-program-record.mjs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
