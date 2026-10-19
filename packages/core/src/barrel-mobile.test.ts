import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "./index";
import * as solana from "./solana";
import * as solanaLive from "./solana-live";

/**
 * THE PHONE BUNDLES THIS BARREL.
 *
 * mobile/metro.config.js aliases @merrymen/core to packages/core/src, and
 * Metro bundles every file index.ts reaches, used or not. An EAS build installs
 * mobile/ only, so a package the barrel reaches that mobile/package.json lacks
 * fails the release build, and @solana/kit would ship to every phone even if it
 * resolved. Solana stays out: the worker and web import solana.ts and
 * solana-live.ts by path.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;

/** Every file index.ts reaches by runtime (not type-only) relative imports, and the packages they name. */
function reach(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (!spec!.startsWith(".")) {
        packages.add(spec!);
        continue;
      }
      const base = resolve(dirname(file), spec!);
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
      assert.ok(hit, `${relative(SRC, file)} imports ${spec}, which does not resolve`);
      if (!hit.endsWith(".json")) visit(hit);
    }
  };
  visit(join(SRC, "index.ts"));
  return { files, packages };
}

describe("the core barrel the phone bundles", () => {
  const { files, packages } = reach();

  it("reaches neither Solana module nor any @solana package", () => {
    const names = [...files].map((f) => relative(SRC, f));
    assert.ok(names.includes("ids.ts"), "the walk follows the barrel");
    assert.ok(!names.includes("solana.ts") && !names.includes("solana-live.ts"), names.join(", "));
    assert.deepEqual([...packages].filter((p) => p.startsWith("@solana/")), []);
  });

  it("exports nothing from either Solana module", () => {
    assert.deepEqual(Object.keys(core).filter((k) => k in solana || k in solanaLive), []);
  });
});
