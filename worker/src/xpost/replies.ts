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

export type ReplyCandidate = { ok: true; text: string } | { ok: false; reason: string };

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

/** A question or a plain address to the agent, after any leading handles. */
const ASKED = /\?|^(?:what|why|how|which|who|whos|who's|where|are|is|do|does|did|can|could|have|has|tell|explain|thoughts|gm|hey|yo|hi|hello)\b/i;

/**
 * IS THIS POST THAT TAGGED AN ACTIVE AGENT ONE IT MAY ANSWER? A question or a
 * plain address, in good faith, about the agent itself. The same screens as a
 * comment reply — opt-outs first, then links, secrets, abuse, sensitive
 * topics, spam, instructions and advice requests — except that digits may
 * appear in the question; the answer is still gated with no numbers in it.
 * Handles never reach the writer.
 */
export function tagCandidate(reply: XReply, ctx: { xUserId: string }): ReplyCandidate {
  const no = (reason: string): ReplyCandidate => ({ ok: false, reason });
  if (!reply.id || !reply.authorId || !ctx.xUserId) return no("invalid");
  if (reply.authorId === ctx.xUserId) return no("own-comment");
  if (isReplyOptOut(reply.text)) return no("opt-out");
  if (typeof reply.text !== "string") return no("invalid");
  const text = withoutLeadingMentions(reply.text.normalize("NFKC")).replace(/@[a-z0-9_]{1,15}\b/gi, " ").replace(/\s+/g, " ").trim();
  if (text.length < 4 || text.length > XREPLY_MAX_COMMENT_CHARS || (text.match(/\p{L}+/gu) ?? []).length < 2) return no("low-signal");
  if (/[\u0000-\u001f\u007f«»<>#]|\p{Script=Cyrillic}|\p{Script=Han}/u.test(text)) return no("unsafe-text");
  if (LINK_OR_SECRET.test(text)) return no("link-or-secret");
  if (ABUSE_OR_SENSITIVE.test(text)) return no("sensitive");
  if (SPAM_OR_INSTRUCTIONS.test(text)) return no("spam-or-instructions");
  if (ADVICE_REQUEST.test(text) || /^(?:please\s+)?(?:buy|sell|hold|ape|pump|dump)\b/i.test(text)) return no("advice-request");
  if (!ASKED.test(text)) return no("not-asked");
  return { ok: true, text };
}
