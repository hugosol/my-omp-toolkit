/**
 * Estimate state document — the one file that carries the Codex quota-ratio
 * measurement across OMP restarts: `codex-usage-estimate.json` in the shared
 * cost archive (`~/.omp/cost-archive`, see archive-store.ts, which owns
 * directory resolution, locking and atomic publication).
 *
 * The document is exactly six numbers — the baseline pair's two used
 * percentages, its two reported reset timestamps, its local capture timestamp,
 * and the stored estimate — with no schema version field and nothing else.
 *
 * Before an estimate exists there is no writable document: the six-number
 * shape has no room for a baseline without one, so a first run keeps its
 * baseline in memory until a sample qualifies and publishes both together. The
 * in-progress sample — the current deltas and the candidate ratio — is
 * recomputable from the baseline and the latest reading, so it is never
 * written at all.
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

/** A settled estimate: state that holds both a baseline and an estimate. */
interface SettledEstimate {
  baseline: BaselinePair;
  estimate: number;
}

/** The document's exact shape: the settled baseline pair, then the estimate. */
interface QuotaEstimateDocument {
  base: BaselinePair;
  ratio: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A used percent is a share of the window's quota, so it cannot leave 0–100. */
function isUsedPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

/** A reported reset timestamp is epoch ms, or null when a reading omitted it. */
function isResetTimestamp(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/**
 * Read one document back into state, checking shape and ranges. Anything else
 * — a missing baseline or estimate, a non-finite number, a used percent
 * outside 0–100, a non-positive estimate — reads as `null`, i.e. as no state.
 */
function fromDocument(raw: unknown): SettledEstimate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { base, ratio } = raw as { base?: unknown; ratio?: unknown };
  if (typeof base !== "object" || base === null) return null;
  const { u5, u7, r5, r7, at } = base as Record<string, unknown>;
  if (!isUsedPercent(u5) || !isUsedPercent(u7)) return null;
  if (!isResetTimestamp(r5) || !isResetTimestamp(r7) || !isFiniteNumber(at)) return null;
  if (!isFiniteNumber(ratio) || ratio <= 0) return null;
  return { baseline: { u5, u7, r5, r7, at }, estimate: ratio };
}

/**
 * Load the document, lock-free. A missing, unreadable, wrong-shape or
 * out-of-range document reads as a first run: no crash, no fabricated value,
 * and the next qualifying sample publishes a valid document again.
 */
function loadEstimate(): SettledEstimate | null {
  try {
    return fromDocument(readArchiveDocument(ESTIMATE_DOCUMENT));
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
  let state: QuotaEstimateState = loadEstimate() ?? createQuotaEstimateState();
  /** When the last publication landed; the throttle's anchor. */
  let publishedAt: number | null = null;

  /**
   * Publish under the shared lock, merging by baseline capture time: a newer
   * on-disk baseline wins and is adopted, so this instance neither replaces it
   * nor restarts its measurement, while an older one is superseded by this
   * instance's state. A failure is swallowed — the in-memory state stays as it
   * is and the next trigger retries the write.
   */
  function publish(settled: SettledEstimate, now: number): Promise<void> {
    return withArchiveLock(ESTIMATE_DOCUMENT, async () => {
      const onDisk = loadEstimate();
      if (onDisk !== null && onDisk.baseline.at > settled.baseline.at) {
        // The document already carries a newer baseline: adopt it unless this
        // instance anchored an even later one while this write was queued, so
        // the in-memory state can never move backwards either.
        const anchored = state.baseline;
        if (anchored === null || anchored.at < onDisk.baseline.at) state = onDisk;
        return;
      }
      const document: QuotaEstimateDocument = { base: settled.baseline, ratio: settled.estimate };
      publishArchiveDocument(ESTIMATE_DOCUMENT, document);
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
    if (baseline === null || estimate === null) return;
    if (!baselineChanged && publishedAt !== null && now - publishedAt < RATIO_WRITE_INTERVAL_MS) return;
    void publish({ baseline, estimate }, now);
  }

  return {
    get state(): QuotaEstimateState {
      return state;
    },
    observe,
  };
}
