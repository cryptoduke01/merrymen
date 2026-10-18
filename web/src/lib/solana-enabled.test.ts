import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "./solana-api";
import * as auth from "./solana-auth";
import * as bindings from "./solana-binding-store";
import { solanaEnabled } from "./solana-enabled";

/**
 * SOLANA IS OFF UNTIL A DEPLOYMENT SAYS OTHERWISE.
 *
 * Every route under app/api/solana, found on disk so a new one cannot be
 * missed, is called with the switch off and must refuse before it signs anyone
 * in, reads a body, opens the binding store or starts the runtime. With the
 * switch on, the same call reaches the route's own work.
 */

const WEB = fileURLToPath(new URL("../", import.meta.url));
const API = join(WEB, "app/api/solana");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const flag = process.env.MERRYMEN_SOLANA;
const set = (value: string | undefined) => { if (value === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = value; };

let touched: string[] = [];
const touch = (name: string) => async () => { touched.push(name); throw new auth.SolanaWebError(401, "Sign in first."); };
const handlers: Array<{ route: string; method: string; handle: (req: Request) => Promise<Response> }> = [];
let page: () => unknown;

before(() => {
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(join(WEB, "app"))) {
      if (id === "@/lib/solana-auth") return { ...auth, authenticateSolana: touch("authenticateSolana") };
      if (id === "@/lib/solana-binding-store") return { ...bindings, getSolanaBindingStore: touch("getSolanaBindingStore") };
      if (id === "@/lib/solana-api") return { ...api, solanaContext: touch("solanaContext"), solanaRequestBody: touch("solanaRequestBody") };
      if (id === "@/lib/solana-enabled") return { solanaEnabled };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: touch("getSolanaAppRuntime") };
    }
    return original.call(this, id, parent, isMain);
  });
  try {
    const load = createRequire(import.meta.url);
    for (const route of readdirSync(API)) {
      const mod = load(join(API, route, "route.ts")) as Record<string, unknown>;
      for (const method of METHODS) if (typeof mod[method] === "function") handlers.push({ route, method, handle: mod[method] as (req: Request) => Promise<Response> });
    }
    page = (load(join(WEB, "app/(app)/solana/page.tsx")) as { default: () => unknown }).default;
  } finally {
    interception.mock.restore();
  }
});
beforeEach(() => { touched = []; });
after(() => set(flag));

const call = (h: (typeof handlers)[number]) =>
  h.handle(new Request(`https://app.example.test/api/solana/${h.route}?owner=x`, h.method === "GET" ? {} : { method: h.method, body: "{}" }));

describe("the Solana switch", () => {
  it("is on only for MERRYMEN_SOLANA=1", () => {
    for (const value of [undefined, "", "0", "false", "true", "yes", "on", "2"]) {
      set(value);
      assert.equal(solanaEnabled(), false, String(value));
    }
    for (const value of ["1", " 1 "]) {
      set(value);
      assert.equal(solanaEnabled(), true, value);
    }
  });

  it("finds every route, including the ones that sign in directly", () => {
    const routes = new Set(handlers.map((h) => h.route));
    for (const route of ["bind", "intent", "owner", "paper", "settings", "setup", "status", "strategy"]) assert.ok(routes.has(route), route);
    assert.ok(handlers.some((h) => h.route === "bind" && h.method === "GET"));
  });

  it("off: every route answers 404 and touches nothing", async () => {
    set(undefined);
    for (const h of handlers) {
      const response = await call(h);
      assert.equal(response.status, 404, `${h.method} ${h.route}`);
      assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true });
    }
    assert.deepEqual(touched, []);
  });

  it("on: every route goes on to its own work", async () => {
    set("1");
    for (const h of handlers) {
      touched = [];
      assert.equal((await call(h)).status, 401, `${h.method} ${h.route}`);
      assert.ok(touched.length > 0, `${h.method} ${h.route} did no work`);
    }
  });

  it("off: the /solana page is not found; on: it renders the terminal", () => {
    set(undefined);
    assert.throws(() => page(), (error: unknown) => String((error as { digest?: unknown }).digest).includes("404"));
    set("1");
    assert.equal(page(), null);
  });

  it("the terminal shows the network switch only when the server says so", () => {
    const layout = readFileSync(join(WEB, "app/(app)/layout.tsx"), "utf8");
    assert.match(layout, /<App solana=\{solanaEnabled\(\)\} \/>/);
    const app = readFileSync(join(WEB, "terminal/App.tsx"), "utf8");
    assert.match(app, /export function App\(\{ solana = false \}/);
    assert.match(app, /screenForPath\(pathname, solana\)/);
    assert.match(app, /\{solana && <nav aria-label="Trading networks"/);
    assert.equal(app.match(/aria-label="Trading networks"/g)?.length, 1, "no second, ungated switch");
  });
});
