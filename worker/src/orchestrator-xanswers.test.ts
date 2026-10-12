/**
 * AN ACTIVE AGENT ANSWERS TAGS: a post that mentions it and asks it something
 * gets one answer, from public facts, in its own lane, right away — read
 * within a minute, due when drafted, the owner's night no hold — but never
 * for an owner the operator did not make active, never for advice, never
 * twice to one person in a day beyond the allowance, and never after a STOP.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite } from "./db";
import { makeXPoster, xpostEnv } from "./orchestrator-xpost";
import { isAsleep } from "./groupchat/clock";
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

async function world(t: TestContext, o: { active?: boolean; tz?: string | null; polls?: number } = {}) {
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
  const sends: Record<string, unknown>[] = [], prompts: string[] = [], reads: number[] = [];
  let clock = NOW;
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) {
      reads.push(clock);
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: inbox, meta: { result_count: inbox.length } }) };
    }
    assert.equal(url, "https://api.x.com/2/tweets");
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000001${sends.length}0` } }) };
  };
  const env = o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT };
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: { ...xpostEnv(env), repliesApproved: true, replyPollsPerDay: o.polls },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: o.tz ?? null }),
      facts: async () => new Map([[TENANT, FACTS]]),
      // Only the answer prompt gets words back: every other draft passes.
      llm: async (_creds, input) => { prompts.push(input.prompt); return /Untrusted question/.test(input.prompt) ? ANSWER : "PASS"; },
    },
  });
  const step = (now = NOW) => { clock = now; return poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now); };
  const answers = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "answer");
  const asked = () => prompts.filter((p) => /Untrusted question/.test(p));
  return { db, step, answers, asked, sends, reads, setInbox: (v: Record<string, unknown>[]) => { inbox = v; } };
}

test("the operator's active owners are read by address only, and a bad entry is named by position", () => {
  const env = xpostEnv({ MERRYMEN_XPOST_ACTIVE_TENANTS: ` ${TENANT.toUpperCase().replace("0X", "0x")} , alan ` });
  assert.deepEqual([...(env.activeTenants ?? [])], [TENANT]);
  assert.ok(env.notes.some((n) => /entry 2 of MERRYMEN_XPOST_ACTIVE_TENANTS/.test(n) && !/alan/.test(n)));
  assert.equal(xpostEnv({}).activeTenants, undefined);
});

test("a tag gets one answer to the mention itself, right away, in its own lane", async (t) => {
  const w = await world(t);
  await w.step();
  const [answer] = await w.answers();
  assert.ok(answer, "an answer was drafted");
  assert.equal(answer.status, "scheduled");
  assert.ok(answer.dueAtMs <= answer.createdAtMs, "due no later than when it was drafted: no ten-minute wait");
  assert.equal(answer.replyToTweetId, MENTION);
  const [prompt] = w.asked();
  assert.match(prompt!, /what kind of coins do you trade/);
  assert.doesNotMatch(prompt!, /@pine_stoat|private-access|private-refresh|private-model/);
  w.setInbox([]);
  // Not on a pass that did not read the inbox again: opt-outs come first.
  await w.step(NOW + 15_000);
  assert.equal(w.sends.length, 0, "a send waits for a fresh read of the mentions");
  // The next pass that reads them, a minute on, sends it.
  await w.step(NOW + MIN);
  assert.deepEqual(w.sends, [{ text: ANSWER, reply: { in_reply_to_tweet_id: MENTION } }]);
  assert.equal((await w.answers())[0]!.status, "posted");
  assert.equal(await store.lastOutAt(w.db, "111", NOW - DAY), null, "an answer is not a post the cadence waits behind");
  assert.equal((await store.readMeta(w.db, `xday:111:2026-09-30`))?.n ?? 0, 0, "nor one it counts");
  assert.equal((await store.readMeta(w.db, `answerday:111:2026-09-30`))?.n, 1);
});

test("an answer restates only what X published, never a draft still waiting or one written this pass", async (t) => {
  const w = await world(t);
  const write = async (key: string, body: string, posted: boolean) => {
    const id = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "casual", dedupeKey: key, body, nowMs: NOW - 2 * HOUR, dueAtMs: NOW + 5 * HOUR });
    if (posted) { await store.claimPost(w.db, id!, NOW - HOUR); await store.markPosted(w.db, id!, "100000000000000088", NOW - HOUR); }
  };
  await write("casual:out", "quiet tapes suit me fine", true);
  await write("casual:waiting", "an unsent thought about owls", false);
  w.setInbox([1, 2].map((n) => tag({ id: `10000000000000006${n}`, conversation_id: `10000000000000006${n}`, author_id: `66${n}`,
    text: "@pine_stoat what kind of coins do you trade?" })));
  await w.step();
  const said = w.asked().map((p) => /What you already said publicly[^\n]*/.exec(p)?.[0] ?? "");
  assert.equal(said.length, 2, "both tags were answered");
  for (const line of said) {
    assert.match(line, /quiet tapes suit me fine/, "a posted line is what it said");
    assert.match(line, /I am an AI trading agent/);
    assert.doesNotMatch(line, /owls/, "a draft still under Coming up was not said");
    assert.doesNotMatch(line, /fresh launches/, "nor the answer drafted a moment ago in this pass");
  }
  // The draft written a moment ago still keeps the next one from echoing it.
  const answers = (await w.answers()).sort((a, b) => a.id - b.id);
  assert.deepEqual(answers.map((a) => a.status), ["scheduled", "skipped"]);
  assert.match(answers[1]!.reason ?? "", /^gate:/);
});

test("the owner's night never holds an answer: a tag is answered and sent while the owner sleeps", async (t) => {
  const tz = "America/Los_Angeles";
  assert.equal(isAsleep(tz, TENANT, NOW), true, "02:00 there: the owner is asleep");
  assert.equal(isAsleep(tz, TENANT, NOW + MIN), true);
  const w = await world(t, { tz });
  await w.step();
  const [answer] = await w.answers();
  assert.equal(answer?.status, "scheduled", "drafted in the owner's night");
  w.setInbox([]);
  await w.step(NOW + MIN);
  assert.deepEqual(w.sends, [{ text: ANSWER, reply: { in_reply_to_tweet_id: MENTION } }], "and sent in it");
  assert.equal((await w.answers())[0]!.status, "posted");
  // Everything else still waits for morning: nothing but the answer went out.
  assert.equal((await store.postsOf(w.db, TENANT, 0)).filter((p) => p.kind !== "answer" && p.kind !== "intro").length, 0);
});

test("an active agent's mentions are read every minute on an allowance of its own; another owner's every thirty", async (t) => {
  const passes = (from: number, to: number) => Array.from({ length: (to - from) / 15_000 + 1 }, (_, i) => NOW + from + i * 15_000);
  const active = await world(t);
  active.setInbox([]);
  // The fleet's allowance spent: an active agent is polled all the same.
  await store.takeAllowance(active.db, "reply-polls:2026-09-30", 1, NOW);
  await active.db.prepare("UPDATE xpost_meta SET n = 200 WHERE k = ?").run("reply-polls:2026-09-30");
  for (const at of passes(0, 3 * MIN)) await active.step(at);
  assert.deepEqual(active.reads, [NOW, NOW + MIN, NOW + 2 * MIN, NOW + 3 * MIN], "once a minute, every minute");
  assert.equal((await store.readMeta(active.db, "reply-polls-active:111:2026-09-30"))?.n, 4);
  assert.equal((await store.readMeta(active.db, "reply-polls:2026-09-30"))?.n, 200, "never the fleet's");

  const other = await world(t, { active: false });
  other.setInbox([]);
  for (const at of [...passes(0, 3 * MIN), NOW + 29 * MIN, NOW + 30 * MIN, NOW + 31 * MIN]) await other.step(at);
  assert.deepEqual(other.reads, [NOW, NOW + 30 * MIN], "every thirty minutes");
  assert.equal((await store.readMeta(other.db, "reply-polls:2026-09-30"))?.n, 2);
  assert.equal(await store.readMeta(other.db, "reply-polls-active:111:2026-09-30"), null);

  const off = await world(t, { polls: 0 });
  await off.step();
  assert.deepEqual(off.reads, [], "polling switched off is off for the active owners too");
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

test("answers go out a minute apart, in their own lane", async (t) => {
  const w = await world(t);
  w.setInbox([]);
  for (const [n, word] of [[1, "one"], [2, "two"]] as const) {
    const id = `10000000000000007${n}`;
    await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer", dedupeKey: `answer:111:${id}`,
      body: `answer number ${word}. Say stop to opt out.`, nowMs: NOW, dueAtMs: NOW, replyToTweetId: id, replyRootTweetId: id, replyAuthorId: `77${n}` });
  }
  await w.step(NOW);
  assert.equal(w.sends.length, 1);
  assert.equal((await w.answers()).find((a) => a.status === "scheduled")?.dueAtMs, NOW + MIN, "the next one a minute after");
  await w.step(NOW + MIN);
  assert.equal(w.sends.length, 2);
});
