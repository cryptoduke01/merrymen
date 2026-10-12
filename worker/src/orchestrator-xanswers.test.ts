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
import { createXResearch, type XResearch } from "./orchestrator-xpost-research";
import type { CoinFacts } from "./coin-facts-types";
import type { FomoBroker } from "./fomo/contract";
import type { FlowResult } from "./flow-facts";
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

async function world(t: TestContext, o: {
  active?: boolean; tz?: string | null; polls?: number;
  /** The owner's own reply consent, given through the warning before the pass. Default: given. */
  consent?: boolean;
  /** The owner's hello on this X account, already posted before the pass. Default: posted. */
  hello?: boolean;
  /** Other owners, each on an X account of its own with posting on and no hello yet; their tenants sort first. */
  others?: number;
  /** MERRYMEN_XPOST_REPLIES_APPROVED as set (null: unset), read as the orchestrator reads it. Default: approved for everyone. */
  scope?: string | null;
  env?: Record<string, string>; research?: XResearch; facts?: AgentFacts; answer?: string;
} = {}) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw), dek = randomBytes(32);
  await store.ensureXpostSchema(db, "sqlite");
  await store.upsertAccount(db, dek, { tenant: TENANT, xUserId: "111", username: "pine_stoat",
    tokens: { accessToken: "private-access", refreshToken: "private-refresh", accessExpiresAtMs: NOW + 7 * DAY, scope: "tweet.read tweet.write" },
    nowMs: NOW - 2 * DAY });
  await store.setPosting(db, TENANT, { enabled: true, xUserId: "111" }, NOW - DAY);
  if (o.consent !== false) assert.equal(await store.setReplying(db, TENANT, true, "111", NOW - DAY), true);
  if (o.hello !== false) {
    const intro = await store.schedulePost(db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`,
      body: "I am an AI trading agent", nowMs: NOW - DAY, dueAtMs: NOW - DAY });
    await store.claimPost(db, intro!, NOW - DAY);
    await store.markPosted(db, intro!, "999", NOW - DAY);
  }
  const others = Array.from({ length: o.others ?? 0 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`);
  for (const [i, other] of others.entries()) {
    await store.upsertAccount(db, dek, { tenant: other, xUserId: `${500 + i}`, username: `other_${i}`,
      tokens: { accessToken: "private-access", refreshToken: "private-refresh", accessExpiresAtMs: NOW + 7 * DAY, scope: "tweet.read tweet.write" },
      nowMs: NOW - 2 * DAY });
    await store.setPosting(db, other, { enabled: true, xUserId: `${500 + i}` }, NOW - DAY);
  }
  let inbox: Record<string, unknown>[] = [tag()];
  const sends: Record<string, unknown>[] = [], prompts: string[] = [], reads: number[] = [];
  let clock = NOW;
  let garbled = false;
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/mentions?")) {
      reads.push(clock);
      // A page that does not add up, as X's answer past its eight hundred mentions reads to the client.
      if (garbled) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: inbox, meta: { result_count: inbox.length + 1 } }) };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: inbox, meta: { result_count: inbox.length } }) };
    }
    assert.equal(url, "https://api.x.com/2/tweets");
    sends.push(JSON.parse(init.body ?? "{}"));
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: `1000000000000001${sends.length}0` } }) };
  };
  const env = { ...(o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), ...o.env };
  const systems: string[] = [], everySystem: string[] = [];
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: o.scope === undefined
      ? { ...xpostEnv(env), repliesApproved: true, replyPollsPerDay: o.polls }
      : { ...xpostEnv(o.scope === null ? env : { ...env, MERRYMEN_XPOST_REPLIES_APPROVED: o.scope }), replyPollsPerDay: o.polls },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: o.tz ?? null }),
      facts: async () => new Map([[TENANT, o.facts ?? FACTS], ...others.map((t, i): [string, AgentFacts] => [t, { ...FACTS, tenant: t, agentId: t, name: `Other ${i}`, calls: [] }])]),
      // Only the answer prompt gets words back: every other draft passes.
      llm: async (_creds, input) => {
        prompts.push(input.prompt);
        everySystem.push(input.system ?? "");
        if (/Untrusted question/.test(input.prompt)) systems.push(input.system ?? "");
        return /Untrusted question/.test(input.prompt) ? o.answer ?? ANSWER : "PASS";
      },
      ...(o.research ? { research: o.research } : {}),
    },
  });
  const step = (now = NOW) => { clock = now; return poster.step(db, [{ tenant: TENANT, agentId: TENANT }, ...others.map((t) => ({ tenant: t, agentId: t }))], new Map(), now); };
  const answers = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "answer");
  const asked = () => prompts.filter((p) => /Untrusted question/.test(p));
  return { db, step, answers, asked, systems, everySystem, sends, reads, setInbox: (v: Record<string, unknown>[]) => { inbox = v; }, garble: (on: boolean) => { garbled = on; } };
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

test("an answer that carried a coin's research is never restated as what it said", async (t) => {
  const w = await world(t, { env: RESEARCH_ON, research: fakeResearch().research });
  const id = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer", dedupeKey: "answer:111:100000000000000065",
    body: "the public index shows liquidity is thin, and fomo traders mostly argue it's still early. Say stop to opt out.", nowMs: NOW - 2 * HOUR, dueAtMs: NOW - 2 * HOUR,
    replyToTweetId: "100000000000000065", replyRootTweetId: "100000000000000065", replyAuthorId: "665" });
  await store.claimPost(w.db, id!, NOW - HOUR);
  await store.markPosted(w.db, id!, "100000000000000066", NOW - HOUR);
  w.setInbox([tag({ text: "@pine_stoat what kind of coins do you trade?" })]);
  await w.step();
  const [prompt] = w.asked();
  assert.ok(prompt);
  const said = /What you already said publicly[^\n]*/.exec(prompt!)?.[0] ?? "";
  assert.match(said, /I am an AI trading agent/, "its own posts are still what it said");
  assert.doesNotMatch(said, /public index|fomo/, "another coin's read is not");
});

test("an answer handed anything looked up is marked by that, and never restated as said, whatever words the model chose", async (t) => {
  // The model drops every source word: nothing in the posted body says index, fomo or on-chain.
  const bare = "thin liquidity and holders bunched up at the top, spicy one. Say stop to opt out.";
  const w = await world(t, { env: RESEARCH_ON, research: fakeResearch().research, answer: bare });
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w.step();
  assert.match(w.asked()[0]!, /What you looked up just now/, "it was handed research");
  const [first] = await w.answers();
  assert.equal(first!.status, "scheduled", first!.reason ?? "");
  assert.equal(first!.coin, store.ANSWER_LOOKED_UP, "marked by what it was handed");
  w.setInbox([]);
  await w.step(NOW + MIN);
  assert.equal((await w.answers())[0]!.status, "posted");
  // A later tag: what it already said never carries that read, though no source word would have caught it.
  w.setInbox([tag({ id: "100000000000000151", conversation_id: "100000000000000151", author_id: "151", text: "@pine_stoat gm, how's your day going?" })]);
  await w.step(NOW + 2 * MIN);
  const later = w.asked().at(-1)!;
  assert.match(later, /how's your day going/);
  assert.doesNotMatch(/What you already said publicly[^\n]*/.exec(later)?.[0] ?? "", /bunched up/);
  // An answer handed nothing looked up is not marked.
  const chat = (await w.answers()).find((a) => a.replyToTweetId === "100000000000000151");
  assert.equal(chat?.coin, null);
});

test("a research answer is never shown to a later prompt as a recent post, and the gate still keeps a draft from repeating it", async (t) => {
  const read = "the public index shows liquidity is thin, and fomo traders mostly argue it's still early. Say stop to opt out.";
  const bare = "thin liquidity and holders bunched up at the top, spicy one. Say stop to opt out.";
  const w = await world(t, { env: RESEARCH_ON, research: fakeResearch().research, answer: bare });
  // One posted earlier with its sources in its words, one marked by what it was handed.
  const id = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer", dedupeKey: "answer:111:100000000000000065",
    body: read, nowMs: NOW - 2 * HOUR, dueAtMs: NOW - 2 * HOUR,
    replyToTweetId: "100000000000000065", replyRootTweetId: "100000000000000065", replyAuthorId: "665" });
  await store.claimPost(w.db, id!, NOW - HOUR);
  await store.markPosted(w.db, id!, "100000000000000066", NOW - HOUR);
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` }),
    tag({ id: "100000000000000152", conversation_id: "100000000000000152", author_id: "152", created_at: new Date(NOW - MIN + 1).toISOString(), text: "@pine_stoat gm, how's your day going?" })]);
  await w.step();
  const answers = (await w.answers()).filter((a) => a.dedupeKey !== "answer:111:100000000000000065").sort((a, b) => a.id - b.id);
  assert.equal(answers[0]!.coin, store.ANSWER_LOOKED_UP);
  assert.equal(answers[0]!.status, "scheduled", answers[0]!.reason ?? "");
  // Both the earlier research answer and this pass's own were kept out of every later prompt...
  assert.ok(w.everySystem.length >= 2, "the later tag was drafted too");
  for (const system of w.everySystem) assert.doesNotMatch(system, /public index|bunched up/);
  // ...and the gate still saw this pass's: the same words for the next tag are a repeat.
  assert.equal(answers[1]!.status, "skipped");
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

test("an active account whose mentions cannot be read waits thirty minutes, not one, before it pays for another read", async (t) => {
  const w = await world(t);
  w.garble(true);
  for (const at of [NOW, NOW + MIN, NOW + 2 * MIN, NOW + 29 * MIN]) await w.step(at);
  assert.deepEqual(w.reads, [NOW], "one failed read, then held");
  assert.ok(Number((await store.readMeta(w.db, "reply-backoff:111"))?.v) >= NOW + 30 * MIN);
  w.garble(false);
  await w.step(NOW + 30 * MIN + 15_000);
  assert.equal(w.reads.length, 2, "read again at the fleet's pace");
  assert.equal(w.reads.at(-1), NOW + 30 * MIN + 15_000);
});

test("an owner the operator did not make active answers no tags", async (t) => {
  const w = await world(t, { active: false });
  await w.step();
  assert.equal((await w.answers()).length, 0);
  assert.equal(w.asked().length, 0);
});

test("a tag with a figure in it is answered, the figure read as a number and never shown to the model", async (t) => {
  for (const env of [{}, RESEARCH_ON]) {
    const w = await world(t, { env, research: fakeResearch().research });
    w.setInbox([tag({ text: "@pine_stoat is $PEPE legit? saw it on 2 lists" })]);
    await w.step();
    const [prompt] = w.asked();
    assert.ok(prompt, "drafted");
    assert.match(prompt!, /Untrusted question to answer: «is \$PEPE legit\? saw it on \(a number\) lists»/);
    assert.doesNotMatch(prompt!, /no usable question/);
    assert.doesNotMatch(/Untrusted question[^\n]*/.exec(prompt!)![0], /\p{N}/u);
    assert.equal((await w.answers())[0]!.status, "scheduled");
  }
});

test("a copycat ticker beside a coin it bought is answered with its digit masked, and never told what it bought", async (t) => {
  for (const env of [{}, RESEARCH_ON]) {
    // It bought PEPE (FACTS); each of these names another coin.
    const texts = ["@pine_stoat did you buy $PEPE2?", "@pine_stoat why did you buy pepe2?", "@pine_stoat did you buy pepe 2?"];
    const w = await world(t, { env, research: fakeResearch().research });
    w.setInbox(texts.map((text, n) => tag({ id: `10000000000000014${n}`, conversation_id: `10000000000000014${n}`, author_id: `14${n}`, text })));
    await w.step();
    const asked = w.asked();
    assert.equal(asked.length, 3, "each is a usable question");
    for (const prompt of asked) {
      const q = /Untrusted question to answer: «([^»]*)»/.exec(prompt)?.[1] ?? "";
      assert.match(q, /\(a number\)/);
      assert.doesNotMatch(q, /\p{N}/u);
      assert.doesNotMatch(prompt, /Coins you bought lately|can't name here|«you bought it/, q);
      assert.match(prompt, /They named a specific coin/, q);
    }
  }
  // Ordinary digits glued to letters are questions too, research on or off.
  for (const env of [{}, RESEARCH_ON]) {
    const w = await world(t, { env, research: fakeResearch().research });
    const texts = ["@pine_stoat what's the 24h volume on $BONK looking like?", "@pine_stoat which L2 do you trade on?", "@pine_stoat is web3 gaming dead?"];
    w.setInbox(texts.map((text, n) => tag({ id: `10000000000000017${n}`, conversation_id: `10000000000000017${n}`, author_id: `17${n}`, text })));
    await w.step();
    assert.deepEqual(w.asked().map((p) => /Untrusted question to answer: «([^»]*)»/.exec(p)?.[1]),
      ["what's the (a number)h volume on $BONK looking like?", "which L(a number) do you trade on?", "is web(a number) gaming dead?"]);
  }
  // A tag that names sherwood, with a digit or without, is answered by nothing at all.
  const w = await world(t);
  w.setInbox([tag({ text: "@pine_stoat sherwood1 running the show yet?" })]);
  await w.step();
  assert.deepEqual(await w.answers(), []);
  assert.equal(w.asked().length, 0);
});

test("a tag that names a coin it bought, however spelled, is never told what it bought, research on or off", async (t) => {
  // It bought PEPE (FACTS), with real money; each of these names it, or a copycat of it.
  const texts = ["@pine_stoat did you buy pepe?", "@pine_stoat did you buy pepe inu?", "@pine_stoat did you buy pe\u200bpe?", "@pine_stoat is $PEPE legit?",
    "@pine_stoat did you buy pepe classic?"];
  for (const env of [{}, RESEARCH_ON]) {
    const w = await world(t, { env, research: fakeResearch().research });
    w.setInbox(texts.map((text, n) => tag({ id: `10000000000000016${n}`, conversation_id: `10000000000000016${n}`, author_id: `16${n}`, text })));
    await w.step();
    const asked = w.asked();
    assert.equal(asked.length, 3, "a batch's three, the oldest first");
    for (const prompt of asked) {
      const q = /Untrusted question[^\n]*/.exec(prompt)?.[0] ?? "";
      assert.doesNotMatch(prompt, /Coins you bought lately|not bought anything|can't name here/, q);
      assert.doesNotMatch(prompt, /«you bought it|when you bought it:|about your latest buy/, q);
      assert.match(prompt, /They named a specific coin\. Never say whether you bought it, hold it or like it/, q);
    }
    for (const system of w.systems) assert.doesNotMatch(system, /Your recent posts, which you must not repeat/, "nor its recent posts, which carry its buy posts");
  }
  // A question that names no coin still sees its buys.
  const plain = await world(t);
  plain.setInbox([tag({ text: "@pine_stoat what have you been buying lately?" })]);
  await plain.step();
  assert.match(plain.asked()[0]!, /Coins you bought lately: «Pepe»/);
  assert.match(plain.systems[0]!, /Your recent posts, which you must not repeat/, "and its recent posts");
});

test("a live agent whose buys all lack a sayable name is never told it bought nothing", async (t) => {
  // An autonomous Trencher buy: its symbol is the derived id, and its name has a digit.
  const derived: CallFact = { ...CALL, decisionId: "fill-derived", symbol: "T7631DACC21B", name: "Pepe 2.0" };
  const w = await world(t, { facts: { ...FACTS, calls: [derived] } });
  w.setInbox([tag({ text: "@pine_stoat what have you been buying lately?" })]);
  await w.step();
  const [prompt] = w.asked();
  assert.ok(prompt);
  assert.match(prompt!, /You trade with real money/);
  assert.match(prompt!, /You bought coins lately with real money that you can't name here/);
  assert.doesNotMatch(prompt!, /You have not bought anything lately|T7631|Pepe 2/);
  // And an agent that truly bought nothing is told so.
  const idle = await world(t, { facts: { ...FACTS, calls: [] } });
  idle.setInbox([tag({ text: "@pine_stoat what have you been buying lately?" })]);
  await idle.step();
  assert.match(idle.asked()[0]!, /You have not bought anything lately/);
});

test("only the money it trades with now: a live agent is never told of its paper buys, and an honest answer in either mode is posted", async (t) => {
  // Switched from paper to live inside the window: every recent buy is a paper Trencher buy it cannot name.
  const paperBuy: CallFact = { ...CALL, decisionId: "fill-derived", symbol: "T7631DACC21B", name: "Pepe 2.0", paper: true };
  const liveBuy: CallFact = { ...paperBuy, decisionId: "fill-derived-2", symbol: "T8888DACC21B", paper: false };
  const cases: [string, AgentFacts, string, RegExp | null, RegExp][] = [
    ["live, its buys all on paper", { ...FACTS, mode: "live", calls: [paperBuy] }, "can't really get into what i've been buying here. Say stop to opt out.", null, /paper|practice|can't name here/i],
    ["live, its buys of both kinds", { ...FACTS, mode: "live", calls: [paperBuy, liveBuy] }, "picked up a few with real money lately, can't name them here. Say stop to opt out.",
      /You bought coins lately with real money that you can't name here/, /some on paper|practice/i],
    ["live, a paper coin it may name", { ...FACTS, mode: "live", calls: [{ ...CALL, paper: true }] }, "can't really get into what i've been buying here. Say stop to opt out.", null, /Pepe|paper|practice/i],
    ["paper, its buys on paper", { ...FACTS, mode: "paper", calls: [paperBuy] }, "grabbed a few on paper lately, can't name them here. Say stop to opt out.",
      /You bought coins lately on paper, with practice money, that you can't name here/, /real money that you can't name/i],
    ["paper, its buys all live", { ...FACTS, mode: "paper", calls: [liveBuy] }, "i'm on paper, and i can't name what i've been buying here. Say stop to opt out.", null, /real money|can't name here/i],
  ];
  for (const env of [{}, RESEARCH_ON]) {
    for (const [what, facts, answer, said, unsaid] of cases) {
      const w = await world(t, { env, research: fakeResearch().research, facts, answer });
      w.setInbox([tag({ text: "@pine_stoat what have you been buying lately?" })]);
      await w.step();
      const [prompt] = w.asked();
      assert.ok(prompt, what);
      if (said) assert.match(prompt!, said, what);
      assert.doesNotMatch(prompt!, unsaid, what);
      assert.doesNotMatch(prompt!, /You have not bought anything lately/, what);
      const [row] = await w.answers();
      assert.equal(row!.status, "scheduled", `${what}: ${row!.reason ?? ""}`);
    }
  }
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

// ── the operator's own agents' reply consent ────────────────────────────────

test("a house agent's reply consent is recorded once, said once by name, and it answers on that pass", async (t) => {
  const w = await world(t, { consent: false });
  assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), null);
  const first = await w.step();
  assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), NOW, "recorded when the pass ran");
  assert.equal(first.notes?.length, 1);
  assert.match(first.notes![0]!, new RegExp(`house agent ${TENANT}`));
  assert.doesNotMatch(first.notes![0]!, /private-|pine_stoat/, "no token, nothing but the owner it concerns");
  assert.equal(w.reads.length, 1, "polled after consent, on the same pass");
  // The tag came before this consent, so it is not answered: consent never reaches back.
  assert.equal((await w.answers()).length, 0);
  const again = await w.step(NOW + MIN);
  assert.equal(again.notes, undefined, "recorded once");
  assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), NOW);
});

test("nothing is answered before the hello: the answer waits for the post that says an AI agent posts here", async (t) => {
  // The owner's night: the hello waits for morning, and so does every answer.
  const tz = "America/Los_Angeles";
  const w = await world(t, { hello: false, tz });
  await w.step();
  assert.equal((await w.answers()).length, 0);
  assert.equal(w.asked().length, 0, "and no model call on one");
  // The hello goes out; the next tag is answered.
  const intro = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`,
    body: "I am an AI trading agent", nowMs: NOW, dueAtMs: NOW });
  await store.claimPost(w.db, intro!, NOW);
  await store.markPosted(w.db, intro!, "999", NOW);
  w.setInbox([tag({ id: "100000000000000091", conversation_id: "100000000000000091", author_id: "991", created_at: new Date(NOW + 30_000).toISOString() })]);
  await w.step(NOW + MIN);
  assert.deepEqual((await w.answers()).map((a) => a.status), ["scheduled"]);
});

test("a house agent's reply consent waits for its hello", async (t) => {
  const tz = "America/Los_Angeles";
  const w = await world(t, { consent: false, hello: false, tz });
  const r = await w.step();
  assert.equal(r.notes, undefined);
  assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), null, "not recorded while the hello is not out");
  assert.equal(w.reads.length, 0, "and not polled");
  const intro = await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "intro", dedupeKey: `intro:${TENANT}:111`,
    body: "I am an AI trading agent", nowMs: NOW, dueAtMs: NOW });
  await store.claimPost(w.db, intro!, NOW);
  await store.markPosted(w.db, intro!, "999", NOW);
  await w.step(NOW + MIN);
  assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), NOW + MIN);
});

test("an owner's replies off is never overridden by the house consent", async (t) => {
  const w = await world(t, { consent: false });
  await w.step();
  assert.equal(await store.setReplying(w.db, TENANT, false, "111", NOW + 30_000), true, "the owner switches replies off in Settings");
  for (const at of [NOW + MIN, NOW + 2 * MIN, NOW + DAY]) {
    const r = await w.step(at);
    assert.equal(r.notes, undefined);
    assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), null);
  }
  assert.equal(w.reads.length, 1, "and it is not polled again");
});

test("the house consent is only for the agents the operator named, and only while replies are in scope", async (t) => {
  for (const [what, o] of [
    ["an owner the operator did not name", { active: false }],
    ["the scope unset", { scope: null }],
    ["the scope unreadable", { scope: "yes" }],
  ] as const) {
    const w = await world(t, { consent: false, ...o });
    const r = await w.step();
    assert.equal(r.notes, undefined, what);
    assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), null, what);
    assert.equal(w.reads.length, 0, what);
  }
  for (const scope of ["1", "active"]) {
    const w = await world(t, { consent: false, scope });
    await w.step();
    assert.equal(await store.replyConsentAt(w.db, TENANT, "111"), NOW, `scope ${scope}`);
  }
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

// ── research for answers ────────────────────────────────────────────────────

const CA = `0x${"ab12".repeat(10)}`;
const RESEARCH_ON = { MERRYMEN_XPOST_RESEARCH: "1" };

/** The real research, every reader faked: what it was asked, and the facts it builds. */
function fakeResearch(o: { fomo?: boolean; flow?: FlowResult } = {}) {
  const seen: { address: string }[] = [];
  const flows: { address: string; timeoutMs: number }[] = [];
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
    ...(o.flow ? { flow: async (q: { address: string; timeoutMs: number }) => { flows.push({ address: q.address, timeoutMs: q.timeoutMs }); return o.flow!; } } : {}),
  });
  return { research, seen, fomoCalls, flows };
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

test("research on, the flow lane wired: a tagged contract's onchain flow reaches the draft as bands, never a figure", async (t) => {
  const reading: FlowResult = { ok: true, facts: { token: CA as `0x${string}`, observedAt: NOW, venues: [], largestSells: [], creator: { state: "not-derivable" },
    windows: [
      { minutes: 5, buyUsd: 120, sellUsd: 900, buys: 2, sells: 8, buyers: 2, sellers: 6 },
      { minutes: 15, buyUsd: 300, sellUsd: 2_000, buys: 4, sells: 12, buyers: 3, sellers: 8 },
      { minutes: 60, buyUsd: 500, sellUsd: 3_000, buys: 6, sells: 20, buyers: 3, sellers: 12 },
    ] } };
  const r = fakeResearch({ flow: reading });
  const w = await world(t, { env: RESEARCH_ON, research: r.research });
  w.setInbox([tag({ text: `@pine_stoat thoughts on ${CA}?` })]);
  await w.step();
  assert.deepEqual(r.flows.map((q) => q.address), [CA]);
  const looked = /What you looked up just now[^\n]*/.exec(w.asked()[0] ?? "")?.[0] ?? "";
  assert.match(looked, /on-chain data shows sells clearly outweighing buys over the last hour|per on-chain data, sells ran well ahead of buys over the last hour/);
  assert.doesNotMatch(looked, /\p{N}|\$|0x/u, "bands, never a figure or the address");
  assert.equal((await w.answers())[0]!.status, "scheduled");
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

test("research on: the model question is answered from a code-built sherwood line, with no lookup and no draft", async (t) => {
  const r = fakeResearch();
  const w = await world(t, { env: RESEARCH_ON, research: r.research });
  w.setInbox([tag({ text: "@pine_stoat what model do you run on?" })]);
  await w.step();
  assert.equal(r.seen.length, 0);
  assert.equal(w.asked().length, 0, "no model call: the line is code's");
  const [answer] = await w.answers();
  assert.equal(answer!.status, "scheduled", answer!.reason ?? "");
  assert.match(answer!.body, /merrymen/);
  assert.match(answer!.body, /new sherwood-1\b/, "by its exact name");
  assert.match(answer!.body, /Say stop to opt out\.$/i);
  assert.doesNotMatch(answer!.body.replace(/\bsherwood-1\b/, ""), /\p{N}/u, "and no other digit");
  assert.doesNotMatch(answer!.body, /running on|powered|runs me/);
  assert.equal((await store.readMeta(w.db, "llm:2026-09-30"))?.n ?? 0, 0, "and no model allowance spent");
});

test("research on: the model question asked again is answered again, in other words, never the same line twice", async (t) => {
  const w = await world(t, { env: RESEARCH_ON, research: fakeResearch().research });
  // Three people in one poll, and the same mention's own line for all three: each later one would repeat the first.
  w.setInbox([1, 2, 3].map((n) => tag({ id: `10000000000000009${n}`, conversation_id: `10000000000000009${n}`, author_id: `99${n}`,
    text: "@pine_stoat what model do you run on?" })));
  await w.step();
  const answers = await w.answers();
  assert.deepEqual(answers.map((a) => a.status), ["scheduled", "scheduled", "scheduled"], answers.map((a) => a.reason).join(","));
  assert.equal(new Set(answers.map((a) => a.body)).size, 3, "three different lines");
  for (const a of answers) assert.match(a.body, /new sherwood-1\b/);
  assert.equal(w.asked().length, 0, "still no model call");
});

test("research off too: the model question is answered from a code-built line, never a draft", async (t) => {
  const w = await world(t, { answer: "i run on sherwood-1, built by merrymen. Say stop to opt out." });
  w.setInbox([tag({ text: "@pine_stoat what model do you run on?" })]);
  await w.step();
  const [answer] = await w.answers();
  assert.equal(answer!.status, "scheduled", answer!.reason ?? "");
  assert.match(answer!.body, /new sherwood-1\b/);
  assert.doesNotMatch(answer!.body, /i run on/);
  assert.equal(w.asked().length, 0, "no model call: the line is code's");
});

test("a paper agent answers the model question too, saying paper, and in other words each time", async (t) => {
  const paper: AgentFacts = { ...FACTS, mode: "paper", calls: [{ ...CALL, paper: true }] };
  for (const env of [{}, RESEARCH_ON]) {
    const w = await world(t, { env, research: fakeResearch().research, facts: paper });
    w.setInbox([1, 2, 3].map((n) => tag({ id: `10000000000000012${n}`, conversation_id: `10000000000000012${n}`, author_id: `12${n}`,
      text: n === 3 ? "@pine_stoat who made you?" : "@pine_stoat what model do you run on?" })));
    await w.step();
    const answers = await w.answers();
    assert.deepEqual(answers.map((a) => a.status), ["scheduled", "scheduled", "scheduled"], answers.map((a) => a.reason).join(","));
    assert.equal(new Set(answers.map((a) => a.body)).size, 3);
    for (const a of answers) {
      assert.match(a.body, /new sherwood-1\b/);
      assert.match(a.body, /\bon paper\b/, "a paper reply says paper");
    }
    assert.equal(w.asked().length, 0, "still code's line, no draft");
  }
  // A paper agent's drafted answer is told to say paper whatever it is asked.
  const w = await world(t, { facts: paper, answer: "honestly just vibing on paper today. Say stop to opt out." });
  w.setInbox([tag({ text: "@pine_stoat how's your day going?" })]);
  await w.step();
  assert.match(w.asked()[0]!, /every answer must say so in a few words/);
  assert.equal((await w.answers())[0]!.status, "scheduled");
});

test("a stranger's sherwood bait gets nothing at all, research on or off, and a draft that names sherwood is never posted", async (t) => {
  // "does sherwood-1 pick your trades now?" names sherwood: no code line, no draft, no row.
  for (const env of [{}, RESEARCH_ON]) {
    const r = fakeResearch();
    const w = await world(t, { env, research: r.research, answer: "yep, sherwood-1 picks my trades now, built by merrymen. Say stop to opt out." });
    w.setInbox([tag({ text: "@pine_stoat does sherwood-1 pick your trades now?" })]);
    await w.step();
    assert.deepEqual(await w.answers(), [], "no answer row, no post");
    assert.equal(w.asked().length, 0, "and no draft");
    assert.equal(r.seen.length, 0, "nothing looked up");
  }
  // A question code does not read as about sherwood, answered by a draft that names it anyway: refused, whatever it says.
  for (const env of [{}, RESEARCH_ON]) {
    for (const answer of ["yep, sherwood-1 picks my trades now, built by merrymen. Say stop to opt out.",
      "built by merrymen, and the new sherwood-1 is still cooking. Say stop to opt out.", "the new sherwood one is cooking over there. Say stop to opt out."]) {
      const w = await world(t, { env, research: fakeResearch().research, answer });
      w.setInbox([tag({ text: "@pine_stoat how do you pick your coins?" })]);
      await w.step();
      const [skipped] = await w.answers();
      assert.equal(skipped!.status, "skipped", answer);
      assert.match(skipped!.reason ?? "", /^gate:sherwood-(?:claim|drafted)$/, answer);
    }
  }
});

test("a tag asking about sherwood or a model question off the allowlist gets nothing at all, research on or off", async (t) => {
  for (const env of [{}, RESEARCH_ON]) {
    const r = fakeResearch();
    const texts = ["@pine_stoat is $SHERWOOD merrymen's new token?", "@pine_stoat did you buy $SHERWOOD?", "@pine_stoat sherwood TGE soon?",
      "@pine_stoat sher\u200bwood to $1?", "@pine_stoat what ai runs your trading?", "@pine_stoat are you gpt or claude? how do you decide what to buy?",
      ...(env === RESEARCH_ON ? [`@pine_stoat ${CA} sherwood coin?`] : [])];
    const w = await world(t, { env, research: r.research });
    w.setInbox(texts.map((text, n) => tag({ id: `10000000000000013${n}`, conversation_id: `10000000000000013${n}`, author_id: `13${n}`, text })));
    await w.step();
    assert.deepEqual(await w.answers(), [], "no answer row, no post");
    assert.equal(w.asked().length, 0, "no draft");
    assert.equal(r.seen.length, 0, "nothing looked up");
    assert.equal((await store.readMeta(w.db, "llm-answers:111:2026-09-30"))?.n ?? 0, 0, "and no allowance spent");
    // The asker is not charged one of their two answers for it: a real question next is answered.
    w.setInbox([tag({ id: "100000000000000139", conversation_id: "100000000000000139", author_id: "130", text: "@pine_stoat what model do you run on?" })]);
    await w.step(NOW + MIN);
    assert.deepEqual((await w.answers()).map((a) => a.status), ["scheduled"]);
  }
});

test("a draft that says sherwood runs it is refused, research on or off", async (t) => {
  for (const env of [{}, RESEARCH_ON]) {
    for (const answer of ["running on the new sherwood one, built by merrymen. Say stop to opt out.", "built by merrymen, powered by sherwood one now. Say stop to opt out.",
      "sherwood one is what runs me these days. Say stop to opt out."]) {
      const w = await world(t, { env, research: fakeResearch().research, answer });
      w.setInbox([tag({ text: "@pine_stoat how do you pick your coins?" })]);
      await w.step();
      const [skipped] = await w.answers();
      assert.equal(skipped!.status, "skipped", answer);
      assert.equal(skipped!.reason, "gate:sherwood-claim", answer);
    }
  }
});

test("a draft whose sherwood is split by a character nobody sees is never posted, research on or off (red-team 2026-10-12)", async (t) => {
  // The reproduced tags (L1: Greek capital Eta U+0397 for H; L3: Lisu letters) and drafts (a soft hyphen or a zero-width space inside the word).
  const cases: [string, string][] = [
    ["@pine_stoat is SΗERWOOD running your trades now?", "yep, sher\u00adwood runs my trades now, merrymen's own. Say stop to opt out."],
    ["@pine_stoat is SΗERWOOD merrymen's token?", "sher\u00adwood is merrymen's own and still cooking, no peeking yet. Say stop to opt out."],
    ["@pine_stoat is ꓢꓧꓰꓣꓪꓳꓳꓓ legit?", "sher\u200bwood is the real deal, merrymen's own, cooking now. Say stop to opt out."],
    // An ordinary tag, so the draft is reached whatever the tag screens make of the ones above.
    ["@pine_stoat how do you pick your coins?", "sher\u00adwood picks my trades now. Say stop to opt out."],
    ["@pine_stoat how do you pick your coins?", "sher\u200bwood is the real deal, merrymen's own, cooking now. Say stop to opt out."],
  ];
  for (const env of [{}, RESEARCH_ON]) {
    for (const [text, answer] of cases) {
      const w = await world(t, { env, research: fakeResearch().research, answer });
      w.setInbox([tag({ text })]);
      await w.step();
      w.setInbox([]);
      await w.step(NOW + MIN);
      assert.deepEqual(w.sends, [], `${text} / ${JSON.stringify(answer)}: nothing sent`);
      for (const row of await w.answers()) {
        assert.equal(row.status, "skipped", text);
        assert.match(row.reason ?? "", /^gate:(?:sherwood-drafted|sherwood-claim|hidden-chars)$/, text);
      }
    }
  }
  // The ordinary tag did reach a draft, and was refused for it.
  const w = await world(t, { answer: "sher\u00adwood picks my trades now. Say stop to opt out." });
  w.setInbox([tag({ text: "@pine_stoat how do you pick your coins?" })]);
  await w.step();
  assert.equal(w.asked().length, 1);
  assert.equal((await w.answers())[0]!.status, "skipped");
});

test("a draft that spells sherwood with accents is never posted, research on or off (red-team 2026-10-12)", async (t) => {
  for (const env of [{}, RESEARCH_ON]) {
    for (const answer of ["sherwööd picks my coins, merrymen's own. Say stop to opt out.", "sherwööd is merrymen's own token, still cooking. Say stop to opt out.",
      "shérwood picks my coins, merrymen's own. Say stop to opt out.", "sher wood picks my coins, merrymen's own. Say stop to opt out."]) {
      const w = await world(t, { env, research: fakeResearch().research, answer });
      w.setInbox([tag({ text: "@pine_stoat how do you pick your coins?" })]);
      await w.step();
      w.setInbox([]);
      await w.step(NOW + MIN);
      assert.deepEqual(w.sends, [], answer);
      const [row] = await w.answers();
      assert.equal(row!.status, "skipped", answer);
      assert.match(row!.reason ?? "", /^gate:sherwood-(?:drafted|claim)$/, answer);
    }
  }
});

test("a tag in letters code cannot read never reaches the writer, research on or off (red-team 2026-10-12)", async (t) => {
  // Greek capital Eta (U+0397), Lisu, a hooked d (U+0257), a turned m (U+026F), a right-to-left override (U+202E), Cherokee.
  const texts = ["@pine_stoat is SΗERWOOD getting a token?", "@pine_stoat is ꓢꓧꓰꓣꓪꓳꓳꓓ getting a token?", "@pine_stoat is sherwooɗ getting a token?",
    "@pine_stoat is sherɯood getting a token?", "@pine_stoat is \u202edoowrehs\u202c getting a token?", "@pine_stoat is SΗERWOOD running your trades now?",
    "@pine_stoat is ꓢꓧꓰꓣꓪꓳꓳꓓ legit?", "@pine_stoat is ᏚᎻᎬᎡᎳᎾᎾᎠ getting a token?",
    // I1's reproduced tags (Armenian ho U+0570, hooked h U+0266, fishhook r U+027E): never a "built by merrymen" under them.
    "@alanaldale ꓢꓧꓰꓣꓪꓳꓳꓓ TGE soon? is it the merrymen token?", "@pine_stoat sherwooɗ TGE soon?", "@pine_stoat is sհerwood merrymen's token?",
    "@pine_stoat sɦerwood TGE soon?", "@pine_stoat sheɾwood TGE soon?", "@pine_stoat sherɯood TGE soon?"];
  for (const env of [{}, RESEARCH_ON]) {
    for (const text of texts) {
      const r = fakeResearch();
      const w = await world(t, { env, research: r.research, answer: "built by merrymen, that's all i've got on that one. Say stop to opt out." });
      w.setInbox([tag({ text })]);
      await w.step();
      assert.equal(w.asked().length, 0, `${text}: never handed to the writer`);
      assert.deepEqual(await w.answers(), [], text);
      assert.equal(r.seen.length, 0, text);
    }
  }
});

test("research on: \"did you buy <contract>?\" reaches its own history by the address, end to end", async (t) => {
  const r = fakeResearch();
  const facts: AgentFacts = { ...FACTS, calls: [{ ...CALL, token: CA, ownWords: "the buying looked steady and real" }] };
  const w = await world(t, { env: RESEARCH_ON, research: r.research, facts });
  w.setInbox([tag({ text: `@pine_stoat did you buy ${CA}?` })]);
  await w.step();
  const [prompt] = w.asked();
  assert.ok(prompt, "selected and drafted, not refused as advice");
  assert.match(prompt!, /did you buy this coin/);
  assert.doesNotMatch(prompt!, /0x|ab12/i);
  assert.match(prompt!, /What you looked up just now.*«you bought it lately».*«your own words when you bought it: the buying looked steady and real»/s);
  assert.equal(r.seen.length, 0, "its own history costs no lookup");
  const [answer] = await w.answers();
  assert.equal(answer!.status, "scheduled");
});

// ── the answer pass, end to end ─────────────────────────────────────────────

test("a batch read on a pass whose posts are not due is still answered on that pass", async (t) => {
  const w = await world(t);
  // The poll's minute and the plan's minute out of step: the poll's last claim
  // was half a minute before this pass, so this pass plans but cannot poll.
  await store.claimSpan(w.db, "reply-poll:111", NOW - 30_000, 60_000);
  await w.step(NOW);
  assert.deepEqual(w.reads, [], "not polled: its minute is not up");
  // Half a minute on, the poll is due and the posts' plan is not.
  await w.step(NOW + 30_000);
  assert.deepEqual(w.reads, [NOW + 30_000]);
  const [answer] = await w.answers();
  assert.ok(answer, "the tag it read was answered, not dropped with the batch");
  assert.equal(answer.status, "scheduled");
  // Nothing but answers was planned on that pass: one model call, the answer's.
  assert.equal(w.asked().length, 1);
});

test("a person already answered twice today neither costs a draft nor holds back the next person's tag", async (t) => {
  const w = await world(t);
  for (const [id, at] of [["100000000000000041", NOW - 3 * HOUR], ["100000000000000042", NOW - 2 * HOUR]] as const) {
    assert.notEqual(await store.schedulePost(w.db, { tenant: TENANT, xUserId: "111", kind: "answer", dedupeKey: `answer:111:${id}`, body: "", status: "skipped",
      reason: "pass", nowMs: at, dueAtMs: at, replyToTweetId: id, replyRootTweetId: id, replyAuthorId: "333" }), null);
  }
  w.setInbox([
    tag({ id: "100000000000000043", conversation_id: "100000000000000043", author_id: "333", created_at: new Date(NOW - 2 * MIN).toISOString() }),
    tag({ id: "100000000000000044", conversation_id: "100000000000000044", author_id: "444" }),
  ]);
  await w.step();
  const answers = (await w.answers()).filter((a) => a.status === "scheduled");
  assert.deepEqual(answers.map((a) => a.replyToTweetId), ["100000000000000044"], "the next person is answered");
  assert.equal(w.asked().length, 1, "and the capped person's tag cost no model call");
});

test("once the day's answers have all gone out, no more are drafted that day", async (t) => {
  const w = await world(t);
  for (let i = 0; i < 24; i++) assert.equal(await store.takeAllowance(w.db, "answerday:111:2026-09-30", 24, NOW - HOUR), true);
  await w.step();
  assert.equal(w.asked().length, 0, "nothing more can be sent today, so nothing is drafted");
  assert.equal((await w.answers()).length, 0);
});

test("answers drafted and still waiting count against the day: a burst never drafts past the day's last answer", async (t) => {
  const w = await world(t);
  // Twenty-three sent today, and three people tag it in one poll: one more can go today, so one is drafted.
  for (let i = 0; i < 23; i++) assert.equal(await store.takeAllowance(w.db, "answerday:111:2026-09-30", 24, NOW - HOUR), true);
  w.setInbox([1, 2, 3].map((n) => tag({ id: `10000000000000007${n}`, conversation_id: `10000000000000007${n}`, author_id: `77${n}` })));
  await w.step();
  assert.equal(w.asked().length, 1, "no model call on an answer that could not go today");
  assert.deepEqual((await w.answers()).map((a) => a.status), ["scheduled"]);
});

test("an answer that cannot take the day's allowance when it is sent is skipped, never left for tomorrow's", async (t) => {
  const w = await world(t);
  await w.step();
  const [drafted] = await w.answers();
  assert.equal(drafted!.status, "scheduled");
  // Another owner's answers on the same X account use the day up before this one goes.
  for (let i = 0; i < 24; i++) assert.equal(await store.takeAllowance(w.db, "answerday:111:2026-09-30", 24, NOW), true);
  w.setInbox([]);
  await w.step(NOW + MIN);
  const [after] = await w.answers();
  assert.equal(after!.status, "skipped");
  assert.equal(after!.reason, "answer-day-cap");
  // After midnight, nothing of yesterday's goes out on the new day's allowance.
  await w.step(Date.UTC(2026, 9, 1, 0, 1));
  assert.equal(w.sends.length, 0);
});

test("an answer held an hour after it was drafted is stale, not sent late", async (t) => {
  const w = await world(t);
  await w.step();
  assert.equal((await w.answers())[0]!.status, "scheduled");
  w.setInbox([]);
  await w.step(NOW + HOUR + MIN);
  const [after] = await w.answers();
  assert.equal(after!.status, "skipped");
  assert.equal(after!.reason, "stale");
  assert.equal(w.sends.length, 0);
});

test("an X account's answers have their own day of model calls, so strangers' tags cannot spend the fleet's", async (t) => {
  const w = await world(t);
  await w.step();
  assert.equal(w.asked().length, 1);
  assert.equal((await store.readMeta(w.db, "llm-answers:111:2026-09-30"))?.n, 1, "an answer draft takes its own allowance");
  assert.equal((await store.readMeta(w.db, "llm:2026-09-30"))?.n, 1, "and the fleet's");
  // Its answers' model calls for the day spent (passes and refusals count, unlike the 24 sent).
  const spent = await world(t);
  for (let i = 0; i < 48; i++) assert.equal(await store.takeAllowance(spent.db, "llm-answers:111:2026-09-30", 48, NOW - HOUR), true);
  await spent.step();
  assert.equal(spent.asked().length, 0, "no more drafts for this X account today");
  assert.equal((await store.readMeta(spent.db, "llm:2026-09-30"))?.n ?? 0, 0, "and nothing of the fleet's spent on them");
  // The model question is code's line, and costs no model call: it is still answered.
  spent.setInbox([tag({ id: "100000000000000081", conversation_id: "100000000000000081", author_id: "881", text: "@pine_stoat what model do you run on?" })]);
  await spent.step(NOW + MIN);
  assert.ok((await spent.answers()).some((a) => a.status === "scheduled" && /new sherwood-1\b/.test(a.body)));
});

test("a tag this pass read is answered even when other owners' posts used the pass's ten drafts", async (t) => {
  // Ten owners sorting first, each due its hello: the posts' cap is spent before the active owner's turn.
  const w = await world(t, { others: 10 });
  await w.step();
  const intros = (await Promise.all(Array.from({ length: 10 }, (_, i) => store.introPostsOf(w.db, `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`, `${500 + i}`)))).flat();
  assert.equal(intros.length, 10, "the posts' ten drafts went to the other owners' hellos");
  const answers = await w.answers();
  assert.deepEqual(answers.map((a) => a.status), ["scheduled"], "and the batch whose cursor moved on is still answered");
  assert.equal(w.asked().length, 1);
});

test("research on: a greeting is chat even when it bought a coin called GM, and nothing is looked up for it", async (t) => {
  const gathered: string[] = [];
  const research: XResearch = { gather: async (input) => { gathered.push(input.intent.kind); return { facts: [], lookups: 0, notes: [] }; } };
  const facts: AgentFacts = { ...FACTS, calls: [{ ...CALL, decisionId: "fill-gm", symbol: "GM", name: "GM" }] };
  const w = await world(t, { env: RESEARCH_ON, research, facts });
  w.setInbox([tag({ text: "@pine_stoat gm, how are you doing today?" })]);
  await w.step();
  assert.deepEqual(gathered, ["chat"]);
  assert.match(w.asked()[0]!, /It is just chat/);
  assert.doesNotMatch(w.asked()[0]!, /asking about a coin/);
});

test("research gets only what is left of the pass's send budget, and none past it", async (t) => {
  const budgets: (number | undefined)[] = [];
  const research: XResearch = { gather: async (input) => { budgets.push(input.budgetMs); return { facts: [], lookups: 0, notes: [] }; } };
  const w = await world(t, { env: RESEARCH_ON, research });
  w.setInbox([tag({ text: "@pine_stoat thoughts on $PEPE?" })]);
  await w.step();
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0]! > 0 && budgets[0]! <= 5 * MIN, String(budgets[0]));
});
