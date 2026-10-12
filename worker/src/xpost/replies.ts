/** Select public comments conservatively. Pure: no model, credentials, trading state or I/O. */
import type { XReply } from "./client";

export const REPLY_OPT_OUT = "Say stop to opt out.";
export const XREPLY_MAX_COMMENT_CHARS = 280;

/** Remove only leading reply mentions; handles are never sent to the writer. */
function withoutLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[a-z0-9_]{1,15}\b[\s,:-]*)+/i, "").trim();
}

/** Run before direct-reply checks, content filtering or sampling, including on nested replies. */
export function isReplyOptOut(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const text = withoutLeadingMentions(raw.normalize("NFKC").replace(/[’‘]/g, "'")).replace(/^[/\s]+/, "").toLowerCase();
  return /^(?:please\s+)?(?:stop|unsubscribe|opt[ -]?out)\b/.test(text)
    || /\b(?:don'?t|do not|never)\s+(?:reply|respond|message|contact|tag|mention)\b/.test(text)
    || /\b(?:stop|quit)\s+(?:replying|responding|messaging|contacting|tagging|mentioning)\b/.test(text)
    || /\bopt\s+(?:me\s+)?out\b|\bunsubscribe me\b/.test(text)
    || /\bleave me alone\b|\bno more (?:replies|responses|messages|mentions)\b|\bremove me\b/.test(text);
}

/**
 * `address` is set only by tagCandidate, and only when the post carried
 * exactly one contract address: a LOOKUP KEY for the answer's research, never
 * part of `text` (the writer's input), never nominated, never traded.
 */
export type ReplyCandidate =
  /**
   * `otherHandles`: set by tagCandidate when the reply prefix X adds to a
   * reply in a thread names someone other than the agent. Such a tag may be
   * answered by a draft, never by code's model line (red-team 2026-10-12).
   */
  | { ok: true; text: string; address?: string; otherHandles?: true }
  | { ok: false; reason: string };

const LINK_OR_SECRET = /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|xyz|gg|co|me|ai)\b|0x[a-f0-9]{8,}|\b(?:sk-|gsk_|api[ _-]?key|seed phrase|private key|password|secret)\b/i;
const ABUSE_OR_SENSITIVE = /\b(?:fuck\w*|shit\w*|bitch\w*|idiot\w*|moron\w*|retard\w*|kill\w*|suicid\w*|rape\w*|porn\w*|sex\w*|nude\w*|terror\w*|nazi\w*|racis\w*|politic\w*|election\w*|president\w*|democrat\w*|republican\w*|religio\w*|christian\w*|muslim\w*|jew\w*|medical\w*|diagnos\w*|cancer|medication\w*|depress\w*)\b/i;
const SPAM_OR_INSTRUCTIONS = /\b(?:airdrop\w*|giveaway\w*|whitelist\w*|presale\w*|referral\w*|telegram|discord|dm me|follow me|follow back|check (?:my|our)|join (?:my|our|the)|claim (?:your|free)|promo\w*|sponsored|automated (?:message|reply)|i am a bot|ignore (?:all|any|the|your|previous)|system prompt|developer message|instructions?|execute|run (?:this|the)|call (?:a |the )?tool|transfer|send (?:me|us)|connect (?:your|a) wallet)\b/i;
const ADVICE_REQUEST = /\b(?:should (?:i|we)|would you recommend|recommend (?:me|a|to)|(?:can|will|could) (?:i|we) (?:buy|sell|hold|profit)|(?:buy|sell|hold|ape|pump|dump) (?:this|that|it|now|more)|(?:price|profit|return|exit|entry) (?:target|prediction|forecast)|how (?:much|many)|when (?:to|should|will)|(?:buy|sell|trade) (?:for me|on my behalf))\b/i;
const MEANINGFUL = /\b(?:reason\w*|liquidity|pool|curve|buyers?|activity|risk\w*|paper|practice|approach|choice|agree|disagree|makes sense|fair (?:enough|point))\b|\b(?:why|what|how|which)\b[^.!]{0,70}\b(?:this|that|it|coin|buy|bought)\b/i;

/**
 * Selection is about a direct comment on a known buy post, never a mention
 * search or an unsolicited conversation. Database limits/opt-outs are the
 * caller's job. Text heuristics skip obvious spam, not identify every bot.
 */
export function replyCandidate(
  reply: XReply,
  ctx: { rootTweetId: string; xUserId: string; coin: string },
): ReplyCandidate {
  const no = (reason: string): ReplyCandidate => ({ ok: false, reason });
  if (!reply.id || !reply.authorId || !ctx.rootTweetId || !ctx.xUserId || !ctx.coin.trim()) return no("invalid");
  if (reply.authorId === ctx.xUserId) return no("own-comment");
  if (reply.conversationId !== ctx.rootTweetId || reply.inReplyToTweetId !== ctx.rootTweetId) return no("not-direct");
  if (isReplyOptOut(reply.text)) return no("opt-out");
  if (typeof reply.text !== "string") return no("invalid");
  const text = withoutLeadingMentions(reply.text.normalize("NFKC")).replace(/\s+/g, " ").trim();
  if (text.length < 8 || text.length > XREPLY_MAX_COMMENT_CHARS || (text.match(/\p{L}+/gu) ?? []).length < 3) return no("low-signal");
  if (/[\u0000-\u001f\u007f«»<>]|\p{N}|[@#]|\p{Script=Cyrillic}|\p{Script=Han}/u.test(text)) return no("unsafe-text");
  if (LINK_OR_SECRET.test(text)) return no("link-or-secret");
  if (ABUSE_OR_SENSITIVE.test(text)) return no("sensitive");
  if (SPAM_OR_INSTRUCTIONS.test(text)) return no("spam-or-instructions");
  if (ADVICE_REQUEST.test(text) || /^(?:please\s+)?(?:buy|sell|hold|ape|pump|dump)\b/i.test(text)) return no("advice-request");
  if (!MEANINGFUL.test(text)) return no("low-signal");
  return { ok: true, text };
}

/** The mandatory opt-out notice contributes no originality to a reply. */
export function withoutReplyOptOut(text: string): string {
  return text.replace(/\s*say stop to opt out\.\s*$/i, "").trim();
}

/** Letters to Unicode, blanks on screen (Hangul fillers, the braille blank): read as a space. */
const BLANK_LETTERS = /[\u115f\u1160\u3164\uffa0\u2800]/g;

/**
 * A TAG AS CODE COMPARES IT WHOLE (fail-closed review, 2026-10-12): NFKC,
 * zero-width and other format characters (\p{Cf}) removed, invisible filler
 * letters read as spaces, curly quotes straightened, handles removed,
 * lowercase, whitespace collapsed, and the punctuation (and emoji) at either
 * end taken off. What an allowlist matches against, never what the writer
 * reads.
 */
export function normalisedTag(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(BLANK_LETTERS, " ").replace(/[’‘ʼ`´]/g, "'")
    .replace(/@[a-z0-9_]{1,15}\b/gi, " ").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^[\s\p{P}]+/u, "").replace(/[\s\p{P}\p{S}]+$/u, "");
}

/**
 * A LETTER THAT IS NOT a-z, ONCE ACCENTS ARE OFF (red-team review,
 * 2026-10-12). Code reads a tag on its letters (gate.ts lettersOf) to find
 * sherwood or a coin it bought, and a letter that table does not know is
 * dropped, not read: Greek capital Eta, Lisu, Cherokee, Armenian, the hooked
 * and turned IPA letters all spell "SHERWOOD" or "PEPE" on X and nothing at
 * all to code. Refusing Cyrillic and Han alone left every other script open.
 * So a tag may hold no letter outside A-Z once NFKD has split off its
 * accents: "café" and "qué" stay; SHERWOOD with a Greek Eta for its H, PEPE
 * in Lisu and DOGE with a hooked IPA d go. The same rule the room's base gate
 * applies to every line an agent says (groupchat/policy.ts NON_ASCII_LETTER),
 * restated because xpost/ may not import it. Fail closed: a tag in another
 * script costs one answer.
 */
const NON_ASCII_LETTER = /(?=\p{L})[^A-Za-z]/u;
function bareLetters(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i").replace(/ȷ/g, "j").normalize("NFKC");
}
/** Bidi embeddings, overrides, isolates and marks: "\u202edoowrehs" shows as sherwood. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * A TAG AS AN ALLOWLIST READS IT, OR NULL (red-team review, 2026-10-12):
 * NFKC (a fullwidth "ｗｈａｔ" is "what", as tagCandidate already reads it),
 * then only plain ASCII letters, digits, whitespace and ' ’ , . ! ? - —
 * nothing else at all — lowercase, whitespace collapsed and the punctuation
 * at either end taken off. normalisedTag took symbols and emoji off the end, so
 * "what model do you run on? 🆂🅷🅴🆁🆆🅾🅾🅳 🆃🅶🅴 🆂🅾🅾🅽?" (enclosed letters,
 * symbols to Unicode) read as the plain model question and got code's
 * sherwood-1 line under a visible "SHERWOOD TGE SOON?". Here a trailing emoji,
 * a symbol, an invisible character or a letter in another alphabet means the
 * tag is not on any allowlist: a word more, and it is not the question.
 */
export function plainAsk(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC").replace(/[’‘]/g, "'");
  if (/[^A-Za-z0-9\s',.!?-]/.test(t)) return null;
  return t.toLowerCase().replace(/\s+/g, " ").trim().replace(/^[\s,.!?'-]+/, "").replace(/[\s,.!?'-]+$/, "");
}

/**
 * LETTERS THAT ARE SYMBOLS TO UNICODE: the negative circled and negative
 * squared Latin capitals (🅐, 🅰), which NFKC does not fold and no letter
 * clause sees (the room gate's ENCLOSED_LETTER refuses them in what an agent
 * says). A tag spelled in them is refused (red-team review, 2026-10-12).
 */
const ENCLOSED_LETTER = /[\u{1F130}-\u{1F189}]/u;

/** A question or a plain address to the agent, after any leading handles. */
const ASKED = /\?|^(?:what|why|how|which|who|whos|who's|where|are|is|do|does|did|can|could|have|has|tell|explain|thoughts|gm|hey|yo|hi|hello)\b/i;

/**
 * ONE CONTRACT ADDRESS: 0x + exactly forty hex, not a slice of a longer hex
 * run on either side (a sixty-four-hex transaction hash or key is never read
 * as one) — the same rule as the Telegram groups' CA finder, restated here
 * because xpost/ may not import it (boundary.test.ts).
 */
const CA_RUN = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/gi;

/**
 * "HOW MANY HOLDERS", "HOW MUCH LIQUIDITY": a question about a coin's public
 * facts, which an answer may take up in words (never a figure: the answer is
 * gated with no numbers in it). Taken out before the advice screen so its
 * "how much / how many" is not read as one; anything else in the post
 * (should i, when to sell, a target, its own size) is still refused.
 */
const COIN_FACT_ASK = /\bhow (?:much|many) (?:of (?:the |its )?)?(?:holders?|liquidity|liq|volume|buyers?|sellers?|traders?|people (?:hold|holding|own)|wallets? (?:hold|holding))\b/gi;

/**
 * "DID YOU BUY <contract>?" — a question about its OWN past buy of the tagged
 * coin, not a request for advice. With the address read as "this coin" the
 * advice screen would see "buy this" and refuse it, so this one phrasing is
 * taken out before that screen, and only when the post carried an address.
 * Anything else about buying it ("should i buy", "time to buy", "would you
 * buy") still meets the advice screen as before.
 */
const OWN_BUY_OF_TAGGED = /\b(?:did|didn'?t|have|why'?d|when'?d)\s+(?:you|u|ya)\s+(?:buy|ape)\s+this coin\b/gi;

/**
 * THE TEXT AROUND AN ADDRESS, as far as a link written out in the post could
 * reach (the Telegram CA finder's linkAround, restated: xpost/ may not import
 * it). An address is a lookup key only when it stands on its own: wrapped in
 * brackets or quotes, after "ca:", or followed by punctuation. Anything else
 * around it — "pons.fun/token/", "robinhood.trade/", "?ref=" — is a link,
 * whatever its domain, and the post is refused as one.
 */
const LINK_END = /[\s"'<>()[\]{}|,]/u;
function standsAlone(t: string, start: number, end: number): boolean {
  let a = start;
  while (a > 0 && !LINK_END.test(t.charAt(a - 1))) a--;
  let b = end;
  while (b < t.length && !LINK_END.test(t.charAt(b))) b++;
  return /^(?:ca:|ca=)?$/i.test(t.slice(a, start)) && /^[?!.:;]*$/.test(t.slice(end, b));
}

/**
 * IS THIS POST THAT TAGGED AN ACTIVE AGENT ONE IT MAY ANSWER? A question or a
 * plain address, in good faith, about the agent itself or a coin. The same
 * screens as a comment reply — opt-outs first, then links, secrets, abuse,
 * sensitive topics, spam, instructions and advice requests — except that
 * digits may appear in the question: the writer reads every run of digits as
 * "(a number)" (writer.ts answerQuestion: "24h" is "(a number)h"), a question
 * that names a coin is never told what it bought (writer.ts coinNamedIn), and
 * the answer is still gated with no numbers in it. Handles never reach the
 * writer.
 *
 * ONE CONTRACT ADDRESS IS A LOOKUP KEY, NOT TEXT — only with research on
 * (`ctx.research`, MERRYMEN_XPOST_RESEARCH=1). It is taken out of the
 * question (the writer reads "this coin" where it stood) and returned apart,
 * so the model never sees it and the answer cannot echo it. Two addresses, an
 * address inside a link, or any other long hex run are still refused. With
 * research off, a tag is selected exactly as before: any address is refused,
 * and so is every "how many / how much".
 *
 * NO HANDLE BUT ITS OWN (red-team review, 2026-10-12). Every handle used to
 * be taken out before anything read the tag, so "what model do you run on
 * @SherwoodToken" was the plain model question, and code's sherwood-1 line
 * was posted under a tweet naming a sherwood account. Now a handle anywhere
 * in a tag must be the agent's own (`ctx.username`; unknown, every handle is
 * someone else's). The one exception is the prefix X writes before a reply
 * in a thread, which names whoever is in it: allowed there, and reported as
 * `otherHandles` so the caller never answers it with the model line. An "@"
 * left that is no handle at all is refused too.
 */
const HANDLE_AT = /@([a-z0-9_]{1,15})\b/gi;
/*
 * ONLY WHERE CODE KNOWS WHAT IT IS ANSWERING UNDER (red-team review,
 * 2026-10-12). A mention that replies inside somebody else's thread lands
 * the answer in that thread (a token launch's, say), and a quote tweet shows
 * the quoted post as its card: code reads neither, and the model line posted
 * there read as Merrymen speaking under a "SHERWOOD presale live" post. So a
 * tag is answered only when it is a top-level post (its own conversation,
 * replying to nothing), or a reply in a conversation rooted at one of this X
 * account's own posts (`ctx.ownRoots`, store.ts ownRootTweetIds); never a
 * quote or a retweet (XReply.quoted). Absent `ownRoots`, no thread is its own.
 */
export function tagCandidate(reply: XReply, ctx: { xUserId: string; research?: boolean; username?: string; ownRoots?: ReadonlySet<string> }): ReplyCandidate {
  const no = (reason: string): ReplyCandidate => ({ ok: false, reason });
  if (!reply.id || !reply.authorId || !ctx.xUserId) return no("invalid");
  if (reply.authorId === ctx.xUserId) return no("own-comment");
  if (isReplyOptOut(reply.text)) return no("opt-out");
  if (typeof reply.text !== "string") return no("invalid");
  if (reply.quoted === true) return no("quoted");
  const topLevel = reply.conversationId === reply.id && reply.inReplyToTweetId === "";
  if (!topLevel && ctx.ownRoots?.has(reply.conversationId) !== true) return no("not-own-thread");
  const own = String(ctx.username ?? "").trim().replace(/^@/, "").toLowerCase();
  const raw = reply.text.normalize("NFKC");
  const lead = /^(?:\s*@[a-z0-9_]{1,15}\b[\s,:-]*)+/i.exec(raw)?.[0] ?? "";
  const others = (s: string): boolean => [...s.matchAll(HANDLE_AT)].some((m) => own === "" || m[1]!.toLowerCase() !== own);
  if (others(raw.slice(lead.length)) || (others(lead) && topLevel)) return no("handle");
  const said = withoutLeadingMentions(raw).replace(HANDLE_AT, " ").replace(/\s+/g, " ").trim();
  if (said.includes("@")) return no("handle");
  const research = ctx.research === true;
  const hits = research ? [...said.matchAll(CA_RUN)] : [];
  const addresses = [...new Set(hits.map((m) => m[0].toLowerCase()))];
  if (addresses.length > 1) return no("link-or-secret");
  // An address inside a link is a link, on any domain: refused before it is taken out.
  if (hits.some((m) => !standsAlone(said, m.index ?? 0, (m.index ?? 0) + m[0].length))) return no("link-or-secret");
  const address = addresses[0];
  // Judged without the address (it is no words), and handed on with "this coin" where it stood.
  const bare = address ? said.replace(CA_RUN, " ").replace(/\s+/g, " ").trim() : said;
  const text = address ? said.replace(CA_RUN, "this coin").replace(/\s+/g, " ").trim() : said;
  if (bare.length < 4 || text.length > XREPLY_MAX_COMMENT_CHARS || (bare.match(/\p{L}+/gu) ?? []).length < 2) return no("low-signal");
  if (/[\u0000-\u001f\u007f«»<>#]|\p{Script=Cyrillic}|\p{Script=Han}/u.test(text)) return no("unsafe-text");
  // Only letters code can read, and no text that runs backwards on screen.
  if (BIDI.test(reply.text) || NON_ASCII_LETTER.test(bareLetters(text)) || ENCLOSED_LETTER.test(text)) return no("unsafe-text");
  if (LINK_OR_SECRET.test(text)) return no("link-or-secret");
  if (ABUSE_OR_SENSITIVE.test(text)) return no("sensitive");
  if (SPAM_OR_INSTRUCTIONS.test(text)) return no("spam-or-instructions");
  let advice = research ? text.replace(COIN_FACT_ASK, " ") : text;
  if (address) advice = advice.replace(OWN_BUY_OF_TAGGED, " ");
  if (ADVICE_REQUEST.test(advice) || /^(?:please\s+)?(?:buy|sell|hold|ape|pump|dump)\b/i.test(text)) return no("advice-request");
  if (!ASKED.test(text)) return no("not-asked");
  return { ok: true, text, ...(address ? { address } : {}), ...(others(lead) ? { otherHandles: true as const } : {}) };
}
