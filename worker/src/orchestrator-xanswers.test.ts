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
  const env = { ...(o.active === false ? {} : { MERRYMEN_XPOST_ACTIVE_TENANTS: TENANT }), ...o.env };
  const systems: string[] = [];
  const poster = makeXPoster({
    app: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/connect/x" }, dek,
    creds: { provider: "groq", transport: "openai", model: "test", apiKey: "private-model", baseUrl: "https://model.test/v1", vision: false },
    knobs: o.scope === undefined
      ? { ...xpostEnv(env), repliesApproved: true, replyPollsPerDay: o.polls }
      : { ...xpostEnv(o.scope === null ? env : { ...env, MERRYMEN_XPOST_REPLIES_APPROVED: o.scope }), replyPollsPerDay: o.polls },
    deps: { dialect: "sqlite", fetch, monotonic: () => 0, member: async () => ({ tz: o.tz ?? null }),
      facts: async () => new Map([[TENANT, o.facts ?? FACTS]]),
      // Only the answer prompt gets words back: every other draft passes.
      llm: async (_creds, input) => {
        prompts.push(input.prompt);
        if (/Untrusted question/.test(input.prompt)) systems.push(input.system ?? "");
        return /Untrusted question/.test(input.prompt) ? o.answer ?? ANSWER : "PASS";
      },
      ...(o.research ? { research: o.research } : {}),
    },
  });
  const step = (now = NOW) => { clock = now; return poster.step(db, [{ tenant: TENANT, agentId: TENANT }], new Map(), now); };
  const answers = async () => (await store.postsOf(db, TENANT, 0)).filter((p) => p.kind === "answer");
  const asked = () => prompts.filter((p) => /Untrusted question/.test(p));
  return { db, step, answers, asked, systems, sends, reads, setInbox: (v: Record<string, unknown>[]) => { inbox = v; } };
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
  assert.match(answer!.body, /the new sherwood one/);
  assert.match(answer!.body, /cooking|oven/);
  assert.match(answer!.body, /Say stop to opt out\.$/i);
  assert.doesNotMatch(answer!.body, /\p{N}|running on|powered|runs me/u);
  assert.equal((await store.readMeta(w.db, "llm:2026-09-30"))?.n ?? 0, 0, "and no model allowance spent");
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
