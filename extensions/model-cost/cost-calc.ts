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

/** Build three-way cost ratio string: cache hit / cache-miss input / output. Returns placeholder when total cost is zero. */
export function cacheInOutRatio(usage: { input: number; cacheRead: number; output: number }, tier: PriceTier): string {
  const cacheCost = rmbCost(0, usage.cacheRead, 0, tier);
  const inCost = rmbCost(usage.input, 0, 0, tier);
  const outCost = rmbCost(0, 0, usage.output, tier);
  const total = cacheCost + inCost + outCost;
  if (total <= 0) return `\uFFE5Cache/In/Out：--:--:--`;

  const raws = [cacheCost, inCost, outCost].map(c => (c / total) * 100);
  const floors = raws.map(c => Math.floor(c));
  let remaining = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = [0, 1, 2].sort((a, b) => {
    const diff = (raws[b] - floors[b]) - (raws[a] - floors[a]);
    return diff !== 0 ? diff : a - b;
  });
  const pcts = [...floors];
  for (const idx of order) {
    if (remaining <= 0) break;
    pcts[idx] += 1;
    remaining -= 1;
  }
  return `\uFFE5Cache/In/Out：${pcts[0]}:${pcts[1]}:${pcts[2]}`;
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
      return `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}  ${cacheInOutRatio(usage, tier)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
    }
    return `Cache: ${String(hitRate).padStart(3)}%  ${cacheInOutRatio(usage, tier)}  Sum: ${padSum(sum)}  Cost: ${padCost(cost)}`;
  }
  if (detailMode) {
    return `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}  ${cacheInOutRatio(usage, tier)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
  }
  return `Cache: ${hitRate}%  ${cacheInOutRatio(usage, tier)}  Sum: ${fmtTokens(sum)}  Cost: ${fmtCost(cost)}`;
}

// ============================================================================
// ChatGPT/Codex cost helpers (USD pricing from ctx.model.cost)
// ============================================================================

/** Per-million-token USD cost for a model (shape matches ctx.model.cost). */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Usage shape accepted by ChatGPT/Codex cost helpers. */
export interface ChatGPTUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  orchestrationInput?: number;
  orchestrationCacheRead?: number;
  orchestrationOutput?: number;
  reasoningTokens?: number;
}

/** Calculate estimated USD cost from token counts and per-million USD rates. */
export function usdCost(usage: ChatGPTUsage, cost: ModelCost): number {
  return (
    (usage.input * cost.input +
      usage.cacheRead * cost.cacheRead +
      usage.cacheWrite * cost.cacheWrite +
      usage.output * cost.output +
      (usage.orchestrationInput ?? 0) * cost.input +
      (usage.orchestrationCacheRead ?? 0) * cost.cacheRead +
      (usage.orchestrationOutput ?? 0) * cost.output) /
    1_000_000
  );
}

/** Format a USD cost value ($2 decimals when ≥0.01, else $4 decimals). */
export function fmtUsd(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/** Build a four-way cost ratio string: cache read / input / cache write / output. */
export function cacheInOutWriteRatio(usage: ChatGPTUsage, cost: ModelCost): string {
  const cacheCost = usdCost({ input: 0, cacheRead: usage.cacheRead, cacheWrite: 0, output: 0 }, cost);
  const inCost = usdCost({ input: usage.input, cacheRead: 0, cacheWrite: 0, output: 0 }, cost);
  const writeCost = usdCost({ input: 0, cacheRead: 0, cacheWrite: usage.cacheWrite, output: 0 }, cost);
  const outCost = usdCost({ input: 0, cacheRead: 0, cacheWrite: 0, output: usage.output }, cost);
  const total = cacheCost + inCost + writeCost + outCost;
  if (total <= 0) return `\u0024CacheRead/In/CacheWrite/Out：--:--:--:--`;

  const raws = [cacheCost, inCost, writeCost, outCost].map(c => (c / total) * 100);
  const floors = raws.map(c => Math.floor(c));
  let remaining = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = [0, 1, 2, 3].sort((a, b) => {
    const diff = (raws[b] - floors[b]) - (raws[a] - floors[a]);
    return diff !== 0 ? diff : a - b;
  });
  const pcts = [...floors];
  for (const idx of order) {
    if (remaining <= 0) break;
    pcts[idx] += 1;
    remaining -= 1;
  }
  return `\u0024CacheRead/In/CacheWrite/Out：${pcts[0]}:${pcts[1]}:${pcts[2]}:${pcts[3]}`;
}

function padUsd(cost: number): string {
  return fmtUsd(cost).padStart(PAD_COST);
}

/** Build a single-line status string for ChatGPT/Codex usage using USD model costs. */
export function buildChatGPTStatusLine(
  usage: ChatGPTUsage,
  cost: ModelCost,
  pad: boolean,
  detailMode: boolean,
  totalTokens?: number,
): string {
  const totalIn = usage.input + usage.cacheRead;
  const sum = totalTokens ?? usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    + (usage.orchestrationInput ?? 0) + (usage.orchestrationCacheRead ?? 0) + (usage.orchestrationOutput ?? 0);
  const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;
  const costVal = usdCost(usage, cost);
  const ratio = cacheInOutWriteRatio(usage, cost);

  if (pad) {
    if (detailMode) {
      const pct = String(hitRate).padStart(3);
      let line = `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}`;
      if (usage.cacheWrite > 0) line += `  Write: ${padTokens(usage.cacheWrite, PAD_OUT)}`;
      line += `  ${ratio}  Sum: ${padSum(sum)}  Cost: ${padUsd(costVal)}`;
      if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
        line += `  Reasoning: ${padTokens(usage.reasoningTokens, PAD_OUT)}`;
      }
      const orchInput = usage.orchestrationInput ?? 0;
      const orchCacheRead = usage.orchestrationCacheRead ?? 0;
      const orchOutput = usage.orchestrationOutput ?? 0;
      if (orchInput + orchCacheRead + orchOutput > 0) {
        line += `  Orch: ${fmtTokens(orchInput)}/${fmtTokens(orchCacheRead)}/${fmtTokens(orchOutput)}`;
      }
      return line;
    }
    return `Cache: ${String(hitRate).padStart(3)}%  ${ratio}  Sum: ${padSum(sum)}  Cost: ${padUsd(costVal)}`;
  }

  if (detailMode) {
    let line = `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}`;
    if (usage.cacheWrite > 0) line += `  Write: ${fmtTokens(usage.cacheWrite)}`;
    line += `  ${ratio}  Sum: ${fmtTokens(sum)}  Cost: ${fmtUsd(costVal)}`;
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
      line += `  Reasoning: ${fmtTokens(usage.reasoningTokens)}`;
    }
    const orchInput = usage.orchestrationInput ?? 0;
    const orchCacheRead = usage.orchestrationCacheRead ?? 0;
    const orchOutput = usage.orchestrationOutput ?? 0;
    if (orchInput + orchCacheRead + orchOutput > 0) {
      line += `  Orch: ${fmtTokens(orchInput)}/${fmtTokens(orchCacheRead)}/${fmtTokens(orchOutput)}`;
    }
    return line;
  }
  return `Cache: ${hitRate}%  ${ratio}  Sum: ${fmtTokens(sum)}  Cost: ${fmtUsd(costVal)}`;
}

/** Build a token-only status line for ChatGPT/Codex when model cost is unavailable. */
export function buildChatGPTTokenLine(
  usage: ChatGPTUsage,
  pad: boolean,
  detailMode: boolean,
  totalTokens?: number,
): string {
  const totalIn = usage.input + usage.cacheRead;
  const sum = totalTokens ?? usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    + (usage.orchestrationInput ?? 0) + (usage.orchestrationCacheRead ?? 0) + (usage.orchestrationOutput ?? 0);
  const hitRate = totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 100) : 0;

  if (pad) {
    if (detailMode) {
      const pct = String(hitRate).padStart(3);
      let line = `Input: ${padTokens(usage.cacheRead, PAD_IN)}/${padTokens(totalIn, PAD_IN)} (${pct}%)  Output: ${padTokens(usage.output, PAD_OUT)}`;
      if (usage.cacheWrite > 0) line += `  Write: ${padTokens(usage.cacheWrite, PAD_OUT)}`;
      line += `  Sum: ${padSum(sum)}`;
      if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
        line += `  Reasoning: ${padTokens(usage.reasoningTokens, PAD_OUT)}`;
      }
      const orchInput = usage.orchestrationInput ?? 0;
      const orchCacheRead = usage.orchestrationCacheRead ?? 0;
      const orchOutput = usage.orchestrationOutput ?? 0;
      if (orchInput + orchCacheRead + orchOutput > 0) {
        line += `  Orch: ${fmtTokens(orchInput)}/${fmtTokens(orchCacheRead)}/${fmtTokens(orchOutput)}`;
      }
      return line;
    }
    return `Cache: ${String(hitRate).padStart(3)}%  Sum: ${padSum(sum)}`;
  }

  if (detailMode) {
    let line = `Input: ${fmtTokens(usage.cacheRead)}/${fmtTokens(totalIn)} (${hitRate}%)  Output: ${fmtTokens(usage.output)}`;
    if (usage.cacheWrite > 0) line += `  Write: ${fmtTokens(usage.cacheWrite)}`;
    line += `  Sum: ${fmtTokens(sum)}`;
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
      line += `  Reasoning: ${fmtTokens(usage.reasoningTokens)}`;
    }
    const orchInput = usage.orchestrationInput ?? 0;
    const orchCacheRead = usage.orchestrationCacheRead ?? 0;
    const orchOutput = usage.orchestrationOutput ?? 0;
    if (orchInput + orchCacheRead + orchOutput > 0) {
      line += `  Orch: ${fmtTokens(orchInput)}/${fmtTokens(orchCacheRead)}/${fmtTokens(orchOutput)}`;
    }
    return line;
  }
  return `Cache: ${hitRate}%  Sum: ${fmtTokens(sum)}`;
}
