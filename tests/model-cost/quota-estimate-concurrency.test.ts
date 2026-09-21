/**
 * Estimate state document under concurrency: two mounted extensions — two OMP
 * instances — publish into the same `codex-usage-estimate.json` archive home.
 * Covers torn-read safety, the leftover temp/lock census, the read-compare-
 * write merge on baseline capture time (newer baseline wins, older cannot
 * overwrite, equal capture times let the writer land), and adopting a peer's
 * within-window baseline to keep sampling from it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { archiveDocumentPath } from "../../extensions/model-cost/archive-store";
import { __setOmpModuleLoaderForTest } from "../../extensions/model-cost/chatgpt-usage";
import {
  codexContext,
  fire,
  flushPromises,
  installFakeCodexModules,
  mountExtension,
  renderLastWidget,
} from "./extension-harness";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

// HOME/USERPROFILE point at one temp directory: both instances publish into the
// same archive home, exactly as two OMP processes on one machine do.
const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-estimate-concurrent-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PI_PROXY = "http://generic-proxy";
  fs.rmSync(path.join(tempHome, ".omp"), { recursive: true, force: true });
});

afterEach(() => {
  __setOmpModuleLoaderForTest(null);
  delete process.env.PI_PROXY_OPENAI_CODEX;
  delete process.env.PI_PROXY;
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const T0 = 1_800_000_000_000;
const R5 = T0 + 2 * HOUR_MS;
const R7 = T0 + 3 * DAY_MS;

const ESTIMATE_DOCUMENT = "codex-usage-estimate.json";

/** Both windows of one paired reading; an omitted window is not reported. */
interface PairedWindows {
  fiveHour?: number;
  weekly?: number;
  fiveHourResetsAt?: number | null;
  weeklyResetsAt?: number | null;
}

interface CodexLimit {
  id: string;
  scope: { accountId: string; windowId: string };
  window: { id: string; durationMs: number; resetsAt?: number };
  amount: { used: number; limit: number; unit: string };
}

/** One window as the readable document carries it. */
interface DocumentWindow {
  usedPercent: number;
  resetsAt: string | null;
}

/** The written shape: a readable baseline pair, then the stored estimate. */
interface EstimateDocument {
  baseline: {
    capturedAt: string;
    fiveHour: DocumentWindow;
    weekly: DocumentWindow;
  };
  ratio: number;
}

/** The same measurement in the estimator's internal epoch-ms terms. */
interface InternalEstimate {
  base: { u5: number; u7: number; r5: number | null; r7: number | null; at: number };
  ratio: number | null;
}

/**
 * The paired reading both instances fetch. Both mounted extensions share one
 * fake Codex module loader, so a test stages the reading it wants the next
 * handler call to receive, exactly as separate processes each fetch their own.
 */
let reading: PairedWindows = { fiveHour: 0, weekly: 0 };

function report(windows: PairedWindows): void {
  reading = windows;
}

function usageReport(windows: PairedWindows) {
  const limit = (id: string, windowId: string, durationMs: number, usedPercent: number, resetsAt: number | null): CodexLimit => ({
    id,
    scope: { accountId: "acct-1", windowId },
    window: { id: windowId, durationMs, ...(resetsAt === null ? {} : { resetsAt }) },
    // Whole percentages, never a fraction: the document's used percentages are
    // then exactly the numbers each reading scripts, so they can be asserted.
    amount: { used: usedPercent, limit: 100, unit: "percent" },
  });
  const limits: CodexLimit[] = [];
  if (windows.fiveHour !== undefined) {
    limits.push(limit("openai-codex:primary", "5h", FIVE_HOUR_MS, windows.fiveHour, windows.fiveHourResetsAt ?? null));
  }
  if (windows.weekly !== undefined) {
    limits.push(limit("openai-codex:secondary", "7d", WEEK_MS, windows.weekly, windows.weeklyResetsAt ?? null));
  }
  return { provider: "openai-codex", fetchedAt: Date.now(), limits };
}

function estimateDocumentPath(): string {
  return archiveDocumentPath(ESTIMATE_DOCUMENT);
}

function estimateArchiveDirectory(): string {
  return path.dirname(estimateDocumentPath());
}

/** Parse the document exactly as a reader does, and check its shape. */
function readEstimateDocument(): EstimateDocument {
  const document = JSON.parse(fs.readFileSync(estimateDocumentPath(), "utf-8")) as EstimateDocument;
  expect(Object.keys(document)).toEqual(["baseline", "ratio"]);
  expect(Object.keys(document.baseline).sort()).toEqual(["capturedAt", "fiveHour", "weekly"]);
  expect(Object.keys(document.baseline.fiveHour).sort()).toEqual(["resetsAt", "usedPercent"]);
  expect(Object.keys(document.baseline.weekly).sort()).toEqual(["resetsAt", "usedPercent"]);
  return document;
}

/** The stored measurement decoded back into the estimator's epoch-ms terms. */
function readInternal(): InternalEstimate {
  const document = readEstimateDocument();
  const { fiveHour, weekly, capturedAt } = document.baseline;
  return {
    base: {
      u5: fiveHour.usedPercent,
      u7: weekly.usedPercent,
      r5: fiveHour.resetsAt === null ? null : Date.parse(fiveHour.resetsAt),
      r7: weekly.resetsAt === null ? null : Date.parse(weekly.resetsAt),
      at: Date.parse(capturedAt),
    },
    ratio: document.ratio,
  };
}

interface Clock {
  now: number;
}

/** Run `run` against a clock the test moves explicitly. */
async function withClock(start: number, run: (clock: Clock) => Promise<void>): Promise<void> {
  const realNow = Date.now;
  const clock: Clock = { now: start };
  Date.now = () => clock.now;
  try {
    await run(clock);
  } finally {
    Date.now = realNow;
  }
}

interface CodexInstance {
  start(): Promise<unknown>;
  turn(): Promise<unknown>;
  line(width?: number): string;
}

/** Mount one instance whose paired readings come from the shared staging cell. */
function mountCodexInstance(): CodexInstance {
  installFakeCodexModules({ fetchUsage: async () => usageReport(reading) });
  const { handlers } = mountExtension();
  const { ctx, widgetContents } = codexContext();
  return {
    start: () => fire(handlers, "session_start", ctx),
    turn: () => fire(handlers, "agent_end", ctx),
    line(width = 300) {
      const rendered = renderLastWidget(widgetContents, width);
      const weekly = rendered.find(candidate => candidate.includes("7d"));
      if (weekly === undefined) throw new Error("no 7d line rendered");
      return weekly;
    },
  };
}

const baseline = { u5: 0, u7: 0, r5: R5, r7: R7 };

describe("model-cost Codex estimate document concurrency", () => {
  test("interleaved baseline and ratio writes never leave an unparseable or temporary document", async () => {
    await withClock(T0, async clock => {
      const instanceA = mountCodexInstance();
      const instanceB = mountCodexInstance();

      // A anchors, samples, and publishes: 50 / 5 = 10.0.
      report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.start();
      clock.now = T0 + 60 * 1000;
      report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 }, ratio: 10 });

      // B anchors inside the same windows; its baseline publication keeps the
      // peer's ratio instead of dropping it to null.
      clock.now = T0 + 90 * 1000;
      report({ fiveHour: 10, weekly: 1, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.start();
      await flushPromises();
      expect(readInternal()).toEqual({
        base: { u5: 10, u7: 1, r5: R5, r7: R7, at: T0 + 90 * 1000 },
        ratio: 10,
      });

      // B's qualifying sample — 50 / 10 = 5.0 — is withheld by the throttle
      // armed by its own baseline publication.
      clock.now = T0 + 120 * 1000;
      report({ fiveHour: 60, weekly: 11, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(instanceB.line()).toContain("ratio≈5.0");
      expect(readInternal()).toEqual({
        base: { u5: 10, u7: 1, r5: R5, r7: R7, at: T0 + 90 * 1000 },
        ratio: 10,
      });

      // A's five-hour window rolls over: a baseline change, written at once.
      clock.now = T0 + 150 * 1000;
      const rolledR5 = R5 + FIVE_HOUR_MS;
      report({ fiveHour: 4, weekly: 1, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await instanceA.turn();
      await flushPromises();
      expect(readInternal()).toEqual({
        base: { u5: 4, u7: 1, r5: rolledR5, r7: R7, at: T0 + 150 * 1000 },
        ratio: 10,
      });

      // B rolls over too, then refines its ratio against its own new baseline.
      clock.now = T0 + 180 * 1000;
      report({ fiveHour: 3, weekly: 0.5, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({
        base: { u5: 3, u7: 0.5, r5: rolledR5, r7: R7, at: T0 + 180 * 1000 },
        ratio: 5,
      });

      clock.now = T0 + 250 * 1000;
      report({ fiveHour: 58, weekly: 6, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({
        base: { u5: 3, u7: 0.5, r5: rolledR5, r7: R7, at: T0 + 180 * 1000 },
        ratio: 10,
      });

      // Every publication is a rename, so no temporary file survives as the
      // document and nothing else is left in the archive directory.
      expect(fs.readdirSync(estimateArchiveDirectory()).filter(name => name !== ESTIMATE_DOCUMENT)).toEqual([]);
    });
  });

  test("a newer-baseline document is never replaced, and the older instance adopts it", async () => {
    await withClock(T0, async clock => {
      const instanceA = mountCodexInstance();
      const instanceB = mountCodexInstance();

      // B anchors first, A anchors a minute later: A's baseline is the newer.
      report({ fiveHour: 30, weekly: 1, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.start();

      clock.now = T0 + 60 * 1000;
      report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.start();

      clock.now = T0 + 120 * 1000;
      report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 + 60 * 1000 }, ratio: 10 });

      // B's own sample reads 50 / 2 = 25.0, but its baseline is the older one:
      // the document keeps A's state and B adopts it instead.
      clock.now = T0 + 180 * 1000;
      report({ fiveHour: 80, weekly: 3, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 + 60 * 1000 }, ratio: 10 });
      expect(instanceB.line()).toContain("ratio≈10.0");

      // B keeps sampling from the adopted baseline: 55 / 6 spans A's anchor,
      // where B's own anchor would have had nothing to qualify.
      clock.now = T0 + 240 * 1000;
      report({ fiveHour: 55, weekly: 6, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 + 60 * 1000 }, ratio: 9.1667 });
      expect(instanceB.line()).toContain("ratio≈9.2");
    });
  });

  test("equal capture times leave the writing instance's state in the document", async () => {
    await withClock(T0, async clock => {
      const instanceA = mountCodexInstance();
      const instanceB = mountCodexInstance();

      // Both anchor inside the same clock tick, on different percentages.
      report({ fiveHour: 30, weekly: 1, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.start();
      report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.start();

      clock.now = T0 + 60 * 1000;
      report({ fiveHour: 80, weekly: 3, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { u5: 30, u7: 1, r5: R5, r7: R7, at: T0 }, ratio: 25 });

      clock.now = T0 + 120 * 1000;
      report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 }, ratio: 10 });
    });
  });

  test("a mounting instance adopts a peer's within-window baseline and keeps sampling from it", async () => {
    await withClock(T0, async clock => {
      const instanceA = mountCodexInstance();
      report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.start();

      clock.now = T0 + 60 * 1000;
      report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceA.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 }, ratio: 10 });

      // B mounts inside the same windows and reads the peer's measurement
      // instead of starting a fresh one.
      clock.now = T0 + 120 * 1000;
      const instanceB = mountCodexInstance();
      report({ fiveHour: 10, weekly: 1, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.start();
      await flushPromises();
      expect(instanceB.line()).toContain("ratio≈10.0");
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 }, ratio: 10 });

      // Its next sample spans the adopted anchor: 55 / 6, not 45 / 5.
      clock.now = T0 + 180 * 1000;
      report({ fiveHour: 55, weekly: 6, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await instanceB.turn();
      await flushPromises();
      expect(readInternal()).toEqual({ base: { ...baseline, at: T0 }, ratio: 9.1667 });
      expect(instanceB.line()).toContain("ratio≈9.2");
    });
  });
});
