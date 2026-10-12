/**
 * AN ACTIVE AGENT ANSWERS TAGS: a post that mentions it and asks it something
 * gets one reviewed answer, from public facts, in its own lane — never for an
 * owner the operator did not make active, never for advice, never twice to
 * one person in a day beyond the allowance, and never after a STOP.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import { createXResearch, type XResearch } from "./orchestrator-xpost-research";
import type { CoinFacts } from "./coin-facts-types";
import type { FomoBroker } from "./fomo/contract";
import type { AgentFacts, CallFact } from "./groupchat/facts";
import type { FetchLike } from "./xpost/client";
import * as store from "./xpost/store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 30, 9);
const TENANT = `0x${"ab".repeat(20)}`;
const MENTION = "100000000000000020";
const ANSWER = "mostly fresh launches, and i only buy when the buying looks real and steady. Say stop to opt out.";
const CALL: CallFact = { decisionId: "fill-pepe", side: "buy", symbol: "PEPE", name: "Pepe", token: null,
  paper: false, atSec: (NOW - 4 * HOUR) / 1000, bands: ["curve early"], ownWords: null };
const FACTS: AgentFacts = { tenant: TENANT, agentId: TENANT, slug: null, name: "Pine Stoat", mode: "live",
  ageDays: 2, strategy: "trencher", traits: [], calls: [CALL] };
const tag = (over: Record<string, unknown> = {}) => ({ id: MENTION, author_id: "333", conversation_id: MENTION,
  created_at: new Date(NOW - MIN).toISOString(), text: "@pine_stoat what kind of coins do you trade?", ...over });

async function world(t: TestContext, o: { active?: boolean; env?: Record<string, string>; research?: XResearch } = {}) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "pine_stoat",
    tokens: { accessToken: "private-access", refreshToken: "private-refresh", accessExpiresAtMs: NOW + 7 * DAY, scope: "tweet.read tweet.write" },
    nowMs: NOW - 2 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, NOW - DAY);
  assert.equal(await store.setReplying(db, TENANT, true, "111", NOW - DAY), true);
  const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`,
    body: "I am an AI trading agent", nowMs: NOW - DAY, dueAtMs: NOW - DAY });
  await store.claimPost(db, intro!, NOW - DAY);
  await store.markPosted(db, intro!, "999", NOW - DAY);
  let inbox: Record<string, unknown>[] = [tag()];
  const sends: Record<string, unknown>[] = [], prompts: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) {
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: inbox, meta: { result_count: inbox.length } }) };
    }
    assert.equal(url, "https://api.x.com/2/tweets");
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000001${sends.length}0` } }) };
  };
  const env = { ...(o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), ...o.env };
  const systems: string[] = [];
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(env), repliesApproved: true },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: null }),
      facts: async () => new Map([[TENANT, FACTS]]),
      // Only the answer prompt gets words back: every other draft passes.
      llm: async (_creds, input) => {
        prompts.push(input.prompt);
        if (/Untrusted question/.test(input.prompt)) systems.push(input.system ?? "");
        return /Untrusted question/.test(input.prompt) ? ANSWER : "PASS";
      },
      ...(o.research ? { research: o.research } : {}),
    },
  });
  const step = (now = NOW) => poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now);
  const answers = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "answer");
  const asked = () => prompts.filter((p) => /Untrusted question/.test(p));
  return { db, step, answers, asked, systems, sends, setInbox: (v: Record<string, unknown>[]) => { inbox = v; } };
}

test("the operator's active owners are read by address only, and a bad entry is named by position", () => {
  const env = xpostEnv({ MERRYMEN_XPOST_ACTIVE_TENANTS: ` ${TENANT.toUpperCase().replace("0X", "0x")} , alan ` });
  assert.deepEqual([...(env.activeTenants ?? [])], [TENANT]);
  assert.ok(env.notes.some((n) => /entry 2 of MERRYMEN_XPOST_ACTIVE_TENANTS/.test(n) && !/alan/.test(n)));
  assert.equal(xpostEnv({}).activeTenants, undefined);
});

test("a tag gets one reviewed answer to the mention itself, in its own lane", async (t) => {
  const w = await world(t);
  await w.step();
  const [answer] = await w.answers();
  assert.ok(answer, "an answer was drafted");
  assert.equal(answer.status, "scheduled");
  assert.ok(answer.dueAtMs >= NOW + 10 * MIN, "the owner still gets ten minutes to skip it");
  assert.equal(answer.replyToTweetId, MENTION);
  const [prompt] = w.asked();
  assert.match(prompt!, /what kind of coins do you trade/);
  assert.doesNotMatch(prompt!, /@pine_stoat|private-access|private-refresh|private-model/);
  w.setInbox([]);
  await w.step(NOW + 30 * MIN);
  assert.deepEqual(w.sends, [{ text: ANSWER, reply: { in_reply_to_tweet_id: MENTION } }]);
  assert.equal((await w.answers())[0]!.status, "posted");
  assert.equal(await store.lastOutAt(w.db, "111", NOW - DAY), null, "an answer is not a post the cadence waits behind");
  assert.equal((await store.readMeta(w.db, `xday:111:2026-09-30`))?.n ?? 0, 0, "nor one it counts");
  assert.equal((await store.readMeta(w.db, `answerday:111:2026-09-30`))?.n, 1);
});

test("an owner the operator did not make active answers no tags", async (t) => {
  const w = await world(t, { active: false });
  await w.step();
  assert.equal((await w.answers()).length, 0);
  assert.equal(w.asked().length, 0);
});

test("advice requests and plain chatter get no answer and cost no model call", async (t) => {
  for (const text of ["@pine_stoat should i buy pepe now?", "@pine_stoat nice", "@pine_stoat check my presale, link in bio?"]) {
    const w = await world(t);
    w.setInbox([tag({ text })]);
    await w.step();
    assert.equal((await w.answers()).length, 0, text);
    assert.equal(w.asked().length, 0, text);
  }
});

test("a STOP opts the person out and nothing is drafted for them again", async (t) => {
  const w = await world(t);
  w.setInbox([tag({ id: "100000000000000019", text: "@pine_stoat stop" }), tag()]);
  await w.step();
  assert.equal((await w.answers()).length, 0);
  assert.equal(w.asked().length, 0);
});

test("one person gets at most two answers in a rolling day, whatever became of them", async (t) => {
  const w = await world(t);
  const answerTo = (id: string, at: number) => store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer",
    dedupeKey: `answer:111:${id}`, body: "", status: "skipped", reason: "pass", nowMs: at, dueAtMs: at,
    replyToTweetId: id, replyRootTweetId: id, replyAuthorId: "333" });
  assert.notEqual(await answerTo("100000000000000031", NOW - 2 * HOUR), null);
  assert.notEqual(await answerTo("100000000000000032", NOW - HOUR), null);
  assert.equal(await answerTo("100000000000000033", NOW), null, "the third in a day is refused");
  assert.notEqual(await answerTo("100000000000000034", NOW + DAY), null, "a day later they may ask again");
  assert.equal(await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer",
    dedupeKey: "answer:111:100000000000000035", body: "x", nowMs: NOW, dueAtMs: NOW,
    replyToTweetId: "100000000000000035", replyRootTweetId: "100000000000000036", replyAuthorId: "444" }), null, "an answer's root is the mention itself");
});

test("several people tagging in one poll are each answered, a few per poll", async (t) => {
  const w = await world(t);
  w.setInbox([1, 2, 3, 4].map((n) => tag({ id: `10000000000000005${n}`, conversation_id: `10000000000000005${n}`, author_id: `55${n}`,
    text: n % 2 ? "@pine_stoat how do you pick your coins?" : "@pine_stoat what are you trading lately?" })));
  await w.step();
  assert.equal((await w.answers()).length, 3, "three from this batch, the oldest first");
});

// ── research for answers ────────────────────────────────────────────────────

const CA = `0x${"ab12".repeat(10)}`;
const RESEARCH_ON = { MERRYMEN_XPOST_RESEARCH: "1" };

/** The real research, every reader faked: what it was asked, and the facts it builds. */
function fakeResearch(o: { fomo?: boolean } = {}) {
  const seen: { address: string }[] = [];
  const fomoCalls: { tool: string; surface: string; groupId: string | null | undefined }[] = [];
  const facts: CoinFacts = { network: "robinhood", observedAt: NOW, priceUsd: 0.0001, fdvNowUsd: 40_000, high: null, barsFromMs: null,
    poolCreatedAtMs: NOW - 3 * HOUR, drawdownPct: null, steepest: null, liquidityUsd: 4_000, change24hPct: 3, buyers24h: null, sellers24h: null,
    holders: { count: 90, top10Pct: 80, updatedAtMs: NOW }, creatorHoldingPct: null, info: "read", poolsSeen: 1 };
  const broker: FomoBroker = {
    async call(tool, _args, opts) {
      fomoCalls.push({ tool, surface: opts.surface, groupId: opts.groupId });
      return { status: "ok", tool, data: tool === "fomo_get_token_activity" ? { distinctBuyers: 9, distinctSellers: 1 } : null } as never;
    },
    memory: { get: async () => null, set: async () => {}, clear: async () => {} },
    report: async () => {},
    configured: () => true,
  };
  const research = createXResearch({
    coinFacts: async (q) => { seen.push({ address: q.address }); return { ok: true, facts }; },
    resolveTicker: async () => null,
    projectDescription: async () => null,
    publicTheses: async () => [],
    ...(o.fomo ? { fomo: () => broker } : {}),
  });
  return { research, seen, fomoCalls };
}

test("the research switches are read exactly, Fomo only inside research, and said when they cannot apply", () => {
  assert.equal(xpostEnv({}).research, undefined);
  assert.equal(xpostEnv({ MERRYMEN_XPOST_RESEARCH: "true" }).research, undefined, "only an exact 1");
  assert.equal(xpostEnv(RESEARCH_ON).research, true);
  assert.equal(xpostEnv({ ...RESEARCH_ON, MERRYMEN_XPOST_FOMO: "1" }).researchFomo, true);
  const alone = xpostEnv({ MERRYMEN_XPOST_FOMO: "1" });
  assert.equal(alone.researchFomo, undefined);
  assert.ok(alone.notes.some((n) => /MERRYMEN_XPOST_FOMO=1 does nothing without MERRYMEN_XPOST_RESEARCH=1/.test(n)));
  assert.equal(xpostEnv({ ...RESEARCH_ON, MERRYMEN_XPOST_RESEARCH_PER_HOUR: "30" }).researchPerHour, 30);
  assert.ok(xpostEnv({ MERRYMEN_XPOST_RESEARCH_PER_HOUR: "lots" }).notes.some((n) => /MERRYMEN_XPOST_RESEARCH_PER_HOUR/.test(n) && !/lots/.test(n)));
});

test("research off: nothing is looked up, and a tag carrying an address is not answered, as before", async (t) => {
  const r = fakeResearch();
  const w = await world(t, { research: r.research });
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w.step();
  assert.equal((await w.answers()).length, 0);
  assert.equal(w.asked().length, 0);
  const plain = await world(t, { research: r.research });
  await plain.step();
  const [prompt] = plain.asked();
  assert.ok(prompt, "an ordinary tag is still answered");
  assert.doesNotMatch(prompt!, /What you looked up/);
  assert.doesNotMatch(plain.systems[0]!, /may be said as what its source showed/, "the reply rules, as before");
  assert.equal(r.seen.length, 0, "the research is never asked while it is off");
});

test("research on: a tagged contract address is looked up and answered in words, and never reaches the model", async (t) => {
  const r = fakeResearch();
  const w = await world(t, { env: RESEARCH_ON, research: r.research });
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w.step();
  assert.deepEqual(r.seen, [{ address: CA }]);
  const [prompt] = w.asked();
  assert.ok(prompt, "an answer was drafted");
  assert.doesNotMatch(prompt!, /0x|ab12/i, "the address is a lookup key only");
  assert.match(prompt!, /thoughts on this coin/);
  assert.match(prompt!, /What you looked up just now.*«the public index shows liquidity is thin».*«the public index says it's only hours old».*«holders look concentrated on the public index»/s);
  assert.doesNotMatch(prompt!.match(/What you looked up[^\n]*/)![0], /\p{N}|\$/u, "no figure in what it looked up");
  assert.match(w.systems[0]!, /may be said as what its source showed/);
  const [answer] = await w.answers();
  assert.equal(answer!.status, "scheduled");
  assert.equal(answer!.replyToTweetId, MENTION);
  w.setInbox([]);
  await w.step(NOW + 30 * MIN);
  assert.deepEqual(w.sends, [{ text: ANSWER, reply: { in_reply_to_tweet_id: MENTION } }]);
});

test("research on, Fomo switch on: a coin answer asks Fomo as a public x-answer for this X account", async (t) => {
  const off = fakeResearch({ fomo: true });
  const w0 = await world(t, { env: RESEARCH_ON, research: off.research });
  w0.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w0.step();
  assert.equal(off.fomoCalls.length, 0, "the Fomo switch is off");
  const on = fakeResearch({ fomo: true });
  const w = await world(t, { env: { ...RESEARCH_ON, MERRYMEN_XPOST_FOMO: "1" }, research: on.research });
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w.step();
  assert.deepEqual(on.fomoCalls.map((c) => c.tool).sort(), ["fomo_get_token_activity", "fomo_get_token_theses"]);
  assert.ok(on.fomoCalls.every((c) => c.surface === "x-answer" && c.groupId === "111"));
  assert.match(w.asked()[0]!, /on fomo, more traders have been buying in than heading out lately/);
});

test("research on: the model question is a sherwood tease, a free intent with no lookup", async (t) => {
  const r = fakeResearch();
  const w = await world(t, { env: RESEARCH_ON, research: r.research });
  w.setInbox([tag({ text: "@pine_stoat what model do you run on?" })]);
  await w.step();
  assert.equal(r.seen.length, 0);
  assert.match(w.asked()[0]!, /asking what model you run on/);
  assert.match(w.systems[0]!, /tease the new «sherwood one», merrymen's own model/);
  assert.match(w.systems[0]!, /never claim sherwood runs you today/);
});
