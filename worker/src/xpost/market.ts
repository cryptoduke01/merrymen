/**
 * A MARKET ANSWER'S WORDS, BUILT BY CODE (red-team review, 2026-10-12).
 *
 * An active agent's answer to "what's hot?" carries code's figures line
 * (figures.ts): the chain's trending coins by ticker, each with its day's
 * change and volume. The model's words used to stand right before that line,
 * and the X gate judged them before the line was put in, with nothing in them
 * to say a coin was named: "if i had to pick one it'd be the first", "these
 * are my plays right now", "i'm in the top one myself" and "the first one is
 * the play" were each admitted, and code then put "$CHUMP 24h +41.2%" right
 * after them. On the house's real-money account that is a recommendation of a
 * named coin, and a claim to hold coins it never bought. A list of pointing
 * words is never whole.
 *
 * So a market answer has no model words at all. Its words are one of the
 * frames below, filled from a typed read (`HotRead`) of what research found:
 * how many coins stand out, and which way the one on top went on the day,
 * never a name, a figure, a "buy", an "early" or a target. Each frame is
 * gated like any answer, and the figures line goes in after it. The frames do
 * not share their words (the gate's repeat limit, pinned in market.test.ts),
 * so the same read is said again in other words, and when every frame has
 * been said lately, not at all: the same rule as code's model and greeting
 * lines (writer.ts codeLines). A major (a coin by name on CoinGecko's list)
 * is the same: its words are code's (`MajorRead`, majorAnswers), never a
 * draft beside its figures.
 *
 * Pure: no I/O, no model, no provider, no clock.
 */
import { REPLY_OPT_OUT } from "./replies";

/** A day's move as code reads it: which way, and how far, by code's own thresholds. Never a figure. */
export interface Move {
  dir: "up" | "down" | "flat";
  /** null when flat. */
  size: "a little" | "a fair bit" | "sharply" | null;
}

/** A change in percent as a Move: flat under half a percent, a little under three, a fair bit under ten, sharply past that. */
export function moveOf(pct: unknown): Move | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const a = Math.abs(pct);
  if (a < 0.5) return { dir: "flat", size: null };
  return { dir: pct > 0 ? "up" : "down", size: a < 3 ? "a little" : a < 10 ? "a fair bit" : "sharply" };
}

/**
 * A MOVE IN ONE FRAME'S OWN WORDS: each frame says a move its own way, so two
 * frames saying the same read share as few words as they can (the gate's
 * repeat limit weighs content words). [up, down] for a little, a fair bit,
 * sharply; then flat.
 */
interface MoveWords { little: readonly [string, string]; fair: readonly [string, string]; sharp: readonly [string, string]; flat: string }
function said(m: Move, w: MoveWords): string {
  if (m.dir === "flat") return w.flat;
  const pair = m.size === "sharply" ? w.sharp : m.size === "a fair bit" ? w.fair : w.little;
  return m.dir === "up" ? pair[0] : pair[1];
}

/**
 * WHAT'S HOT, AS CODE READ IT: how many coins the line shows (one, or a few),
 * and which way the first of them went on the day. The first coin is the one
 * the line always keeps however it is shortened (figures.ts withFigures), so
 * what the words say of it is what the reader sees beside them.
 */
export interface HotRead {
  /** Coins past the floors the line shows, at most three; at least one here (none is another answer). */
  coins: number;
  /** The first coin's day, or null when the index did not say. */
  lead: Move | null;
}

/**
 * EIGHT FRAMES THAT ARE NOT EACH OTHER. Each names its source (the chain's
 * trending index), says how many and the first coin's day in words of its
 * own, and closes with "not a call" its own way. None says "i", "my", "buy",
 * "early", "pick", "play", "own", "hold", "back", "long" or a target, and none
 * a coin's name: the line after it does.
 */
const HOT_FRAMES: readonly ((many: boolean, lead: Move | null) => string)[] = [
  (many, lead) => `${many ? "a few coins" : "one coin"} standing out on the robinhood chain index${lead ? `, the top one ${said(lead, { little: ["up a little", "down a little"], fair: ["up a fair bit", "down a fair bit"], sharp: ["up sharply", "down sharply"], flat: "flat" })} today` : ""}. not a call`,
  (many, lead) => `geckoterminal has ${many ? "several tokens" : "a single token"} trending for robinhood${lead ? `, the leader ${said(lead, { little: ["slightly higher", "slightly lower"], fair: ["noticeably higher", "noticeably lower"], sharp: ["steeply higher", "steeply lower"], flat: "unchanged" })} since yesterday` : ""}. just data`,
  (many, lead) => `per the chain's index, ${many ? "a handful of names" : "one name"} drawing action${lead ? `, the busiest ${said(lead, { little: ["gaining a touch", "slipping a touch"], fair: ["gaining moderately", "slipping moderately"], sharp: ["gaining strongly", "slipping strongly"], flat: "staying level" })}` : ""}. observation only`,
  (many, lead) => `trending on robinhood: ${many ? "a small group" : "a lone ticker"} out in front${lead ? `, the frontrunner ${said(lead, { little: ["rising mildly", "falling mildly"], fair: ["rising solidly", "falling solidly"], sharp: ["rising hard", "falling hard"], flat: "moving sideways" })} lately` : ""}. a snapshot`,
  (many, lead) => `index movers over there: ${many ? "multiple listings" : "one listing"} getting attention${lead ? `, number one ${said(lead, { little: ["up marginally", "down marginally"], fair: ["up meaningfully", "down meaningfully"], sharp: ["up dramatically", "down dramatically"], flat: "barely changed" })}` : ""}. no recommendation`,
  (many, lead) => `robinhood chain's trending list has ${many ? "a cluster of busy coins" : "one busy coin"}${lead ? `, the first ${said(lead, { little: ["a bit firmer", "a bit softer"], fair: ["clearly firmer", "clearly softer"], sharp: ["far firmer", "far softer"], flat: "steady" })} for the day` : ""}. descriptive only`,
  (many, lead) => `the index flags ${many ? "a bunch of coins" : "a coin"} heating up${lead ? `, the head of the pack ${said(lead, { little: ["edging up", "edging down"], fair: ["climbing decently", "sliding decently"], sharp: ["rising fast", "dropping fast"], flat: "going nowhere" })}` : ""}. reporting, not recommending`,
  (many, lead) => `over on robinhood chain, ${many ? "some tickers" : "one ticker"} top geckoterminal's page${lead ? `, the leading one ${said(lead, { little: ["up mildly", "off mildly"], fair: ["up notably", "off notably"], sharp: ["up substantially", "off heavily"], flat: "about level" })} over a day` : ""}. info only`,
];

/**
 * A paper agent's market answer says paper: the gate refuses a paper reply
 * that never does. One clause per frame, each in words of its own.
 */
const MARKET_PAPER: readonly string[] = Object.freeze([
  "i'm on paper myself",
  "i trade on paper for now",
  "i'm on paper these days",
  "i play it on paper",
  "i'm strictly on paper",
  "i'm trading on paper",
  "i'm on paper so far",
  "i'm on paper at the moment",
]);

/** The lines, this mention's own frame first (chosen by its id), each with the notice and, on paper, a paper clause. */
function framed(texts: readonly string[], seed: string, style: { lower: boolean }, o: { paper?: boolean }): string[] {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const notice = style.lower ? REPLY_OPT_OUT.toLowerCase() : REPLY_OPT_OUT;
  return texts.map((_, i) => {
    const k = (h + i) % texts.length;
    return `${texts[k]!}${o.paper === true ? `. ${MARKET_PAPER[k % MARKET_PAPER.length]!}` : ""}. ${notice}`;
  });
}

/**
 * WHAT'S HOT, ANSWERED BY CODE: every frame for this read, starting from this
 * mention's own (`seed`, its id). Empty for a read with no coin: that is
 * hotNoneAnswers.
 */
export function hotAnswers(read: HotRead, seed: string, style: { lower: boolean }, o: { paper?: boolean } = {}): string[] {
  if (!read || !(read.coins >= 1)) return [];
  return framed(HOT_FRAMES.map((f) => f(read.coins > 1, read.lead ?? null)), seed, style, o);
}

/**
 * NOTHING PAST THE FLOORS, SAID BY CODE (red-team 2026-10-12): a drafted
 * "what's hot?" answer named coins the index never showed it ("chump is the
 * one standing out", "wif and bonk are the ones") right before code's line,
 * and a draft with nothing to show could still do so with no line at all. So
 * what's hot is never drafted: with nothing to show, one of these.
 */
const HOT_NONE_LINES: readonly string[] = Object.freeze([
  "nothing is standing out on the robinhood chain index right now",
  "quiet on geckoterminal for robinhood, no coin clears the bar today",
  "per the chain's index, no name is pulling away from the pack",
  "trending on robinhood looks flat, nobody out in front lately",
  "index movers over there: none that stand apart",
  "robinhood chain's trending list is sleepy, nothing busy enough to mention",
  "the index flags nothing heating up at the moment",
  "over on robinhood chain, geckoterminal's page has no clear leader",
]);

/** And with the index unread (busy, down, late, or research off): never a guess at what is moving. */
const HOT_UNREAD_LINES: readonly string[] = Object.freeze([
  "no read on the robinhood chain index available right now",
  "geckoterminal's robinhood view can't be pulled up from here",
  "the chain's index is out of reach just now, so no rundown",
  "what's trending on robinhood can't be checked this time",
  "index movers over there aren't visible currently",
  "robinhood chain's trending list is unavailable for the moment",
  "the index is a blank on this end for now",
  "the movers board for robinhood chain is dark today",
]);

/** What's hot with nothing past the floors: every line, this mention's own first. */
export function hotNoneAnswers(seed: string, style: { lower: boolean }, o: { paper?: boolean } = {}): string[] {
  return framed(HOT_NONE_LINES, seed, style, o);
}

/** What's hot with the index unread: every line, this mention's own first. */
export function hotUnreadAnswers(seed: string, style: { lower: boolean }, o: { paper?: boolean } = {}): string[] {
  return framed(HOT_UNREAD_LINES, seed, style, o);
}

// ── a major ────────────────────────────────────────────────────────────────

/**
 * A MAJOR, AS CODE READ IT FROM COINGECKO (red-team 2026-10-12): where it
 * ranks, how its day and its week went, how busy its trading is against its
 * size, each by code's own thresholds. A major's answer carried the model's
 * words right before "coingecko: $ETH #2, ~$3.4k, …", and "looks set to keep
 * climbing toward new highs", "it's the play", "alan has been stacking it all
 * week" and "wif and bonk are doing even better" were each admitted and
 * posted beside the coin's figures. So a major's words are code's too.
 */
export interface MajorRead {
  rank: "top" | "large" | "mid" | null;
  day: Move | null;
  week: Move | null;
  volume: "heavy" | "light" | "ordinary" | null;
}

/** One frame's own words for a major: how it opens and closes, and how it says a rank, a move and a volume. */
interface MajorWords {
  open: string;
  close: string;
  rank: { top: string; large: string; mid: string };
  move: MoveWords;
  day: string;
  week: string;
  volume: { heavy: string; light: string; ordinary: string };
}

/** EIGHT FRAMES THAT ARE NOT EACH OTHER, each naming coingecko, never the coin, a figure, "i", "buy", "early" or where it is headed. */
const MAJOR_FRAMES: readonly MajorWords[] = [
  { open: "coingecko has it", close: "not a call", rank: { top: "among the very biggest", large: "a large cap", mid: "a mid cap" },
    move: { little: ["up a little", "down a little"], fair: ["up a fair bit", "down a fair bit"], sharp: ["up sharply", "down sharply"], flat: "flat" },
    day: "today", week: "on the week", volume: { heavy: "volume heavy", light: "volume light", ordinary: "volume ordinary" } },
  { open: "per coingecko it's", close: "just data", rank: { top: "one of the largest", large: "big by value", mid: "mid-sized" },
    move: { little: ["slightly higher", "slightly lower"], fair: ["noticeably higher", "noticeably lower"], sharp: ["steeply higher", "steeply lower"], flat: "unchanged" },
    day: "since yesterday", week: "over the week", volume: { heavy: "turnover high", light: "turnover low", ordinary: "turnover normal" } },
  { open: "on coingecko it sits", close: "observation only", rank: { top: "near the top", large: "ranked high", mid: "mid-ranked" },
    move: { little: ["gaining a touch", "slipping a touch"], fair: ["gaining moderately", "slipping moderately"], sharp: ["gaining strongly", "slipping strongly"], flat: "level" },
    day: "this session", week: "across the week", volume: { heavy: "busy trading", light: "thin trading", ordinary: "normal trading" } },
  { open: "coingecko's view:", close: "a snapshot", rank: { top: "a heavyweight", large: "a big name", mid: "a mid-tier name" },
    move: { little: ["rising mildly", "falling mildly"], fair: ["rising solidly", "falling solidly"], sharp: ["rising hard", "falling hard"], flat: "sideways" },
    day: "lately", week: "week over week", volume: { heavy: "lots of volume", light: "little volume", ordinary: "average volume" } },
  { open: "by coingecko's numbers it's", close: "for reference", rank: { top: "top tier", large: "upper tier", mid: "middle tier" },
    move: { little: ["up marginally", "down marginally"], fair: ["up meaningfully", "down meaningfully"], sharp: ["up dramatically", "down dramatically"], flat: "barely changed" },
    day: "for the day", week: "for the week", volume: { heavy: "volume elevated", light: "volume subdued", ordinary: "volume typical" } },
  { open: "coingecko shows it as", close: "descriptive only", rank: { top: "one of the giants", large: "a sizeable coin", mid: "a mid-weight coin" },
    move: { little: ["a bit firmer", "a bit softer"], fair: ["clearly firmer", "clearly softer"], sharp: ["far firmer", "far softer"], flat: "steady" },
    day: "on the day", week: "on the week", volume: { heavy: "brisk turnover", light: "slow turnover", ordinary: "steady turnover" } },
  { open: "the coingecko page lists it", close: "no recommendation", rank: { top: "elite by valuation", large: "sizeable by valuation", mid: "modest by valuation" },
    move: { little: ["edging up", "edging down"], fair: ["climbing", "sliding"], sharp: ["racing up", "plunging"], flat: "idle" },
    day: "in a day", week: "over a week", volume: { heavy: "packed order flow", light: "sparse order flow", ordinary: "usual order flow" } },
  { open: "over on coingecko it's", close: "info only", rank: { top: "top of the table", large: "well up the table", mid: "mid-table" },
    move: { little: ["up mildly", "off mildly"], fair: ["up notably", "off notably"], sharp: ["up strongly", "off heavily"], flat: "about level" },
    day: "past day", week: "through the week", volume: { heavy: "active trade", light: "quiet trade", ordinary: "routine trade" } },
];

/** One frame said of one read, or null when the read has nothing in it to say. */
function majorText(w: MajorWords, r: MajorRead): string | null {
  const parts = [
    r.rank ? w.rank[r.rank] : null,
    r.day ? `${said(r.day, w.move)} ${w.day}` : null,
    r.week ? `${said(r.week, w.move)} ${w.week}` : null,
    r.volume ? w.volume[r.volume] : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? `${w.open} ${parts.join(", ")}. ${w.close}` : null;
}

/** A major, answered by code: every frame for this read, this mention's own first. Empty when the read has nothing to say. */
export function majorAnswers(read: MajorRead, seed: string, style: { lower: boolean }, o: { paper?: boolean } = {}): string[] {
  if (!read) return [];
  const texts = MAJOR_FRAMES.map((w) => majorText(w, read));
  return texts.every((t): t is string => t !== null) ? framed(texts, seed, style, o) : [];
}

/** A coin asked by name that coingecko could not be read for (or research off): never a guess at how it is doing, never its name. */
const MAJOR_UNREAD_LINES: readonly string[] = Object.freeze([
  "no coingecko read on that one available right now",
  "coingecko can't be pulled up from here for that coin",
  "that one is out of reach on coingecko just now, so no rundown",
  "can't check that coin's coingecko page this time",
  "the coingecko numbers for that one aren't visible currently",
  "coingecko is unavailable for that coin at the moment",
  "that coin's market page is a blank on this end for now",
  "the market board for that coin is dark today",
]);

/** A major unread: every line, this mention's own first. */
export function majorUnreadAnswers(seed: string, style: { lower: boolean }, o: { paper?: boolean } = {}): string[] {
  return framed(MAJOR_UNREAD_LINES, seed, style, o);
}
