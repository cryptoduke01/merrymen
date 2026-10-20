import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CHAINS,
  SOLANA_USDG_MINT,
  allChains,
  base58Decode,
  base58Encode,
  canonicalId,
  chainInfo,
  chainOfEvmId,
  explorerUrl,
  idFamily,
  isSolanaKeypair,
  onchainIdIn,
  onchainIdsIn,
  redactSolanaIds,
  requireChain,
  sameId,
  secretScanBudget,
  solanaSecretIn,
  solanaSecretsIn,
} from "./ids";
import { CASH } from "./tokens";

const EVM = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EVM_HASH = `0x${"Ab".repeat(32)}`;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** A real ed25519 keypair, its base58 secret, and a real signature by it. */
function keypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { pub: base58Encode(pub), secret, secretB58: base58Encode(secret), sig: base58Encode(sig) };
}

describe("the chain registry", () => {
  it("names Robinhood Chain and Solana, mainnet and test, and nothing else", () => {
    assert.deepEqual(allChains().map((c) => c.ref), [CHAINS.robinhood, CHAINS.robinhoodTestnet, CHAINS.solana, CHAINS.solanaDevnet]);
    assert.equal(chainInfo(CHAINS.solana)?.family, "solana");
    assert.equal(chainInfo(CHAINS.robinhood)?.evmChainId, 4663);
    assert.equal(chainInfo(CHAINS.solanaDevnet)?.realMoney, false);
  });

  it("is fail-closed: an unknown chain is null, never a default", () => {
    for (const bad of ["eip155:1", "solana:mainnet", "", null, 4663, "EIP155:4663"]) assert.equal(chainInfo(bad), null, String(bad));
    assert.throws(() => requireChain("eip155:8453"), /unknown chain/);
    assert.equal(chainOfEvmId(4663), CHAINS.robinhood);
    assert.equal(chainOfEvmId(46630), CHAINS.robinhoodTestnet);
    for (const id of [1, 8453, 0, -1, 4663.5, "4663"]) assert.equal(chainOfEvmId(id), null, String(id));
  });

  it("keeps the books in USDG on both chains, at 6 decimals", () => {
    assert.equal(chainInfo(CHAINS.robinhood)?.cash.address, CASH.USDG.toLowerCase());
    assert.equal(chainInfo(CHAINS.solana)?.cash.address, SOLANA_USDG_MINT);
    for (const c of allChains()) assert.equal(c.cash.decimals, 6);
    assert.equal(base58Decode(SOLANA_USDG_MINT)?.length, 32);
  });
});

describe("base58", () => {
  it("round-trips, leading zero bytes included", () => {
    assert.deepEqual(base58Decode(SYSTEM_PROGRAM), new Uint8Array(32));
    assert.equal(base58Encode(new Uint8Array(32)), SYSTEM_PROGRAM);
    for (const s of [SOLANA_USDG_MINT, keypair(7).pub, keypair(9).sig]) assert.equal(base58Encode(base58Decode(s)!), s);
  });

  it("refuses characters outside the alphabet (0, O, I, l)", () => {
    for (const s of ["0abc", "Oabc", "Iabc", "labc", "", "a b"]) assert.equal(base58Decode(s), null, s);
  });
});

describe("canonical ids", () => {
  it("lowercases EVM ids and keeps Solana ids exactly as written", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", EVM), EVM.toLowerCase());
    assert.equal(canonicalId(CHAINS.robinhood, "op", EVM_HASH), EVM_HASH.toLowerCase());
    assert.equal(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT), SOLANA_USDG_MINT);
    const { sig } = keypair(3);
    assert.equal(canonicalId(CHAINS.solana, "op", sig), sig);
  });

  it("never treats a case-folded Solana id as the same id", () => {
    assert.notEqual(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT.toLowerCase()), SOLANA_USDG_MINT);
    assert.equal(sameId(CHAINS.solana, "token", SOLANA_USDG_MINT, SOLANA_USDG_MINT.toLowerCase()), false);
    assert.equal(sameId(CHAINS.robinhood, "token", EVM, EVM.toLowerCase()), true);
  });

  it("refuses an id of the other family, the wrong length, or on an unknown chain", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", SOLANA_USDG_MINT), null);
    assert.equal(canonicalId(CHAINS.solana, "token", EVM), null);
    assert.equal(canonicalId(CHAINS.solana, "op", SOLANA_USDG_MINT), null, "a 32-byte key is not a signature");
    assert.equal(canonicalId(CHAINS.solana, "token", keypair(4).sig), null, "a signature is not a key");
    assert.equal(canonicalId("eip155:1", "token", EVM), null);
  });

  it("names the family of a bare id by its shape", () => {
    assert.equal(idFamily(EVM), "evm");
    assert.equal(idFamily(EVM_HASH), "evm");
    assert.equal(idFamily(SOLANA_USDG_MINT), "solana");
    assert.equal(idFamily("PEPE"), null);
  });
});

describe("explorer links", () => {
  it("Blockscout for Robinhood Chain, Solscan for Solana, the cluster for devnet", () => {
    assert.equal(explorerUrl(CHAINS.robinhood, "op", EVM_HASH), `https://robinhoodchain.blockscout.com/tx/${EVM_HASH.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "token", EVM), `https://robinhoodchain.blockscout.com/token/${EVM.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.solana, "token", SOLANA_USDG_MINT), `https://solscan.io/token/${SOLANA_USDG_MINT}`);
    assert.equal(explorerUrl(CHAINS.solanaDevnet, "account", SOLANA_USDG_MINT), `https://solscan.io/account/${SOLANA_USDG_MINT}?cluster=devnet`);
    assert.equal(explorerUrl(CHAINS.solana, "token", "not-a-mint"), null);
  });
});

describe("on-chain id detection", () => {
  it("finds EVM ids, Solana keys and signatures, and Solana explorer links", () => {
    const { sig } = keypair(5);
    const text = `bought ${SOLANA_USDG_MINT} at ${EVM} tx ${EVM_HASH} sig ${sig} https://solscan.io/tx/${sig}`;
    const hits = onchainIdsIn(text);
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "address" && h.value === SOLANA_USDG_MINT));
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "hash" && h.value === sig));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "address"));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "hash"));
    assert.ok(hits.some((h) => h.shape === "link"));
  });

  it("leaves ordinary prose alone", () => {
    for (const t of ["supercalifragilisticexpialidociousandmorewordsjoined", "the market is quiet today", "PEPE pumped 40% on the week", ""]) {
      assert.equal(onchainIdIn(t), false, t);
    }
  });

  it("detects letters-only public keys and signature encodings", () => {
    // A real ed25519 public key with no digits, from a deterministic test seed.
    const seed = new Uint8Array(32);
    new DataView(seed.buffer).setUint32(0, 4900, true);
    const pub = base58Encode(ed25519.getPublicKey(seed));
    assert.equal(pub, "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT");
    const signature = "A".repeat(87);
    assert.equal(canonicalId(CHAINS.solana, "account", pub), pub);
    assert.equal(canonicalId(CHAINS.solana, "op", signature), signature);
    assert.deepEqual(onchainIdsIn(`owner ${pub}, signature ${signature}`), [
      { family: "solana", shape: "address", value: pub },
      { family: "solana", shape: "hash", value: signature },
    ]);
  });
});

describe("glued on-chain id detection (audit regressions F3)", () => {
  const SIG = "3NGW7mkqWR84fuKhxiUmVTJg8AehpcEQHKZcivruB5449akQiFvm2Ej6AvJGLnfwW15Cb2wn1D6UAFMJtXh6tigd";
  const glued = { glued: true };

  it("finds a mint or signature written against neighbouring letters or digits, and returns the whole run", () => {
    for (const [text, value, shape] of [
      [`grab it CA${SOLANA_USDG_MINT} now`, `CA${SOLANA_USDG_MINT}`, "address"],
      [`${SOLANA_USDG_MINT}is the one`, `${SOLANA_USDG_MINT}is`, "address"],
      [`0${SOLANA_USDG_MINT}`, SOLANA_USDG_MINT, "address"],
      [`${SOLANA_USDG_MINT}l`, SOLANA_USDG_MINT, "address"],
      [`${SOLANA_USDG_MINT}x`, `${SOLANA_USDG_MINT}x`, "address"],
      // 89 characters: long enough to hide a signature, so that is the shape reported.
      [`${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, `${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, "hash"],
      [`tx${SIG}done`, `tx${SIG}done`, "hash"],
      // After a 0, an x with more than hex behind it is the run's own, so the whole run is the hit.
      [`0x${SOLANA_USDG_MINT}`, `x${SOLANA_USDG_MINT}`, "address"],
    ] as const) {
      // The default scan, pinned to Brain's mirror, misses each of these.
      assert.deepEqual(onchainIdsIn(text).filter((h) => h.family === "solana"), [], text);
      assert.deepEqual(onchainIdsIn(text, glued), [{ family: "solana", shape, value }], text);
      assert.equal(onchainIdIn(text, glued), true);
      assert.ok(text.split(value).join("[address]").indexOf(SOLANA_USDG_MINT.slice(0, 20)) < 0, "a redactor strips the whole id");
    }
  });

  it("finds everything the default scan finds", () => {
    const { sig, pub, secretB58 } = keypair(5);
    for (const text of [`bought ${SOLANA_USDG_MINT} at ${EVM} tx ${EVM_HASH} sig ${sig} https://solscan.io/tx/${sig}`,
      `owner ${pub}, ${"A".repeat(87)}`, `the system program 11111111111111111111111111111111 owns it`, `exported ${secretB58}`,
      `ca:${SOLANA_USDG_MINT}_v2`, `${SOLANA_USDG_MINT},${sig}`]) {
      const strict = onchainIdsIn(text, glued);
      for (const hit of onchainIdsIn(text)) assert.ok(strict.some((h) => h.value === hit.value && h.shape === hit.shape), `${text}: ${hit.value}`);
    }
  });

  it("answers every shared case as Brain's Python mirror does, in both scans", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../services/brain/tests/data/onchain_ids.json", import.meta.url), "utf8")) as
      { cases: { text: string; hits: { family: string; shape: string; value: string }[]; glued?: { family: string; shape: string; value: string }[] }[] };
    const changed: string[] = [];
    for (const c of fixture.cases) {
      const strict = onchainIdsIn(c.text, glued);
      assert.deepEqual(onchainIdsIn(c.text), c.hits, c.text);
      assert.deepEqual(strict, c.glued ?? c.hits, c.text);
      for (const hit of c.hits) assert.ok(strict.some((h) => h.value === hit.value && h.shape === hit.shape), `${c.text}: ${hit.value}`);
      if (c.glued) changed.push(c.text);
    }
    // The glued cases the default misses, among them the three it pinned as no id before.
    for (const t of [`0${SOLANA_USDG_MINT}`, `${SOLANA_USDG_MINT}l`, `${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, `grab it CA${SOLANA_USDG_MINT} now`]) assert.ok(changed.includes(t), t);
  });

  it("reads a key that begins with an x written after a 0 (\"10x<key>\", \"CA0x<key>\")", () => {
    // A real 32-byte key whose first character is x: dropped as the x of an "0x", the 42 left decoded to nothing.
    const xKey = "xD8ndgHckqX4TKpPgeRJ8o8Mmp8qE4bZ9USpRzQN4Uj";
    assert.equal(base58Decode(xKey)?.length, 32);
    for (const text of [`0${xKey}`, `price 10${xKey} today`, `grab it CA0${xKey} now`, `0${xKey}is the one`]) {
      const hits = onchainIdsIn(text, glued);
      assert.equal(hits.length, 1, text);
      assert.ok(hits[0]!.value.includes(xKey), text);
      assert.ok(!redactSolanaIds(text, () => "[id]").includes(xKey.slice(1, 21)), text);
    }
    // "0x" then hex alone is still that hex, whichever letters it holds.
    for (const text of [`0x${"ab".repeat(20)}`, `0x${"cafe".repeat(20)}`, `0x${"1".repeat(41)}`, "0x177286bb17374e1f47a767a43d99c674b38c4f54c8e"]) {
      assert.deepEqual(onchainIdsIn(text, glued).filter((h) => h.family === "solana"), [], text);
    }
  });

  it("never reads hex split at its zeros, a long number or filler as an id glued to anything", () => {
    // Each run between zeros is hex alone, and some are 43 or 44 characters that decode to 32 bytes:
    // read as glued ids, every digest, EVM hash and long number like these was withheld.
    for (const text of [
      "6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa",
      "| `MERRYMEN_ADOPT_HOME_HALT_SHA256` | `6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa` |",
      "02D20BBD7E394AD5999A4CEBABAC9619732C343A4CAC99470C03E23BA2BDC2BC",
      "supply 63971511409728546707420640415976470808777281049430980144558505433936508649475518010444363585908687133263558897911835323323191563463575735092780586118530448 ok",
    ]) assert.deepEqual(onchainIdsIn(text, glued), [], text);
    const tx = "0x177286bb17374e1f47a767a43d99c674b38c4f54c8e00bb2042998a8fd1b4a4c";
    assert.deepEqual(onchainIdsIn(`tx ${tx}`, glued), [{ family: "evm", shape: "hash", value: tx }]);
    // Filler, one to four characters repeated (a length test's padding, "hahaha"): 87 x's decode to 64 bytes.
    for (const text of ["x".repeat(220), `${"x".repeat(2_500)}`, "ha".repeat(60), `${"abc".repeat(40)}!`, "wxyz".repeat(30)]) {
      assert.deepEqual(onchainIdsIn(text, glued), [], text.slice(0, 12));
    }
    // ...but a letters-only signature glued to a letter is still one.
    assert.deepEqual(onchainIdsIn(`${"A".repeat(87)}h`, glued), [{ family: "solana", shape: "hash", value: `${"A".repeat(87)}h` }]);
    // A standalone run is read exactly as the default reads it, hex alone or not.
    const hexKey = "abcdef123456789abcdef123456789abcdef1234567";
    assert.deepEqual(onchainIdsIn(`digest ${hexKey} ok`, glued), onchainIdsIn(`digest ${hexKey} ok`));
    assert.deepEqual(onchainIdsIn(`digest ${hexKey} ok`, glued), [{ family: "solana", shape: "address", value: hexKey }]);
  });

  it("leaves prose, tickers, hex digests, long numbers and other base58 alone", () => {
    for (const text of [
      "the market is quiet today", "PEPE pumped 40% on the week", "$SOL $BONK $WIF $JUP and $USDG",
      "supercalifragilisticexpialidociousandmorewordsjoined", "merrymen:meme dec_9f2c4b7a1e3d5f60 [ref:d3fa91cr2c1] up to 30 minutes",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "abcdef123456789".repeat(5),
      "ABCDEF123456789abcdef".repeat(4), "2345678923456789234567892345678923456789", "9".repeat(120),
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa paid", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "#BuyTheDipAndHoldForeverBecauseSolanaIsTheFuture", "0x11111111111111111111111111111111111111111", "",
      `0x${"Ab".repeat(30)}`, `0x${"cafe".repeat(20)}`,
    ]) assert.deepEqual(onchainIdsIn(text, glued), [], text);
  });

  it("redactSolanaIds replaces the longest value first, so a run holding a shorter hit is never split around a mint", () => {
    const key = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff));
    const text = `${key} then X${SOLANA_USDG_MINT}${key}Y`;
    // In scan order the lone key comes first, and its value is the end of the second run.
    const hits = onchainIdsIn(text, glued);
    assert.deepEqual(hits.map((h) => h.value), [key, `X${SOLANA_USDG_MINT}${key}Y`]);
    assert.equal(redactSolanaIds(text, () => "[id]"), "[id] then [id]");
    // Each hit is named by its own shape, and a link keeps its address, losing only the id in it.
    const { sig } = keypair(5);
    const marked = redactSolanaIds(`${key} https://solscan.io/tx/${sig} ${EVM}`, (h) => `[${h.shape}]`);
    assert.equal(marked, `[address] https://solscan.io/tx/[hash] ${EVM}`);
    assert.equal(redactSolanaIds("the market is quiet today", () => "[id]"), "the market is quiet today");
  });

  it("reads a megabyte of long base58 runs in linear time and fails closed past its budget", () => {
    // Runs that hold no 43- or 44-character key window (short of one, or hex alone), and runs that hold a signature.
    const noKeyRun = (i: number) => (i % 3 ? "1" + "z".repeat(31 + (i % 10)) : "abcdef12345".repeat(9));
    const keyLikeRun = (i: number) => `${base58Encode(Uint8Array.from({ length: 64 }, (_, j) => (i * 7 + j * 13 + 1) % 256))}x${i}`;
    const textOf = (count: number, run: (i: number) => string) => Array.from({ length: count }, (_, i) => run(i)).join(" ");
    const noKey = textOf(30_000, noKeyRun);
    assert.ok(noKey.length > 1_000_000);
    assert.deepEqual(onchainIdsIn(noKey.slice(0, 5_000), glued), [], "none of these runs holds an id");
    assert.ok(onchainIdsIn(noKey, glued).length > 0, "past the decode budget, the remaining runs are refused unread");
    const keyLike = textOf(12_000, keyLikeRun);
    assert.ok(keyLike.length > 1_000_000);
    assert.equal(onchainIdIn(keyLike, glued), true);

    // BOUNDED TIME, MEASURED AGAINST THIS MACHINE IN THIS RUN, never a wall clock: a fixed 2-second
    // budget failed at 4.8 s on a runner with a load average near 100. Each figure is the best of
    // several runs (load only ever adds time), and both sides of a comparison share the machine.
    // - Linear: 32 times the text costs at most 4 x 32 times the time (measured 17-19x). A scan
    //   quadratic in its text costs about 1,000x; an exponential one never returns.
    // - A constant of the default scan over the same text, which decodes every standalone run with
    //   no budget (measured 4.5-6.6x): a glued scan that grew a large constant fails here too.
    // The 5 ms is timer and scheduling slack on the smaller figure, not a budget.
    const best = (runs: number, scan: () => unknown): number => {
      let least = Infinity;
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        scan();
        least = Math.min(least, performance.now() - started);
      }
      return least;
    };
    for (const [name, big, run, count] of [["no key", noKey, noKeyRun, 30_000], ["key-like", keyLike, keyLikeRun, 12_000]] as const) {
      const small = textOf(Math.ceil(count / 32), run);
      best(2, () => onchainIdsIn(small, glued));
      const tSmall = best(5, () => onchainIdsIn(small, glued));
      const tBig = best(3, () => onchainIdsIn(big, glued));
      const tDefault = best(3, () => onchainIdsIn(big));
      const took = `${name}: ${tBig.toFixed(1)} ms for ${big.length} characters, ${tSmall.toFixed(1)} ms for ${small.length}, default scan ${tDefault.toFixed(1)} ms`;
      assert.ok(tBig < 4 * 32 * tSmall + 5, `not linear in the text: ${took}`);
      assert.ok(tBig < 50 * tDefault + 5, `far slower than the default scan: ${took}`);
    }
  });
});

describe("Solana secret detection", () => {
  it("flags a keypair as base58 or as an id.json byte array", () => {
    const { secret, secretB58 } = keypair(11);
    assert.equal(isSolanaKeypair(secret), true);
    assert.equal(solanaSecretIn(`key: ${secretB58}`), true);
    assert.equal(solanaSecretIn(`[${[...secret].join(",")}]`), true);
    assert.equal(solanaSecretIn(JSON.stringify([...secret], null, 2)), true);
  });

  it("never mistakes a signature, a public key or random bytes for a secret", () => {
    const { sig, pub } = keypair(13);
    assert.equal(solanaSecretIn(`sig ${sig}`), false, "a signature is 64 bytes but no keypair");
    assert.equal(solanaSecretIn(`owner ${pub} ${SOLANA_USDG_MINT}`), false);
    const random = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(isSolanaKeypair(random), false);
    assert.equal(solanaSecretIn(`[${[...random].join(",")}]`), false);
  });

  it("solanaSecretsIn returns each secret exactly as written, and only secrets", () => {
    const a = keypair(17);
    const b = keypair(19);
    const array = JSON.stringify([...b.secret], null, 2);
    const text = `PRIVATE_KEY=${a.secretB58}\nsig ${a.sig} owner ${a.pub}\nid.json: ${array}`;
    assert.deepEqual(solanaSecretsIn(text), [a.secretB58, array]);
    for (const s of solanaSecretsIn(text)) assert.ok(text.includes(s));
    assert.deepEqual(solanaSecretsIn(`sig ${a.sig}`), []);
    for (const x of [null, undefined, 42, "", "short"]) assert.deepEqual(solanaSecretsIn(x), []);
  });

  it("reads a near-miss byte array in linear time", () => {
    // Values 10-19 once matched two ways each, so an array that failed at its
    // end backtracked 2^k times: k=20 took about half a second, k=63 forever.
    // 22 is enough to fail this on the old pattern in seconds rather than hang.
    const nearMiss = (value: string, sep: string, last: string) => `[${[...Array(22).fill(value), ...Array(41).fill("1")].join(sep)}${sep}${last}]`;
    const nearMisses = [
      nearMiss("11", ",", "999"),
      nearMiss("19", " , ", "256"),
      `[${Array(64).fill("10").join(",")}`,
      `${"[11,".repeat(2_000)}999]`,
    ];
    const started = performance.now();
    for (const text of nearMisses) assert.deepEqual(solanaSecretsIn(text), []);
    assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
  });

  it("caps the candidates it reads, and counts what it did not read as a secret", () => {
    const distinct = Array.from({ length: 150 }, (_, i) => keypair(i).sig);
    const sigs = [...distinct, ...distinct];
    const { secretB58 } = keypair(29);
    const found = solanaSecretsIn([...sigs, secretB58].join(" "));
    assert.equal(found.length, 300 - 256 + 1, "the first 256 are read; the rest, the key included, are refused unread");
    assert.equal(found.at(-1), secretB58, "a key past the cap is never let through");
    assert.deepEqual(solanaSecretsIn(sigs.slice(0, 256).join(" ")), [], "up to the cap, signatures stay signatures");
    const addresses = Array.from({ length: 1_000 }, (_, i) => keypair(i % 150).pub).join(" ");
    assert.deepEqual(solanaSecretsIn(`${addresses} ${secretB58}`), [secretB58], "an address is too short to be a candidate");

    const budget = secretScanBudget();
    for (const sig of sigs.slice(0, 256)) assert.equal(solanaSecretIn(sig, budget), false);
    assert.equal(solanaSecretIn(sigs[256], budget), true, "scans sharing a budget are capped together");
  });

  it("reads a megabyte of key-shaped text in bounded time", () => {
    const runs = Array.from({ length: 64 }, (_, i) => base58Encode(Uint8Array.from({ length: 64 }, (_, j) => (i * 7 + j * 13 + 1) % 256)));
    const text = Array.from({ length: 12_000 }, (_, i) => (i % 2 ? runs[i % 64] : `[${Array(64).fill(i % 200).join(",")}]`)).join(" ");
    assert.ok(text.length > 1_000_000);
    const started = performance.now();
    assert.equal(solanaSecretIn(text), true, "past the cap it fails closed");
    assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
  });
});
