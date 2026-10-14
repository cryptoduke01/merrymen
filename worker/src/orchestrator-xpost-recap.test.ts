/**
 * AN ACTIVE AGENT'S TRADES, SEEN (the owner's ask, 2026-10-14): a burst of
 * buys is said in one recap with code's figures, even when the model passes
 * on every single post; a buy at three in the morning goes out that night;
 * every recap line clears the real gate, live and paper.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { admitAgentLine } from "./groupchat/policy";
import type { AgentFacts, CallFact } from "./groupchat/facts";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import type { FetchLike } from "./xpost/client";
import { admitXPost } from "./xpost/gate";
import { recapLines } from "./xpost/recap";
import * as store from "./xpost/store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TENANT = `0x${"ab".repeat(20)}`;

function calls(nowMs: number, hoursAgo: number[], paper = false): CallFact[] {
  return hoursAgo.map((h, i) => ({ decisionId: `fill-${i}`, side: "buy", symbol: ["CAPITOL", "WISP", "INDEX"][i % 3]!, name: null, token: null,
    paper, atSec: (nowMs - h * HOUR) / 1000, bands: ["curve early"], ownWords: null }));
}

async function world(t: TestContext, o: { now: number; calls: CallFact[]; tz?: string | null; draft?: string }) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "alanaidale",
    tokens: { accessToken: "a", refreshToken: "r", accessExpiresAtMs: o.now + 7 * DAY, scope: "tweet.read tweet.write" }, nowMs: o.now - 3 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, o.now - 2 * DAY);
  const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`, body: "I am an AI trading agent", nowMs: o.now - 2 * DAY, dueAtMs: o.now - 2 * DAY });
  await store.claimPost(db, intro!, o.now - 2 * DAY);
  await store.markPosted(db, intro!, "999", o.now - 2 * DAY);
  const sends: { text: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ meta: { result_count: 0 } }) };
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000007${sends.length}0` } }) };
  };
  const facts: AgentFacts = { tenant: TENANT, agentId: TENANT, slug: null, name: "Alan Al Dale", mode: "live", ageDays: 20, strategy: "trencher", traits: [], calls: o.calls };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "k", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv({ MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), repliesApproved: true },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: o.tz ?? null }), facts: async () => new Map([[TENANT, facts]]),
      // The model passes on everything unless a draft is given: a recap needs none.
      llm: async () => o.draft ?? "PASS" },
  });
  const step = (now: number) => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now);
  const rows = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind !== "intro");
  return { step, rows, sends };
}

test("a burst of buys is said in one recap, with code's figures, though the model passed on every single post", async (t) => {
  const now = Date.UTC(2026, 9, 13, 9);
  const w = await world(t, { now, calls: calls(now, [3, 2.8, 2.6, 2.4, 2.2, 2, 1.5, 1]) });
  await w.step(now);
  const recap = (await w.rows()).find((p) => p.kind === "recap");
  assert.ok(recap, "a recap is planned");
  assert.equal(recap!.status, "scheduled", recap!.reason ?? "");
  assert.match(recap!.body, /\. recap: 8 buys; traded (?:[A-Z]+(?:, )?){3}\.$/);
  // It goes out when due, as it was written.
  await w.step(recap!.dueAtMs + MIN);
  assert.ok(w.sends.some((s) => s.text === recap!.body), "and is sent");
});

test("a buy at three in the morning is posted that night", async (t) => {
  const now = Date.UTC(2026, 9, 13, 3);
  const w = await world(t, { now, calls: calls(now, [0.2]), tz: "UTC", draft: "grabbed some capitol, the curve looked early" });
  await w.step(now);
  const [buy] = (await w.rows()).filter((p) => p.kind === "buy");
  assert.ok(buy, "planned in the night");
  assert.equal(buy!.status, "scheduled", buy!.reason ?? "");
  await w.step(buy!.dueAtMs + MIN);
  assert.equal(w.sends.length, 1, "and sent in it");
  assert.equal((await w.rows()).filter((p) => p.kind === "casual").length, 0, "no casual post at night");
});

describe("every recap line clears the real gate", () => {
  for (const mode of ["live", "paper"] as const) {
    it(`${mode}`, () => {
      for (const seed of ["recap:a:1", "recap:b:2"]) {
        for (const line of recapLines(seed, { paper: mode === "paper" })) {
          const v = admitXPost(line, { kind: "recap", agentName: "Alan Al Dale", mode, coins: [], recentOwn: [], recentFleet: [], house: true }, (r, c) => admitAgentLine(r, c));
          assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
        }
      }
    });
  }
});
