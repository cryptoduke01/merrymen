/**
 * A launched token's own description, logo and socials — from the chain.
 *
 * THE FINDING THIS FILE EXISTS FOR: none of this needs a browser, an API key,
 * an indexer, or a page fetch. Every Pons token is the same 3,248-byte template
 * and it publishes its own metadata as a public getter. One `eth_call` returns
 * the deployer, the logo URI, the description and five social slots.
 *
 * That matters because the alternative was a headless browser on Railway to
 * scrape a launchpad page — memory, fragility, and an apt layer, to obtain
 * something the contract hands over for free. It also beats decoding the launch
 * transaction's calldata, which was tried and is strictly worse: it needs an
 * extra `eth_getTransactionByHash` per launch, has to handle at least five
 * entrypoint selectors across three router addresses, and silently failed on
 * 3.4% of launches this getter handled. Where both worked they agreed 702/702.
 *
 * MEASURED COVERAGE over 926 launches in one hour: twitter 81.7%, website
 * 38.4%, description 65.2%, logo 99.6%, telegram 8.2%, discord 0.2%. 84% carry
 * at least one social. The fifth slot was never populated in 4,800+ tokens.
 *
 * WHAT IT IS NOT. Every string here is written by whoever launched the token.
 * It is a CLAIM, useful for telling an abandoned template apart from something
 * with a person behind it, and worthless as evidence of anything. Treat it the
 * way discovery.ts already treats a symbol: attacker-chosen text headed for a
 * human, sanitised before it is shown and never trusted as identity.
 */
import type { PublicClient } from "viem";
import { decodeAbiParameters } from "viem";

/** The template's combined metadata getter: (deployer, logo, description, socials). */
const SEL_METADATA = "0xabb1dc44" as const;

/** Multicall3, at its canonical address — deployed on chain 4663. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * How many tokens go in one Multicall3 batch.
 *
 * 400 was measured against the public RPC: an hour of launches (926 tokens) is
 * three calls and under four seconds, with zero failures. Larger batches start
 * to risk the node's response limits for no useful gain.
 */
export const META_BATCH = 400;

/**
 * Multicall3's `aggregate3`, exported so every batched reader on this chain
 * shares one definition.
 *
 * `allowFailure` is the load-bearing part and the reason this is worth sharing:
 * a sub-call that reverts is an ordinary fact about ONE address — not a Pons
 * template token, not a curve — and it must not take the other 399 with it.
 */
export const AGGREGATE3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** One batch of `(target, calldata)` reads. Never throws — a failed BATCH is a
 *  missing fact about that batch, and the caller gets an empty array to say so. */
export async function aggregate3(
  client: PublicClient,
  calls: readonly { target: `0x${string}`; callData: `0x${string}` }[],
): Promise<readonly { success: boolean; returnData: `0x${string}` }[]> {
  if (calls.length === 0) return [];
  try {
    return (await client.readContract({
      address: MULTICALL3,
      abi: AGGREGATE3_ABI,
      functionName: "aggregate3",
      args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
    })) as readonly { success: boolean; returnData: `0x${string}` }[];
  } catch {
    return [];
  }
}

const METADATA_ABI = [
  { type: "address" },
  { type: "string" },
  { type: "string" },
  {
    type: "tuple",
    components: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }],
  },
] as const;

/** What a token says about itself. Every field is the launcher's own claim. */
export interface TokenMeta {
  token: `0x${string}`;
  /** Who deployed it, per the token itself. Recorded, never a trust signal. */
  deployer: `0x${string}`;
  /** Usually an ipfs:// URI. Present on 99.6% of launches. */
  logo: string;
  description: string;
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  /** True when it published nothing at all — the shape an abandoned template has. */
  bare: boolean;
}

/**
 * Strip a launcher-written string down to something safe to show a human.
 *
 * Same reasoning as `sanitizeSymbol`, applied harder because these are longer
 * and freer: they will land in a dashboard row, a Telegram message and — the
 * one that actually matters — a prompt. Newlines and control characters go
 * because a description containing "\n\nIGNORE THE ABOVE" is the cheapest
 * prompt injection there is, and length is capped because a token can publish a
 * kilobyte and a model will read all of it.
 *
 * WHAT THIS CLASS MISSED, and why the list below is longer. Serializing through
 * `JSON.stringify` escapes C0, so the naive injection above really was
 * neutralised — but that is the ONLY class it handles. Zero-width characters,
 * BiDi overrides and isolates, and Unicode tag characters all survive
 * JSON.stringify VERBATIM, and every one of them is invisible: a name can carry
 * a second sentence a reader cannot see and a model reads plainly. The tag
 * block (U+E0000–U+E007F) is the sharpest of them, being a whole shadow ASCII
 * alphabet. Reimplemented from the equivalent guard in Vex
 * (github.com/Vex-Foundation/Vex), used with its author's permission.
 *
 * U+200D ZERO WIDTH JOINER is deliberately KEPT: it is load-bearing inside emoji
 * sequences, which memecoin names are made of, and dropping it turns one glyph
 * into three. TAB/LF/CR stay in the C0 class above only to be collapsed into a
 * space by the whitespace rule, which is what they were always doing.
 *
 * SANITISING AND BOUNDING STAY SEPARATE, and the second one is lossy. Removing
 * invisibles costs a reader nothing they could see; a length cut removes
 * meaning, so it is applied once, last, and counted the way a reader counts.
 */
const INVISIBLE = new RegExp(
  [
    // zero-width space / non-joiner, word joiner, the BOM (a.k.a. ZWNBSP)
    "[\\u200B\\u200C\\u2060\\uFEFF]",
    // BiDi: the LRM/RLM marks, the embedding+override controls, the isolates
    "[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
    // Unicode TAG characters — an invisible ASCII alphabet
    "[\\u{E0000}-\\u{E007F}]",
  ].join("|"),
  "gu",
);

export function sanitizeMeta(raw: string, max = 200): string {
  const cleaned = raw
    // C0 and C1 control characters, written as ESCAPES. They used to sit in
    // this class as literal bytes — a real NUL among them — which made the file
    // read as binary to grep and diff, and left the class one careless
    // save-with-normalisation away from silently changing meaning.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  // COUNT BY CODE POINT, not by UTF-16 unit. `slice` cuts at a unit boundary,
  // so a cap landing mid-surrogate leaves a lone half — an unpaired surrogate
  // that JSON.stringify emits as a literal \udXXX escape and that some
  // consumers reject outright. An emoji is two units and one character, and
  // the reader's count is the one worth honouring.
  const points = [...cleaned];
  return points.length <= max ? cleaned : points.slice(0, max).join("");
}

/** Decode one metadata return, or null when it is not a Pons template token. */
export function parseTokenMeta(token: `0x${string}`, data: `0x${string}` | undefined): TokenMeta | null {
  if (!data || data.length < 10) return null;
  try {
    const [deployer, logo, description, socials] = decodeAbiParameters(METADATA_ABI, data) as [
      `0x${string}`,
      string,
      string,
      readonly [string, string, string, string, string],
    ];
    const [twitter, telegram, discord, website] = socials;
    const clean = {
      token,
      deployer: deployer.toLowerCase() as `0x${string}`,
      logo: sanitizeMeta(logo, 300),
      description: sanitizeMeta(description),
      twitter: sanitizeMeta(twitter, 200),
      telegram: sanitizeMeta(telegram, 200),
      discord: sanitizeMeta(discord, 200),
      website: sanitizeMeta(website, 200),
    };
    return {
      ...clean,
      bare: !clean.description && !clean.twitter && !clean.telegram && !clean.discord && !clean.website,
    };
  } catch {
    // A decode failure means "not a token of this template", which is a
    // different fact from "published nothing" — and the caller needs to be able
    // to tell them apart, so it gets a null rather than a bare TokenMeta.
    return null;
  }
}

/**
 * Read metadata for many tokens at once.
 *
 * Batched through Multicall3 with `allowFailure`, because a sub-call that
 * reverts means the address is not a Pons template token — a perfectly ordinary
 * thing for it to be — and one such address must not take the whole batch down
 * with it. Returns a map so a caller can tell "read and empty" from "not read".
 */
export async function readTokenMeta(
  client: PublicClient,
  tokens: readonly `0x${string}`[],
): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  for (let i = 0; i < tokens.length; i += META_BATCH) {
    const batch = tokens.slice(i, i + META_BATCH);
    // A failed BATCH is a missing fact about that batch, not about the tokens.
    // aggregate3 returns [] to say so, and leaving them absent from the map
    // keeps that distinction — inventing empty metadata for an unread token
    // would make it look like an abandoned one.
    const results = await aggregate3(
      client,
      batch.map((t) => ({ target: t, callData: SEL_METADATA as `0x${string}` })),
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (!r?.success) continue;
      const meta = parseTokenMeta(batch[j]!, r.returnData);
      if (meta) out.set(batch[j]!.toLowerCase(), meta);
    }
  }
  return out;
}
