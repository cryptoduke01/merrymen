/**
 * THE FIGURES LINE: only what code renders from typed numbers and clean
 * tickers, in one grammar, short enough for X with the words around it — and
 * never read back as the agent's own words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import {
  admitFiguresLine, cleanTicker, compactMoney, FIGURES_LINE, FIGURES_MAX, figuresTickers, rankOf, renderFiguresLine, signedPercent,
  withFigures, withoutFiguresLine, type FiguresSpec,
} from "./figures";
import { merrymenMentioned, sherwoodMentioned } from "./gate";

const BTC: FiguresSpec = [{ kind: "major", symbol: "btc", rank: 1, priceUsd: 97_431.2, marketCapUsd: 1.93e12, volume24hUsd: 41.2e9, change24hPct: 1.234, change7dPct: -3.44 }];
const HOT: FiguresSpec = [
  { kind: "pools", coins: [{ symbol: "ABC", change24hPct: 42.07, volume24hUsd: 1.21e6 }, { symbol: "DEF", change24hPct: -8.3, volume24hUsd: 310_400 }, { symbol: "GHI", change24hPct: 5, volume24hUsd: 90_000 }] },
  { kind: "crowd", symbols: ["DEF"] },
  { kind: "trending", symbols: ["PEPE", "WIF", "TAO"] },
];
const NOTICE = "Say stop to opt out.";

describe("tickers: A-Z, two to ten letters, nothing else", () => {
  it("a clean symbol is upper-cased and kept", () => {
    assert.equal(cleanTicker("btc"), "BTC");
    assert.equal(cleanTicker("SOL"), "SOL");
    assert.equal(cleanTicker("ABCDEFGHIJ"), "ABCDEFGHIJ");
  });

  it("anything else is dropped, never repaired or echoed", () => {
    for (const bad of ["B", "ABCDEFGHIJK", "123", "$BTC", "BTC.X", "BTC 2", " BTC", "BTC​", "ΒΤC", "ВТС", "ıNCH", "straße", "🐸", "PEPE🐸", "B-TC", "", null, undefined, 42, { s: "BTC" }]) {
      assert.equal(cleanTicker(bad), null, String(bad));
    }
  });

  it("never a digit: a sum, a multiple or a copy that no code built (red-team 2026-10-12)", () => {
    // The red team's posts: "trending $100X 24h +55.5% vol ~$1.2M, $1B 24h +21% vol ~$640k, $97K 24h +3.3% vol ~$120k".
    for (const bad of ["100X", "1B", "97K", "10M", "1000X", "1INCH", "PEPE2", "USDC2", "ETH2", "S0L", "HH1488"]) assert.equal(cleanTicker(bad), null, bad);
    assert.equal(renderFiguresLine([{ kind: "pools", coins: ["100X", "1B", "97K"].map((symbol) => ({ symbol, change24hPct: 21, volume24hUsd: 640_000 })) }]), null);
    assert.equal(admitFiguresLine("geckoterminal robinhood: trending $1B 24h +21% vol ~$640k."), false, "nor does the grammar take one");
    for (const bad of ["MILLION", "BILLIONS", "BUCKS", "DOLLAR", "MELANIA"]) assert.equal(cleanTicker(bad), null, bad);
  });

  it("every ticker a line shows, read off it", () => {
    assert.deepEqual(figuresTickers(renderFiguresLine(HOT)), ["ABC", "DEF", "GHI", "DEF", "PEPE", "WIF", "TAO"]);
    assert.deepEqual(figuresTickers("bitquery: 1h buys ~$12k, sells ~$8.1k."), []);
  });

  it("never a sherwood, merrymen, robinhood or agent name, however its digits spell it", () => {
    for (const bad of ["SHERWOOD", "SHERWOOD1", "SH3RW00D", "SHRWD", "HERWOOD", "SHEROOD", "MERRY", "MERRYMEN", "HOOD", "ROBINHOOD", "ALAN", "ALANAIDALE"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    // Whatever the gate reads as sherwood, the line never shows.
    for (const t of ["SHERW00D", "SHERWOOD", "SHERWOOOD", "5HERWOOD", "SHERWOD"]) {
      if (sherwoodMentioned(t)) assert.equal(cleanTicker(t), null, t);
    }
  });

  it("never merrymen in any spelling the letters allow (red-team 2026-10-12)", () => {
    // Posted at 34ced01e: "trending $MERRIMEN 24h +12% vol ~$300k, $MERYMEN 24h +9% vol ~$200k".
    for (const bad of ["MERRYMEN", "MERRYMAN", "MERRYMEM", "MERRIMEN", "MERYMEN", "MERIMEN", "MERRMEN", "MRRYMEN", "MEERYMEN", "MRYMN", "MERR", "MERRIMAN", "merrimen"]) {
      assert.equal(cleanTicker(bad), null, bad);
      assert.ok(merrymenMentioned(bad), bad);
    }
    for (const ok of ["CHUMP", "PEPE", "MERIT", "MERCURY", "MEME", "SUMMER", "HAMMER"]) {
      assert.equal(cleanTicker(ok), ok, ok);
      assert.equal(merrymenMentioned(ok), false, ok);
    }
  });

  it("never advice or hype run together into one word (red-team 2026-10-12)", () => {
    // Posted at 34ced01e, each as "trending $<SYM> 24h +312% vol ~$1.2M".
    for (const bad of ["BUYNOW", "BUYIT", "SENDIT", "APEIN", "GOBUY", "APENOW", "SAFU", "SELLNOW", "FREEMONEY", "RISKFREE", "GUARANTEE", "BULLRUN",
      "HODL", "YOLO", "LONGIT", "SHORTIT", "BEARISH", "GETRICH", "PROFITS", "AIRDROP", "PRESALE", "ROCKET", "BUYTHEDIP"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["CHUMP", "FROGGY", "WOJAK", "MEMECOIN", "PEPE", "TAO", "BONK"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never a slur, a hate code, a house, chain, agent or model name in any short form, nor advice: the red team's thirty (red-team 2026-10-12)", () => {
    // Each accepted by cleanTicker at 34ced01e, and posted as trending from the house account.
    for (const bad of ["KYS", "HEIL", "KIKE", "CHINK", "SPIC", "TRANNY", "GOOK", "WETBACK", "COON", "PEDO", "LOLI", "HAMAS", "KKK", "SIEG", "HH1488",
      "MERYMEN", "MERRIMEN", "MRYMN", "RBNHD", "ALDALE", "BUYNOW", "BUYIT", "SENDIT", "APEIN", "100X", "1000X", "FREEMONEY", "RISKFREE", "GUARANTEE", "SELLNOW",
      "HH", "SS", "ASS", "ROBNHOOD", "CLAUDE", "GROKCOIN", "OPENAI", "CHATGPT", "MELANIA", "ELON"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["PEPE", "CHUMP", "FROGGY", "WOJAK", "BTC", "ETH", "SOL", "TAO", "BONK", "WIF", "DOGE", "LINK", "AAVE", "NEAR", "BASS", "GALA"]) {
      assert.equal(cleanTicker(ok), ok, ok);
    }
  });

  it("never the slurs, hate codes and sexual words the first list missed, nor a slur spelled on its consonants (red-team 2026-10-12)", () => {
    // Each passed cleanTicker at fbcf8756 and was posted as trending, or as fomo's most bought, from the house account.
    for (const bad of ["JIGABOO", "HOLOHOAX", "KNEEGROW", "NIBBA", "GASTHEM", "HAILHTLR", "NIQQA", "JEWBOY", "GOYIM", "ZOG", "FUHRER", "SWASTIKA", "LYNCH",
      "WHITEPRIDE", "HITLR", "SHEMALE", "DILDO", "ADOLF", "HIMMLER", "JEW", "JEWS", "NIGLET", "CUMSHOT", "SPASTIC", "NYGGA", "NIGRO", "HTLR", "FUHRR"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["PEPE", "CHUMP", "FROGGY", "WOJAK", "BONK", "COINA", "ZAPX", "QRTZ", "MOLT", "GALA", "BASS", "MERIT"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never a slur, a political name or a hype word", () => {
    for (const bad of ["NAZI", "FUCK", "TRUMP", "MAGA", "BIDEN", "PUMP", "MOON", "GEM", "SCAM", "SAFE", "LEGIT"]) assert.equal(cleanTicker(bad), null, bad);
  });
});

describe("figures, compact and signed", () => {
  it("money: ~$1.2T, ~$850M, ~$85k; under a thousand dollars is left out", () => {
    assert.equal(compactMoney(1.2e12), "~$1.2T");
    assert.equal(compactMoney(850e6), "~$850M");
    assert.equal(compactMoney(85_000), "~$85k");
    assert.equal(compactMoney(97_431.2), "~$97k");
    assert.equal(compactMoney(3_412), "~$3.4k");
    assert.equal(compactMoney(1_000), "~$1k");
    assert.equal(compactMoney(1.04e12), "~$1T", "no .0");
    assert.equal(compactMoney(9_960), "~$10k");
    assert.equal(compactMoney(999_999), "~$1M", "never ~$1000k");
    for (const none of [999.99, 0, -5_000, Number.NaN, Number.POSITIVE_INFINITY, 2e15, "5000", null]) assert.equal(compactMoney(none), null, String(none));
  });

  it("percent: an explicit sign, at most one decimal, whole from a hundred", () => {
    assert.equal(signedPercent(1.234), "+1.2%");
    assert.equal(signedPercent(-3.44), "-3.4%");
    assert.equal(signedPercent(3), "+3%");
    assert.equal(signedPercent(0), "+0%");
    assert.equal(signedPercent(-0.04), "+0%", "a rounded zero has one sign");
    assert.equal(signedPercent(150.6), "+151%");
    assert.equal(signedPercent(-99.97), "-100%");
    for (const none of [100_000, -250_000, Number.NaN, "1.2", null]) assert.equal(signedPercent(none), null, String(none));
  });

  it("rank: #1 to #999", () => {
    assert.equal(rankOf(1), "#1");
    assert.equal(rankOf(200), "#200");
    for (const none of [0, -1, 1.5, 1000, Number.NaN, "1"]) assert.equal(rankOf(none), null, String(none));
  });
});

describe("the line, rendered from typed data", () => {
  it("a coin by name or ticker: rank, price, market cap, volume, the day and the week, named coingecko", () => {
    assert.equal(renderFiguresLine(BTC), "coingecko: $BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.");
  });

  it("a major under a thousand dollars shows no price", () => {
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "sol", rank: 5, priceUsd: 185.2, marketCapUsd: 88e9, volume24hUsd: 4.1e9, change24hPct: -2.1, change7dPct: 6 }]),
      "coingecko: $SOL #5, mcap ~$88B, vol ~$4.1B, 24h -2.1%, 7d +6%.");
  });

  it("what's hot: three coins of the chain, fomo's most bought, coingecko's trending", () => {
    assert.equal(renderFiguresLine(HOT),
      "geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M, $DEF 24h -8.3% vol ~$310k, $GHI 24h +5% vol ~$90k; fomo: most bought $DEF; coingecko: trending $PEPE, $WIF, $TAO.");
  });

  it("onchain flow: both sides, or nothing", () => {
    assert.equal(renderFiguresLine([{ kind: "flow", buyUsd: 12_300, sellUsd: 8_100 }]), "bitquery: 1h buys ~$12k, sells ~$8.1k.");
    assert.equal(renderFiguresLine([{ kind: "flow", buyUsd: 12_300, sellUsd: 400 }]), null);
  });

  it("an unclean ticker takes its coin with it; nothing showable is no line", () => {
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "B T C", rank: 1, priceUsd: 97_000 }]), null);
    assert.equal(renderFiguresLine([{ kind: "pools", coins: [{ symbol: "SHERWOOD", change24hPct: 900, volume24hUsd: 5e6 }, { symbol: "OKAY", change24hPct: 2, volume24hUsd: 60_000 }] }]),
      "geckoterminal robinhood: trending $OKAY 24h +2% vol ~$60k.");
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "BTC", rank: null, priceUsd: 900 }]), null, "a coin with no figure is no line");
    assert.equal(renderFiguresLine([{ kind: "crowd", symbols: ["🐸", "a b"] }]), null);
    assert.equal(renderFiguresLine([]), null);
  });

  it("never more than a handful: three coins, two fomo tickers, three trending, six figures", () => {
    const line = renderFiguresLine([
      { kind: "pools", coins: ["AA", "BB", "CC", "DD"].map((symbol) => ({ symbol, change24hPct: 1, volume24hUsd: 50_000 })) },
      { kind: "crowd", symbols: ["AA", "BB", "CC"] },
      { kind: "trending", symbols: ["XA", "XB", "XC", "XD"] },
      { kind: "flow", buyUsd: 5_000, sellUsd: 5_000 },
    ])!;
    assert.doesNotMatch(line, /\$DD|\$CC, \$|XD/);
    assert.doesNotMatch(line, /bitquery/, "a section past six figures is left out whole");
    assert.ok((line.match(/~\$|[+-]\d/g) ?? []).length <= FIGURES_MAX);
  });
});

describe("the grammar the validator holds an inserted line to", () => {
  it("every rendered line is admitted", () => {
    for (const spec of [BTC, HOT, [{ kind: "flow", buyUsd: 1e6, sellUsd: 2e5 }] as FiguresSpec]) {
      const line = renderFiguresLine(spec)!;
      assert.ok(admitFiguresLine(line), line);
      assert.match(line, FIGURES_LINE);
    }
  });

  it("nothing else is: a word more, a link, a handle, a lowercase ticker, a missing stop, a seventh figure", () => {
    const ok = "coingecko: $BTC #1, ~$97k, mcap ~$1.9T.";
    assert.ok(admitFiguresLine(ok));
    for (const bad of [
      "coingecko: $BTC #1, ~$97k, mcap ~$1.9T", // no full stop
      "coingecko: $btc #1, ~$97k.",
      "coingecko: $BTC #1, ~$97k, buy now.",
      "coingecko: $BTC #1, ~$97k, https://x.co.",
      "coingecko: $BTC #1, @someone.",
      "coingecko: $BTC.",
      "coingecko: $BTC #0.",
      "coingecko: $BTC, ~$97.0k.",
      "coingecko: $BTC, ~$1000k.",
      "coingecko: $BTC, 24h 1.2%.",
      "coingecko: $BTC, 24h +1.23%.",
      "the public index: $BTC #1.",
      "coingecko: $BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%; bitquery: 1h buys ~$1k, sells ~$1k.",
      "geckoterminal robinhood: trending $AA 24h +1%, $BB 24h +1%, $CC 24h +1%, $DD 24h +1%.",
      "geckoterminal robinhood: trending $AA.",
      "Say stop to opt out.",
      "",
      null,
    ]) assert.equal(admitFiguresLine(bad), false, String(bad));
  });

  it("fuzzed specs render only admitted lines, and only the grammar's characters", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const n = () => (rnd() < 0.1 ? Number.NaN : (rnd() - 0.3) * 10 ** Math.floor(rnd() * 15));
    const sym = () => ["BTC", "eth", "S0L", "🐸", "x", "WAYTOOLONGTICKER", "SHERWOOD", "DOGE", "1INCH", "PEPE2"][Math.floor(rnd() * 10)]!;
    for (let i = 0; i < 400; i++) {
      const spec: FiguresSpec = [
        { kind: "major", symbol: sym(), rank: Math.floor(rnd() * 1200), priceUsd: n(), marketCapUsd: n(), volume24hUsd: n(), change24hPct: n(), change7dPct: n() },
        { kind: "pools", coins: [0, 1, 2, 3].map(() => ({ symbol: sym(), change24hPct: n(), volume24hUsd: n() })) },
        { kind: "crowd", symbols: [sym(), sym(), sym()] },
        { kind: "flow", buyUsd: n(), sellUsd: n() },
      ];
      const line = renderFiguresLine(spec.filter(() => rnd() < 0.7));
      if (line === null) continue;
      assert.ok(admitFiguresLine(line), line);
      assert.match(line, /^[a-z :;,.$#~%+\-0-9A-Z]+$/, line);
      assert.doesNotMatch(line, /SHERWOOD|🐸|http|@/);
    }
  });
});

describe("fitting it into the answer", () => {
  const words = "it's up a little today on coingecko and the week looks soft, not a call.";

  it("between the words and the notice, the whole line when it fits", () => {
    const r = withFigures(`${words} ${NOTICE}`, BTC);
    assert.equal(r.text, `${words} coingecko: $BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%. ${NOTICE}`);
    assert.equal(r.dropped, 0);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED);
  });

  it("words that end without a stop get one; a lowercase notice stays as written", () => {
    const r = withFigures(`its up a little today on coingecko ${NOTICE.toLowerCase()}`, BTC);
    assert.match(r.text, /^its up a little today on coingecko\. coingecko: \$BTC #1, .* say stop to opt out\.$/);
  });

  it("too long for X: the least telling fields go first, then the line", () => {
    const long = "x".repeat(175) + " up a little on coingecko today.";
    const r = withFigures(`${long} ${NOTICE}`, BTC);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED, String(xWeightedLength(r.text)));
    assert.ok(r.line !== null && r.dropped > 0);
    assert.doesNotMatch(r.line!, /7d/, "the week went first");
    assert.match(r.line!, /\$BTC #1/, "the rank goes last");
    const longer = "x".repeat(240) + " today.";
    const none = withFigures(`${longer} ${NOTICE}`, BTC);
    assert.equal(none.line, null);
    assert.equal(none.text, `${longer} ${NOTICE}`, "no form fits: the gate's text as it was");
  });

  it("what's hot sheds coingecko's list, then the third coin, then fomo's, then coins, then volume, before the line", () => {
    const mid = "y".repeat(110) + ", not a call.";
    const r = withFigures(`${mid} ${NOTICE}`, HOT);
    assert.ok(r.line);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED);
    assert.doesNotMatch(r.line!, /coingecko: trending/);
    assert.match(r.line!, /^geckoterminal robinhood: trending \$ABC/);
    // As the words grow, each shorter form in turn, and every post fits.
    const seen: (string | null)[] = [];
    for (let n = 4; n <= 270; n++) {
      const f = withFigures(`${"z".repeat(n)}. ${NOTICE}`, HOT);
      if (f.line) assert.ok(xWeightedLength(f.text) <= X_MAX_WEIGHTED, String(n));
      if (seen.at(-1) !== f.line) seen.push(f.line);
    }
    assert.deepEqual(seen, [
      renderFiguresLine(HOT),
      "geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M, $DEF 24h -8.3% vol ~$310k, $GHI 24h +5% vol ~$90k; fomo: most bought $DEF.",
      "geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M, $DEF 24h -8.3% vol ~$310k; fomo: most bought $DEF.",
      "geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M, $DEF 24h -8.3% vol ~$310k.",
      "geckoterminal robinhood: trending $ABC 24h +42.1% vol ~$1.2M.",
      "geckoterminal robinhood: trending $ABC 24h +42.1%.",
      null,
    ]);
  });

  it("no notice, no words, or nothing showable: unchanged", () => {
    assert.equal(withFigures(words, BTC).line, null);
    assert.equal(withFigures(NOTICE, BTC).line, null);
    assert.equal(withFigures(`${words} ${NOTICE}`, []).line, null);
    assert.equal(withFigures(`${words} ${NOTICE}`, null).text, `${words} ${NOTICE}`);
  });
});

describe("never read back as its own words", () => {
  it("a posted answer without its line, the notice where it was", () => {
    const posted = withFigures(`its up a little today on coingecko. ${NOTICE}`, BTC).text;
    assert.equal(withoutFiguresLine(posted), `its up a little today on coingecko. ${NOTICE}`);
    const hot = withFigures(`a few movers on the index, not a call. ${NOTICE}`, HOT).text;
    assert.equal(withoutFiguresLine(hot), `a few movers on the index, not a call. ${NOTICE}`);
    assert.equal(withoutFiguresLine(`a few movers, not a call. ${renderFiguresLine(HOT)}`), "a few movers, not a call.", "with the notice already off");
  });

  it("two answers with different figures read the same, and so do two with the same figures", () => {
    const a = withFigures(`steady on coingecko today. ${NOTICE}`, BTC).text;
    const b = withFigures(`steady on coingecko today. ${NOTICE}`, [{ ...BTC[0]!, change24hPct: -9 } as FiguresSpec[number]]).text;
    assert.notEqual(a, b);
    assert.equal(withoutFiguresLine(a), withoutFiguresLine(b));
  });

  it("text that only looks like a line is left as it was", () => {
    for (const t of ["nothing here. Say stop to opt out.", "coingecko: $btc #1. Say stop to opt out.", "coingecko: $BTC #1, buy. Say stop to opt out."]) {
      assert.equal(withoutFiguresLine(t), t);
    }
  });
});
