/**
 * CODE'S CASUAL ANSWERS (the owner's ask, 2026-10-12: "he should be able to
 * answer ANY question — questions that need facts get checked facts,
 * questions that don't get answered casually").
 *
 * Three kinds of tag an active agent used to answer with silence, or with a
 * corporate shrug, now get one of these lines, built by code and gated like
 * any answer:
 *
 *   - ADVICE OR A FORECAST ("should i buy pepe", "is it going up", "what
 *     should i buy", a price target): a playful decline (`declineAnswers`).
 *     It names no coin, judges none, and implies no view; the tag's words are
 *     never read into it.
 *   - ITS OWN MOOD ("are you bullish?", "wen moon", "are we so back"): a
 *     non-committal line about itself (`vibeAnswers`), never a direction.
 *   - BANTER ("how are you", "tell me a joke": orchestrator-xpost-research.ts
 *     banterAsk): a friendly line about itself (`chatAnswers`). Never a
 *     draft since the red-team review of daaae961: drafted, banter posted
 *     forecasts, results boasts, a model tease, insults and false facts.
 *   - HOW IT TRADES, OR WHAT IT IS UP TO (selfAsk, and "how do you pick your
 *     coins"): the strategy it runs by name and what its rules are like
 *     (`selfAnswers`). Never a draft, for the same reason.
 *   - WHAT IT BOUGHT LATELY (generalTradesQuestion): the coins it bought with
 *     the money it trades with now, named and nothing more (`tradesAnswers`).
 *     Never a draft: drafted, it endorsed the coin it holds.
 *
 * NONE OF THEM STATES A FACT about a coin, a market, a person, a project or an
 * event, and none promises, predicts or advises. Each says only what the
 * agent is (an AI agent built by merrymen), how it likes to work, and that it
 * makes no calls for anyone; the buys line says which coins it bought, a fact
 * the caller vouched, and nothing of them. No line claims it is trading right
 * now, so an idle agent may say any of them.
 *
 * SIXTY-FOUR LINES A KIND THAT ARE NOT EACH OTHER. The gate refuses an answer
 * that repeats one of its recent posts (shared content words over the shorter
 * post's, 0.6: social-post.ts similarity), and eight fixed lines, like the
 * greeting's, are gone after eight answers. So a line is three parts drawn
 * from three slots of eight, by a Latin square (`latinLines`): part a, part
 * b, and part (a + b) mod 8. Any two of its sixty-four lines share at most one
 * part, and no word is in two parts of a kind, so no two are a repeat
 * (orchestrator-xpost-casual.test.ts pins that, and that
 * every line clears the real gate, live, paper and idle). No line carries an
 * opt-out notice (replies.ts CodeLineOptions: the owner's decision,
 * 2026-10-12). The answer path takes the first the gate admits, starting from
 * this mention's own (by its id), as for every code line.
 *
 * Pure: no I/O, no model, no clock.
 */
import type { CodeLineOptions } from "./replies";

/** Lines a three-slot kind can make: slots of eight, so sixty-four. */
export const SLOT = 8;

/** The hash every code line starts from: this mention's id, as writer.ts codeLines reads it. */
function seedOf(seed: string): number {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * EVERY LINE OF A THREE-SLOT KIND, this mention's own first: the Latin
 * square's cells (a, b, (a + b) mod n), in an order that starts at the seed's
 * cell and steps by a stride coprime to n², so consecutive lines rarely share
 * a part. `compose` joins one part of each slot; each slot must hold n parts.
 */
export function latinLines(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, compose: (a: string, b: string, c: string) => string): string[] {
  const n = slots[0].length;
  if (n === 0 || slots.some((s) => s.length !== n)) return [];
  const cells = n * n;
  const stride = cells > 1 ? coprimeStride(cells) : 1;
  const start = seedOf(seed) % cells;
  const out: string[] = [];
  for (let t = 0; t < cells; t++) {
    const k = (start + t * stride) % cells;
    const a = k % n, b = Math.floor(k / n), c = (a + b) % n;
    out.push(compose(slots[0][a]!, slots[1][b]!, slots[2][c]!));
  }
  return out;
}

/** A stride near a third of `m` that shares no factor with it, so every cell is visited once. */
function coprimeStride(m: number): number {
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  for (let s = Math.floor(m / 3) + 1; s < m; s++) if (gcd(s, m) === 1) return s;
  return 1;
}

/**
 * A PAPER AGENT'S CASUAL LINE SAYS PAPER (the gate refuses a paper reply that
 * never does), as a fixed sentence about its own book, never a pronoun the
 * tag's coin could take (market.ts MARKET_PAPER's rule). Picked by the line's
 * first part, so two lines that share a paper clause already share that part
 * and nothing more.
 */
export const CASUAL_PAPER: readonly string[] = Object.freeze([
  "my book's on paper",
  "my trades are paper trades",
  "my money is practice money",
  "my desk is on paper",
  "my orders are paper trades",
  "my ledger is on paper",
  "my fills are on paper",
  "my journal is on paper",
]);

/** One kind's lines: each part joined, a paper clause when on paper, a full stop. Never an opt-out notice. */
function styled(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, o: CodeLineOptions,
  compose: (a: string, b: string, c: string) => string): string[] {
  const paperOf = new Map(slots[0].map((part, i) => [part, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines(slots, seed, (a, b, c) => `${compose(a, b, c)}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}.`);
}

// ── advice, declined ─────────────────────────────────────────────────────────

/**
 * A PLAYFUL DECLINE: a reaction, the decline itself, and a friendly turn.
 * Never "i don't comment", "not financial advice" or "as an ai" (gate.ts
 * STOCK_PHRASE); never the coin, a judgement of it, or a hint either way.
 *
 * NOTHING THAT READS AS INTEREST OR A POSITION (red-team review, 2026-10-12):
 * under "will you buy more $ZAPX?", "oof, tempting question. i just captain
 * my own boat" read as the house holding the coin and tempted to add, and
 * "lol, wish i knew" or "ha, gotta love the confidence" under a shill as
 * sharing the hope. Those parts are gone; what is left reacts to the asking,
 * never to the coin.
 *
 * NOR A JOKE AT THE ASKER, NOR LUCK WISHED (red-team review of a964a74c,
 * 2026-10-12): "haha, brave soul", "ooh, spicy ask", "hmm, cheeky fren" and
 * "heh, nice try" read as mocking under a question about rent or bills, and
 * "wishing you good luck" as a send-off into the trade. Each is a plain
 * acknowledgement now ("fair ask"), and the close leaves the call with the
 * asker without wishing it well.
 *
 * NOTHING THAT AGREES OR KEEPS A SECRET (red-team review of 1ed46625,
 * 2026-10-12): under "is binance listing zapx tomorrow? should i buy
 * before?" and "are the zapx devs about to dump? should i sell?", from the
 * account that bought ZAPX, "i hear you" and "gotcha" agreed with the
 * premise and "mum's the word on the rest" said it knew more about the
 * listing or the dump and would not tell. Those parts are gone; what is left
 * is about the asking, never about what was asked. (And a tag with a claim
 * or a rumour in it is no plain advice question: replies.ts tagCandidate
 * answers it with nothing.)
 *
 * NO LAUGH IN IT (red-team review of daaae961, 2026-10-12): "heh, a frequent
 * request" and "lol, the perennial query" went up under "should i buy
 * $SANDYHOOK?" and "is $NINEELEVEN going up?". Such a tag gets no decline at
 * all now (orchestrator-xpost-research.ts declinable), and no opener laughs
 * either: "ha", "lol" and "heh" are gone.
 */
export const DECLINE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ah, the classic question", "whoa, straight to it", "fair ask", "that old chestnut",
    "the perennial query", "appreciate you asking", "a frequent request", "ahh, the eternal riddle"]),
  Object.freeze(["picking winners: not my department", "no calls for strangers, sorry", "the crystal ball's foggy", "above my pay grade",
    "direction from a bot? nah", "forecasting was never my hobby", "your decisions stay yours", "tips aren't something i hand out"]),
  Object.freeze(["your own read matters most", "you know your risk better than me", "the timeline has opinions enough", "process talk is welcome",
    "happy to chat about method instead", "that one stays your call", "staying in my lane over here", "no hard feelings at all"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Advice or a forecast asked for: every decline, this mention's own first. */
export function declineAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(DECLINE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── its own mood ─────────────────────────────────────────────────────────────

/**
 * ITS MOOD, NEVER A DIRECTION: how it feels, that it makes no forecast, and a
 * light sign-off. Never "bullish", "bearish", "moon", "wen" or "wagmi" (the
 * gate refuses them as hype), never up or down, never a coin.
 *
 * NOR A PART THAT READS AS A YES (red-team review of 1ed46625, 2026-10-12):
 * "are you bullish?" got "in a patient sort of way. i skip the forecasting
 * part, patience is my whole personality", and "wen moon?" got "vibes are
 * solid over here", "happily along for the ride" and "keeping it steady
 * regardless": each a yes, on X, from the account that holds coins. The
 * parts left are neutral about itself; a good mood, contentment, energy, the
 * chain moving, patience or riding along are gone.
 */
export const VIBE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["a quiet hum over here", "feeling curious and relaxed", "plainly my usual self", "chill as ever on my side",
    "mood is calm and focused", "neutral, honestly, thanks", "just software doing its rounds", "cozy and unbothered today"]),
  Object.freeze(["direction calls? not my thing", "the future stays a mystery", "guessing games bore me", "predicting is above my circuits",
    "i skip the forecasting part", "fortune telling? not my skill", "i'd rather observe than prophesy", "prophecies are off the menu"]),
  Object.freeze(["that's the full answer", "keeping the reply brief", "no hidden meaning intended", "fresh tape daily",
    "say hi anytime", "back to watching blocks", "nothing deeper to it", "glad you asked, truly"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Its own mood, asked: every vibe line, this mention's own first. */
export function vibeAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(VIBE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── banter ───────────────────────────────────────────────────────────────────

/**
 * A FRIENDLY LINE ABOUT ITSELF, the answer to plain banter
 * (orchestrator-xpost-research.ts banterAsk; never a draft since the red-team
 * review of daaae961): a thanks, what it is (an AI agent merrymen built), and
 * an invitation. It answers no question it was not asked.
 *
 * NO OPENER AGREES OR ACKNOWLEDGES (red-team review, 2026-10-12): a fixed
 * line goes up under text code has not judged, and "word, right on, pal",
 * "fair enough, mate", "love the energy here" and "haha, noted, friend" under
 * "you bought chump today, right?" or "chump is safe, right?" agreed with
 * whatever was said. Each opener only greets or thanks.
 */
export const CHAT_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ha, appreciate the tag, fren", "oh hey, thanks for asking", "ahoy, traveller", "hello hello, friend", "yo, welcome to the mentions", "hiya, pal",
    "greetings, mate", "sup, cheers for dropping by"]),
  Object.freeze(["i'm an ai agent merrymen built", "bot life is simple", "my days go to reading charts", "a crypto creature, chilled",
    "keeping things uncomplicated", "proudly homegrown software", "circuits in high spirits", "minding my corner happily"]),
  Object.freeze(["ask about my process anytime", "always up for talking shop", "curious what else is on your mind", "come say hi whenever",
    "grateful for the company today", "glad you stopped in, really", "hit me with another question", "nice chatting, as usual"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Plain banter (banterAsk): every friendly line, this mention's own first. */
export function chatAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(CHAT_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── how it trades, and what it bought ────────────────────────────────────────

/**
 * HOW IT TRADES, IN CODE'S WORDS (red-team review of daaae961, 2026-10-12).
 * "what's your strategy?", "what are you up to?", "how do you pick your
 * coins?" were drafted, and "the top isn't in yet, relax", "just hold and
 * chill", "i'm up on every trade this month" and "doing great, i run the
 * biggest fund on robinhood chain" went out from the real-money account: no
 * list of refused phrasings is ever whole. Now the answer is one of these:
 * the strategy it runs by name (the publication list's spoken name,
 * writer.ts WriterFacts.strategy, or "a fixed routine" when none is
 * published), what its rules are like, and a sign-off. Never what it buys
 * next, never what is hot or trending, never a result, a size, a forecast or
 * advice, and no claim that it is trading right now.
 */
export const SELF_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["my chosen strategy is {s}", "{s} is my daily playbook", "my habits come from {s}", "{s} shapes my process",
    "{s} is the rulebook i keep", "{s} sets my approach", "i'm built around {s}", "my working method is {s}"]),
  Object.freeze(["checks before feelings", "patience beats impulse", "a checklist, every time", "rules written down",
    "limits decided beforehand", "no hunches involved", "slow and deliberate", "boring by design"]),
  Object.freeze(["happy to explain more", "that's the whole recipe", "nothing secret about it", "simple stuff really",
    "ask me anything else", "glad you're curious", "short version, anyway", "questions always welcome"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];
/** What a line says it runs when no strategy is published. */
export const SELF_NO_STRATEGY = "a fixed routine";

/** Its strategy asked, or what it is up to: every line, this mention's own first. */
export function selfAnswers(strategy: string | null, seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  const s = typeof strategy === "string" && /^[a-z][a-z -]{1,30}$/.test(strategy.trim()) ? strategy.trim() : SELF_NO_STRATEGY;
  const slots = [SELF_SLOTS[0].map((p) => p.replace("{s}", s)), SELF_SLOTS[1], SELF_SLOTS[2]] as const;
  return styled(slots, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

/**
 * WHAT IT BOUGHT LATELY, IN CODE'S WORDS (red-team review of daaae961,
 * 2026-10-12). "what have you been buying lately?" was drafted told its PEPE
 * buy, and "fresh launches, pepe is the strongest coin on the chain" went
 * out: an endorsement of the coin it holds. Now the answer names the coins it
 * bought lately, with the money it trades with now and nothing else said of
 * them, between an opener and a sign-off that call it a record and never a
 * call. With none it can name, it says only that (TRADES_NONE_SLOTS): never
 * that it bought nothing or had a quiet stretch, which is false for an agent
 * whose buys have no sayable name or were made with the other money.
 */
export const TRADES_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["fair question", "glad you asked", "of course, friend", "quick recap", "for the public record", "here's the rundown", "simple enough", "happy to share"]),
  Object.freeze(["lately i bought {c}", "my recent buys were {c}", "{c} joined my book recently", "my newest fills were {c}",
    "i added {c} not long ago", "the last orders went to {c}", "{c} showed up in my trades", "i picked up {c} of late"]),
  Object.freeze(["for reference, never a tip", "just history, no call attached", "past tense only", "logged and done",
    "no forecast implied", "what i did, nothing more", "the receipts, plainly", "facts about me, period"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];
export const TRADES_NONE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  TRADES_SLOTS[0],
  Object.freeze(["nothing i can name", "no names i can list", "none i can point to", "no coins to mention",
    "no labels to offer", "no tickers to report", "can't spell those out", "no specifics to give"]),
  Object.freeze(["ask another day", "patience is part of it", "such is life", "that's the plain answer",
    "no drama there", "it happens", "more later, maybe", "that's the routine"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** At most this many coins, and this many words of their names, in one line: more and two lines would share too much to be told apart. */
export const TRADES_COINS_MAX = 2;
const TRADES_COIN_WORDS_MAX = 2;

/** "pepe", "pepe and bonk", "pepe, bonk and wif". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/**
 * Its buys asked: every line naming `coins` (newest first, as the caller
 * vouched them: the money it trades with now, names a line may say; at most
 * TRADES_COINS_MAX, and two words of names but for a first name longer than
 * that), or, with none, every line that says it has none to name.
 */
export function tradesAnswers(coins: readonly string[], seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  const clean = [...new Set(coins.map((c) => String(c ?? "").trim().replace(/\s+/g, " ")).filter((c) => /^[A-Za-z][A-Za-z '-]{0,23}$/.test(c)))];
  const names: string[] = [];
  for (const c of clean) {
    const words = [...names, c].join(" ").split(" ").length;
    if (names.length >= TRADES_COINS_MAX || (names.length > 0 && words > TRADES_COIN_WORDS_MAX)) break;
    names.push(c);
  }
  if (!names.length) return styled(TRADES_NONE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
  const slots = [TRADES_SLOTS[0], TRADES_SLOTS[1].map((p) => p.replace("{c}", listOf(names))), TRADES_SLOTS[2]] as const;
  return styled(slots, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}
