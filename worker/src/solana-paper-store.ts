/**
 * Standalone local Solana simulation ledger. This database is deliberately not
 * the worker's live ledger: no grants, signing material, or chain transactions.
 * Fills use the quote's minimum output. Network fees and account rent are not
 * modeled; a receipt records a simulation, never proof of execution on chain.
 */
import { DatabaseSync } from "node:sqlite";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import {
  parseSolanaRawAmount, parseSolanaSwapIntent, solanaPaperAgentId,
  SOLANA_QUOTE_MAX_AGE_MS,
  validateSolanaPaperLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaQuote, type SolanaSwapIntent,
} from "../../packages/core/src/solana";

const APPLICATION_ID = 0x4d535031; // MSP1: refuses existing unrelated databases.
const DAY_MS = 86_400_000;
export const SOLANA_PAPER_MAX_POSITIONS = 32;
const ERRORS = {
  invalid_input: "Invalid Solana paper input",
  incompatible_database: "This is not a standalone Solana paper database",
  book_exists: "The Solana paper book already exists; it cannot be refilled or reset",
  book_missing: "The Solana paper book does not exist",
  request_conflict: "The Solana paper request ID was already used for a different intent",
  version_conflict: "The Solana paper book changed while quoting; obtain fresh quotes",
  clock_rollback: "The Solana paper clock moved backwards",
  expired: "The Solana paper limits have expired",
  invalid_quote: "The Solana quote is invalid, stale, or does not match the intent",
  invalid_marks: "Fresh exact-size USDG marks are required for every open Solana position",
  stale_safety: "The Solana mint safety evidence is missing, stale or future-dated",
  per_trade_limit: "The Solana paper per-trade limit would be exceeded",
  daily_limit: "The Solana paper rolling 24-hour notional limit would be exceeded",
  operation_limit: "The Solana paper rolling 24-hour operation limit would be exceeded",
  drawdown_limit: "The Solana paper drawdown limit blocks additional buys",
  insufficient_balance: "The Solana paper balance is insufficient",
  decimals_conflict: "The Solana position decimals changed",
  position_limit: "The Solana paper open-position limit would be exceeded",
  balance_overflow: "The Solana paper token balance would exceed u64",
} as const;
export class SolanaPaperStoreError extends Error {
  readonly code: keyof typeof ERRORS;
  constructor(code: keyof typeof ERRORS) {
    super(ERRORS[code]);
    this.name = "SolanaPaperStoreError";
    this.code = code;
  }
}
function fail(code: keyof typeof ERRORS): never { throw new SolanaPaperStoreError(code); }

export interface SolanaPaperPosition {
  mint: string;
  decimals: number;
  amountRaw: string;
  costBasisUsdgRaw: string;
}
export interface SolanaPaperReceipt {
  owner: string;
  agentId: string;
  chain: typeof CHAINS.solana;
  mode: "paper";
  execution: "simulated";
  /** Fee/rent exclusion remains visible when a receipt is exported alone. */
  excludesNetworkFeesAndRent: true;
  requestId: string;
  intent: SolanaSwapIntent;
  quote: SolanaQuote;
  /** Oldest observation timestamp across the input and output mint checks. */
  safetyObservedAtMs: number;
  /** Recorded buy exit evidence; this is not an executed exit. */
  buyExitQuote?: SolanaQuote;
  side: "buy" | "sell";
  createdAtMs: number;
  version: number;
  inputAmountRaw: string;
  outputAmountRaw: string;
  notionalUsdgRaw: string;
  realizedPnlRaw: string;
}
export interface SolanaPaperSnapshot {
  owner: string;
  agentId: string;
  chain: typeof CHAINS.solana;
  mode: "paper";
  version: number;
  initialCashRaw: string;
  cashRaw: string;
  hwmRaw: string;
  realizedPnlRaw: string;
  limits: SolanaPaperLimits;
  positions: SolanaPaperPosition[];
  /** Most recent 100, newest first. Durable replay records are never pruned. */
  trades: SolanaPaperReceipt[];
  createdAtMs: number;
  updatedAtMs: number;
}
export type SolanaPaperBook = Omit<SolanaPaperSnapshot, "trades">;
type Book = SolanaPaperBook;
export interface SolanaPaperCommit {
  owner: string;
  intent: SolanaSwapIntent;
  quote: SolanaQuote;
  /** Oldest observation timestamp across the input and output mint checks. */
  safetyObservedAtMs: number;
  /** Required for a new buy: executable exit evidence for exactly minOut units. */
  buyExitQuote?: SolanaQuote;
  /** Decimals of the non-USDG mint, verified by the market client. */
  tokenDecimals: number;
  /** All current positions at exact full size, or [] for an exit during outage. */
  marks: SolanaQuote[];
  expectedVersion: number;
  /** Preparation timestamp only; risk checks use the store clock after locking. */
  nowMs: number;
}

function checked<T>(code: keyof typeof ERRORS, fn: () => T): T {
  try { return fn(); } catch { return fail(code); }
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_input");
}
function ownerKey(owner: string): string {
  checked("invalid_input", () => solanaPaperAgentId(owner));
  return owner;
}
function balance(amount: bigint): string {
  return checked("balance_overflow", () => {
    const raw = amount.toString();
    parseSolanaRawAmount(raw, true);
    return raw;
  });
}
/** Stable exact intent identity; deliberately excludes a retry's fresh quote. */
export function solanaPaperIntentFingerprint(value: SolanaSwapIntent): string {
  const intent = checked("invalid_input", () => parseSolanaSwapIntent(value));
  return JSON.stringify([
    intent.kind, intent.chain, intent.mode, intent.requestId,
    intent.inputMint, intent.outputMint, intent.amountRaw, intent.slippageBps,
  ]);
}

export class SolanaPaperStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(file: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(file);
    try {
      // Check before setting WAL or schema pragmas: an accidental live DB path
      // must not modify the existing worker's database or its journal mode.
      this.assertDatabaseIdentity();
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.transaction(() => {
        this.assertDatabaseIdentity();
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS solana_paper_books (
            owner TEXT COLLATE BINARY PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 0),
            book_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS solana_paper_trades (
            owner TEXT COLLATE BINARY NOT NULL REFERENCES solana_paper_books(owner),
            request_id TEXT COLLATE BINARY NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            notional_usdg_raw TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            PRIMARY KEY (owner, request_id)
          );
          CREATE INDEX IF NOT EXISTS solana_paper_trades_window ON solana_paper_trades(owner, created_at_ms);
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private assertDatabaseIdentity(): void {
    const appId = this.db.prepare("PRAGMA application_id").get()!.application_id;
    const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
    const objects = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (appId === 0 && version === 0 && objects.length === 0) return;
    if (appId !== APPLICATION_ID || version !== 1) fail("incompatible_database");
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 2 || tables.some((row) => row.name !== "solana_paper_books" && row.name !== "solana_paper_trades")) fail("incompatible_database");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private readBook(owner: string): Book | null {
    const row = this.db.prepare("SELECT book_json FROM solana_paper_books WHERE owner = ?").get(owner);
    return row ? JSON.parse(String(row.book_json)) as Book : null;
  }

  create(owner: string, initialCashRaw: string, limits: SolanaPaperLimits, preparedAtMs = this.now()): SolanaPaperSnapshot {
    ownerKey(owner);
    timestamp(preparedAtMs);
    checked("invalid_input", () => parseSolanaRawAmount(initialCashRaw));
    return this.transaction(() => {
      if (this.readBook(owner)) fail("book_exists");
      const nowMs = this.now();
      timestamp(nowMs);
      if (preparedAtMs > nowMs) fail("invalid_input");
      const validatedLimits = checked("invalid_input", () => validateSolanaPaperLimits(limits, nowMs));
      const book: Book = {
        owner, agentId: solanaPaperAgentId(owner), chain: CHAINS.solana, mode: "paper", version: 0,
        initialCashRaw, cashRaw: initialCashRaw, hwmRaw: initialCashRaw, realizedPnlRaw: "0",
        limits: validatedLimits, positions: [], createdAtMs: nowMs, updatedAtMs: nowMs,
      };
      this.db.prepare("INSERT INTO solana_paper_books(owner, version, book_json) VALUES (?, ?, ?)")
        .run(owner, 0, JSON.stringify(book));
      return { ...book, trades: [] };
    });
  }

  get(owner: string): SolanaPaperSnapshot | null {
    ownerKey(owner);
    // One read statement supplies book + trades under the same SQLite snapshot.
    const rows = this.db.prepare(`
      SELECT b.book_json, t.receipt_json FROM solana_paper_books b
      LEFT JOIN solana_paper_trades t ON t.owner = b.owner
      WHERE b.owner = ? ORDER BY t.created_at_ms DESC, t.rowid DESC LIMIT 100
    `).all(owner);
    if (!rows.length) return null;
    return {
      ...JSON.parse(String(rows[0]!.book_json)) as Book,
      trades: rows.filter((row) => row.receipt_json !== null).map((row) => JSON.parse(String(row.receipt_json)) as SolanaPaperReceipt),
    };
  }

  findTrade(owner: string, requestId: string): SolanaPaperReceipt | null {
    ownerKey(owner);
    if (typeof requestId !== "string" || requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(requestId)) fail("invalid_input");
    const row = this.db.prepare("SELECT receipt_json FROM solana_paper_trades WHERE owner = ? AND request_id = ?").get(owner, requestId);
    return row ? JSON.parse(String(row.receipt_json)) as SolanaPaperReceipt : null;
  }

  commit(input: SolanaPaperCommit): SolanaPaperReceipt {
    const owner = ownerKey(input.owner);
    const intent = checked("invalid_input", () => parseSolanaSwapIntent(input.intent));
    const fingerprint = solanaPaperIntentFingerprint(intent);
    return this.transaction(() => {
      // Durable idempotency precedes expiry/quote/version validation: a crash
      // after COMMIT must never cause a second fill or need a new market quote.
      const prior = this.db.prepare("SELECT fingerprint, receipt_json FROM solana_paper_trades WHERE owner = ? AND request_id = ?").get(owner, intent.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("request_conflict");
        return JSON.parse(String(prior.receipt_json)) as SolanaPaperReceipt;
      }
      const nowMs = this.now();
      const existingBook = this.readBook(owner);
      if (!existingBook) fail("book_missing");
      const recent = this.db.prepare("SELECT notional_usdg_raw FROM solana_paper_trades WHERE owner = ? AND created_at_ms > ?").all(owner, nowMs - DAY_MS);
      const { book, receipt } = applySolanaPaperCommit(existingBook, input, recent.map((row) => String(row.notional_usdg_raw)), nowMs);
      this.db.prepare("INSERT INTO solana_paper_trades(owner, request_id, fingerprint, created_at_ms, notional_usdg_raw, receipt_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(owner, intent.requestId, fingerprint, nowMs, receipt.notionalUsdgRaw, JSON.stringify(receipt));
      const update = this.db.prepare("UPDATE solana_paper_books SET version = ?, book_json = ? WHERE owner = ? AND version = ?")
        .run(book.version, JSON.stringify(book), owner, input.expectedVersion);
      if (update.changes !== 1) fail("version_conflict");
      return receipt;
    });
  }
}

/** Pure fill accounting shared by local CLI and tenant-bound SQLite/Postgres books.
 * Call only under a write lock, after durable replay lookup, with an authoritative
 * post-lock clock and the complete rolling-window notional list.
 */
export function applySolanaPaperCommit(bookInput: SolanaPaperBook, input: SolanaPaperCommit,
  recentNotionals: readonly string[], nowMs: number): { book: SolanaPaperBook; receipt: SolanaPaperReceipt } {
  const owner = ownerKey(input.owner);
  const intent = checked("invalid_input", () => parseSolanaSwapIntent(input.intent));
  timestamp(input.nowMs);
  // BEGIN IMMEDIATE can wait for another process. Caller preparation time
  // is not an execution clock: freshness and rolling caps use time sampled
  // only after we actually own the write transaction.
  timestamp(nowMs);
  if (input.nowMs > nowMs) fail("invalid_input");
  const book = structuredClone(bookInput);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== book.version || book.version === Number.MAX_SAFE_INTEGER) fail("version_conflict");
  if (nowMs < book.updatedAtMs) fail("clock_rollback");
  if (nowMs >= book.limits.expiresAtMs) fail("expired");
  if (!Number.isSafeInteger(input.safetyObservedAtMs) || input.safetyObservedAtMs < 0
    || input.safetyObservedAtMs > nowMs || nowMs - input.safetyObservedAtMs >= SOLANA_QUOTE_MAX_AGE_MS) fail("stale_safety");
  if (!Number.isSafeInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 18) fail("invalid_input");
  checked("invalid_quote", () => validateSolanaQuote(input.quote, intent, nowMs));
  if (!Array.isArray(input.marks) || input.marks.length > SOLANA_PAPER_MAX_POSITIONS) fail("invalid_marks");
  const side = intent.inputMint === SOLANA_USDG_MINT ? "buy" : "sell";
  if (side === "buy") {
    if (!input.buyExitQuote) fail("invalid_quote");
    const exitIntent: SolanaSwapIntent = {
      kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "entry-exit-check",
      inputMint: intent.outputMint, outputMint: SOLANA_USDG_MINT,
      amountRaw: input.quote.minOutAmount, slippageBps: intent.slippageBps,
    };
    checked("invalid_quote", () => validateSolanaQuote(input.buyExitQuote!, exitIntent, nowMs));
  }
  const tokenMint = side === "buy" ? intent.outputMint : intent.inputMint;
  const position = book.positions.find((item) => item.mint === tokenMint);
  if (position && position.decimals !== input.tokenDecimals) fail("decimals_conflict");
  if (side === "buy" && !position && book.positions.length >= SOLANA_PAPER_MAX_POSITIONS) fail("position_limit");
  const amountIn = BigInt(intent.amountRaw);
  const amountOut = BigInt(input.quote.minOutAmount);
  // Sell risk counts the quoted gross USDG value, not the reduced simulated
  // fill, so a slippage setting cannot enlarge a risk allowance.
  const notional = side === "buy" ? amountIn : BigInt(input.quote.outAmount);
  if (notional > BigInt(book.limits.perTradeUsdg)) fail("per_trade_limit");
  if (recentNotionals.length >= book.limits.maxOpsPerDay) fail("operation_limit");
  if (recentNotionals.reduce((sum, raw) => sum + BigInt(raw), 0n) + notional > BigInt(book.limits.dailyUsdg)) fail("daily_limit");

  const cashBefore = BigInt(book.cashRaw);
  let equityBefore = cashBefore;
  // Explicit degraded exit mode: [] permits selling without other assets'
  // feeds. Partial or stale marks never silently masquerade as a full book.
  const completeMarks = side === "buy" || input.marks.length > 0;
  if (completeMarks) {
    if (input.marks.length !== book.positions.length) fail("invalid_marks");
    for (const held of book.positions) {
      const mark = input.marks.find((quote) => quote.inputMint === held.mint);
      if (!mark) fail("invalid_marks");
      const markIntent: SolanaSwapIntent = {
        kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "mark",
        inputMint: held.mint, outputMint: SOLANA_USDG_MINT, amountRaw: held.amountRaw,
        slippageBps: mark.slippageBps,
      };
      checked("invalid_marks", () => validateSolanaQuote(mark, markIntent, nowMs));
      const value = BigInt(mark.minOutAmount);
      equityBefore += value;
    }
  }
  let hwm = BigInt(book.hwmRaw);
  if (equityBefore > hwm) hwm = equityBefore;
  if (side === "buy" && (hwm - equityBefore) * 10_000n >= hwm * BigInt(book.limits.maxDrawdownBps)) fail("drawdown_limit");

  let realized = 0n;
  if (side === "buy") {
    if (amountIn > cashBefore) fail("insufficient_balance");
    book.cashRaw = balance(cashBefore - amountIn);
    if (position) {
      position.amountRaw = balance(BigInt(position.amountRaw) + amountOut);
      position.costBasisUsdgRaw = (BigInt(position.costBasisUsdgRaw) + amountIn).toString();
    } else {
      book.positions.push({ mint: tokenMint, decimals: input.tokenDecimals, amountRaw: balance(amountOut), costBasisUsdgRaw: amountIn.toString() });
    }
  } else {
    if (!position || amountIn > BigInt(position.amountRaw)) fail("insufficient_balance");
    const heldAmount = BigInt(position.amountRaw);
    const heldBasis = BigInt(position.costBasisUsdgRaw);
    // Full exit explicitly consumes every remaining basis unit; partial
    // sells floor the allocated basis, retaining rounding dust in the lot.
    const basisSold = amountIn === heldAmount ? heldBasis : heldBasis * amountIn / heldAmount;
    realized = amountOut - basisSold;
    book.cashRaw = balance(cashBefore + amountOut);
    if (amountIn === heldAmount) book.positions = book.positions.filter((item) => item.mint !== tokenMint);
    else {
      position.amountRaw = (heldAmount - amountIn).toString();
      position.costBasisUsdgRaw = (heldBasis - basisSold).toString();
    }
  }
  // No position's post-trade liquidation value is invented by extrapolating
  // a purchase quote or scaling a previous mark. Cash alone is a lower bound;
  // the next fully marked decision can establish a higher portfolio peak.
  const cashAfter = BigInt(book.cashRaw);
  if (cashAfter > hwm) hwm = cashAfter;
  book.hwmRaw = hwm.toString();
  book.realizedPnlRaw = (BigInt(book.realizedPnlRaw) + realized).toString();
  book.version++;
  book.updatedAtMs = nowMs;
  const receipt: SolanaPaperReceipt = {
    owner, agentId: book.agentId, chain: CHAINS.solana, mode: "paper", execution: "simulated",
    excludesNetworkFeesAndRent: true, requestId: intent.requestId, intent,
    quote: structuredClone(input.quote), side, createdAtMs: nowMs, version: book.version,
    safetyObservedAtMs: input.safetyObservedAtMs,
    ...(side === "buy" ? { buyExitQuote: structuredClone(input.buyExitQuote!) } : {}),
    inputAmountRaw: amountIn.toString(), outputAmountRaw: amountOut.toString(),
    notionalUsdgRaw: notional.toString(), realizedPnlRaw: realized.toString(),
  };
  return { book, receipt };
}
