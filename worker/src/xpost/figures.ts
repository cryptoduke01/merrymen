/**
 * THE FIGURES LINE, BUILT BY CODE (the owner's decision, 2026-10-12): an
 * active agent's answer may carry market figures, AiXBT-style, but only ones
 * code built from a provider's typed numbers. The model still writes no
 * digit at all (the X gate's has-digits rule does not move); this line is
 * put in AFTER the gate admitted the model's words, between them and the
 * opt-out notice, and it is held to its own grammar here, so nothing but what
 * these functions render can ever stand where it stands.
 *
 *   coingecko: $BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.
 *   geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M; fomo: most bought $ABC.
 *
 * WHAT GOES IN IS TYPED DATA, NEVER TEXT. A provider's numbers, and of its
 * words only a ticker that passes `cleanTicker`: A-Z and 0-9, two to ten
 * characters, at least one letter, nothing else. Anything else is dropped,
 * never echoed, never repaired: a symbol with a space, a dot, an emoji, a
 * lowercase look-alike from another alphabet or eleven characters is not
 * shown at all. A ticker that spells sherwood, merrymen, robinhood or the
 * agent's own name, a slur, a political name or a hype word is dropped too:
 * under an answer from Merrymen's own account it would read as Merrymen
 * speaking for that coin.
 *
 * THE GRAMMAR (FIGURES_LINE below, pinned by figures.test.ts):
 *   money    ~$ then 1-999 or 1.1-9.9, then k, M, B or T. Under a thousand
 *            dollars is left out, never shown.
 *   percent  an explicit sign, then at most one decimal (below 100) or a whole
 *            number, then %: +1.2%, -38%, +0%.
 *   rank     #1 to #999.
 *   sections "coingecko:" (one coin's rank, price, market cap, 24h volume,
 *            24h and 7d change), "geckoterminal robinhood: trending" (up to
 *            three coins, each its 24h change and volume), "fomo: most bought"
 *            (up to two tickers), "coingecko: trending" (up to three
 *            tickers), "bitquery: 1h" (buys and sells in money), joined by
 *            "; ", ending with ".". At most six figures in all: a handful.
 *
 * TOO LONG FOR X, FIELDS GO FIRST, THEN THE LINE (`withFigures`): the least
 * telling field is dropped, then the next, and when no form of the line fits
 * X's weighted 280 with the words and the notice, the answer goes out as the
 * gate admitted it, with no line.
 *
 * NEVER WHAT THE MODEL READS AS ITS OWN WORDS. A posted answer keeps its line
 * (it is what X published), but every prompt and every echo check reads it
 * without it (`withoutFiguresLine`): the model is never shown a figure it
 * could repeat as its own, two answers are never a repeat because their
 * figures match, and never "not a repeat" because their figures differ.
 *
 * Pure: no I/O, no clock, no model, no provider.
 */
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";

// ── the pieces ──────────────────────────────────────────────────────────────

/** At most this many figures (money, percent, rank) in one line: a handful. */
export const FIGURES_MAX = 6;
/** Coins one trending section shows, Fomo's tickers, CoinGecko's trending tickers. */
export const POOLS_MAX = 3;
export const CROWD_MAX = 2;
export const TRENDING_MAX = 3;

/**
 * WORDS A TICKER MAY NOT SPELL, read on its letters (digits read as the letters
 * they stand in for: "SH3RW00D" is sherwood). Merrymen's own names and its
 * model's, the agent's, the chain's and its stock token's; slurs and
 * profanity; political names; hype. Errs toward dropping: "SKILL" holds
 * "kill" and is left out, which costs one ticker in one line.
 */
const TICKER_REFUSED = new RegExp([
  // its own house, in any spelling the letters allow
  "s+h+e*r+w+o*d", "h+e+r+w+o+d", "s+h+e*r+o{2,}d", "sherw", "merry", "robinhood", "robin", "hood", "alan", "aidale",
  // abuse
  "fuck", "fuk", "shit", "cunt", "nigg", "fag", "nazi", "hitler", "rape", "porn", "sex", "nude", "cock", "dick", "puss", "bitch", "whore", "slut", "retard", "kill", "isis", "jihad", "terror",
  // politics
  "trump", "biden", "maga", "kamala", "harris", "obama", "putin", "zelensk", "election", "president", "vote",
  // hype and trust words
  "pump", "moon", "gem", "lambo", "scam", "rug", "safe", "legit", "official",
].join("|"));

/** A ticker's letters as a reader sees them: lowercase, digits read as the letters they stand in for. */
function tickerLetters(t: string): string {
  return t.toLowerCase().replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/8/g, "b");
}

/**
 * A PROVIDER'S SYMBOL AS THE LINE MAY SHOW IT, or null. Exactly A-Z, a-z and
 * 0-9, two to ten of them, at least one letter, read before anything is
 * changed (a Turkish dotless i or a German sharp s never becomes a capital by
 * upper-casing): then upper-cased. Nothing else is trimmed, folded or
 * repaired, and a refused word (TICKER_REFUSED) is null too.
 */
export function cleanTicker(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^[A-Za-z0-9]{2,10}$/.test(raw) || !/[A-Za-z]/.test(raw)) return null;
  const t = raw.toUpperCase();
  return TICKER_REFUSED.test(tickerLetters(t)) ? null : t;
}

const UNITS: readonly [number, string][] = [[1e3, "k"], [1e6, "M"], [1e9, "B"], [1e12, "T"]];

/**
 * MONEY, COMPACT: ~$97k, ~$3.4k, ~$850M, ~$1.9T. One decimal below ten of a
 * unit, whole numbers above, the next unit at a thousand. Under a thousand
 * dollars, or past a thousand trillion, or not a finite number: null, and the
 * field is left out.
 */
export function compactMoney(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1000) return null;
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [unit, name] = UNITS[i]!;
    if (v < unit) continue;
    const s = v / unit;
    const tenths = Math.round(s * 10) / 10;
    let text: string;
    if (tenths < 10) text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
    else {
      const whole = Math.round(s);
      if (whole >= 1000) {
        // Rounded up into the next unit: 999,999 is ~$1M, never ~$1000k.
        if (i === UNITS.length - 1) return null;
        return `~$1${UNITS[i + 1]![1]}`;
      }
      text = String(whole);
    }
    return `~$${text}${name}`;
  }
  return null;
}

/**
 * A CHANGE, WITH ITS SIGN: +1.2%, -3.4%, +38%, +0%. One decimal below a
 * hundred, whole numbers from there; ".0" never written. Not a finite number,
 * or a move of a hundred thousand percent or more (an indexer's artefact):
 * null.
 */
export function signedPercent(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= 100_000) return null;
  const r = Math.abs(v) < 99.95 ? Math.round(v * 10) / 10 : Math.round(v);
  const abs = Math.abs(r);
  if (abs >= 100_000) return null;
  const sign = r < 0 ? "-" : "+";
  return `${sign}${Number.isInteger(abs) ? String(abs) : abs.toFixed(1)}%`;
}

/** A market-cap rank: #1 to #999. */
export function rankOf(v: unknown): string | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999 ? `#${v}` : null;
}

// ── the data ────────────────────────────────────────────────────────────────

/** One section of the line: what one source showed, as numbers and tickers only. */
export type FiguresSection =
  /** A coin by name or ticker, from CoinGecko's markets: "coingecko: $BTC #1, ~$97k, mcap …". */
  | { kind: "major"; symbol: string; rank?: number | null; priceUsd?: number | null; marketCapUsd?: number | null; volume24hUsd?: number | null; change24hPct?: number | null; change7dPct?: number | null }
  /** Robinhood Chain coins trending on GeckoTerminal that cleared the fleet's floors. */
  | { kind: "pools"; coins: { symbol: string; change24hPct?: number | null; volume24hUsd?: number | null }[] }
  /** The coins most Fomo traders bought in the window, by ticker only. */
  | { kind: "crowd"; symbols: string[] }
  /** CoinGecko's own trending list, by ticker only. */
  | { kind: "trending"; symbols: string[] }
  /** One coin's last hour of onchain flow, from Bitquery: buys and sells in money. */
  | { kind: "flow"; buyUsd?: number | null; sellUsd?: number | null };

export type FiguresSpec = readonly FiguresSection[];

/** Distinct clean tickers, in order, at most `max`. */
function tickers(list: readonly unknown[], max: number): string[] {
  const out: string[] = [];
  for (const s of list) {
    const t = cleanTicker(s);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The figures a section can actually show, in its own order, after every rule above. */
type Shown =
  | { kind: "major"; ticker: string; rank: string | null; price: string | null; mcap: string | null; vol: string | null; d1: string | null; d7: string | null }
  | { kind: "pools"; coins: { ticker: string; d1: string | null; vol: string | null }[] }
  | { kind: "crowd"; tickers: string[] }
  | { kind: "trending"; tickers: string[] }
  | { kind: "flow"; buys: string | null; sells: string | null };

/** What of a spec can be shown: unclean tickers, unshowable numbers and empty sections out; the caps applied. */
function shownOf(spec: FiguresSpec): Shown[] {
  const out: Shown[] = [];
  for (const s of Array.isArray(spec) ? spec : []) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "major") {
      const ticker = cleanTicker(s.symbol);
      if (!ticker) continue;
      const m: Shown = { kind: "major", ticker, rank: rankOf(s.rank), price: compactMoney(s.priceUsd), mcap: compactMoney(s.marketCapUsd),
        vol: compactMoney(s.volume24hUsd), d1: signedPercent(s.change24hPct), d7: signedPercent(s.change7dPct) };
      if (m.rank || m.price || m.mcap || m.vol || m.d1 || m.d7) out.push(m);
    } else if (s.kind === "pools") {
      const coins: { ticker: string; d1: string | null; vol: string | null }[] = [];
      for (const c of Array.isArray(s.coins) ? s.coins : []) {
        const ticker = cleanTicker(c?.symbol);
        if (!ticker || coins.some((x) => x.ticker === ticker)) continue;
        const d1 = signedPercent(c.change24hPct), vol = compactMoney(c.volume24hUsd);
        if (d1 || vol) coins.push({ ticker, d1, vol });
        if (coins.length >= POOLS_MAX) break;
      }
      if (coins.length) out.push({ kind: "pools", coins });
    } else if (s.kind === "crowd" || s.kind === "trending") {
      const list = tickers(Array.isArray(s.symbols) ? s.symbols : [], s.kind === "crowd" ? CROWD_MAX : TRENDING_MAX);
      if (list.length) out.push({ kind: s.kind, tickers: list });
    } else if (s.kind === "flow") {
      const buys = compactMoney(s.buyUsd), sells = compactMoney(s.sellUsd);
      // Both sides or neither: one side alone is half a picture.
      if (buys && sells) out.push({ kind: "flow", buys, sells });
    }
  }
  return capFigures(out);
}

function figuresIn(s: Shown): number {
  switch (s.kind) {
    case "major": return [s.rank, s.price, s.mcap, s.vol, s.d1, s.d7].filter((x) => x !== null).length;
    case "pools": return s.coins.reduce((n, c) => n + (c.d1 ? 1 : 0) + (c.vol ? 1 : 0), 0);
    case "flow": return 2;
    default: return 0;
  }
}

/** No more than FIGURES_MAX figures: sections past the handful are left out whole. */
function capFigures(list: Shown[]): Shown[] {
  const out: Shown[] = [];
  let n = 0;
  for (const s of list) {
    const k = figuresIn(s);
    if (n + k > FIGURES_MAX) continue;
    n += k;
    out.push(s);
  }
  return out;
}

function renderSection(s: Shown): string {
  switch (s.kind) {
    case "major": {
      const head = `coingecko: $${s.ticker}${s.rank ? ` ${s.rank}` : ""}`;
      const rest = [s.price, s.mcap ? `mcap ${s.mcap}` : null, s.vol ? `vol ${s.vol}` : null, s.d1 ? `24h ${s.d1}` : null, s.d7 ? `7d ${s.d7}` : null].filter((x): x is string => x !== null);
      return [head, ...rest].join(", ");
    }
    case "pools":
      return `geckoterminal robinhood: trending ${s.coins.map((c) => [`$${c.ticker}`, c.d1 ? `24h ${c.d1}` : null, c.vol ? `vol ${c.vol}` : null].filter((x): x is string => x !== null).join(" ")).join(", ")}`;
    case "crowd":
      return `fomo: most bought ${s.tickers.map((t) => `$${t}`).join(", ")}`;
    case "trending":
      return `coingecko: trending ${s.tickers.map((t) => `$${t}`).join(", ")}`;
    case "flow":
      return `bitquery: 1h buys ${s.buys}, sells ${s.sells}`;
  }
}

function renderShown(list: readonly Shown[]): string | null {
  return list.length ? `${list.map(renderSection).join("; ")}.` : null;
}

/** The whole line for a spec, or null when nothing in it can be shown. Never anything but FIGURES_LINE. */
export function renderFiguresLine(spec: FiguresSpec): string | null {
  const line = renderShown(shownOf(spec));
  return line !== null && admitFiguresLine(line) ? line : null;
}

// ── the grammar ─────────────────────────────────────────────────────────────

const T = String.raw`\$(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,10}`;
const MONEY = String.raw`~\$(?:[1-9]\.[1-9]|[1-9]\d{0,2})[kMBT]`;
const PCT = String.raw`[+-](?:0|[1-9]\d{0,4})(?:\.[1-9])?%`;
const RANK = String.raw`#[1-9]\d{0,2}`;
// A coin with no figure is never rendered, so the grammar refuses one: after
// the ticker a field must follow (the lookahead), whichever it is.
const MAJOR = String.raw`coingecko: ${T}(?=[ ,])(?: ${RANK})?(?:, ${MONEY})?(?:, mcap ${MONEY})?(?:, vol ${MONEY})?(?:, 24h ${PCT})?(?:, 7d ${PCT})?`;
const POOL = String.raw`${T}(?= )(?: 24h ${PCT})?(?: vol ${MONEY})?`;
const POOLS = String.raw`geckoterminal robinhood: trending ${POOL}(?:, ${POOL}){0,${POOLS_MAX - 1}}`;
const CROWD = String.raw`fomo: most bought ${T}(?:, ${T}){0,${CROWD_MAX - 1}}`;
const TRENDING = String.raw`coingecko: trending ${T}(?:, ${T}){0,${TRENDING_MAX - 1}}`;
const FLOW = String.raw`bitquery: 1h buys ${MONEY}, sells ${MONEY}`;
const SECTION = `(?:${MAJOR}|${POOLS}|${CROWD}|${TRENDING}|${FLOW})`;
/** The line, whole: one to five sections joined by "; ", ending with a full stop. Nothing else. */
const LINE = String.raw`${SECTION}(?:; ${SECTION}){0,4}\.`;
export const FIGURES_LINE = new RegExp(`^${LINE}$`);
const FIGURE = new RegExp(`${MONEY}|${PCT}|${RANK}`, "g");

/** The longest a figures line may be, weighted as X weighs it: room is always left for the words. */
export const FIGURES_MAX_WEIGHTED = 200;

/**
 * IS THIS A FIGURES LINE, AND ONLY THAT? The whole string in the renderer's
 * grammar (FIGURES_LINE), at most FIGURES_MAX figures, and at most
 * FIGURES_MAX_WEIGHTED long. Whatever the caller hands in — a draft with a
 * digit, a provider's text, a line with a link or a handle — that is not
 * exactly what renderFiguresLine can produce is false.
 */
export function admitFiguresLine(line: unknown): line is string {
  if (typeof line !== "string" || !FIGURES_LINE.test(line)) return false;
  if ((line.match(FIGURE) ?? []).length > FIGURES_MAX) return false;
  return xWeightedLength(line) <= FIGURES_MAX_WEIGHTED;
}

// ── fitting it in ───────────────────────────────────────────────────────────

/** Each shorter form of a section list, least telling field first, down to one field; never the empty list. */
function* shorter(list: Shown[]): Generator<Shown[]> {
  let cur = list.map((s) => (s.kind === "pools" ? { ...s, coins: s.coins.map((c) => ({ ...c })) } : { ...s })) as Shown[];
  const emit = (next: Shown[]) => { cur = next.filter((s) => figuresIn(s) > 0 || s.kind === "crowd" || s.kind === "trending"); return cur; };
  // CoinGecko's global list first, then Fomo's: the chain's own coins are what was asked.
  for (const kind of ["trending", "crowd"] as const) {
    if (cur.some((s) => s.kind === kind) && cur.length > 1) yield emit(cur.filter((s) => s.kind !== kind));
  }
  const pools = (): Extract<Shown, { kind: "pools" }> | undefined => cur.find((s): s is Extract<Shown, { kind: "pools" }> => s.kind === "pools");
  // Fewer coins before thinner coins: one coin said whole beats three said halfway.
  while ((pools()?.coins.length ?? 0) > 1) {
    const p = pools()!;
    yield emit(cur.map((s) => (s === p ? { ...p, coins: p.coins.slice(0, -1) } : s)));
  }
  const p = pools();
  if (p && p.coins[0]!.vol && p.coins[0]!.d1) yield emit(cur.map((s) => (s === p ? { ...p, coins: [{ ...p.coins[0]!, vol: null }] } : s)));
  // A coin's line: the week, then volume, market cap, price, and last its rank.
  for (const field of ["d7", "vol", "mcap", "price", "rank"] as const) {
    const m = cur.find((s): s is Extract<Shown, { kind: "major" }> => s.kind === "major");
    if (!m || m[field] === null || figuresIn(m) <= 1) continue;
    yield emit(cur.map((s) => (s === m ? { ...m, [field]: null } : s)));
  }
}

export interface WithFigures {
  /** What to post: the gate's text with the line before its notice, or the gate's text as it was. */
  text: string;
  /** The line put in, or null when none was (nothing to show, no notice to put it before, or no form of it fit). */
  line: string | null;
  /** Fields dropped to make it fit (0 when the whole line fit). */
  dropped: number;
}

/** The opt-out notice at the very end of an answer, as the gate admitted it. */
const NOTICE_TAIL = /\s*(say stop to opt out\.)\s*$/i;

/**
 * THE ANSWER WITH ITS FIGURES, OR WITHOUT. `admitted` is the X gate's own
 * text (words and the opt-out notice, already judged). The line goes between
 * the words and the notice; the words gain a full stop if they ended without
 * one. The full line is tried first, then each shorter form (`shorter`), and
 * the first whose whole post fits X_MAX_WEIGHTED is used. None fits, the
 * notice is missing, or nothing in `spec` can be shown: `admitted` unchanged.
 */
export function withFigures(admitted: string, spec: FiguresSpec | null | undefined): WithFigures {
  const none: WithFigures = { text: admitted, line: null, dropped: 0 };
  if (typeof admitted !== "string" || !spec) return none;
  const m = NOTICE_TAIL.exec(admitted);
  if (!m) return none;
  const words = admitted.slice(0, m.index).trim();
  if (!words) return none;
  const lead = /[.!?…]$/.test(words) ? words : `${words}.`;
  const full = shownOf(spec);
  if (!full.length) return none;
  const total = full.reduce((n, s) => n + figuresIn(s) + (s.kind === "crowd" || s.kind === "trending" ? s.tickers.length : 0), 0);
  const tries: Shown[][] = [full, ...shorter(full)];
  for (const t of tries) {
    const line = renderShown(t);
    if (line === null || !admitFiguresLine(line)) continue;
    const text = `${lead} ${line} ${m[1]!}`;
    if (xWeightedLength(text) > X_MAX_WEIGHTED) continue;
    const kept = t.reduce((n, s) => n + figuresIn(s) + (s.kind === "crowd" || s.kind === "trending" ? s.tickers.length : 0), 0);
    return { text, line, dropped: total - kept };
  }
  return none;
}

const LINE_AT_END = new RegExp(String.raw`\s*(${LINE})(?=\s*(?:[Ss]ay stop to opt out\.)?\s*$)`);

/**
 * A POSTED ANSWER AS EVERY PROMPT AND ECHO CHECK READS IT: without its figures
 * line, the notice left where it was. Only a line in the renderer's own
 * grammar, at the end of the words, is taken out; text that only looks like
 * one is left as it was (and a prompt's own digit screen drops it).
 */
export function withoutFiguresLine(text: string): string {
  if (typeof text !== "string") return text;
  const m = LINE_AT_END.exec(text);
  if (!m || !admitFiguresLine(m[1])) return text;
  return `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
}
