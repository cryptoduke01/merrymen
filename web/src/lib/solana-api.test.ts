import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SolanaExecutionError } from "../../../worker/src/solana-executor";
import { SolanaLiveMarketError } from "../../../worker/src/solana-live-market";
import { SolanaPaperServiceError } from "../../../worker/src/solana-paper-service";
import { SolanaSettlementError } from "../../../worker/src/solana-settlement";
import { SolanaAppRuntimeError } from "../../../worker/src/solana-app-runtime";
import { SolanaMarketError } from "../../../worker/src/solana-market";
import { SolanaRpcError } from "../../../worker/src/solana-rpc";
import { SolanaTradingStoreError } from "../../../worker/src/solana-trading-store";
import { OWNER_OUTCOME_UNKNOWN, solanaRequestBody, solanaResponse } from "./solana-api";
import { SolanaWebError } from "./solana-auth";

const flag = process.env.MERRYMEN_SOLANA;
before(() => { process.env.MERRYMEN_SOLANA = "1"; });
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });

test("Solana routes reject authority fields and oversized bodies", async () => {
  for (const value of [null, [], { owner: "untrusted", amount: "1" }, { tenant: "other" }]) {
    await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify(value) }), ["amount"]));
  }
  await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify({ amount: "x".repeat(20_000) }) }), ["amount"]), (e: unknown) => e instanceof SolanaWebError && e.status === 413);
  assert.deepEqual(await solanaRequestBody(new Request("https://example.test", { method: "POST", body: '{"amount":"1"}' }), ["amount"]), { amount: "1" });
});
test("unexpected errors cannot reflect RPC credentials, session seeds or SQL values", async () => {
  const response = await solanaResponse(async () => { throw new Error("https://rpc.example?api-key=secret sessionSecretKey=private SQL value"); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.text();
  for (const secret of ["rpc.example", "api-key", "sessionSecretKey", "SQL value"]) assert.ok(!body.includes(secret));
});
test("setup errors answer as unavailable, never naming a setting", async () => {
  for (const error of [new SolanaMarketError("missing-jupiter-key"), new SolanaMarketError("invalid-jupiter-key"),
    new SolanaRpcError("missing-config"), new SolanaRpcError("invalid-config"),
    new SolanaAppRuntimeError("configuration", "Configure the separate Solana network fee payer before live trading.")]) {
    const response = await solanaResponse(async () => { throw error; });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true }, error.message);
  }
  // A problem with the request itself still says what it is.
  const quote = await solanaResponse(async () => { throw new SolanaMarketError("invalid-quote"); });
  assert.equal((await quote.json()).error, "Jupiter did not return a valid quote for the requested swap.");
});
test("with Solana off the response refuses before the action runs", async () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = value;
    let ran = false;
    const response = await solanaResponse(async () => { ran = true; return { ok: true }; });
    assert.equal(response.status, 404, String(value));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true });
    assert.equal(ran, false);
  }
  process.env.MERRYMEN_SOLANA = "1";
  assert.equal((await solanaResponse(async () => ({ ok: true }))).status, 200);
});

const OUTAGE = "Solana is temporarily unavailable. Nothing was confirmed; refresh to check existing requests before retrying.";
/** Owner text must never name a provider, a setting, an endpoint or the worker's internal code. */
function ownerSafe(text: string) {
  assert.doesNotMatch(text, /MERRYMEN_|jupiter|pyth|api[ _-]?key|https?:|rpc|refused: |execution/i, text);
}
test("live refusals the owner can act on are clear 4xx answers, not an outage", async () => {
  const cases: Array<[SolanaExecutionError["code"], number, RegExp]> = [
    ["risk", 409, /outside your trading limits/], ["fee-cap", 409, /fees are above/], ["simulation", 409, /pre-flight check/],
    ["unsafe-route", 409, /No safe route/], ["conflict", 409, /Refresh before trying again/], ["invalid-intent", 400, /not supported/],
    ["price-moved", 409, /^The price moved\. Preview again; nothing was sent\.$/], ["owner-refund", 409, /Reopen that token account in your wallet/],
  ];
  for (const [code, status, text] of cases) {
    const response = await solanaResponse(async () => { throw new SolanaExecutionError(code); });
    const body = await response.json() as { error: string; ownerFacing: boolean };
    assert.equal(response.status, status, code);
    assert.match(body.error, text, code);
    assert.equal(body.ownerFacing, true);
    ownerSafe(body.error);
  }
  const settlement = await solanaResponse(async () => { throw new SolanaSettlementError(); });
  assert.equal(settlement.status, 409); const held = (await settlement.json() as { error: string }).error;
  assert.match(held, /stays held for review/); ownerSafe(held);
  // Outcomes nobody can vouch for keep the cautious answer; a program that is
  // not the audited binary is this deployment's problem, not the owner's.
  for (const code of ["invalid-state", "cancelled"] as const) {
    const response = await solanaResponse(async () => { throw new SolanaExecutionError(code); });
    assert.equal(response.status, 503, code); assert.equal((await response.json()).error, OUTAGE);
  }
  const program = await solanaResponse(async () => { throw new SolanaExecutionError("unsafe-program"); });
  assert.equal(program.status, 503); assert.equal((await program.json()).error, "Solana trading is not available.");
});
test("every paper refusal the worker raises has a fixed owner answer, and the fixable ones are 4xx", async () => {
  const source = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-paper-service.ts", import.meta.url)), "utf8");
  const raised = [...source.matchAll(/new SolanaPaperServiceError\(([^)]*)\)/g)].map((match) => match[1]!.trim());
  assert.ok(raised.length >= 8, "paper refusals moved");
  for (const argument of raised) assert.match(argument, /^"[^"$`\\]+"$/, `a literal message, never interpolated: ${argument}`);
  const answers = new Map<string, { status: number; error: string }>();
  for (const literal of raised) {
    const message = JSON.parse(literal) as string;
    const response = await solanaResponse(async () => { throw new SolanaPaperServiceError(message); });
    const body = await response.json() as { error: string };
    assert.notEqual(body.error, OUTAGE, message);
    ownerSafe(body.error);
    answers.set(message, { status: response.status, error: body.error });
  }
  for (const message of ["Create the Solana paper book before requesting a trade.", "The Solana paper book's limits have expired.",
    "Insufficient simulated USDG for this buy.", "Insufficient simulated token balance for this sell.",
    "Buying is blocked by the current token safety checks.", "This request ID already belongs to a different paper trade."]) {
    assert.equal(answers.get(message)?.status, 409, message);
  }
  assert.match(answers.get("The Solana paper book's limits have expired.")!.error, /limits have expired\. Save new limits/);
  // A paper trade below the minimum the owner previewed reads as the live one does.
  assert.deepEqual(answers.get("The fresh quote's minimum output is below the previewed minimum."), { status: 409, error: "The price moved. Preview again; nothing was sent." });
  assert.deepEqual(answers.get("The USDG mint does not match the configured cash asset."), { status: 503, error: "Solana trading is not available." });
  // An unlisted message is never reflected.
  const unknown = await solanaResponse(async () => { throw new SolanaPaperServiceError("constructor"); });
  assert.equal(unknown.status, 503); assert.equal((await unknown.json()).error, OUTAGE);
});

test("failures to use Solana's answer about a saved owner transaction are an unknown outcome, never a 4xx refusal", async () => {
  // Each message is still raised by the worker after the owner's bytes were saved (ownerStatus, finishSetup).
  const raised = ["solana-app-runtime.ts", "solana-trading-store.ts"].map((file) => readFileSync(fileURLToPath(new URL(`../../../worker/src/${file}`, import.meta.url)), "utf8")).join("\n");
  assert.ok(OWNER_OUTCOME_UNKNOWN.size >= 13);
  for (const message of OWNER_OUTCOME_UNKNOWN) {
    assert.ok(raised.includes(JSON.stringify(message)), `still raised: ${message}`);
    for (const error of [new SolanaAppRuntimeError("invalid", message), new SolanaTradingStoreError(message)]) {
      const response = await solanaResponse(async () => { throw error; });
      const body = await response.json() as { error: string; ownerFacing: boolean };
      assert.equal(response.status, 503, `${error.name}: ${message}`);
      assert.match(body.error, /could not be confirmed or recorded yet\. Nothing new was sent\. A transaction you already submitted stays saved and may still complete/);
      assert.equal(body.ownerFacing, true);
      ownerSafe(body.error);
    }
  }
  // A refusal before anything is saved still says what it is.
  const expired = await solanaResponse(async () => { throw new SolanaTradingStoreError("The prepared owner transaction expired before submission."); });
  assert.equal(expired.status, 409); assert.equal((await expired.json()).error, "The prepared owner transaction expired before submission.");
  const signature = await solanaResponse(async () => { throw new SolanaAppRuntimeError("invalid", "The owner signature or reviewed transaction does not match."); });
  assert.equal(signature.status, 400);
});

test("a live route that cannot be built is not 'no supported route': setup is unavailable, anything else is a neutral retry", async () => {
  const key = process.env.MERRYMEN_JUPITER_API_KEY;
  try {
    // The builder raises the same codeless error for a missing or invalid key and for a bad answer.
    for (const value of [undefined, "", "   ", "bad key", "x".repeat(1025)]) {
      if (value === undefined) delete process.env.MERRYMEN_JUPITER_API_KEY; else process.env.MERRYMEN_JUPITER_API_KEY = value;
      const response = await solanaResponse(async () => { throw new SolanaLiveMarketError(); });
      assert.equal(response.status, 503, JSON.stringify(value));
      assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true }, JSON.stringify(value));
    }
    process.env.MERRYMEN_JUPITER_API_KEY = "configured-key";
    const response = await solanaResponse(async () => { throw new SolanaLiveMarketError(); });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 503);
    assert.equal(body.error, "A route for this trade could not be prepared right now. Nothing was sent. Preview again shortly.");
    assert.doesNotMatch(body.error, /no supported route|another amount/i); ownerSafe(body.error);
  } finally { if (key === undefined) delete process.env.MERRYMEN_JUPITER_API_KEY; else process.env.MERRYMEN_JUPITER_API_KEY = key; }
});

test("an amount that quotes to nothing is a 400 the owner can fix, in fixed words", async () => {
  const response = await solanaResponse(async () => { throw new SolanaMarketError("zero-output"); });
  const body = await response.json() as { error: string; ownerFacing: boolean };
  assert.equal(response.status, 400);
  assert.equal(body.error, "This amount is too small to trade: no route returns anything for it. Nothing was sent or recorded. Try a larger amount.");
  ownerSafe(body.error);
  // Other quote problems keep their answer.
  assert.equal((await solanaResponse(async () => { throw new SolanaMarketError("invalid-quote"); })).status, 503);
});

test("owner bytes refused before anything was saved answer notSaved, and nothing else does", async () => {
  // The worker still raises the two malformed-bytes refusals as not-saved.
  const runtime = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-app-runtime.ts", import.meta.url)), "utf8");
  for (const message of ["Invalid encoded Solana transaction.", "The owner signature or reviewed transaction does not match."]) {
    assert.ok(runtime.includes(`notSaved(${JSON.stringify(message)})`), message);
  }
  for (const [message, status] of [["Invalid encoded Solana transaction.", 400], ["The owner signature or reviewed transaction does not match.", 400],
    ["Prepare this owner transaction before signing it.", 409], ["Another owner transaction is already saved.", 409],
    ["The prepared owner transaction expired before submission.", 409], ["The live permission settings changed. Review and sign again.", 409],
    // Even a message that, from saved bytes, would be an unknown outcome: these bytes were never saved.
    ["Invalid Solana confirmation data.", 409]] as const) {
    const response = await solanaResponse(async () => { throw new SolanaAppRuntimeError("not-saved", message); });
    assert.equal(response.status, status, message);
    assert.deepEqual(await response.json(), { error: message, ownerFacing: true, notSaved: true }, message);
  }
  for (const error of [new SolanaAppRuntimeError("pending", "Invalid owner transaction confirmation."), new SolanaAppRuntimeError("invalid", "The owner signature or reviewed transaction does not match."),
    new SolanaTradingStoreError("The prepared owner transaction expired before submission."), new SolanaExecutionError("price-moved"), new Error("boom")]) {
    const body = await (await solanaResponse(async () => { throw error; })).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(body, "notSaved"), false, error.message);
  }
});

test("a paced intent answers 429 in its own words, never as an outage", async () => {
  const response = await solanaResponse(async () => { throw new SolanaWebError(429, "Too many Solana trade requests. Nothing was sent. Try again in 6 seconds."); });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "Too many Solana trade requests. Nothing was sent. Try again in 6 seconds.", ownerFacing: true });
});
