/**
 * WHO THE OPERATOR NAMED: one parser for the web's reply warning and the
 * orchestrator's behaviour, so the two never disagree about who is active.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeTenantsOf } from "./scope";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;

describe("the operator's active owners", () => {
  it("are tenant addresses, lowercased; anything else is reported by position, never by value", () => {
    const { tenants, badEntries } = activeTenantsOf(` ${A.toUpperCase().replace("0X", "0x")} , alan ,, ${B} , 0x1234 `);
    assert.deepEqual([...tenants], [A, B]);
    assert.deepEqual(badEntries, [2, 4]);
  });

  it("unset or blank is nobody", () => {
    for (const raw of [undefined, null, "", "  ", " , "]) {
      const { tenants, badEntries } = activeTenantsOf(raw);
      assert.equal(tenants.size, 0);
      assert.deepEqual(badEntries, []);
    }
  });
});
