/**
 * Estimate state document — the one file that carries the Codex quota-ratio
 * measurement across OMP restarts: `codex-usage-estimate.json` in the shared
 * cost archive (`~/.omp/cost-archive`, see archive-store.ts, which owns
 * directory resolution, locking and atomic publication).
 *
 * The document is human-readable: a `baseline` object naming the five-hour and
 * weekly windows — each with its used percent and reset timestamp — plus the
 * baseline's `capturedAt`, and the stored `ratio` beside it. `ratio` is null
 * until a sample qualifies; timestamps are local-time ISO-8601 strings carrying
 * their UTC offset, and numbers are written with four decimals to keep
 * floating-point noise out of the file. There is no schema version field; a
 * document that does not match this shape is read as a first run, so the
 * previous six-number shape reinitializes rather than migrates.
 *
 * The first usable paired reading publishes the baseline with `ratio: null`, so
 * a restart or a long idle stretch continues measuring from the same baseline
 * instead of re-anchoring. A baseline change — a window rollover, an aged-out
 * or future-dated capture — publishes immediately as well, while a ratio
 * refinement waits out the throttle. A known ratio is never downgraded back to
 * null: a publication or an adopted peer baseline keeps whichever side has one.
 * The in-progress sample — the current deltas and the candidate ratio — is
 * recomputable from the baseline and the latest reading, so it is never
 * written at all.
 *
 * A baseline whose capture time lies ahead of the local clock is not state:
 * the archive is local, so every writer and reader shares the system clock,
 * and such a timestamp means the clock moved backwards after the write. It
 * reads as a first run, and publication replaces it rather than deferring to a
 * document that could never be superseded.
 *
 * Writes are asynchronous and best-effort, off the event handler's critical
 * path: a baseline change is published at once, a qualifying ratio refinement
 * at most once a minute, and nothing else writes the file. A failed write
 * keeps the in-memory state and leaves the throttle unarmed, so the next
 * trigger retries it.
 *
 * Publication merges instead of overwriting: inside the shared lock the
 * on-disk document and the in-memory one are compared by the baseline's
 * capture time and the newer baseline wins, so an instance holding an older
 * state can never replace a newer one. An instance that finds a newer baseline
 * within the same windows adopts it and keeps sampling from it instead of
 * restarting the measurement; with equal capture times the writing instance's
 * state is what lands. A reader only ever parses a complete document, because
 * publication is a rename over the destination.
 */

import { publishArchiveDocument, readArchiveDocument, withArchiveLock } from "./archive-store";
import {
  BASELINE_FUTURE_TOLERANCE_MS,
  createQuotaEstimateState,
  observeQuotaReading,
  type BaselinePair,
  type QuotaEstimateState,
} from "./quota-estimate";
import type { ChatGPTUsageSnapshot } from "./tracker-state";

/** The estimate document inside the shared cost-archive directory. */
const ESTIMATE_DOCUMENT = "codex-usage-estimate.json";

/** A qualifying ratio refinement reaches the document at most this often. */
const RATIO_WRITE_INTERVAL_MS = 60_000;

/** A baseline to publish, carrying the stored estimate when one is known. */
interface SettledEstimate {
  baseline: BaselinePair;
  estimate: number | null;
}

/** One quota window as it appears in the document. */
interface DocumentWindow {
  /** Used percent of that window's quota. */
  usedPercent: number;
  /** Local ISO-8601 reset timestamp with its UTC offset; null when unreported. */
  resetsAt: string | null;
}

/**
 * The document's readable shape: the baseline pair as named windows plus a
 * local capture time, followed by the stored estimate, which is null until a
 * sample qualifies.
 */
interface QuotaEstimateDocument {
  baseline: {
    capturedAt: string;
    fiveHour: DocumentWindow;
    weekly: DocumentWindow;
  };
  ratio: number | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A used percent is a share of the window's quota, so it cannot leave 0–100. */
function isUsedPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

/** ISO-8601 timestamps with an optional millisecond part and a zone. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse one timestamp field back to epoch ms; undefined when malformed. */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A window's reset timestamp is a parseable timestamp, or null when omitted. */
function parseResetTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  return parseTimestamp(value);
}

/**
 * Read one document back into state, checking shape and ranges. Anything else
 * — a missing baseline, a used percent outside 0–100, a malformed or missing
 * timestamp, an estimate that is present but not positive and finite, or a
 * capture time ahead of the local clock — reads as `null`, i.e. as no state.
 * A null (or absent) estimate is valid: the baseline was published before any
 * sample qualified.
 */
function fromDocument(raw: unknown, now: number): SettledEstimate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { baseline, ratio } = raw as { baseline?: unknown; ratio?: unknown };
  if (typeof baseline !== "object" || baseline === null) return null;
  const { capturedAt, fiveHour, weekly } = baseline as Record<string, unknown>;
  if (typeof fiveHour !== "object" || fiveHour === null) return null;
  if (typeof weekly !== "object" || weekly === null) return null;
  const fiveHourWindow = fiveHour as Record<string, unknown>;
  const weeklyWindow = weekly as Record<string, unknown>;
  const at = parseTimestamp(capturedAt);
  const u5 = fiveHourWindow.usedPercent;
  const u7 = weeklyWindow.usedPercent;
  const r5 = parseResetTimestamp(fiveHourWindow.resetsAt);
  const r7 = parseResetTimestamp(weeklyWindow.resetsAt);
  if (at === undefined || r5 === undefined || r7 === undefined) return null;
  if (!isUsedPercent(u5) || !isUsedPercent(u7)) return null;
  if (at - now > BASELINE_FUTURE_TOLERANCE_MS) return null;
  let estimate: number | null;
  if (ratio === null || ratio === undefined) estimate = null;
  else if (isFiniteNumber(ratio) && ratio > 0) estimate = ratio;
  else return null;
  return { baseline: { u5, u7, r5, r7, at }, estimate };
}

/** Write one measurement number with enough precision to read, no float noise. */
function roundForDocument(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Render one epoch-ms instant as a local-time ISO-8601 string with its UTC
 * offset, e.g. `2026-09-21T11:23:47.817+08:00`, preserving milliseconds. The
 * offset is the one in effect at that instant, so timestamps written across a
 * DST change each stay unambiguous.
 */
function toLocalTimestamp(epochMs: number): string {
  const offsetMinutes = -new Date(epochMs).getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  const local = new Date(epochMs + offsetMinutes * 60_000).toISOString();
  return `${local.slice(0, -1)}${offset}`;
}

/** Render the in-memory state as the human-readable document. */
function toDocument(settled: SettledEstimate): QuotaEstimateDocument {
  return {
    baseline: {
      capturedAt: toLocalTimestamp(settled.baseline.at),
      fiveHour: {
        usedPercent: roundForDocument(settled.baseline.u5),
        resetsAt: settled.baseline.r5 === null ? null : toLocalTimestamp(settled.baseline.r5),
      },
      weekly: {
        usedPercent: roundForDocument(settled.baseline.u7),
        resetsAt: settled.baseline.r7 === null ? null : toLocalTimestamp(settled.baseline.r7),
      },
    },
    ratio: settled.estimate === null ? null : roundForDocument(settled.estimate),
  };
}

/**
 * Load the document, lock-free. A missing, unreadable, legacy, wrong-shape,
 * out-of-range or future-dated document reads as a first run: no crash, no
 * fabricated value, and the next qualifying sample publishes a valid document
 * again. `now` is the local clock the document's capture time is judged
 * against.
 */
function loadEstimate(now: number): SettledEstimate | null {
  try {
    return fromDocument(readArchiveDocument(ESTIMATE_DOCUMENT), now);
  } catch {
    return null;
  }
}

/** The extension's estimate state and the document it is published to. */
export interface QuotaEstimateStore {
  /** The estimate the widget renders; what the next write publishes. */
  readonly state: QuotaEstimateState;
  /** Fold one paired reading in, then publish the change per the write policy. */
  observe(reading: ChatGPTUsageSnapshot, now: number): void;
}

/**
 * Open the estimate document and continue its measurement. The loaded baseline
 * and stored estimate are the starting state, so a restart or a long idle
 * stretch shows a usable estimate instead of `estimating…`.
 */
export function createQuotaEstimateStore(): QuotaEstimateStore {
  let state: QuotaEstimateState = loadEstimate(Date.now()) ?? createQuotaEstimateState();
  /** When the last publication landed; the throttle's anchor. */
  let publishedAt: number | null = null;

  /**
   * Publish under the shared lock, merging by baseline capture time: a newer
   * on-disk baseline wins and is adopted, so this instance neither replaces it
   * nor restarts its measurement, while an older one is superseded by this
   * instance's state. A known ratio is never downgraded to null — whichever
   * side has one is what lands. A failure is swallowed — the in-memory state
   * stays as it is and the next trigger retries the write.
   */
  function publish(settled: SettledEstimate, now: number): Promise<void> {
    return withArchiveLock(ESTIMATE_DOCUMENT, async () => {
      const onDisk = loadEstimate(now);
      if (onDisk !== null && onDisk.baseline.at > settled.baseline.at) {
        // The document already carries a newer baseline: adopt it — keeping
        // its ratio when it has one, falling back to this instance's — unless
        // this instance anchored an even later one while this write was
        // queued, so the in-memory state can never move backwards either.
        const anchored = state.baseline;
        if (anchored === null || anchored.at < onDisk.baseline.at) {
          state = { baseline: onDisk.baseline, estimate: onDisk.estimate ?? settled.estimate };
        }
        return;
      }
      // This instance's baseline lands; a known ratio is never downgraded to
      // null, so fall back to the document's when this instance has none.
      const estimate = settled.estimate ?? onDisk?.estimate ?? null;
      publishArchiveDocument(ESTIMATE_DOCUMENT, toDocument({ baseline: settled.baseline, estimate }));
      if (estimate !== null && state.estimate === null) state = { ...state, estimate };
      publishedAt = now;
    }).catch(() => {
      // Best-effort persistence; the reading that triggered this write is
      // never held up or failed by it.
    });
  }

  function observe(reading: ChatGPTUsageSnapshot, now: number): void {
    const next = observeQuotaReading(state, reading, now);
    // Unchanged state — a skipped sample or an unusable reading — is never a
    // write trigger, and neither is a redraw.
    if (next === state) return;
    const baselineChanged = next.baseline !== state.baseline;
    state = next;

    const { baseline, estimate } = state;
    if (baseline === null) return;
    // A new or rolled-over baseline lands immediately, even before any ratio
    // exists, so a restart resumes the same measurement. An unchanged baseline
    // writes only when a ratio appears or moves, and then the throttle applies.
    if (!baselineChanged && (estimate === null || (publishedAt !== null && now - publishedAt < RATIO_WRITE_INTERVAL_MS))) return;
    void publish({ baseline, estimate }, now);
  }

  return {
    get state(): QuotaEstimateState {
      return state;
    },
    observe,
  };
}
