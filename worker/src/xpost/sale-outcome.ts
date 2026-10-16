import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import type { SaleOutcome } from "./planner";

/** Measured trade proceeds minus evidenced cost. Never a claim about net profit. */
const RESULT: Readonly<Record<Exclude<SaleOutcome, "unknown">, string>> = {
  profit: "gross gain before fees and gas. pleased with that part.",
  loss: "gross loss before fees and gas. not my finest call.",
  flat: "flat before fees and gas. no victory lap.",
};

/** Trusted prose appended after the model's neutral sale text passes its gate. */
export function appendSaleOutcome(body: string, outcome: SaleOutcome): string | null {
  if (!(outcome === "unknown" || Object.hasOwn(RESULT, outcome))) return null;
  const text = outcome === "unknown" ? body : `${body.trim()}\n${RESULT[outcome]}`;
  return xWeightedLength(text) <= X_MAX_WEIGHTED ? text : null;
}

/** Send-time check against freshly replayed evidence; changed or lost evidence withholds the post. */
export function hasSaleOutcome(body: string, outcome: SaleOutcome): boolean {
  if (outcome === "unknown") return !Object.values(RESULT).some((line) => body.includes(line));
  if (!Object.hasOwn(RESULT, outcome) || !body.includes(`\n${RESULT[outcome]}`)) return false;
  return Object.entries(RESULT).every(([kind, line]) => kind === outcome || !body.includes(line));
}
