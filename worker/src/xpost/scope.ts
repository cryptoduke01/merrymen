/**
 * WHO THE OPERATOR NAMED, READ THE SAME WAY BY THE WEB AND THE ORCHESTRATOR.
 *
 * MERRYMEN_XPOST_ACTIVE_TENANTS is set on both services: the orchestrator
 * puts the named owners on the active cadence and lets them answer tags, and
 * the web tells those owners so in the reply warning. Two parsers would let
 * the warning and the behaviour disagree about who is active, so there is one.
 *
 * PURE. It is handed the raw value and reads no environment (boundary.test.ts:
 * only client.ts does), so a test holds every case.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * THE OPERATOR'S ACTIVE OWNERS, by tenant address only: a name or a handle is
 * not an identity. Lowercased. An entry that is not an address is dropped and
 * reported by its 1-based position, never by value, so a key pasted into the
 * wrong variable never reaches a log; the rest still apply. Unset or blank is
 * nobody.
 */
export function activeTenantsOf(raw: string | undefined | null): { tenants: Set<string>; badEntries: number[] } {
  const tenants = new Set<string>();
  const badEntries: number[] = [];
  const value = (raw ?? "").trim();
  if (!value) return { tenants, badEntries };
  value.split(",").map((v) => v.trim()).filter(Boolean).forEach((v, i) => {
    if (ADDRESS.test(v)) tenants.add(v.toLowerCase());
    else badEntries.push(i + 1);
  });
  return { tenants, badEntries };
}
