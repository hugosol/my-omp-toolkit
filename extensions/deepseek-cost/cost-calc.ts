/**
 * Cost calculation and token formatting — pure functions, no I/O.
 * Pricing follows the official DeepSeek price list (RMB per million tokens).
 */

export interface PriceTier {
  input: number;
  cacheRead: number;
  output: number;
}

export const PRICE_RMB_PER_1M: Record<string, PriceTier> = {
  "deepseek-v4-pro": { input: 3, cacheRead: 0.025, output: 6 },
  "deepseek-v4-flash": { input: 1, cacheRead: 0.02, output: 2 },
};

/** Resolve the price tier for a model id; undefined when the model is not tracked. */
export function priceForModel(modelId: string | undefined): PriceTier | undefined {
  if (!modelId) return undefined;
  return PRICE_RMB_PER_1M[modelId];
}

const PAD_IN = 7;
const PAD_OUT = 8;
const PAD_COST = 10;
const PAD_SUM = 7;

/** Format a raw token count to human-readable string (e.g. 123456 → "123.4K"). */
export function fmtTokens(n: number): string {
  if (n >= 100_000) {
    const k = n / 1000;
    const whole = Math.floor(k);
    const frac = Math.round((k - whole) * 10);
    const carry = frac >= 10 ? 1 : 0;
    const adjusted = whole + carry;
    const finalFrac = carry ? 0 : frac;
    return `${adjusted.toLocaleString("en-US")}.${finalFrac}K`;
  }
  return n.toLocaleString("en-US");
}

/** Calculate RMB cost from token counts using the given price tier. */
export function rmbCost(input: number, cacheRead: number, output: number, tier: PriceTier): number {
  return (
    (input * tier.input) / 1_000_000 +
    (cacheRead * tier.cacheRead) / 1_000_000 +
    (output * tier.output) / 1_000_000
  );
}

/** Format a cost value as ¥ string (2 decimals when ≥0.01, else 4). */
export function fmtCost(cost: number): string {
  return cost >= 0.01 ? `\u00A5${cost.toFixed(2)}` : `\u00A5${cost.toFixed(4)}`;
}

function padTokens(n: number, width: number): string {
  return fmtTokens(n).padStart(width);
}

function padCost(cost: number): string {
  return fmtCost(cost).padStart(PAD_COST);
}

function padSum(sum: number): string {
  return fmtTokens(sum).padStart(PAD_SUM);
}

/** Build ¥I/O ratio string: input+cache cost % vs output cost %. Returns "--:--" when total cost is zero. */
export function ioRatio(usage: { input: number; cacheRead: number; output: number }, tier: PriceTier): string {
  const iCost = rmbCost(usage.input, usage.cacheRead, 0, tier);
  const oCost = rmbCost(0, 0, usage.output, tier);
  const total = iCost + oCost;
  if (total <= 0) return `\u00A5I/O: --:--`;
  const iPct = Math.round((iCost / total) * 100);
  const oPct = 100 - iPct;
  return `\u00A5I/O: ${iPct}:${oPct}`;
}

/** Build a single-line status string for token usage. */
export function buildStatusLine(
  usage: { input: number; cacheRead: number; output: number },
  pad: boolean,
  detailMode: boolean,
  tier: PriceTier,
): string {
  const totalIn = usage.input + usage.cacheRead;
  const sum = totalIn + usage.output;
  const cost = rmbCost(usage.input, usage.cacheRead, usage.output, tier);
  const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;
  if (pad) {
    if (detailMode) {
      const pct = String(hitRate).padStart(3);
      return `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}  ${ioRatio(usage, tier)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
    }
    return `Cache: ${String(hitRate).padStart(3)}%  ${ioRatio(usage, tier)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
  }
  if (detailMode) {
    return `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}  ${ioRatio(usage, tier)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
  }
  return `Cache: ${hitRate}%  ${ioRatio(usage, tier)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
}
