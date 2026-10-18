import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaUnits, displaySolanaAmount } from "./solana-amounts";
test("Solana amounts preserve u64 precision and signed accounting displays", () => {
  assert.equal(solanaUnits("18446744073709.551615", 6), "18446744073709551615");
  assert.equal(displaySolanaAmount("18446744073709551615"), "18446744073709.551615");
  assert.equal(displaySolanaAmount("-1500001"), "-1.500001");
  assert.equal(displaySolanaAmount("-1"), "-0.000001");
  assert.equal(displaySolanaAmount("0", 0), "0");
  assert.equal(solanaUnits("0.00", 2, true), "0");
  for (const input of ["0", "01", "-1", "1e6", "1.0000001", "18446744073709.551616"]) assert.throws(() => solanaUnits(input, 6));
});
