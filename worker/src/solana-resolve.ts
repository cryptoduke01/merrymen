/**
 * OPERATOR-REVIEWED RESOLUTION OF A STUCK LIVE TRADE.
 *
 * reconcileSolanaSubmission books a pending live trade only when both configured
 * providers derive the same outcome. When they keep disagreeing (one lags or
 * withholds, or one returns a receipt this code cannot read), the trade stays
 * pending: its reservation is held and the vault takes no new trade. This tool
 * is the operator's way through, and it adds no authority:
 *
 * - It shows each provider's view, as the executor derives it from finalized
 *   on-chain evidence (observeSolanaSubmission), and can consult a third
 *   provider the operator supplies (--third-rpc, whose URL is read from
 *   MERRYMEN_SOLANA_RESOLVE_THIRD_RPC, never the command line: a URL can carry
 *   an API key, and arguments show in ps listings and shell history). Every
 *   provider must be on its own hostname.
 * - It books only when two of them agree on the same final outcome (a fill, an
 *   on-chain failure, or a proven expiry) and no provider reports a different
 *   final outcome. A provider that cannot answer, or answers with a receipt
 *   that cannot be read, does not count toward that agreement.
 * - An expiry is not booked while any provider has seen the signature, nor
 *   while any provider the operator has not set aside could not be read: an
 *   unreadable answer may be the evidence that it landed (a finalized status
 *   whose receipt cannot be used is refused as unreadable, not as unseen).
 * - When one provider keeps reporting a final outcome the others contradict,
 *   or cannot be read at all, the operator can set it aside by name (--exclude
 *   primary|fallback|third). Its view is still read, shown and recorded with
 *   the decision as excluded; two OTHER providers on their own hostnames must
 *   still agree, no other provider may disagree, and an expiry is still
 *   refused while any provider, the excluded one included, has seen the
 *   signature.
 * - Before booking it records the operator, their reason, the outcome and
 *   every provider's view in solana_operator_resolutions, then books through
 *   the trading store's own settle (settleResolution), which re-checks the
 *   evidence against the reservation and marks that decision booked in the
 *   same transaction. A decision is marked booked if and only if it booked
 *   the trade; one that did not (the worker's automatic settlement booked the
 *   same evidence first, or its run stopped before settling) is recorded as
 *   superseded. Nothing is ever booked or released any other way: there is no
 *   override, and the tool never signs or sends a transaction.
 *
 * Output and the durable record carry provider labels and a short hash of each
 * hostname, never an endpoint URL (URLs can carry API keys).
 */
import { createHash, randomUUID } from "node:crypto";
import { CHAINS } from "../../packages/core/src/ids";
import type { Db } from "./db";
import { observationKey, observeSolanaSubmission, SolanaExecutionError, type SolanaLiveRecord, type SolanaLiveSettlement,
  type SolanaObservation } from "./solana-executor";
import { createSolanaLiveRpc, type SolanaLiveRead } from "./solana-live-rpc";
import { readSolanaMainnetRpcConfig, SolanaRpcError } from "./solana-rpc";
import { SolanaSettlementError } from "./solana-settlement";
import { ensureSolanaTradingSchema, SolanaTradingStore, SolanaTradingStoreError } from "./solana-trading-store";

export class SolanaResolveError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaResolveError"; }
}
function refuse(message: string): never { throw new SolanaResolveError(message); }

/** The environment variable holding the third provider's HTTPS URL for --third-rpc. */
export const SOLANA_RESOLVE_THIRD_RPC_ENV = "MERRYMEN_SOLANA_RESOLVE_THIRD_RPC";
/** --exclude names, and the provider label each one sets aside. */
const EXCLUDABLE: Readonly<Record<string, string>> = { primary: "primary", fallback: "fallback", third: "operator's provider" };
export const SOLANA_RESOLVE_USAGE = [
  "Usage: npm run solana:resolve -- show <tenant> <request-id> [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- book <tenant> <request-id> --operator NAME --reason \"why\" [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- history <tenant> [<request-id>]",
  `--third-rpc also asks the provider whose HTTPS URL is in ${SOLANA_RESOLVE_THIRD_RPC_ENV} (set it in .env.solana.local or the environment, never on the command line).`,
  "--exclude sets aside one provider that reports a conflicting final outcome or cannot be read: its view is still shown and recorded, two other providers on their own",
  "hostnames must agree, and an expiry is still refused while any provider has seen the signature.",
].join("\n");

const SCHEMA = `CREATE TABLE IF NOT EXISTS solana_operator_resolutions (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL,
 outcome TEXT NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL, settlement_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
 approved_at_ms BIGINT NOT NULL, booked_at_ms BIGINT, refusal TEXT
);
CREATE INDEX IF NOT EXISTS solana_operator_resolutions_request ON solana_operator_resolutions(tenant, owner, request_id);`;
const ready = new WeakMap<Db, Promise<void>>();
/** The resolution record's table (and the trading tables it refers to). */
export async function ensureSolanaResolutionSchema(db: Db, postgres: boolean): Promise<void> {
  await ensureSolanaTradingSchema(db, postgres);
  let promise = ready.get(db);
  if (!promise) {
    promise = (postgres ? db.tx(async tx => { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_985); await tx.exec(SCHEMA); }) : db.exec(SCHEMA))
      .catch(error => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}

/** One provider the operator can consult: a label, its hostname, and a read session against it alone. */
export interface SolanaResolveProvider {
  label: string;
  host: string;
  read<T>(operation: (read: SolanaLiveRead) => Promise<T>): Promise<T>;
}
/**
 * A provider's view: the executor's own observation, or why it could not be
 * read (fixed text only). `excluded`: set aside by the operator (--exclude).
 */
export type SolanaResolveView = { label: string; hostId: string; excluded?: true } & ({ observation: SolanaObservation } | { error: string });
export type SolanaResolveDecision =
  | { book: true; settlement: SolanaLiveSettlement; agreed: string[] }
  | { book: false; reason: string };

/** A stable short id for a hostname: enough to tell providers apart in the record, never the URL. */
function hostId(host: string): string { return createHash("sha256").update(host).digest("hex").slice(0, 16); }
function normalizedHost(url: string): string { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); }

/**
 * What may be booked from these views. Two providers on different hostnames
 * must derive the same final outcome, and no provider may report a different
 * one. An expiry also needs that no provider has seen the signature and that
 * every provider not excluded could be read. A view the operator excluded
 * neither agrees nor disagrees, but its having seen the signature still
 * refuses an expiry. Anything else books nothing.
 */
export function solanaResolveDecision(views: readonly SolanaResolveView[]): SolanaResolveDecision {
  const settled = views.filter((view): view is SolanaResolveView & { observation: SolanaObservation } => !view.excluded && "observation" in view && view.observation.settlement !== null);
  const outcomes = new Map<string, typeof settled>();
  for (const view of settled) outcomes.set(observationKey(view.observation), [...(outcomes.get(observationKey(view.observation)) ?? []), view]);
  if (outcomes.size > 1) return { book: false, reason: "Providers report different final outcomes for this transaction. Nothing is booked: find out which provider is wrong before going further. "
    + "Once you know, set it aside with --exclude (and --third-rpc for another provider): two other providers must still agree." };
  const [agreeing] = [...outcomes.values()];
  if (!agreeing) return { book: false, reason: "No provider reports a final outcome yet. Nothing is booked; the reservation stays held. Try again later, or consult another provider with --third-rpc." };
  if (new Set(agreeing.map(view => view.hostId)).size < 2) {
    return { book: false, reason: "Only one provider reports this final outcome. Two independent providers must agree before anything is booked; consult another provider with --third-rpc." };
  }
  const settlement = agreeing[0]!.observation.settlement!;
  if (settlement.status === "expired") {
    // Every view counts here, an excluded one included: a provider that saw the signature may be the one telling the truth.
    if (views.some(view => "observation" in view && view.observation.seen)) {
      return { book: false, reason: "A provider has seen this signature, so its expiry is not booked: the transaction may have landed. Nothing is booked." };
    }
    // An unreadable answer may be the proof it landed: a finalized status whose
    // receipt cannot be used throws rather than reading as unseen. A transaction
    // that landed and failed leaves the vault sequence unchanged, so the others'
    // expiry proofs cannot rule it out. Only the operator sets a dead provider aside.
    if (views.some(view => !view.excluded && "error" in view)) {
      return { book: false, reason: "A provider could not be read, so this expiry is not booked: its answer may be the evidence that the transaction landed. Nothing is booked. "
        + "If that provider is down, set it aside with --exclude (two other providers must still agree)." };
    }
  }
  return { book: true, settlement, agreed: agreeing.map(view => view.label) };
}

/** Fixed text for a provider that could not answer: never provider content, endpoints or keys. */
function viewError(error: unknown): string {
  if (error instanceof SolanaRpcError || error instanceof SolanaSettlementError || error instanceof SolanaExecutionError) return error.message;
  return "Its answer could not be read.";
}
function describe(view: SolanaResolveView): string {
  const text = describeObservation(view);
  return view.excluded ? `${text} (excluded by the operator: shown and recorded, not counted)` : text;
}
function describeObservation(view: SolanaResolveView): string {
  if ("error" in view) return `could not be used: ${view.error}`;
  const { settlement, seen } = view.observation;
  if (!settlement) return seen ? "pending: seen, not finalized" : "pending: not seen, and its blockhash may still land";
  if (settlement.status !== "expired") {
    return settlement.status === "finalized" ? `finalized fill at slot ${settlement.slot}: ${settlement.amountIn} in, ${settlement.amountOut} out, fee ${settlement.feeLamports} lamports`
      : `failed on chain at slot ${settlement.slot}, fee ${settlement.feeLamports} lamports, no tokens moved`;
  }
  const proof = settlement.expiryProof;
  return proof.reason === "session-revoked" ? `never ran: the session was revoked (epoch ${proof.sessionEpoch}) with vault sequence ${proof.vaultSequence} unchanged`
    : `never ran: blockhash expired at finalized height ${proof.blockHeight} with vault sequence ${proof.vaultSequence} unchanged`;
}

export interface SolanaResolveInput {
  db: Db; postgres?: boolean; tenant: string; requestId: string;
  providers: readonly SolanaResolveProvider[];
  now?: () => number;
  /** Book the agreed outcome, recording who decided and why. Without it nothing is written. */
  book?: { operator: string; reason: string };
  /** The label of one provider the operator sets aside (--exclude): read, shown and recorded, never counted. */
  exclude?: string;
  /** The executor's per-provider observation; injectable for tests only. */
  observe?: typeof observeSolanaSubmission;
}
export interface SolanaResolveResult {
  owner: string; record: SolanaLiveRecord; views: SolanaResolveView[]; decision: SolanaResolveDecision | null;
  /** True only when this run's decision booked the outcome. */
  booked: boolean; lines: string[];
}
/** The refusal recorded on a decision that did not book the trade because something else booked it first. */
export const SOLANA_RESOLUTION_SUPERSEDED = "Already booked by another path when this decision was settled or rerun; this decision did not book it.";

function tenantOf(value: string | undefined): string {
  if (!value || !/^0x[0-9a-f]{40}$/.test(value)) refuse("Name the tenant as a lowercase 0x address.");
  return value;
}
function requestIdOf(value: string | undefined): string {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) refuse("Name the live trade's request id.");
  return value;
}
function lineOf(value: string | undefined, label: string, max: number): string {
  if (!value || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) refuse(`Give ${label} on one line, at most ${max} characters.`);
  return value;
}
async function ownerOf(db: Db, tenant: string): Promise<string> {
  let row: { owner: string } | undefined;
  try { row = await db.prepare("SELECT owner FROM solana_wallet_bindings WHERE tenant=? AND chain=?").get(tenant, CHAINS.solana) as { owner: string } | undefined; }
  catch { row = undefined; }
  if (!row) refuse("No Solana wallet binding exists for that tenant.");
  return row.owner;
}
function sameSettlement(a: SolanaLiveSettlement | undefined, b: SolanaLiveSettlement): boolean {
  return !!a && JSON.stringify({ ...a, finalizedAtMs: 0 }) === JSON.stringify({ ...b, finalizedAtMs: 0 });
}

/**
 * Shows every provider's view of one pending live trade and what may be booked
 * from them; with `book`, records the decision and books it through the store.
 */
export async function resolveSolanaPendingTrade(input: SolanaResolveInput): Promise<SolanaResolveResult> {
  const now = input.now ?? Date.now, observe = input.observe ?? observeSolanaSubmission, postgres = input.postgres ?? false;
  const tenant = tenantOf(input.tenant), requestId = requestIdOf(input.requestId);
  const book = input.book ? { operator: lineOf(input.book.operator, "the operator's name", 80), reason: lineOf(input.book.reason, "a reason", 200) } : undefined;
  const hosts = input.providers.map(provider => provider.host);
  if (new Set(hosts).size !== hosts.length) refuse("Every provider must be on its own hostname.");
  if (input.exclude !== undefined && !input.providers.some(provider => provider.label === input.exclude)) refuse("The excluded provider is not one of the providers consulted.");
  await ensureSolanaResolutionSchema(input.db, postgres);
  const owner = await ownerOf(input.db, tenant);
  const store = new SolanaTradingStore(input.db, { tenant, owner }, now);
  const record = await store.get(owner, requestId);
  if (!record) refuse("No live trade with that request id exists for that tenant.");
  const submission = record.submission, lines = [
    `Live trade ${requestId} for tenant ${tenant}: ${record.status}.`,
    `  signature ${submission.signature}, vault sequence ${submission.vaultSequence}, last valid block height ${submission.lastValidBlockHeight}, prepared ${new Date(submission.preparedAtMs).toISOString()}`,
  ];
  if (record.status !== "pending") {
    lines.push(`It is already ${record.status}; nothing is booked.`);
    // A decision is marked booked in the same transaction that books the trade
    // (settleResolution), so one still open on a booked trade did not book it:
    // its run stopped before settling, and something else booked the trade.
    // A book run records that; show writes nothing.
    if (book) {
      const superseded = await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE tenant=? AND owner=? AND request_id=? AND booked_at_ms IS NULL AND refusal IS NULL")
        .run(SOLANA_RESOLUTION_SUPERSEDED, tenant, owner, requestId);
      if (superseded.changes > 0) lines.push(`${superseded.changes === 1 ? "An open operator decision" : `${superseded.changes} open operator decisions`} for it did not book it and ${superseded.changes === 1 ? "is" : "are"} now recorded as superseded.`);
    }
    const booker = await input.db.prepare("SELECT operator,booked_at_ms FROM solana_operator_resolutions WHERE tenant=? AND owner=? AND request_id=? AND booked_at_ms IS NOT NULL")
      .get(tenant, owner, requestId) as { operator: string; booked_at_ms: number | string } | undefined;
    lines.push(booker ? `It was booked by an operator decision of ${booker.operator} at ${new Date(Number(booker.booked_at_ms)).toISOString()}.` : "No operator decision booked it.");
    return { owner, record, views: [], decision: null, booked: false, lines };
  }
  const nowMs = now();
  const views: SolanaResolveView[] = [];
  for (const provider of input.providers) {
    const base = { label: provider.label, hostId: hostId(provider.host), ...(provider.label === input.exclude ? { excluded: true as const } : {}) };
    try { views.push({ ...base, observation: await provider.read(read => observe(read, submission, owner, nowMs)) }); }
    catch (error) { views.push({ ...base, error: viewError(error) }); }
  }
  for (const view of views) lines.push(`  ${view.label}: ${describe(view)}`);
  const decision = solanaResolveDecision(views);
  if (!decision.book) { lines.push(decision.reason); return { owner, record, views, decision, booked: false, lines }; }
  const outcome = decision.settlement.status === "finalized" ? "a finalized fill" : decision.settlement.status === "failed" ? "an on-chain failure" : "a proven expiry";
  lines.push(`${decision.agreed.join(" and ")} agree on ${outcome}.`);
  if (!book) { lines.push("Nothing was written. To book it, run book with --operator and --reason."); return { owner, record, views, decision, booked: false, lines }; }
  // The record comes first: nothing is ever booked without who decided it, why and on what evidence.
  const id = randomUUID();
  // An excluded provider's dissent is part of the evidence: who set it aside, and what it said.
  const evidence = { signature: submission.signature, vaultSequence: submission.vaultSequence, lastValidBlockHeight: submission.lastValidBlockHeight,
    agreed: decision.agreed, ...(input.exclude !== undefined ? { excluded: input.exclude } : {}), providers: views.map(view => ({ label: view.label, hostId: view.hostId,
      ...(view.excluded ? { excluded: true } : {}),
      ...("error" in view ? { error: view.error } : { seen: view.observation.seen, settlement: view.observation.settlement }) })) };
  await input.db.prepare(`INSERT INTO solana_operator_resolutions(id,tenant,owner,request_id,signature,outcome,operator,reason,settlement_json,evidence_json,approved_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, tenant, owner, requestId, submission.signature, decision.settlement.status, book.operator, book.reason,
    JSON.stringify(decision.settlement), JSON.stringify(evidence), now());
  let bookedHere: boolean;
  try { bookedHere = await store.settleResolution(owner, requestId, submission.signature, decision.settlement, id); }
  catch (error) {
    // An error after the store committed (a lost reply) must not be recorded as a refusal. The decision is marked
    // booked in the store's own transaction, so its record says whether this run booked; read it and the trade.
    // When that read fails too, the outcome is unknown: nothing is recorded, and the operator is told so.
    let mark: { booked_at_ms: number | string | null } | undefined, after: SolanaLiveRecord | null;
    try {
      mark = await input.db.prepare("SELECT booked_at_ms FROM solana_operator_resolutions WHERE id=?").get(id) as typeof mark;
      after = await store.get(owner, requestId);
    } catch {
      refuse("The settlement's reply was lost and the trade could not be read again, so it may or may not be booked. Run show to see its status, and history to see "
        + "whether this decision booked it: a decision is marked booked if and only if it booked the trade (nothing is ever booked twice).");
    }
    if (mark && mark.booked_at_ms !== null) bookedHere = true;
    else if (after && after.status !== "pending" && sameSettlement(after.settlement, decision.settlement)) bookedHere = false;
    else {
      // The store re-checks the evidence against the reservation; its refusals are fixed text.
      const refusal = error instanceof SolanaTradingStoreError ? error.message : "The settlement could not be written.";
      await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL").run(refusal, id);
      refuse(`Nothing was booked: ${refusal} The decision is recorded as refused.`);
    }
  }
  if (!bookedHere) {
    // Booked meanwhile with the same evidence by something else (the worker's automatic settlement): not this decision.
    try { await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL AND refusal IS NULL").run(SOLANA_RESOLUTION_SUPERSEDED, id); }
    catch { /* It stays open, never marked booked; the next book run records it as superseded. */ }
    lines.push(`It was booked meanwhile with the same evidence by another path, so this decision did not book it and is recorded as superseded.`);
    return { owner, record, views, decision, booked: false, lines };
  }
  lines.push(`Booked ${outcome}, recorded as decided by ${book.operator}.`);
  return { owner, record, views, decision, booked: true, lines };
}

/** The recorded operator resolutions for a tenant, newest first. */
export async function listSolanaResolutions(db: Db, tenant: string, requestId?: string, postgres = false) {
  await ensureSolanaResolutionSchema(db, postgres);
  const rows = await db.prepare(`SELECT request_id,signature,outcome,operator,reason,approved_at_ms,booked_at_ms,refusal FROM solana_operator_resolutions
    WHERE tenant=?${requestId === undefined ? "" : " AND request_id=?"} ORDER BY approved_at_ms DESC`).all(...(requestId === undefined ? [tenantOf(tenant)] : [tenantOf(tenant), requestIdOf(requestId)])) as
    Array<{ request_id: string; signature: string; outcome: string; operator: string; reason: string; approved_at_ms: number | string; booked_at_ms: number | string | null; refusal: string | null }>;
  return rows.map(row => ({ requestId: row.request_id, signature: row.signature, outcome: row.outcome, operator: row.operator, reason: row.reason,
    approvedAtMs: Number(row.approved_at_ms), bookedAtMs: row.booked_at_ms === null ? null : Number(row.booked_at_ms), refusal: row.refusal }));
}

export interface SolanaResolveDeps {
  db: Db; postgres?: boolean; env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
}
/**
 * The configured providers (primary, and the fallback when set) plus, with
 * `third`, the operator's from MERRYMEN_SOLANA_RESOLVE_THIRD_RPC, each a
 * single-endpoint read session.
 */
export function solanaResolveProviders(env: Readonly<Record<string, string | undefined>>, third: boolean,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}): SolanaResolveProvider[] {
  const config = readSolanaMainnetRpcConfig(env);
  const urls: Array<[string, string]> = [["primary", config.url]];
  if (config.fallbackUrl) urls.push(["fallback", config.fallbackUrl]);
  if (third) {
    const thirdRpc = env[SOLANA_RESOLVE_THIRD_RPC_ENV];
    if (!thirdRpc) refuse(`--third-rpc reads the third provider's HTTPS URL from ${SOLANA_RESOLVE_THIRD_RPC_ENV}. Set it in .env.solana.local or the environment, then run this again.`);
    urls.push([EXCLUDABLE.third!, readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: thirdRpc }).url]);
  }
  const providers = urls.map(([label, url]) => {
    const transport = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: url }, singleEndpoint: true, fetch: options.fetch, timeoutMs: options.timeoutMs ?? 15_000 });
    return { label, host: normalizedHost(url), read: <T>(operation: (read: SolanaLiveRead) => Promise<T>) => transport.read(operation) };
  });
  if (new Set(providers.map(provider => provider.host)).size !== providers.length) {
    refuse(!third ? "The configured providers share a hostname." : "The third provider must be on a different hostname from the configured providers.");
  }
  return providers;
}

/** The CLI's whole behaviour, so it can be tested without a process. */
export async function runSolanaResolveCommand(argv: readonly string[], deps: SolanaResolveDeps): Promise<string> {
  const [command, ...rest] = argv;
  const positional: string[] = [], flags = new Map<string, string>();
  // A URL is never taken from the command line (it can carry an API key, and
  // arguments show in ps and shell history). It is refused without being echoed.
  if (rest.some(item => /^[a-z][a-z0-9+.-]*:\/\//i.test(item))) {
    refuse(`Do not pass provider URLs on the command line. Put the third provider's HTTPS URL in ${SOLANA_RESOLVE_THIRD_RPC_ENV} and pass --third-rpc alone.`);
  }
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]!;
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (name === "third-rpc") { if (flags.has(name)) refuse(SOLANA_RESOLVE_USAGE); flags.set(name, ""); continue; }
    const value = rest[++index];
    if (!["operator", "reason", "exclude"].includes(name) || value === undefined || flags.has(name)) refuse(SOLANA_RESOLVE_USAGE);
    flags.set(name, value);
  }
  const excluded = flags.get("exclude");
  if (excluded !== undefined && !Object.hasOwn(EXCLUDABLE, excluded)) refuse(SOLANA_RESOLVE_USAGE);
  const postgres = deps.postgres ?? false;
  if (command === "history" && (positional.length === 1 || positional.length === 2) && flags.size === 0) {
    const rows = await listSolanaResolutions(deps.db, positional[0]!, positional[1], postgres);
    if (!rows.length) return "No operator resolutions are recorded for that tenant.";
    return rows.map(row => [new Date(row.approvedAtMs).toISOString(), row.requestId, row.outcome, row.bookedAtMs !== null ? "booked" : row.refusal ? `refused: ${row.refusal}` : "not booked",
      `by ${row.operator}`, row.reason].join("\t")).join("\n");
  }
  const booking = command === "book";
  if ((command !== "show" && !booking) || positional.length !== 2 || (booking ? !flags.has("operator") || !flags.has("reason") : flags.has("operator") || flags.has("reason"))) {
    refuse(SOLANA_RESOLVE_USAGE);
  }
  const providers = solanaResolveProviders(deps.env ?? process.env, flags.has("third-rpc"), { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const result = await resolveSolanaPendingTrade({ db: deps.db, postgres, tenant: positional[0]!, requestId: positional[1]!, providers, now: deps.now,
    ...(excluded !== undefined ? { exclude: EXCLUDABLE[excluded] } : {}),
    ...(booking ? { book: { operator: flags.get("operator")!, reason: flags.get("reason")! } } : {}) });
  // A book that booked nothing is a failure the operator must see (exit status 1).
  if (booking && !result.booked) refuse(result.lines.join("\n"));
  return result.lines.join("\n");
}
