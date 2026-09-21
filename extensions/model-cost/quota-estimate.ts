/**
 * Codex quota-ratio estimation — learns how many five-hour quotas one weekly
 * quota amounts to from the paired usage readings the extension already sees.
 *
 * A paired reading is both windows' used percentages taken from a single usage
 * fetch or one set of rate-limit headers. The merged widget state is never an
 * input: its per-window merge retains a stale value for a window a later
 * reading omitted, which would pair a stale five-hour percent with a fresh
 * weekly one and corrupt the ratio.
 *
 * Everything here is a deterministic function of stored state, one paired
 * reading, and a supplied clock — no network, no timers, no hidden clock reads.
 */

import type { ChatGPTUsageSnapshot, ChatGPTUsageState } from "./tracker-state";
import { FIVE_HOUR_MS } from "./chatgpt-usage";

/** One window's used percent, finite and successful; null when unusable. */
function usablePercent(window: ChatGPTUsageState): number | null {
  if (window.kind !== "ok") return null;
  const usedPercent = window.usedPercent;
  return typeof usedPercent === "number" && Number.isFinite(usedPercent) ? usedPercent : null;
}

function resetTimestamp(resetsAt: number | null | undefined): number | null {
  return typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : null;
}

/**
 * The baseline pair: the reading that anchors consumption measurement for the
 * current windows — both used percentages, both reported reset timestamps, and
 * the local capture timestamp.
 */
export interface BaselinePair {
  /** Five-hour used percent at capture. */
  u5: number;
  /** Weekly used percent at capture. */
  u7: number;
  /** Reported five-hour reset timestamp; null when the reading omitted it. */
  r5: number | null;
  /** Reported weekly reset timestamp; null when the reading omitted it. */
  r7: number | null;
  /** Local capture timestamp, epoch ms. */
  at: number;
}

/** Learned estimate state: the current baseline pair plus the stored estimate. */
export interface QuotaEstimateState {
  baseline: BaselinePair | null;
  /** Quota ratio from the last qualifying sample; null until one exists. */
  estimate: number | null;
}

/** A baseline is never trusted past the five-hour window it anchors. */
const BASELINE_MAX_AGE_MS = FIVE_HOUR_MS;
/**
 * A local capture time this far ahead of the local clock is impossible: the
 * archive is local, so every writer and reader shares the system clock, and
 * such a timestamp means the clock moved backwards after the write (or the
 * document came from a foreign clock). A baseline anchored in the future never
 * ages out, so it is rejected as state instead of blocking measurement forever.
 */
export const BASELINE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/**
 * A real rollover moves a reported reset timestamp by hours or days; this
 * tolerance absorbs second-level rounding in relative reset fields.
 */
const RESET_MOVE_TOLERANCE_MS = 30 * 60 * 1000;
/** Percentage-decrease fallback: a rollover drops a counter by more than this. */
const RESET_DROP_POINTS = 1;
/** Five-hour movement a sample needs before it may replace the stored estimate. */
const QUALIFYING_SPAN_POINTS = 50;
/** A saturated window hides later consumption, so its movement is unusable. */
const SATURATION_POINTS = 100;

export function createQuotaEstimateState(): QuotaEstimateState {
  return { baseline: null, estimate: null };
}

/**
 * Fold one paired reading into the estimate state. A rollover of either window
 * — or the first reading ever — rebuilds the baseline and yields no sample;
 * otherwise the reading's absolute percentage-point deltas from the baseline
 * yield a sample that replaces the stored estimate when it qualifies. Readings
 * missing a usable window leave the state untouched.
 */
export function observeQuotaReading(
  state: QuotaEstimateState,
  reading: ChatGPTUsageSnapshot,
  now: number,
): QuotaEstimateState {
  const fiveHour = usablePercent(reading.fiveHour);
  const weekly = usablePercent(reading.weekly);
  if (fiveHour === null || weekly === null) return state;

  const baseline = state.baseline;
  if (!baseline || isRollover(baseline, reading, fiveHour, weekly, now)) {
    return {
      baseline: {
        u5: fiveHour,
        u7: weekly,
        r5: resetTimestamp(reading.fiveHour.resetsAt),
        r7: resetTimestamp(reading.weekly.resetsAt),
        at: now,
      },
      estimate: state.estimate,
    };
  }

  const deltaFiveHour = fiveHour - baseline.u5;
  const deltaWeekly = weekly - baseline.u7;
  if (
    deltaFiveHour <= 0 ||
    deltaWeekly <= 0 ||
    fiveHour >= SATURATION_POINTS ||
    weekly >= SATURATION_POINTS ||
    deltaFiveHour < QUALIFYING_SPAN_POINTS
  ) {
    return state;
  }

  return { baseline, estimate: deltaFiveHour / deltaWeekly };
}

/**
 * A rollover of either window — or an aged-out or future-dated baseline —
 * invalidates the baseline; no sample spans it.
 */
function isRollover(
  baseline: BaselinePair,
  reading: ChatGPTUsageSnapshot,
  fiveHour: number,
  weekly: number,
  now: number,
): boolean {
  if (now - baseline.at >= BASELINE_MAX_AGE_MS) return true;
  if (baseline.at - now > BASELINE_FUTURE_TOLERANCE_MS) return true;
  return (
    windowRolledOver(baseline.r5, resetTimestamp(reading.fiveHour.resetsAt), baseline.u5, fiveHour) ||
    windowRolledOver(baseline.r7, resetTimestamp(reading.weekly.resetsAt), baseline.u7, weekly)
  );
}

/**
 * Detect one window's rollover: a reported reset timestamp that moved beyond
 * the tolerance, or — only when either side lacks a timestamp — a used-percent
 * drop of more than one point.
 */
function windowRolledOver(
  baselineReset: number | null,
  currentReset: number | null,
  baselinePercent: number,
  currentPercent: number,
): boolean {
  if (baselineReset !== null && currentReset !== null) {
    return Math.abs(currentReset - baselineReset) > RESET_MOVE_TOLERANCE_MS;
  }
  return baselinePercent - currentPercent > RESET_DROP_POINTS;
}

/**
 * The segment appended to the 7d line: `left≈N.N×5h · ratio≈R.R` once a
 * qualifying sample exists, `estimating…` before one ever does, and null when
 * either window is unusable so that the line renders exactly as it did before
 * this feature.
 *
 * `left` is the remaining budget recomputed from the weekly percent this
 * redraw displays, not from the reading that produced the estimate, so it
 * tracks weekly consumption on every redraw. `left` precedes `ratio` because
 * it is the more actionable number, and a narrower line therefore drops
 * `ratio` first.
 */
export function buildQuotaEstimateSegment(
  estimate: QuotaEstimateState,
  fiveHour: ChatGPTUsageState,
  weekly: ChatGPTUsageState,
): string | null {
  const weeklyPercent = usablePercent(weekly);
  if (usablePercent(fiveHour) === null || weeklyPercent === null) return null;
  const ratio = estimate.estimate;
  if (ratio === null) return "estimating…";
  return `left≈${remainingBudget(weeklyPercent, ratio).toFixed(1)}×5h · ratio≈${ratio.toFixed(1)}`;
}

/**
 * Remaining budget: the unconsumed weekly share expressed as a count of full
 * five-hour quotas. Credit overage is never part of it, so a window at or past
 * its plan quota reads zero and the count can never exceed the plan ratio.
 */
function remainingBudget(weeklyPercent: number, ratio: number): number {
  const clamped = Math.min(SATURATION_POINTS, Math.max(0, weeklyPercent));
  return ((SATURATION_POINTS - clamped) / SATURATION_POINTS) * ratio;
}
