/**
 * WHAT A TAG'S WORDS COULD BE, READ THE SAME FOR EVERY NAME (red-team review,
 * 2026-10-12). Pure: no model, no I/O, no state.
 *
 * Whether a word in a tag is a coin's name used to be decided by the coins
 * the agent itself bought: "is pepe legit?" was a coin (looked up, told it
 * named a coin) and "is bonk legit?" chat, so asking name by name told anyone
 * which coins it bought. Here nothing it bought is read. A word is everyday
 * (TAG_WORDS), or it might be a coin's name (nameLikeWords): never more.
 */

/**
 * WORDS A TAG IS MADE OF THAT NAME NO COIN: everyday English, how people talk
 * to an agent on X, and how they talk about coins and trading. Not a
 * dictionary: a word not here is only read as a word that might be a coin's
 * name, which errs toward caution (nothing looked up, the word never said
 * back), never toward a lookup.
 */
const TAG_WORDS: ReadonlySet<string> = new Set((
  "a about above actually after again against ago ai alan all almost already also always am an and anon another any anybody anyone anything anyway " +
  "approach are around as ask at away back bad be because been before being best better between big bigger bit both bro bros but buy by call can " +
  "cap care cash ca chain chains chart check choose chose coin come compare compared contract cool could crazy curve cycle data day days dear deep " +
  "dev did different dip do does doing done down dude during each early easy either else end enough entry even ever every everyone everything exit " +
  "fair fake fam far fast feel few find first flow fomo for fren frens fresh friend from fun full gain gas get give gm gn go going gone gonna good " +
  "got great guy guys had half happen hard has have he healthy hear hello help her here hey hi high his hold holder honest honestly hot how huge i " +
  "idea if in index into is it its just keep kind know last late lately launch launchpad least left legit less let life like little live liq " +
  "liquidity lmao lol long look lot lots love low made make man many market maybe mcap me mean meme memecoin merrymen might mine mint model " +
  "money month more morning most much must my name near need never new next nice night no none nope not nothing now number of off often oh ok okay " +
  "old on once one only onchain open opinion or other our out over owner own paper part people pick plan play please pls point pons pool position " +
  "post pretty price probably profit project pump question quick quiet rather real really reason recent recently right risk risky robinhood rug run " +
  "safe same say scam see seem select sell ser should show since sir small so some someone something sometimes soon sort spread start still stuff " +
  "such supply sure swap take talk tax team tell than thanks thank that the their them then there these they thin thing think this those though " +
  "thought thoughts through thx time to today token too top trade trader trencher true try ty type u ultra under until up ur us use usually very " +
  "view vol volume vs versus want was watch way we week well were what whale when where whether which while who whole why will wild with without " +
  "wonder work worth would wow ya yeah year yep yes yet yo you young your yours yup zero " +
  "bullish bearish bottom candle concentrated cex dex holders tokens traders buyers sellers safer riskier healthier stronger weaker cheaper " +
  "worse worst ape aped aping bought sold trading buying selling bag strategy style thesis agent bot account wallet fund funds activity tape " +
  "presale airdrop stake staking yield reward fee fees sniper address " +
  "vibe vibes spicy behind dead alive strong weak sus solid shady trust trusted official hype hyped cold chill send sent rip moon gem degen alpha " +
  "wen cook based mid goat ngmi wagmi lfg fud rekt tank floor ceiling ath support resistance breakout trend green red pnl roi apy apr " +
  "tonight tomorrow yesterday weekend hour minute second asked answer answered tag tagged reply replied posted posting thread " +
  "whats hows thats wheres whos dont doesnt didnt isnt arent wasnt cant wont wouldnt shouldnt couldnt havent hasnt lets gotta wanna kinda " +
  "anymore bet buddy chance close closer damn deal decent definitely everybody exactly feeling folks found guess " +
  "happy heard hmm hope interesting job joke lucky luck mate mostly nah nobody normal ones pal perfect personally quite rough " +
  "says saw seen seems simple smart sorry story totally trying understand weird whatever wondering worried yall " +
  "source scout hunt spot research decide filter screen scan grab snipe usual"
).split(/\s+/));

/** A word as TAG_WORDS lists it: an ending people add taken off, if what is left is listed. */
function tagWord(w: string): boolean {
  if (TAG_WORDS.has(w)) return true;
  for (const end of ["s", "es", "ed", "d", "ing", "er", "est", "ly", "y"]) {
    const stem = w.endsWith(end) ? w.slice(0, -end.length) : "";
    if (stem.length >= 2 && (TAG_WORDS.has(stem) || TAG_WORDS.has(`${stem}e`))) return true;
  }
  return false;
}

/** A tag's words, lowercase, with the endings of contractions taken off: "what's" is "what", "wif's" is "wif". */
function tagWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘ʼ]/g, "'").split(/[^a-z']+/)
    .map((raw) => raw.replace(/^'+|'+$/g, "").replace(/'(?:s|re|ve|ll|d|m|t)$/, "").replace(/n't$/, ""))
    .filter((w) => w !== "");
}

/**
 * THE WORDS OF A TAG THAT COULD BE A COIN'S NAME: each word of three letters
 * or more, a cashtag's $ aside, that is not an everyday one (TAG_WORDS).
 * "bonk" in "is $WOJAK safer than bonk?", "pepe" in "is pepe <contract>
 * legit?". The same for every name, whatever the agent bought.
 */
export function nameLikeWords(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(tagWords(text).filter((w) => /^[a-z]{3,}$/.test(w) && !tagWord(w)))];
}

/** Words that are talk about a coin or a trade. */
const COIN_TALK: ReadonlySet<string> = new Set(("coin coins token tokens ticker chart charts buy buys bought buying ape aped apes aping " +
  "sell sells sold selling trade trades traded trading holder holders liquidity liq volume mcap marketcap pump pumping pumped " +
  "dump dumped rug rugged legit scam safe safer risky riskier bag bags entry position ca contract launch launched curve pool dev devs").split(" "));

/**
 * TALK ABOUT A COIN BY A NAME (red-team review, 2026-10-12): a word about a
 * coin or a trade beside a word that might be a coin's name, "is pepe
 * legit?", "is bonk legit?", "did you buy pepe inu?". Read alike for every
 * name: an answer to it is told it named a coin, and is never told what it
 * bought, whatever the name is.
 */
export function asksAboutACoin(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const words = tagWords(text);
  return words.some((w) => COIN_TALK.has(w)) && nameLikeWords(text).length > 0;
}
