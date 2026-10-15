/** Package checks against the real MCP contract; these do not certify a host install. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_SERVER_URL } from "./install-links";
import { SCOPES, scopeFor } from "./scopes";
import { ALL_TOOLS } from "./tools";

const root = new URL("../../../plugins/merrymen-grok/", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, root), "utf8");
const skills = ["merrymen-monitor", "merrymen-setup"];

test("the Grok package is declarative and targets the production MCP endpoint without credentials", () => {
  const manifest = JSON.parse(read(".cursor-plugin/plugin.json"));
  assert.equal(manifest.name, "merrymen-grok");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description && manifest.author?.name);
  // Reject new execution/configuration surfaces unless their packaging is reviewed.
  assert.deepEqual(Object.keys(manifest).sort(), ["author", "description", "homepage", "keywords", "license", "name", "repository", "version"]);
  assert.deepEqual(JSON.parse(read("mcp.json")), {
    mcpServers: { merrymen: { url: PLUGIN_SERVER_URL } },
  });
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const parent = entry.parentPath ?? entry.path;
      return relative(fileURLToPath(root), join(parent, entry.name)).replaceAll("\\", "/");
    }).sort();
  assert.deepEqual(files, [
    ".cursor-plugin/plugin.json", "README.md", "mcp.json",
    ...skills.map(skill => `skills/${skill}/SKILL.md`),
  ].sort(), "package contains only the reviewed manifest, remote config, README and skills");
});

test("packaged skills resolve to current Merrymen tools", () => {
  const tools = new Set(ALL_TOOLS.map(tool => tool.name));
  assert.deepEqual(readdirSync(new URL("skills/", root)).sort(), skills);
  for (const skill of skills) {
    const text = read(`skills/${skill}/SKILL.md`);
    const frontmatter = /^---\nname: ([a-z-]+)\ndescription: ([^\n]+)\n---\n/.exec(text);
    assert.equal(frontmatter?.[1], skill);
    assert.ok(frontmatter?.[2]);
    for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      assert.ok(tools.has(name), `${skill} references missing tool ${name}`);
    }
  }
});

test("the monitoring workflow only allows existing read-only tools reachable by its read scopes", () => {
  const text = read("skills/merrymen-monitor/SKILL.md");
  const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  assert.ok(block, "monitoring workflow must declare its tool/scope allowlist");
  const policy = JSON.parse(block) as { scopes: string[]; tools: string[] };
  assert.deepEqual(Object.keys(policy).sort(), ["scopes", "tools"]);
  assert.deepEqual(policy.scopes, ["agents:read", "portfolio:read", "decisions:read"]);
  assert.ok(policy.tools.length > 0);
  assert.equal(new Set(policy.tools).size, policy.tools.length);
  const tools = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));
  for (const scope of policy.scopes) {
    assert.equal(SCOPES.find(entry => entry.id === scope)?.level, "read", scope);
  }
  for (const name of policy.tools) {
    const tool = tools.get(name);
    assert.ok(tool, `monitoring references missing tool ${name}`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} must not write`);
    assert.notEqual(tool.annotations.destructiveHint, true, name);
    assert.ok((tool.anyOf ?? [tool.capability]).some(capability => policy.scopes.includes(scopeFor(capability))),
      `${name} requires access outside the monitoring scope allowlist`);
  }
  for (const [, name] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
    assert.ok(policy.tools.includes(name), `monitoring prose directs a call outside its allowlist: ${name}`);
  }
});
