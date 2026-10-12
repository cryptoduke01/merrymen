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

/**
 * AND HOW AN AGENT TALKS ABOUT ITS OWN TRADING, in an answer told its buys:
 * the reasons it is handed for a buy (writer.ts BUY_GLOSS), its strategies'
 * names, and the everyday words of a casual line about how it trades. What
 * such an answer may say beside the coins it was told of (answerWords).
 */
const ANSWER_WORDS: ReadonlySet<string> = new Set((
  "pool behind sitting comfortably room plenty cheap wrong cost costs expensive barely started building nowhere caught getting along built " +
  "steady stable pace stream noticed busier busy crowd hands group hardly nudged touch pushed stood others looked feel felt fun nice reason " +
  "reasons because cause cuz since while liked enjoyed basket weekend gap even keel hunter trencher launches launch fresh shallow mood calm " +
  "boring exciting excited curious careful picky choosy patient patience chase chasing mostly mainly usually often sometimes rarely always " +
  "lately recently earlier couple handful bunch few some plenty enough lots names plays picks things stuff memecoins memes coins tokens " +
  "practice paper real money cash honestly vibes vibe quiet noise noisy loud slow slowly fast quick quickly small smaller bigger little " +
  "piece bite bits nibble moved moves move price prices thing guess anyway also too either though tho kinda sorta pretty really very just " +
  "only still yet again back around about over under into onto across through toward towards without within beside besides plus mix mixed " +
  "spot spots style approach rules rule habit habits plan way ways usual typical type kinds sort sorts variety diverse spread careful lucky " +
  "favourite favorite lean leaning tend tends tended prefer preferred like likes find finding found catch catching look looking watch " +
  "watching wait waiting patient sit sitting stay staying keep keeping hold holding hands slower faster quieter louder newer older earliest"
).split(/\s+/));

/** A word as a list has it: an ending people add taken off, if what is left is listed. */
function listedIn(list: ReadonlySet<string>, w: string): boolean {
  if (list.has(w)) return true;
  for (const end of ["s", "es", "ies", "ed", "d", "ing", "er", "est", "ly", "y"]) {
    if (!w.endsWith(end)) continue;
    const stem = w.slice(0, -end.length);
    if (stem.length < 2) continue;
    if (list.has(stem) || list.has(`${stem}e`) || (end === "ies" && list.has(`${stem}y`))) return true;
    // A doubled last letter: "grabbing" is "grab", "snipped" is "snip".
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2) && list.has(stem.slice(0, -1))) return true;
  }
  return false;
}
const tagWord = (w: string): boolean => listedIn(TAG_WORDS, w);

/** An everyday word of a tag (TAG_WORDS, endings people add taken off): never a coin's name to look up. */
export function everydayWord(w: string): boolean {
  return typeof w === "string" && tagWord(w.toLowerCase());
}

/** A word an answer told its buys may say beside the coins it was told of: everyday, or how it talks about its trading. */
export function answerWord(w: string): boolean {
  return tagWord(w) || listedIn(ANSWER_WORDS, w);
}

/** A text's words, lowercase, with the endings of contractions taken off: "what's" is "what", "wif's" is "wif". */
export function textWords(text: string): string[] {
  return tagWords(text);
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
 * HOW A DRAFT TALKS ABOUT A COIN'S MARKET (red-team 2026-10-12): "wif and
 * bonk look hot right now" went out as chat, handed nothing. Beside a word
 * that might be a coin's name, any of these is a coin named.
 */
const MARKET_TALK: ReadonlySet<string> = new Set(("coin coins token tokens memecoin memecoins buy buys buying bought ape aped aping pump pumping pumped " +
  "moon mooning gem gems hot trending ripping rally rallying surging bag bags bullish bearish play plays pick picks mover movers runner runners").split(" "));

/**
 * DOES A DRAFT NAME A COIN, BY ANY NAME? A word that might be a coin's name
 * (nameLikeWords: not an everyday word, not a word of the agent's own name)
 * beside market talk (MARKET_TALK). Read alike for every name; errs toward
 * yes: an answer handed nothing that it finds is not posted.
 */
export function coinTalkIn(text: unknown, ownName = ""): boolean {
  if (typeof text !== "string") return false;
  const own = new Set(tagWords(String(ownName ?? "")));
  return nameLikeWords(text).some((w) => !own.has(w) && !answerWord(w)) && tagWords(text).some((w) => MARKET_TALK.has(w));
}

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
