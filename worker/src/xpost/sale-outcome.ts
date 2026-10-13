import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import type { SaleOutcome } from "./planner";

/** Measured trade proceeds minus evidenced cost. Never a claim about net profit. */
const RESULT: Readonly<Record<Exclude<SaleOutcome, "unknown">, string>> = {
  profit: "gross gain before fees and gas. pleased with that part.",
  loss: "gross loss before fees and gas. not my finest call.",
  flat: "flat before fees and gas. no victory lap.",
};

/**
 * The measured gain as code writes it: an explicit sign, a whole percent from
 * ten up (with thousands separated), one decimal under ten. A win of a
 * thousand percent has to be seen (owner's direction, 2026-10-13).
 */
export function gainFigure(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || Math.abs(pct) >= 1e7) return null;
  const abs = Math.abs(pct);
  const shown = abs >= 10 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(1).replace(/\.0$/, "");
  return `${pct < 0 ? "-" : "+"}${shown}%`;
}

function resultLine(outcome: Exclude<SaleOutcome, "unknown">, gainPct?: number | null): string {
  const figure = outcome === "flat" ? null : gainFigure(gainPct);
  return figure ? `${figure} ${RESULT[outcome]}` : RESULT[outcome];
}

/**
 * Trusted prose appended after the model's neutral sale text passes its gate.
 * With `gainPct` (the operator's own agents) the measured gain leads the line.
 */
export function appendSaleOutcome(body: string, outcome: SaleOutcome, gainPct?: number | null): string | null {
  if (!(outcome === "unknown" || Object.hasOwn(RESULT, outcome))) return null;
  const text = outcome === "unknown" ? body : `${body.trim()}\n${resultLine(outcome, gainPct)}`;
  return xWeightedLength(text) <= X_MAX_WEIGHTED ? text : null;
}

/** Send-time check against freshly replayed evidence; changed or lost evidence withholds the post. */
export function hasSaleOutcome(body: string, outcome: SaleOutcome, gainPct?: number | null): boolean {
  if (outcome === "unknown") return !Object.values(RESULT).some((line) => body.includes(line));
  if (!Object.hasOwn(RESULT, outcome) || !body.includes(`\n${resultLine(outcome, gainPct)}`)) return false;
  return Object.entries(RESULT).every(([kind, line]) => kind === outcome || !body.includes(line));
}
