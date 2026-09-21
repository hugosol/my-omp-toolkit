/**
 * Estimate state document — the persisted Codex quota-ratio measurement,
 * observed at both surfaces: the mounted extension (the rendered 7d line says
 * what it believes) and the document's own bytes under a substituted archive
 * home. Covers the readable-document round trip, first-run behaviour, cold start,
 * write cadence, retry after a failed write, restart continuity, the never-
 * expiring stored estimate, and `/budget clear`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { archiveDocumentPath } from "../../extensions/model-cost/archive-store";
import { __setOmpModuleLoaderForTest } from "../../extensions/model-cost/chatgpt-usage";
import { createDailyTracker, type DailyData } from "../../extensions/model-cost/daily-tracker";
import {
  codexContext,
  fire,
  fireWithPayload,
  flushPromises,
  installFakeCodexModules,
  mountExtension,
  renderLastWidget,
  runCommand,
} from "./extension-harness";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

// HOME/USERPROFILE point at a temp directory so the mounted extension loads and
// publishes the estimate document inside the test's own archive home.
const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-estimate-document-"));
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

type Theme = { fg: (color: string, text: string) => string };

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

/** One paired reading as a Codex usage report. */
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

// ── The document under test ──

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

function estimateDocumentPath(): string {
  return archiveDocumentPath(ESTIMATE_DOCUMENT);
}

function estimateArchiveDirectory(): string {
  return path.dirname(estimateDocumentPath());
}

/** Read the document's bytes; a caller only does this once a write landed. */
function readEstimateDocument(): EstimateDocument {
  return JSON.parse(fs.readFileSync(estimateDocumentPath(), "utf-8")) as EstimateDocument;
}

function writeEstimateDocument(document: EstimateDocument): void {
  fs.writeFileSync(estimateDocumentPath(), JSON.stringify(document, null, 2), "utf-8");
}

/** Decode a written document back into the internal measurement terms. */
function toInternal(document: EstimateDocument): InternalEstimate {
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

/** Build a written document from a fixture; UTC `Z` keeps it machine-fixed. */
function toDocument(state: InternalEstimate): EstimateDocument {
  const { r5, r7 } = state.base;
  return {
    baseline: {
      capturedAt: new Date(state.base.at).toISOString(),
      fiveHour: {
        usedPercent: state.base.u5,
        resetsAt: r5 === null ? null : new Date(r5).toISOString(),
      },
      weekly: {
        usedPercent: state.base.u7,
        resetsAt: r7 === null ? null : new Date(r7).toISOString(),
      },
    },
    ratio: state.ratio,
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

interface CodexSession {
  widgetContents: unknown[];
  commands: Map<string, (args: string, ctx: unknown) => unknown>;
  ctx: unknown;
  report(windows: PairedWindows): void;
  start(): Promise<unknown>;
  turn(): Promise<unknown>;
  redraw(): Promise<unknown>;
  line(width?: number, theme?: Theme): string;
}

/** Mount the extension with a fake Codex loader whose readings the test scripts. */
function mountCodexSession(): CodexSession {
  let reading: PairedWindows = { fiveHour: 0, weekly: 0 };
  installFakeCodexModules({ fetchUsage: async () => usageReport(reading) });
  const { handlers, commands } = mountExtension();
  const { ctx, widgetContents } = codexContext();
  const line = (width = 300, theme?: Theme): string => {
    const rendered = renderLastWidget(widgetContents, width, theme);
    const weekly = rendered.find(candidate => candidate.includes("7d"));
    if (weekly === undefined) throw new Error("no 7d line rendered");
    return weekly;
  };
  return {
    widgetContents,
    commands,
    ctx,
    report(windows) {
      reading = windows;
    },
    start: () => fire(handlers, "session_start", ctx),
    turn: () => fire(handlers, "agent_end", ctx),
    redraw: () => fireWithPayload(handlers, "before_provider_request", {}, ctx),
    line,
  };
}

describe("model-cost Codex estimate document", () => {
  test("a published document round-trips as readable fields, and a restart reads them", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();

      const document = readEstimateDocument();
      expect(toInternal(document)).toEqual({
        base: { u5: 0, u7: 0, r5: R5, r7: R7, at: T0 },
        ratio: 10,
      });
      expect(Object.keys(document)).toEqual(["baseline", "ratio"]);
      expect(Object.keys(document.baseline).sort()).toEqual(["capturedAt", "fiveHour", "weekly"]);
      expect(Object.keys(document.baseline.fiveHour).sort()).toEqual(["resetsAt", "usedPercent"]);
      expect(Object.keys(document.baseline.weekly).sort()).toEqual(["resetsAt", "usedPercent"]);
      expect(document.baseline.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/);
      expect(Date.parse(document.baseline.capturedAt)).toBe(T0);
      expect(Date.parse(document.baseline.fiveHour.resetsAt!)).toBe(R5);
      expect(Date.parse(document.baseline.weekly.resetsAt!)).toBe(R7);

      // A fresh instance continues the measurement: repeating the stored
      // baseline shows the stored estimate, so nothing was relearned.
      clock.now = T0 + 2 * 60 * 1000;
      const restarted = mountCodexSession();
      restarted.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.start();

      expect(restarted.line()).toContain("left≈10.0×5h · ratio≈10.0");
    });
  });

  test("the first reading publishes the baseline, and a restart keeps measuring from it", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      await flushPromises();

      // The baseline is published before any ratio exists, so the line shows
      // estimating… while the measurement is already on disk.
      expect(session.line()).toContain("estimating…");
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 10, u7: 2, r5: R5, r7: R7, at: T0 },
        ratio: null,
      });

      // A restart inside the same five-hour window continues from the persisted
      // baseline instead of re-anchoring on the next reading.
      clock.now = T0 + 5 * 60 * 1000;
      const restarted = mountCodexSession();
      restarted.report({ fiveHour: 40, weekly: 4, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.start();
      await flushPromises();

      expect(restarted.line()).toContain("estimating…");
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 10, u7: 2, r5: R5, r7: R7, at: T0 },
        ratio: null,
      });

      // The qualifying sample spans the original 10 → 90 five-hour points, not
      // the post-restart 40 → 90, and fills in the ratio beside the kept
      // baseline.
      restarted.report({ fiveHour: 90, weekly: 6, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.turn();
      await flushPromises();

      expect(restarted.line()).toContain("ratio≈20.0");
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 10, u7: 2, r5: R5, r7: R7, at: T0 },
        ratio: 20,
      });
    });
  });

  test("a five-hour rollover publishes the new baseline even before any ratio exists", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      await flushPromises();
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 10, u7: 2, r5: R5, r7: R7, at: T0 },
        ratio: null,
      });

      // The five-hour window rolls over: the new baseline lands immediately
      // with the ratio still unknown.
      clock.now = T0 + 4 * HOUR_MS;
      const rolledR5 = R5 + FIVE_HOUR_MS;
      session.report({ fiveHour: 3, weekly: 4, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();

      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 3, u7: 4, r5: rolledR5, r7: R7, at: T0 + 4 * HOUR_MS },
        ratio: null,
      });
    });
  });

  test("skipped samples and redraw-only passes write nothing", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();

      // Stand a sentinel document in the same shape: any writer that fires
      // would replace it.
      const sentinel = toDocument({
        base: { u5: 7, u7: 7, r5: R5, r7: R7, at: T0 - 90_000 },
        ratio: 3.5,
      });
      writeEstimateDocument(sentinel);

      // One point below the five-hour span threshold: a skipped sample.
      clock.now = T0 + 2 * 60 * 1000;
      session.report({ fiveHour: 49, weekly: 4.9, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(readEstimateDocument()).toEqual(sentinel);

      // A redraw carries no paired reading at all; it recomputes display text
      // from the reading already held and writes nothing.
      await session.redraw();
      expect(session.line()).toContain("4.9% /");
      await flushPromises();
      expect(readEstimateDocument()).toEqual(sentinel);

      expect(fs.readdirSync(estimateArchiveDirectory()).filter(name => name !== ESTIMATE_DOCUMENT)).toEqual([]);
    });
  });

  test("a baseline change writes at once while a ratio refinement waits a minute", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      // The first qualifying sample — 50 / 5 — computes the ratio in memory,
      // but its write waits out the throttle armed by the baseline publication.
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(session.line()).toContain("ratio≈10.0");
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 0, u7: 0, r5: R5, r7: R7, at: T0 },
        ratio: null,
      });

      // A rollover moves the reported five-hour reset: a new baseline lands
      // immediately, well inside the ratio throttle.
      clock.now = T0 + 30 * 1000;
      const rolledR5 = R5 + FIVE_HOUR_MS;
      session.report({ fiveHour: 5, weekly: 1, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 5, u7: 1, r5: rolledR5, r7: R7, at: T0 + 30 * 1000 },
        ratio: 10,
      });

      // A ratio-only refinement 30 seconds after that write is withheld in
      // memory: 55 / 6 = 9.2 shows on the line but not yet in the file.
      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 5, u7: 1, r5: rolledR5, r7: R7, at: T0 + 30 * 1000 },
        ratio: 10,
      });
      expect(session.line()).toContain("ratio≈9.2");

      // 61 seconds after the write it is published; 60 / 8 = 7.5.
      clock.now = T0 + 91 * 1000;
      session.report({ fiveHour: 65, weekly: 9, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 5, u7: 1, r5: rolledR5, r7: R7, at: T0 + 30 * 1000 },
        ratio: 7.5,
      });
    });
  });

  test("a failed write keeps the in-memory state and the next trigger retries it", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(readEstimateDocument().ratio).toBe(10);

      // Break the archive: the cost-archive directory is a regular file, so
      // every publication fails.
      const archiveDirectory = estimateArchiveDirectory();
      fs.rmSync(archiveDirectory, { recursive: true, force: true });
      fs.writeFileSync(archiveDirectory, "", "utf-8");

      // The failed baseline write never rejects out of the event handler, and
      // the rolled-over baseline survives in memory.
      clock.now = T0 + 90 * 1000;
      const rolledR5 = R5 + FIVE_HOUR_MS;
      session.report({ fiveHour: 5, weekly: 1, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await expect(session.turn()).resolves.toBeUndefined();
      await flushPromises();
      expect(session.line()).toContain("ratio≈10.0");

      // Healed archive, next trigger 61 seconds after the last successful
      // write: the retry publishes the state the failed write was carrying,
      // not a fresh anchor on this reading.
      fs.rmSync(archiveDirectory, { force: true });
      clock.now = T0 + 121 * 1000;
      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();

      expect(toInternal(readEstimateDocument())).toEqual({
        base: { u5: 5, u7: 1, r5: rolledR5, r7: R7, at: T0 + 90 * 1000 },
        ratio: 9.1667,
      });
    });
  });

  test("a restart continues the loaded baseline and the stored estimate never expires", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();
      expect(session.line()).toContain("ratio≈10.0");

      // The restart shows the stored estimate without relearning: its first
      // reading repeats the loaded baseline, so no sample can be produced.
      clock.now = T0 + 2 * 60 * 1000;
      const restarted = mountCodexSession();
      restarted.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.start();
      expect(restarted.line()).toContain("left≈10.0×5h · ratio≈10.0");

      // It keeps sampling from the loaded baseline — 55 / 5 spans the whole
      // window, where a fresh measurement would have had to start over.
      clock.now = T0 + 3 * 60 * 1000;
      restarted.report({ fiveHour: 55, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.turn();
      await flushPromises();
      expect(restarted.line()).toContain("ratio≈11.0");
      expect(readEstimateDocument().ratio).toBe(11);

      // An idle stretch far longer than the five-hour window ages the baseline
      // out, but never the stored estimate.
      clock.now = T0 + 3 * DAY_MS;
      restarted.report({ fiveHour: 55, weekly: 30, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await restarted.turn();
      await flushPromises();
      expect(restarted.line()).not.toContain("estimating…");
      expect(restarted.line()).toContain("left≈7.7×5h · ratio≈11.0");

      const afterIdle = mountCodexSession();
      afterIdle.report({ fiveHour: 55, weekly: 30, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await afterIdle.start();
      expect(afterIdle.line()).toContain("ratio≈11.0");
    });
  });

  test("/budget clear leaves the estimate document untouched while the daily archive resets", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      clock.now = T0 + 60 * 1000;
      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      await flushPromises();

      const daily = createDailyTracker();
      const dailyData: DailyData = {
        start: "2026-09-21T00:00:00.000Z",
        totalCost: 12.5,
        totalTokens: { input: 1_000, cacheRead: 500, output: 200 },
        sessions: [{ id: "s1", name: "test", lastInput: 1_000, lastCacheRead: 500, lastOutput: 200, cost: 12.5 }],
      };
      await daily.write(dailyData);
      const before = fs.readFileSync(estimateDocumentPath(), "utf-8");

      await runCommand(session.commands, "budget", "clear", session.ctx);
      await flushPromises();

      expect(fs.readFileSync(estimateDocumentPath(), "utf-8")).toBe(before);
      const reset = createDailyTracker().read();
      expect(reset.totalCost).toBe(0);
      expect(reset.sessions).toEqual([]);
      expect(fs.readdirSync(estimateArchiveDirectory()).filter(name => name.startsWith("deepseek-cost-2"))).toHaveLength(1);
    });
  });
});

describe("model-cost Codex estimate document first runs", () => {
  const baseline = { u5: 10, u7: 2, r5: R5, r7: R7, at: T0 };
  const baselineDocument = toDocument({ base: baseline, ratio: 6.7 }).baseline;

  const invalidDocuments: Array<[string, string | null]> = [
    ["an absent document", null],
    ["an unparseable document", '{"baseline": {"fiveHour":'],
    ["a document with no estimate", JSON.stringify({ baseline: baselineDocument })],
    ["a document whose baseline is not an object", JSON.stringify({ baseline: 7, ratio: 6.7 })],
    ["a document whose estimate is not a number", JSON.stringify({ baseline: baselineDocument, ratio: "6.7" })],
    ["a used percent above 100", JSON.stringify({ baseline: { ...baselineDocument, fiveHour: { ...baselineDocument.fiveHour, usedPercent: 101 } }, ratio: 6.7 })],
    ["a negative used percent", JSON.stringify({ baseline: { ...baselineDocument, weekly: { ...baselineDocument.weekly, usedPercent: -1 } }, ratio: 6.7 })],
    ["a malformed capture time", JSON.stringify({ baseline: { ...baselineDocument, capturedAt: "yesterday" }, ratio: 6.7 })],
    ["a malformed reset time", JSON.stringify({ baseline: { ...baselineDocument, fiveHour: { ...baselineDocument.fiveHour, resetsAt: "tomorrow" } }, ratio: 6.7 })],
    ["a zero estimate", JSON.stringify({ baseline: baselineDocument, ratio: 0 })],
    ["a negative estimate", JSON.stringify({ baseline: baselineDocument, ratio: -6.7 })],
    ["a baseline captured in the future", JSON.stringify({ baseline: { ...baselineDocument, capturedAt: new Date(T0 + DAY_MS).toISOString() }, ratio: 6.7 })],
    ["the previous six-number document", JSON.stringify({ base: baseline, ratio: 6.7 })],
  ];

  for (const [description, contents] of invalidDocuments) {
    test(`${description} reads as a first run and the next qualifying sample republishes`, async () => {
      await withClock(T0, async clock => {
        if (contents !== null) {
          fs.mkdirSync(estimateArchiveDirectory(), { recursive: true });
          fs.writeFileSync(estimateDocumentPath(), contents, "utf-8");
        }

        const session = mountCodexSession();
        session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
        await session.start();
        await flushPromises();

        expect(session.line()).toContain("estimating…");
        expect(session.line()).not.toContain("ratio≈");

        clock.now = T0 + 60 * 1000;
        session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
        await session.turn();
        await flushPromises();

        expect(toInternal(readEstimateDocument())).toEqual({ base: baseline, ratio: 10 });
      });
    });
  }
});
