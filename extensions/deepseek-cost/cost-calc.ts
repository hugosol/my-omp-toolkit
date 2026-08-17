/**
 * Cost calculation and token formatting — pure functions, no I/O.
 * Pricing follows the official DeepSeek price list (RMB per million tokens)
 * with Beijing peak/off-peak time-of-day rates.
 */

export interface PriceTier {
  input: number;
  cacheRead: number;
  output: number;
}

export interface PriceSchedule {
  peak: PriceTier;
  offPeak: PriceTier;
}

export const PRICE_RMB_PER_1M: Record<string, PriceSchedule> = {
  "deepseek-v4-pro": {
    peak: { input: 9, cacheRead: 0.3, output: 27 },
    offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
  },
  "deepseek-v4-flash": {
    peak: { input: 3, cacheRead: 0.1, output: 9 },
    offPeak: { input: 1.5, cacheRead: 0.05, output: 4.5 },
  },
};

/** Resolve the price schedule for a model id; undefined when the model is not tracked. */
export function priceForModel(modelId: string | undefined): PriceSchedule | undefined {
  if (!modelId) return undefined;
  return PRICE_RMB_PER_1M[modelId];
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PEAK_START_1 = 9 * 60 * 60 * 1000;
const PEAK_END_1 = 12 * 60 * 60 * 1000;
const PEAK_START_2 = 14 * 60 * 60 * 1000;
const PEAK_END_2 = 18 * 60 * 60 * 1000;

/** Milliseconds since midnight in Asia/Shanghai for the given instant. */
function beijingMsOfDay(date: Date): number {
  return ((date.getTime() + BEIJING_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS;
}

/**
 * Whether the given instant is DeepSeek peak time in Beijing.
 * Peak intervals are closed: [09:00, 12:00] and [14:00, 18:00].
 */
export function isPeakHour(date: Date): boolean {
  const ms = beijingMsOfDay(date);
  return (ms >= PEAK_START_1 && ms <= PEAK_END_1) || (ms >= PEAK_START_2 && ms <= PEAK_END_2);
}

/** Resolve the effective price tier for a model at a given instant. */
export function resolvePriceTier(modelId: string | undefined, date: Date): PriceTier | undefined {
  const schedule = priceForModel(modelId);
  if (!schedule) return undefined;
  return isPeakHour(date) ? schedule.peak : schedule.offPeak;
}

/** Absolute time (ms) of the next peak/off-peak boundary strictly after `date`. */
export function nextBoundary(date: Date): Date {
  const shifted = date.getTime() + BEIJING_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  const dayStartMs = dayStartShifted - BEIJING_OFFSET_MS;
  const boundaries = [PEAK_START_1, PEAK_END_1, PEAK_START_2, PEAK_END_2];
  for (const b of boundaries) {
    const candidate = dayStartMs + b;
    if (candidate > date.getTime()) return new Date(candidate);
  }
  return new Date(dayStartMs + DAY_MS + PEAK_START_1);
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
