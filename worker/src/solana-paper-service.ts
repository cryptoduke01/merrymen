/** Read-only market preparation followed by one atomic paper-ledger commit. */
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, canonicalId } from "../../packages/core/src/ids";
import { isHostedMode } from "../../packages/core/src/hosted";
import {
  SOLANA_QUOTE_MAX_AGE_MS,
  parseSolanaSwapIntent,
  solanaPaperAgentId,
  validateSolanaQuote,
  type SolanaMint,
  type SolanaQuote,
  type SolanaSwapIntent,
} from "../../packages/core/src/solana";
import { SolanaMarketError } from "./solana-market";
import { solanaPaperIntentFingerprint, type SolanaPaperCommit, type SolanaPaperReceipt, type SolanaPaperSnapshot } from "./solana-paper-store";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export class SolanaPaperServiceError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaPaperServiceError"; }
}

export function assertSolanaPaperLocalMode(): void {
  if (isHostedMode()) {
    throw new SolanaPaperServiceError("Solana paper trading is local-only until hosted tenant binding is implemented.");
  }
}

export interface SolanaPaperMarket {
  readMint(address: string): Promise<SolanaMint>;
  quote(intent: SolanaSwapIntent): Promise<SolanaQuote>;
}

export interface SolanaPaperLedger {
  get(owner: string): SolanaPaperSnapshot | null | Promise<SolanaPaperSnapshot | null>;
  findTrade(owner: string, requestId: string): SolanaPaperReceipt | null | Promise<SolanaPaperReceipt | null>;
  commit(input: SolanaPaperCommit): SolanaPaperReceipt | Promise<SolanaPaperReceipt>;
}

function requireFreshMint(mint: SolanaMint, expected: string, nowMs: number): void {
  if (!mint || mint.address !== expected || canonicalId(CHAINS.solana, "token", mint.address) !== expected
    || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(mint.program)
    || !Number.isInteger(mint.decimals) || mint.decimals < 0 || mint.decimals > 18
    || !Number.isSafeInteger(mint.slot) || mint.slot < 1
    || !Number.isSafeInteger(mint.observedAtMs) || mint.observedAtMs > nowMs
    || nowMs - mint.observedAtMs >= SOLANA_QUOTE_MAX_AGE_MS
    || !Array.isArray(mint.buyBlockedReasons) || mint.buyBlockedReasons.some((reason) => typeof reason !== "string")) {
    throw new SolanaPaperServiceError("Solana mint evidence is missing, stale or inconsistent.");
  }
  if (expected === SOLANA_USDG_MINT && (mint.program !== TOKEN_2022_PROGRAM || mint.decimals !== 6)) {
    throw new SolanaPaperServiceError("The USDG mint does not match the configured cash asset.");
  }
}

/** Limit concurrent provider requests; a failed mark never becomes a zero valuation. */
async function mapBounded<T, U>(values: readonly T[], task: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]!, index);
    }
  }));
  return results;
}

export function createSolanaPaperService(
  store: SolanaPaperLedger,
  market: SolanaPaperMarket,
  now: () => number = Date.now,
  /** Server-authenticated scope with a tenant-partitioned ledger. Never request data. */
  scope?: { owner: string },
) {
  function assertScope(owner: string): void {
    if (!scope) return assertSolanaPaperLocalMode();
    solanaPaperAgentId(scope.owner);
    if (owner !== scope.owner) throw new SolanaPaperServiceError("The Solana paper owner does not match this authenticated account.");
  }
  async function prepare(owner: string, rawIntent: unknown, valuePortfolio: boolean) {
    assertScope(owner);
    solanaPaperAgentId(owner);
    const intent = parseSolanaSwapIntent(rawIntent);
    const book = await store.get(owner);
    if (!book) throw new SolanaPaperServiceError("Create the Solana paper book before requesting a trade.");
    if (now() >= book.limits.expiresAtMs) throw new SolanaPaperServiceError("The Solana paper book's limits have expired.");
    const buying = intent.inputMint === SOLANA_USDG_MINT;
    if (buying && BigInt(intent.amountRaw) > BigInt(book.cashRaw)) {
      throw new SolanaPaperServiceError("Insufficient simulated USDG for this buy.");
    }
    if (!buying) {
      const position = book.positions.find((p) => p.mint === intent.inputMint);
      if (!position || BigInt(intent.amountRaw) > BigInt(position.amountRaw)) {
        throw new SolanaPaperServiceError("Insufficient simulated token balance for this sell.");
      }
    }
    const [inputMint, outputMint] = await Promise.all([
      market.readMint(intent.inputMint), market.readMint(intent.outputMint),
    ]);
    requireFreshMint(inputMint, intent.inputMint, now());
    requireFreshMint(outputMint, intent.outputMint, now());
    if (buying && (inputMint.buyBlockedReasons.length || outputMint.buyBlockedReasons.length)) {
      throw new SolanaPaperServiceError("Buying is blocked by the current token safety checks.");
    }
    const quote = await market.quote(intent);
    validateSolanaQuote(quote, intent, now());
    // Prove a current route back to cash for exactly the simulated entry
    // size. A buy quote alone says nothing about whether an exit is quoted.
    const exitIntent = buying ? parseSolanaSwapIntent({
      kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "entry-exit-check",
      inputMint: intent.outputMint, outputMint: SOLANA_USDG_MINT,
      amountRaw: quote.minOutAmount, slippageBps: intent.slippageBps,
    }) : null;
    const exitQuote = exitIntent ? await market.quote(exitIntent) : null;
    if (exitQuote && exitIntent) validateSolanaQuote(exitQuote, exitIntent, now());
    // Existing holdings must have current executable-sized exit quotes before
    // another buy. An unrelated illiquid holding must not stop an exit.
    const quoted = valuePortfolio && buying ? await mapBounded(book.positions, async (position, index) => {
      try {
        return await market.quote(parseSolanaSwapIntent({
          kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: `mark-${index}`,
          inputMint: position.mint, outputMint: SOLANA_USDG_MINT,
          amountRaw: position.amountRaw, slippageBps: intent.slippageBps,
        }));
      } catch (error) {
        // Dust no route will buy (a partial sell's remainder) is valued at
        // zero and recorded, rather than blocking every later buy. Any other
        // failure, an outage included, still blocks: never a zero valuation.
        if (error instanceof SolanaMarketError && error.code === "zero-output") return null;
        throw error;
      }
    }) : [];
    const marks = quoted.filter((mark): mark is SolanaQuote => mark !== null);
    const zeroValuedMints = book.positions.filter((_, index) => quoted[index] === null).map((position) => position.mint);
    return { intent, quote, exitQuote, inputMint, outputMint, marks, zeroValuedMints, version: book.version };
  }

  return {
    /** A preview has no accounting effect, and is not an execution authorization. */
    preview: (owner: string, intent: unknown) => prepare(owner, intent, false),
    async trade(owner: string, rawIntent: unknown) {
      assertScope(owner);
      solanaPaperAgentId(owner);
      const intent = parseSolanaSwapIntent(rawIntent);
      // Recovery works even while RPC/Jupiter is down, or after limits expire.
      const existing = await store.findTrade(owner, intent.requestId);
      if (existing) {
        if (solanaPaperIntentFingerprint(existing.intent) !== solanaPaperIntentFingerprint(intent)) {
          throw new SolanaPaperServiceError("This request ID already belongs to a different paper trade.");
        }
        return existing;
      }
      const prepared = await prepare(owner, intent, true);
      const nowMs = now();
      // Portfolio quote reads can take time; never commit using an expired
      // safety observation just because it was fresh at preparation start.
      requireFreshMint(prepared.inputMint, intent.inputMint, nowMs);
      requireFreshMint(prepared.outputMint, intent.outputMint, nowMs);
      if (prepared.exitQuote) {
        validateSolanaQuote(prepared.exitQuote, {
          ...intent, requestId: "entry-exit-check", inputMint: intent.outputMint,
          outputMint: SOLANA_USDG_MINT, amountRaw: prepared.quote.minOutAmount,
        }, nowMs);
      }
      return store.commit({
        owner, intent, quote: prepared.quote, marks: prepared.marks,
        ...(prepared.zeroValuedMints.length ? { zeroValuedMints: prepared.zeroValuedMints } : {}),
        buyExitQuote: prepared.exitQuote ?? undefined,
        safetyObservedAtMs: Math.min(prepared.inputMint.observedAtMs, prepared.outputMint.observedAtMs),
        tokenDecimals: intent.inputMint === SOLANA_USDG_MINT ? prepared.outputMint.decimals : prepared.inputMint.decimals,
        expectedVersion: prepared.version, nowMs,
      });
    },
  };
}
