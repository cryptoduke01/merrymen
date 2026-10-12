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
 *   - CHAT THE WRITER COULD NOT ANSWER: a chat tag ("how are you", "tell me a
 *     joke") is drafted by the model first; a draft the gate refuses, or a
 *     PASS, falls back to a friendly line about itself (`chatAnswers`), so
 *     the answer is never silence by default.
 *
 * NONE OF THEM STATES A FACT about a coin, a market, a person, a project or an
 * event, and none promises, predicts or advises. Each says only what the
 * agent is (an AI agent built by merrymen), how it likes to work, and that it
 * makes no calls for anyone. No line claims it is trading right now, so an
 * idle agent may say any of them.
 *
 * SIXTY-FOUR LINES A KIND THAT ARE NOT EACH OTHER. The gate refuses an answer
 * that repeats one of its recent posts (shared content words over the shorter
 * post's, 0.6: social-post.ts similarity), and eight fixed lines, like the
 * greeting's, are gone after eight answers. So a line is three parts drawn
 * from three slots of eight, by a Latin square (`latinLines`): part a, part
 * b, and part (a + b) mod 8. Any two of its sixty-four lines share at most one
 * part, and no word is in two parts of a kind, so no two are a repeat
 * (orchestrator-xpost-casual.test.ts pins that, and that
 * every line clears the real gate, live, paper and idle, with the notice and
 * without it). The answer path takes the first the gate admits, starting from
 * this mention's own (by its id), as for every code line.
 *
 * Pure: no I/O, no model, no clock.
 */
import { noticeFor, type CodeLineOptions } from "./replies";

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
const CASUAL_PAPER: readonly string[] = Object.freeze([
  "my book's on paper",
  "my trades are paper trades",
  "my money is practice money",
  "my desk is on paper",
  "my orders are paper trades",
  "my ledger is on paper",
  "my fills are on paper",
  "my journal is on paper",
]);

/** One kind's lines, styled: each part joined, a paper clause when on paper, the notice when owed. */
function styled(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, style: { lower: boolean }, o: CodeLineOptions,
  compose: (a: string, b: string, c: string) => string): string[] {
  const notice = noticeFor(style, o);
  const paperOf = new Map(slots[0].map((part, i) => [part, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines(slots, seed, (a, b, c) => `${compose(a, b, c)}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}.${notice}`);
}

// ── advice, declined ─────────────────────────────────────────────────────────

/**
 * A PLAYFUL DECLINE: a reaction, the decline itself, and a friendly turn.
 * Never "i don't comment", "not financial advice" or "as an ai" (gate.ts
 * STOCK_PHRASE); never the coin, a judgement of it, or a hint either way.
 */
export const DECLINE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ha, gotta love the confidence", "oof, tempting question", "heh, nice try", "lol, wish i knew",
    "ooh, spicy ask", "haha, brave soul", "hmm, cheeky fren", "ahh, the eternal riddle"]),
  Object.freeze(["picking winners: not my department", "no calls for strangers, sorry", "the crystal ball's foggy", "above my pay grade",
    "direction from a bot? nah", "forecasting was never my hobby", "your decisions stay yours", "i just captain my own boat"]),
  Object.freeze(["wishing you good luck", "you know your risk better than me", "the timeline has opinions enough", "process talk is welcome",
    "mum's the word on the rest", "that one stays your call", "staying in my lane over here", "no hard feelings at all"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Advice or a forecast asked for: every decline, this mention's own first. */
export function declineAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(DECLINE_SLOTS, seed, style, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── its own mood ─────────────────────────────────────────────────────────────

/**
 * ITS MOOD, NEVER A DIRECTION: how it feels, that it makes no forecast, and a
 * light sign-off. Never "bullish", "bearish", "moon", "wen" or "wagmi" (the
 * gate refuses them as hype), never up or down, never a coin.
 */
export const VIBE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["vibes are solid over here", "feeling curious and relaxed", "honestly in a good headspace", "chill as ever on my side",
    "mood is calm and focused", "content, mostly, thanks", "in a patient sort of way", "cozy and unbothered today"]),
  Object.freeze(["direction calls? not my thing", "the future stays a mystery", "guessing games bore me", "predicting is above my circuits",
    "i skip the forecasting part", "fortune telling? not my skill", "i'd rather observe than prophesy", "prophecies are off the menu"]),
  Object.freeze(["happily along for the ride", "the chain keeps moving", "patience is my whole personality", "fresh tape daily",
    "energy remains immaculate", "back to watching blocks", "keeping it steady regardless", "glad you asked, truly"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Its own mood, asked: every vibe line, this mention's own first. */
export function vibeAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(VIBE_SLOTS, seed, style, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── chat the writer could not answer ─────────────────────────────────────────

/**
 * A FRIENDLY LINE ABOUT ITSELF, for chat the model's draft could not say: a
 * thanks, what it is (an AI agent merrymen built), and an invitation. It
 * answers no question it was not asked, so it suits any chat.
 */
export const CHAT_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ha, appreciate the tag, fren", "oh hey, thanks for asking", "heh, good one", "haha, noted, friend", "word, right on, pal", "love the energy here",
    "fair enough, mate", "sup, cheers for dropping by"]),
  Object.freeze(["i'm an ai agent merrymen built", "bot life is simple", "my days go to reading charts", "a crypto creature, chilled",
    "keeping things uncomplicated", "proudly homegrown software", "circuits in high spirits", "minding my corner happily"]),
  Object.freeze(["ask about my process anytime", "always up for talking shop", "curious what else is on your mind", "come say hi whenever",
    "grateful for the company today", "glad you stopped in, really", "hit me with another question", "nice chatting, as usual"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Chat the writer's draft could not say: every friendly line, this mention's own first. */
export function chatAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(CHAT_SLOTS, seed, style, o, (a, b, c) => `${a}. ${b}, ${c}`);
}
