/**
 * Feature-verification census for the Codex 5h quota estimate: what the feature
 * must not have changed, pinned at the mounted extension surface.
 *
 * These tests are censuses, not new behaviour. They pin provider calls, timer
 * registrations and document writes across a redraw-only sweep, the pre-feature
 * bytes of the rest of the widget, and the incompatible-version path — so they
 * fail when the feature alters something it promised to leave alone.
 *
 * Every `before` byte below is recorded output of the extension as it was
 * before this feature landed (commit e48f81b; all feature work is uncommitted,
 * so `git show HEAD:extensions/model-cost/*` is the pre-feature source). The
 * bytes were captured by mounting that pre-feature extension in-process against
 * the same fake Codex provider, frozen clock and empty archive these tests use,
 * and were never rewritten from the current implementation. The frozen clock
 * maps local-time getters to UTC, so the recorded reset text holds on every
 * machine. Every mount runs under the shared harness's temporary archive home:
 * the extension loads the estimate document while mounting.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { __setOmpModuleLoaderForTest } from "../../extensions/model-cost/chatgpt-usage";
import {
  extensionContext,
  fire,
  flushPromises,
  installFakeCodexModules,
  mountExtension,
  renderLastWidget,
  withTemporaryHome,
} from "./extension-harness";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const T0 = 1_800_000_000_000;
const R5 = T0 + 2 * HOUR_MS;
const R7 = T0 + 3 * DAY_MS;

interface Theme {
  fg: (color: string, text: string) => string;
}

const COLOUR_THEME: Theme = { fg: (color, text) => `[${color}]${text}[/${color}]` };

afterEach(() => {
  __setOmpModuleLoaderForTest(null);
  delete process.env.PI_PROXY_OPENAI_CODEX;
  delete process.env.PI_PROXY;
});

// ============================================================================
// Fixtures — recorded pre-feature bytes
// ============================================================================

/**
 * The appended text once a qualifying sample exists: the sampled reading (5h
 * 60%, 7d 7%) with its `ratio≈10.0` estimate reads `left≈9.3×5h · ratio≈10.0`.
 */
const SEGMENT = "left≈9.3×5h · ratio≈10.0";

/** The same segment wrapped by the semantic colour the 7d quota number carries. */
const COLOURED_SEGMENT = "[text]left≈9.3×5h · ratio≈10.0[/text]";

/** One tested width: the pre-feature widget bytes, and the feature's bytes. */
interface WidthCensus {
  width: number;
  before: string[];
  after: string[];
}

/**
 * The Codex widget at each tested width, sampled state. The widths cover the
 * whole existing ladder: the full form, the width where the segment exactly
 * fits, the countdown-only and minimal forms, the last-resort truncation, and
 * widths narrow enough that the pre-existing cut lands inside the core.
 */
const CODEX_ROWS: WidthCensus[] = [
  { width: 300, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0 · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 120, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0 · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 95, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0 · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 76, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━──────────│──────── 7.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━━━━━━━━━━━│─────── 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0 · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 60, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 7.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0 · resets in 3d 0h", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 42, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0% · resets in 2h", "7d 7.0% / 57.1% · resets in 3d 0h", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0% · resets in 2h", "7d 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 30, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1%", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1% · left≈9.3×5h…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 24, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1%", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1% · left≈…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 20, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1%", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.0%", "7d 7.0% / 57.1% · l…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 15, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.…", "7d 7.0% / 57.1%", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% / 60.…", "7d 7.0% / 57.1…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 10, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% …", "7d 7.0% /…", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 60.0% …", "7d 7.0% /…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 5, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 6…", "7d 7…", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 6…", "7d 7…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 3, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h…", "7d…", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h…", "7d…", "📋 Total:  Cache:   0%  Sum:       0"] },
];

/**
 * The first-run state — one paired reading, no estimate yet — per tested width,
 * where the appended text reads `estimating…`.
 */
const ESTIMATING_ROWS: WidthCensus[] = [
  { width: 300, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━──────────│─────── 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━━━━━━━────│──────── 34.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━──────────│─────── 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━━━━━━━────│──────── 34.0% / 57.1% · estimating… · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 76, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━──────────│─────── 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d ━━━━━━━────│──────── 34.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h ━━──────────│─────── 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 34.0% / 57.1% · estimating… · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 60, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 34.0% / 57.1% · resets in 3d 0h (01/18 08:00)", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0% · resets in 2h (01/15 10:00)", "7d 34.0% / 57.1% · estimating… · resets in 3d 0h", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 42, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0% · resets in 2h", "7d 34.0% / 57.1% · resets in 3d 0h", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0% · resets in 2h", "7d 34.0% / 57.1% · estimating…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 24, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0%", "7d 34.0% / 57.1%", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% / 60.0%", "7d 34.0% / 57.1% · esti…", "📋 Total:  Cache:   0%  Sum:       0"] },
  { width: 10, before: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% …", "7d 34.0% …", "📋 Total:  Cache:   0%  Sum:       0"], after: ["[██████████░░░░░░░░░░  50% (136.0K/272.0K)]", "5h 12.0% …", "7d 34.0% …", "📋 Total:  Cache:   0%  Sum:       0"] },
];

/** The pre-feature 7d widget at 300 columns, rendered with the theme's colour markup. */
const COLOURED_BEFORE: string[] = [
  "[success][██████████░░░░░░░░░░  50% (136.0K/272.0K)][/success]",
  "5h [text]━━━━━━━━━━━━[/text]│─────── [text]60.0[/text]% / 60.0% · resets in 2h (01/15 10:00)",
  "7d [text]━[/text]──────────│──────── [text]7.0[/text]% / 57.1% · resets in 3d 0h (01/18 08:00)",
  "📋 Total:  Cache:   0%  Sum:       0",
];

/** DeepSeek-mode and token-only renders, recorded at 300, 120, 60, 24 and 10 columns. */
const MODE_RENDERS = [
  {
    mode: "DeepSeek mode",
    model: { id: "deepseek-v4-pro", provider: "deepseek" },
    lines: ["🔥  [██████░░░░░░░░░░░░░░  30% (136.0K/450.0K)]  ⏳ Accrued: ¥0.0000", "📋 Total:  Cache:   0%  ￥Cache/In/Out：--:--:--  Sum:       0  Cost:    ¥0.0000"],
  },
  {
    mode: "token-only mode",
    model: { id: "deepseek-v4-flash", provider: "opencode-go" },
    lines: ["[██████░░░░░░░░░░░░░░  30% (136.0K/450.0K)]", "📋 Total:  Cache:   0%  Sum:       0"],
  },
];

/** The loader-failure render, recorded at 300, 24 and 5 columns. */
const INCOMPATIBLE_LINES: string[] = [
  "[██████████░░░░░░░░░░  50% (136.0K/272.0K)]",
  "5h incompatible OMP version",
  "7d incompatible OMP version",
  "📋 Total:  Cache:   0%  Sum:       0",
];

const TESTED_WIDTHS = [300, 120, 60, 24, 10];

/**
 * The four pre-feature 7d forms of the sampled reading, recorded at 300, 60, 42
 * and 30 columns: the full form, then each rung the width ladder degrades to —
 * no bar, countdown only, percentages alone.
 */
const PRE_FEATURE_WEEKLY_FORMS = [300, 60, 42, 30].map(width => recordedRow(CODEX_ROWS, width).before[2]!);

// ============================================================================
// Harness
// ============================================================================

/**
 * Run `run` with `Date` frozen at `T0` — the clock the test can advance, so a
 * redraw can be tried past the write throttle — and with local-time getters
 * mapped to UTC, so the recorded reset text `(01/15 10:00)` is the same bytes
 * on every machine.
 */
async function withFrozenClock(run: (clock: { now: number }) => Promise<void>): Promise<void> {
  const RealDate = Date;
  const clock = { now: T0 };
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return clock.now;
    }
    getMonth() {
      return super.getUTCMonth();
    }
    getDate() {
      return super.getUTCDate();
    }
    getHours() {
      return super.getUTCHours();
    }
    getMinutes() {
      return super.getUTCMinutes();
    }
  }
  globalThis.Date = FrozenDate as typeof Date;
  try {
    await run(clock);
  } finally {
    globalThis.Date = RealDate;
  }
}

interface PairedWindows {
  fiveHour?: number;
  weekly?: number;
  fiveHourResetsAt?: number | null;
  weeklyResetsAt?: number | null;
}

/** One paired reading, as the Codex usage provider reports it. */
function usageReport(windows: PairedWindows) {
  const limit = (
    id: string,
    windowId: string,
    durationMs: number,
    usedPercent: number,
    resetsAt: number | null,
  ) => ({
    id,
    scope: { accountId: "acct-1", windowId },
    window: { id: windowId, durationMs, ...(resetsAt === null ? {} : { resetsAt }) },
    amount: { used: usedPercent, limit: 100, usedFraction: usedPercent / 100, unit: "percent" },
  });
  const limits: unknown[] = [];
  if (windows.fiveHour !== undefined) {
    limits.push(limit("openai-codex:primary", "5h", FIVE_HOUR_MS, windows.fiveHour, windows.fiveHourResetsAt ?? null));
  }
  if (windows.weekly !== undefined) {
    limits.push(limit("openai-codex:secondary", "7d", WEEK_MS, windows.weekly, windows.weeklyResetsAt ?? null));
  }
  return { provider: "openai-codex", fetchedAt: T0, limits };
}

/**
 * A Codex-mode context that records timer registrations: the shared
 * timer-recording context plus the OAuth account surface the Codex usage fetch
 * reads, so a mounted session arms exactly the timers production would.
 */
function codexTimerContext() {
  const mounted = extensionContext(136_000);
  Object.assign(mounted.ctx.modelRegistry, {
    authStorage: {
      listOAuthAccounts: () => [{ position: 0, accountId: "acct-1", email: "u@example.com" }],
      getOAuthAccessAt: async () => ({ ok: true, accessToken: "token-1", accountId: "acct-1", email: "u@example.com" }),
      fetchUsageReports: async () => {
        throw new Error("aggregate usage must not be called");
      },
    },
  });
  return mounted;
}

/** Mount the Codex extension against a fake provider whose single reading the test scripts. */
function mountCodexSession(
  reading: PairedWindows = { fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 },
) {
  const usage = { reading, calls: 0 };
  installFakeCodexModules({
    fetchUsage: async () => {
      usage.calls += 1;
      return usageReport(usage.reading);
    },
  });
  process.env.PI_PROXY = "http://generic-proxy";
  const { handlers } = mountExtension();
  const { ctx, widgetContents, timers } = codexTimerContext();
  return {
    usage,
    timers,
    widgetContents,
    start: () => fire(handlers, "session_start", ctx),
    turn: () => fire(handlers, "agent_end", ctx),
    redraw: () => fire(handlers, "before_provider_request", {}, ctx),
  };
}

/** Mount a Codex session and settle one qualifying sample: 5h 60%, 7d 7%, ratio 10.0. */
async function sampledSession() {
  const session = mountCodexSession();
  await session.start();
  session.usage.reading = { fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 };
  await session.turn();
  return session;
}

function recordedRow(rows: WidthCensus[], width: number): WidthCensus {
  const row = rows.find(candidate => candidate.width === width);
  if (!row) throw new Error(`no recorded census row for width ${width}`);
  return row;
}

/** The rendered line that starts with `prefix`, or a failure naming the prefix. */
function lineStartingWith(lines: string[], prefix: string): string {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`no line starting with ${JSON.stringify(prefix)} was rendered`);
  return line;
}

/** The registered timers as the deadline list the pre-feature baseline pins. */
function deadlines(timers: Array<{ id: number; at: number }>): Array<{ id: number; at: number }> {
  return timers.map(({ id, at }) => ({ id, at }));
}

/**
 * The contract's insertion point: the appended segment sits between the two
 * percentages and the reset text. A pre-feature line and its segment therefore
 * compose by splicing at ` · resets in`, or by appending to the minimal form,
 * which carries no reset text.
 */
function withEstimateSegment(preFeatureLine: string, segment: string): string {
  const resetIndex = preFeatureLine.indexOf(" · resets in");
  if (resetIndex < 0) return `${preFeatureLine} · ${segment}`;
  return `${preFeatureLine.slice(0, resetIndex)} · ${segment}${preFeatureLine.slice(resetIndex)}`;
}

/**
 * Render the mounted widget at every width from 1 to 300 with no lifecycle
 * event, then let any write a render queued land, so the document census sees
 * it.
 */
async function sweepRedraws(widgetContents: unknown[]): Promise<void> {
  for (let width = 1; width <= 300; width += 1) {
    const lines = renderLastWidget(widgetContents, width);
    if (lines.length === 0) throw new Error(`no widget content at width ${width}`);
  }
  await flushPromises();
}

/**
 * The recorded pre-feature 7d form a rendered line is built from, or a failure
 * naming the line: a render that is not a pre-feature form plus the segment at
 * the contract's insertion point means the feature rewrote bytes it promised to
 * leave alone.
 */
function coreFormOf(weekly: string): string {
  const core = PRE_FEATURE_WEEKLY_FORMS.find(form => withEstimateSegment(form, SEGMENT) === weekly);
  if (core === undefined) {
    throw new Error(`not a recorded pre-feature form plus the segment: ${JSON.stringify(weekly)}`);
  }
  return core;
}

/** Every archive file with its bytes and mtime, for "nothing was written" censuses. */
function archiveSnapshot(): Record<string, string> {
  const directory = path.join(process.env.HOME!, ".omp", "cost-archive");
  if (!fs.existsSync(directory)) return {};
  const snapshot: Record<string, string> = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    snapshot[name] = `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf-8")}`;
  }
  return snapshot;
}

// ============================================================================
// Widget bytes
// ============================================================================

describe("model-cost feature verification: widget bytes", () => {
  test("the Codex widget keeps every pre-feature line byte for byte, at every tested width", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();

        for (const row of CODEX_ROWS) {
          const rendered = renderLastWidget(session.widgetContents, row.width);
          expect({ width: row.width, lines: rendered.length }).toEqual({ width: row.width, lines: 4 });
          // The 272K context bar, the five-hour line and the token totals are
          // exactly the bytes the pre-feature extension rendered.
          expect({ width: row.width, context: rendered[0], fiveHour: rendered[1], total: rendered[3] }).toEqual({
            width: row.width,
            context: row.before[0],
            fiveHour: row.before[1],
            total: row.before[3],
          });
          // Only the 7d line moves, and it moves exactly as recorded.
          expect({ width: row.width, weekly: rendered[2] }).toEqual({ width: row.width, weekly: row.after[2] });
        }
      });
    });
  });

  test("the appended segment is the only text the 7d line gains, at the documented insertion point", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();
        const pureInsertions: number[] = [];

        for (const row of CODEX_ROWS) {
          const weekly = lineStartingWith(renderLastWidget(session.widgetContents, row.width), "7d");
          if (!weekly.includes(` · ${SEGMENT}`)) continue;
          // Removing the appended segment restores a form the pre-feature
          // extension rendered: the feature never rewrites the bytes the line
          // already carried, it only inserts.
          expect(PRE_FEATURE_WEEKLY_FORMS).toContain(weekly.replace(` · ${SEGMENT}`, ""));
          // And a recorded pre-feature form spliced at the contract's insertion
          // point — between the percentages and the reset text — reproduces the
          // line byte for byte.
          coreFormOf(weekly);
          if (withEstimateSegment(row.before[2]!, SEGMENT) === weekly) pureInsertions.push(row.width);
        }

        // Where the pre-feature line already showed the full form the segment is
        // a pure insertion: the two wide widths and 95, the exact fit.
        expect(pureInsertions).toEqual([300, 120, 95]);
      });
    });
  });

  test("a width that cannot hold the extra text degrades along the existing ladder and alters no pre-feature byte", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();

        for (const width of [76, 60, 42]) {
          const row = recordedRow(CODEX_ROWS, width);
          const weekly = lineStartingWith(renderLastWidget(session.widgetContents, width), "7d");
          // The pre-feature line at this width is one of the recorded forms,
          // and the feature renders a narrower recorded form plus the segment.
          expect(PRE_FEATURE_WEEKLY_FORMS).toContain(row.before[2]);
          const core = coreFormOf(weekly);
          expect(weekly).toBe(row.after[2]);
          // It is a degradation, not the same rung: the width's own pre-feature
          // form plus the segment does not fit.
          expect(withEstimateSegment(row.before[2]!, SEGMENT)).not.toBe(weekly);
          // What the narrower rung keeps is byte-identical: both percentages,
          // and the reset text wherever it survived the extra rung.
          expect(weekly).toContain("7.0% / 57.1%");
          const resetIndex = core.indexOf(" · resets in");
          if (resetIndex >= 0) expect(weekly).toContain(core.slice(resetIndex));
        }
      });
    });
  });

  test("the last-resort truncation keeps the pre-feature core and drops ratio before left", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();

        for (const width of [30, 24, 20]) {
          const row = recordedRow(CODEX_ROWS, width);
          const weekly = lineStartingWith(renderLastWidget(session.widgetContents, width), "7d ");
          expect(weekly).toBe(row.after[2]);
          // The pre-feature minimal form survives whole; the appended numbers
          // are cut, and ratio goes before left.
          expect(weekly.startsWith(row.before[2]!)).toBe(true);
          expect(weekly).not.toContain("ratio≈");
          expect(weekly.endsWith("…")).toBe(true);
        }

        // Once the cut lands inside the pre-feature core, the line is the
        // pre-feature bytes with the extra text costing the minimal form its
        // final glyph at 15 columns, and nothing at all below that.
        expect(lineStartingWith(renderLastWidget(session.widgetContents, 15), "7d ")).toBe("7d 7.0% / 57.1…");
        expect(lineStartingWith(renderLastWidget(session.widgetContents, 10), "7d ")).toBe("7d 7.0% /…");
        expect(lineStartingWith(renderLastWidget(session.widgetContents, 5), "7d ")).toBe("7d 7…");
      });
    });
  });

  test("a first run shows the pre-feature line plus estimating…, and nothing else", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = mountCodexSession({ fiveHour: 12, weekly: 34, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
        await session.start();

        for (const row of ESTIMATING_ROWS) {
          const rendered = renderLastWidget(session.widgetContents, row.width);
          expect({ width: row.width, context: rendered[0], fiveHour: rendered[1], total: rendered[3] }).toEqual({
            width: row.width,
            context: row.before[0],
            fiveHour: row.before[1],
            total: row.before[3],
          });
          expect({ width: row.width, weekly: rendered[2] }).toEqual({ width: row.width, weekly: row.after[2] });
        }

        expect(lineStartingWith(renderLastWidget(session.widgetContents, 300), "7d ")).toBe(
          withEstimateSegment(recordedRow(ESTIMATING_ROWS, 300).before[2]!, "estimating…"),
        );
      });
    });
  });

  test("the pre-feature 7d bytes keep their semantic colours, and the segment reuses the quota number's", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();

        const rendered = renderLastWidget(session.widgetContents, 300, COLOUR_THEME);
        expect({ context: rendered[0], fiveHour: rendered[1], total: rendered[3] }).toEqual({
          context: COLOURED_BEFORE[0],
          fiveHour: COLOURED_BEFORE[1],
          total: COLOURED_BEFORE[3],
        });
        expect(rendered[2]).toBe(withEstimateSegment(COLOURED_BEFORE[2]!, COLOURED_SEGMENT));

        const quotaColour = COLOURED_BEFORE[2]!.match(/\[(\w+)\]7\.0\[\/\1\]/)?.[1];
        expect(quotaColour).toBeDefined();
        expect(rendered[2]).toContain(`[${quotaColour}]left≈9.3×5h · ratio≈10.0[/${quotaColour}]`);
      });
    });
  });

  test("DeepSeek-mode and token-only renders keep their pre-feature bytes at every tested width", async () => {
    await withFrozenClock(async () => {
      for (const mode of MODE_RENDERS) {
        await withTemporaryHome(async () => {
          const { handlers } = mountExtension();
          const { ctx, widgetContents } = extensionContext(136_000, mode.model);
          await fire(handlers, "agent_start", ctx);

          for (const width of TESTED_WIDTHS) {
            expect({ mode: mode.mode, width, lines: renderLastWidget(widgetContents, width) }).toEqual({
              mode: mode.mode,
              width,
              lines: mode.lines,
            });
          }
        });
      }
    });
  });
});

// ============================================================================
// Resource censuses
// ============================================================================

describe("model-cost feature verification: redraw-only sweep", () => {
  test("a redraw-only sweep adds no provider call, no timer and no document write", async () => {
    await withFrozenClock(async clock => {
      await withTemporaryHome(async () => {
        const session = mountCodexSession();
        await session.start();

        // The pre-feature baseline for opening a Codex session, measured on the
        // pre-feature extension under this harness: one usage fetch and the one
        // boundary timer, due at the next peak boundary.
        expect({ calls: session.usage.calls, timers: deadlines(session.timers) }).toEqual({
          calls: 1,
          timers: [{ id: 1, at: T0 + 2 * HOUR_MS + 1 }],
        });

        // A first run has no writable document yet, and the sweep is not
        // vacuous: the appended text is on the line it redraws.
        const documentBefore = archiveSnapshot();
        expect(documentBefore).toEqual({});
        const beforeSweep = renderLastWidget(session.widgetContents, 300);
        expect(lineStartingWith(beforeSweep, "7d ")).toContain("estimating…");
        await flushPromises();
        await sweepRedraws(session.widgetContents);
        expect({
          calls: session.usage.calls,
          timers: deadlines(session.timers),
          document: archiveSnapshot(),
          lines: renderLastWidget(session.widgetContents, 300),
        }).toEqual({
          calls: 1,
          timers: [{ id: 1, at: T0 + 2 * HOUR_MS + 1 }],
          document: documentBefore,
          lines: beforeSweep,
        });

        // One qualifying turn — a new observation, not a redraw — is what
        // publishes the document.
        session.usage.reading = { fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 };
        await session.turn();
        await flushPromises();
        const documentAfterTurn = archiveSnapshot();
        expect({ calls: session.usage.calls, files: Object.keys(documentAfterTurn) }).toEqual({
          calls: 2,
          files: ["codex-usage-estimate.json"],
        });
        // Past the ratio write throttle, so a redraw that tried to learn from
        // what is already on screen would publish and show up below.
        clock.now = T0 + 61_000;
        const afterTurn = renderLastWidget(session.widgetContents, 300);
        expect(lineStartingWith(afterTurn, "7d ")).toContain(` · ${SEGMENT}`);
        await flushPromises();

        // The same sweep over the settled estimate: still no call, no timer,
        // and not one byte — nor an mtime — of the document.
        await sweepRedraws(session.widgetContents);
        expect({
          calls: session.usage.calls,
          timers: deadlines(session.timers),
          document: archiveSnapshot(),
          lines: renderLastWidget(session.widgetContents, 300),
        }).toEqual({
          calls: 2,
          timers: [{ id: 1, at: T0 + 2 * HOUR_MS + 1 }],
          document: documentAfterTurn,
          lines: afterTurn,
        });
      });
    });
  });

  test("a redraw carrying no new observation leaves the estimate and the boundary timer where they were", async () => {
    await withFrozenClock(async clock => {
      await withTemporaryHome(async () => {
        const session = await sampledSession();
        // Past the ratio write throttle: an event that tried to learn from the
        // merged widget state would publish here.
        clock.now = T0 + 61_000;
        const document = archiveSnapshot();
        const weekly = lineStartingWith(renderLastWidget(session.widgetContents, 300), "7d ");

        await session.redraw();
        await session.redraw();
        await flushPromises();

        expect({
          calls: session.usage.calls,
          timers: deadlines(session.timers),
          document: archiveSnapshot(),
          weekly: lineStartingWith(renderLastWidget(session.widgetContents, 300), "7d "),
        }).toEqual({
          calls: 2,
          timers: [{ id: 1, at: T0 + 2 * HOUR_MS + 1 }],
          document,
          weekly,
        });
      });
    });
  });
});

// ============================================================================
// Public module surface
// ============================================================================

describe("model-cost feature verification: public module surface", () => {
  test("a failing OMP module loader still renders the incompatible-version message with the extension observable", async () => {
    await withFrozenClock(async () => {
      await withTemporaryHome(async () => {
        const { handlers } = mountExtension();
        const { ctx, widgetContents, timers } = codexTimerContext();
        __setOmpModuleLoaderForTest(async () => {
          throw new Error("Cannot find package '@oh-my-pi/pi-coding-agent'");
        });

        await fire(handlers, "agent_start", ctx);

        for (const width of [300, 24, 5]) {
          expect({ width, lines: renderLastWidget(widgetContents, width) }).toEqual({
            width,
            lines: INCOMPATIBLE_LINES,
          });
        }
        // The extension stays observable: the boundary timer is armed exactly
        // as in the pre-feature baseline, no usage request was made, the
        // archive home stays untouched, and a later lifecycle event still
        // renders the same message.
        expect(deadlines(timers)).toEqual([{ id: 1, at: T0 + 2 * HOUR_MS + 1 }]);
        expect(archiveSnapshot()).toEqual({});
        await fire(handlers, "before_provider_request", {}, ctx);
        expect(renderLastWidget(widgetContents, 300)).toEqual(INCOMPATIBLE_LINES);
      });
    });
  });
});
