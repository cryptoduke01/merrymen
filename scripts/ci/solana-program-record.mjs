#!/usr/bin/env node
// Ties a built vault artifact to the program ID its source declares, and
// records what was built.
//
//   node scripts/ci/solana-program-record.mjs <contracts/solana dir> <program .so> <record.json>
//
// Refuses (exit 1) unless:
// - lib.rs declares exactly one program ID, a 32-byte base58 key;
// - Anchor.toml names that same ID for merrymen_vault in every [programs.*];
// - the .so is an ELF file that contains the ID's 32 bytes. A binary built for
//   another ID passes a hash check but fails every instruction with
//   DeclaredProgramIdMismatch (0x1004) once deployed, and an immutable deploy
//   cannot be fixed or refunded.
// Then it writes the record (ID, size, SHA-256, toolchain, commit) to
// <record.json>, adds it to the GitHub step summary when there is one, and
// prints the SHA-256 on stdout.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("empty base58 string");
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`not base58: ${JSON.stringify(text)}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.push(Number(n & 0xffn));
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function declaredProgramId(libRs) {
  const mentions = (libRs.match(/declare_id!/g) ?? []).length;
  const found = [...libRs.matchAll(/^[ \t]*declare_id!\s*\(\s*"([^"]*)"\s*\)\s*;/gm)];
  if (mentions !== 1 || found.length !== 1) {
    throw new Error(`lib.rs must declare exactly one program ID with declare_id!("..."); found ${mentions} mention(s)`);
  }
  return found[0][1];
}

export function anchorProgramIds(anchorToml, program) {
  const ids = [];
  let section = "";
  for (const raw of anchorToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section.startsWith("programs.")) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (entry && entry[1] === program) ids.push({ cluster: section.slice("programs.".length), id: entry[2] });
  }
  return ids;
}

export function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

export function readToolchain(envText) {
  const pins = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(\S+)$/.exec(line.trim());
    if (m) pins[m[1]] = m[2];
  }
  return {
    agave: pins.AGAVE_VERSION ?? null,
    platformTools: pins.PLATFORM_TOOLS_VERSION ?? null,
    platformToolsRustc: pins.PLATFORM_TOOLS_RUSTC ?? null,
    arch: pins.SBF_ARCH ?? null,
    hostRust: pins.HOST_RUST ?? null,
  };
}

export function programRecord({ libRs, anchorToml, so, toolchain = null, commit = null }) {
  const programId = declaredProgramId(libRs);
  const key = base58Decode(programId);
  if (key.length !== 32) throw new Error(`declared program ID ${programId} is ${key.length} bytes, not 32`);

  const named = anchorProgramIds(anchorToml, "merrymen_vault");
  if (named.length === 0) throw new Error("Anchor.toml names no merrymen_vault program ID");
  for (const { cluster, id } of named) {
    if (id !== programId) throw new Error(`Anchor.toml [programs.${cluster}] names ${id}, but lib.rs declares ${programId}`);
  }

  if (so.length < 4 || so.readUInt32BE(0) !== 0x7f454c46) throw new Error("the artifact is not an ELF file");
  const programIdOccurrences = countOccurrences(so, key);
  if (programIdOccurrences === 0) throw new Error(`the artifact does not contain the declared program ID ${programId}`);

  return {
    program: "merrymen_vault",
    programId,
    programIdOccurrences,
    bytes: so.length,
    sha256: createHash("sha256").update(so).digest("hex"),
    // The deployed ProgramData region is the artifact followed by zero
    // padding up to max-len, so its hash equals sha256 only when max-len
    // equals bytes (the CLI default). Otherwise hash the artifact plus
    // (max-len - bytes) zero bytes.
    regionNote: "ProgramData region SHA-256 equals sha256 only for max-len == bytes",
    toolchain,
    // GITHUB_SHA: the pushed commit, or a pull request's test merge commit.
    commit,
  };
}

function main(argv) {
  if (argv.length !== 3) {
    console.error("usage: solana-program-record.mjs <contracts/solana dir> <program .so> <record.json>");
    process.exit(2);
  }
  const [programRoot, soPath, outPath] = argv;
  const here = dirname(fileURLToPath(import.meta.url));
  const record = programRecord({
    libRs: readFileSync(join(programRoot, "programs/merrymen-vault/src/lib.rs"), "utf8"),
    anchorToml: readFileSync(join(programRoot, "Anchor.toml"), "utf8"),
    so: readFileSync(soPath),
    toolchain: readToolchain(readFileSync(join(here, "solana-toolchain.env"), "utf8")),
    commit: process.env.GITHUB_SHA || null,
  });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const t = record.toolchain;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### merrymen_vault SBF artifact",
      "",
      `- program ID: \`${record.programId}\` (its 32 bytes appear ${record.programIdOccurrences} time(s) in the binary)`,
      `- size: ${record.bytes} bytes`,
      `- SHA-256: \`${record.sha256}\``,
      `- toolchain: agave ${t.agave}, platform-tools ${t.platformTools} (rustc ${t.platformToolsRustc}), arch ${t.arch}`,
      `- commit: ${record.commit ?? "unknown"}`,
      "",
    ].join("\n"));
  }
  process.stdout.write(`${record.sha256}\n`);
}

// Real paths on both sides: run through a symlink (macOS /tmp), the plain
// comparison would skip main and exit 0 having checked nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
