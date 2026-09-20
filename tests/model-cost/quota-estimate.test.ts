/**
 * Codex quota-ratio estimate, observed at the mounted-extension surface: paired
 * usage readings arrive through the fake Codex module loader, and the rendered
 * 7d line carries the appended estimate segment.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  __setOmpModuleLoaderForTest,
  visibleDisplayWidth,
} from "../../extensions/model-cost/chatgpt-usage";
import {
  codexContext,
  fire,
  fireWithPayload,
  installFakeCodexModules,
  mountExtension,
  renderLastWidget,
  withTemporaryHome,
} from "./extension-harness";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

// HOME/USERPROFILE point at a temp directory: a mounted extension loads and
// publishes `codex-usage-estimate.json` from the archive home, so each test
// needs its own empty one instead of the developer's real archive.
const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-quota-estimate-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const T0 = 1_800_000_000_000;

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
  amount: { used: number; limit: number; usedFraction: number; unit: string };
}

/** One paired reading as a Codex usage report. */
function usageReport(windows: PairedWindows) {
  const limit = (id: string, windowId: string, durationMs: number, usedPercent: number, resetsAt: number | null): CodexLimit => ({
    id,
    scope: { accountId: "acct-1", windowId },
    window: { id: windowId, durationMs, ...(resetsAt === null ? {} : { resetsAt }) },
    amount: { used: usedPercent, limit: 100, usedFraction: usedPercent / 100, unit: "percent" },
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

function weeklyLine(widgetContents: unknown[], width = 200, theme?: Theme): string {
  const line = renderLastWidget(widgetContents, width, theme).find(candidate => candidate.includes("7d"));
  if (line === undefined) throw new Error("no 7d line rendered");
  return line;
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
  report(windows: PairedWindows): void;
  headerReport(report: unknown): void;
  start(): Promise<unknown>;
  turn(): Promise<unknown>;
  headers(): Promise<unknown>;
  line(width?: number, theme?: Theme): string;
}

/** Mount the extension with a fake Codex loader whose readings the test scripts. */
function mountCodexSession(): CodexSession {
  let reading: PairedWindows = { fiveHour: 0, weekly: 0 };
  let headerReport: unknown = null;
  installFakeCodexModules({
    fetchUsage: async () => usageReport(reading),
    parseRateLimitHeaders: () => headerReport,
  });
  const { handlers } = mountExtension();
  const { ctx, widgetContents } = codexContext();
  return {
    widgetContents,
    report(windows) {
      reading = windows;
    },
    headerReport(report) {
      headerReport = report;
    },
    start: () => fire(handlers, "session_start", ctx),
    turn: () => fire(handlers, "agent_end", ctx),
    headers: () => fireWithPayload(handlers, "after_provider_response", { headers: {} }, ctx),
    line: (width = 200, theme) => weeklyLine(widgetContents, width, theme),
  };
}

const R5 = T0 + 2 * HOUR_MS;
const R7 = T0 + 3 * DAY_MS;
const COLOR_THEME: Theme = { fg: (color, text) => `[${color}]${text}[/${color}]` };

beforeEach(() => {
  process.env.PI_PROXY = "http://generic-proxy";
  fs.rmSync(path.join(tempHome, ".omp"), { recursive: true, force: true });
});

afterEach(() => {
  __setOmpModuleLoaderForTest(null);
  delete process.env.PI_PROXY_OPENAI_CODEX;
  delete process.env.PI_PROXY;
});

describe("model-cost Codex quota estimate", () => {
  test("a first paired reading renders estimating… between the percentages and the reset text", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 12, weekly: 34, weeklyResetsAt: R7 });

      await session.start();

      const lines = renderLastWidget(session.widgetContents, 300);
      expect(lines[2]).toMatch(/7d .*34\.0% \/ [\d.]+% · estimating… · resets in/);
      expect(lines[1]).toContain("5h");
      expect(lines[1]).not.toMatch(/estimating…|ratio≈/);
    });
  });

  test("a qualifying sample makes the 7d line read ratio≈R.R at one decimal", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      expect(session.line()).toContain("estimating…");

      // Exactly the 50-point five-hour movement threshold.
      clock.now = T0 + 30 * 60 * 1000;
      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();

      expect(session.line()).toContain("ratio≈10.0");
    });
  });

  test("non-positive and unpaired intervals never produce a sample", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 5, weekly: 1, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("estimating…");
      expect(session.line()).not.toContain("ratio≈");

      // A reading that omits the five-hour window carries no pair to learn from:
      // it hides the segment, and the next paired reading still starts from the
      // untouched baseline.
      session.report({ weekly: 1, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).not.toMatch(/estimating…|ratio≈/);

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");
    });
  });

  test("non-qualifying and unusable intervals leave the displayed estimate untouched", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      const intervals: Array<[string, PairedWindows]> = [
        ["one point below the five-hour span threshold", { fiveHour: 59, weekly: 6.9 }],
        ["zero movement in either window", { fiveHour: 10, weekly: 2 }],
        ["weekly movement only", { fiveHour: 10, weekly: 30 }],
        ["non-positive five-hour delta", { fiveHour: 5, weekly: 1 }],
        ["saturated five-hour window", { fiveHour: 100, weekly: 40 }],
        ["saturated weekly window", { fiveHour: 60, weekly: 100 }],
      ];
      for (const [interval, windows] of intervals) {
        session.report({ ...windows, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
        await session.turn();
        expect({ interval, segment: session.line().match(/ratio≈[\d.]+|estimating…/)?.[0] })
          .toEqual({ interval, segment: "ratio≈10.0" });
      }
    });
  });

  test("the newest qualifying sample replaces the estimate outright inside one five-hour window", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 0, weekly: 0, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 50, weekly: 5, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // A changed quota relationship surfaces without waiting for a new window.
      session.report({ fiveHour: 60, weekly: 8, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈7.5");
    });
  });

  test("a moved five-hour reset timestamp rebuilds the baseline and keeps the estimate", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // The five-hour window rolled over: its reset moved, its percent dropped.
      const rolledR5 = R5 + FIVE_HOUR_MS;
      session.report({ fiveHour: 5, weekly: 3, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // The next sample spans the new window only: 50 / 4.5, not 45 / 5.5.
      clock.now = T0 + HOUR_MS;
      session.report({ fiveHour: 55, weekly: 7.5, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈11.1");
    });
  });

  test("a moved weekly reset timestamp rebuilds the baseline and keeps the estimate", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      const rolledR7 = R7 + WEEK_MS;
      session.report({ fiveHour: 5, weekly: 3, fiveHourResetsAt: R5, weeklyResetsAt: rolledR7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      session.report({ fiveHour: 55, weekly: 10.5, fiveHourResetsAt: R5, weeklyResetsAt: rolledR7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈6.7");
    });
  });

  test("an equal-percentage rollover is detected from the reported reset timestamp alone", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // The percentages repeat the baseline, so only the moved reset shows the rollover.
      clock.now = T0 + 4 * HOUR_MS + 30 * 60 * 1000;
      const rolledR5 = R5 + FIVE_HOUR_MS;
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // The baseline now dates from the rollover, so the five-hour cap has not fired.
      clock.now = T0 + 5 * HOUR_MS + 30 * 60 * 1000;
      session.report({ fiveHour: 60, weekly: 7.5, fiveHourResetsAt: rolledR5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈9.1");
    });
  });

  test("a percentage drop rebuilds the baseline when reset timestamps are unavailable", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2 });
      await session.start();

      // A one-point drop is below the fallback trigger and is never a rollover.
      session.report({ fiveHour: 9, weekly: 1.5 });
      await session.turn();
      expect(session.line()).toContain("estimating…");

      session.report({ fiveHour: 60, weekly: 7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      session.report({ fiveHour: 5, weekly: 1 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // 50 / 10 only qualifies if the drop rebuilt the baseline; the stale baseline
      // would leave the previous estimate in place.
      session.report({ fiveHour: 55, weekly: 11 });
      await session.turn();
      expect(session.line()).toContain("ratio≈5.0");
    });
  });

  test("a baseline aged five hours is never sampled across", async () => {
    await withClock(T0, async clock => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      clock.now = T0 + FIVE_HOUR_MS;
      session.report({ fiveHour: 30, weekly: 4, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈10.0");

      // Measured from the aged-out rebuild: 50 / 10, not 70 / 12.
      clock.now = T0 + FIVE_HOUR_MS + 60 * 1000;
      session.report({ fiveHour: 80, weekly: 14, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈5.0");
    });
  });

  test("a stale five-hour value retained for a missing window never pairs with a fresh weekly value", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 20, weekly: 4, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      session.report({ fiveHour: 80, weekly: 12, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("ratio≈7.5");

      // A header carrying only the weekly window leaves the stale 80% five-hour
      // value on the widget; pairing it with the fresh 20% would read 3.8.
      session.headerReport(usageReport({ weekly: 20, weeklyResetsAt: R7 }));
      await session.headers();

      expect(session.line()).toContain("20.0%");
      expect(session.line()).toContain("ratio≈7.5");
    });
  });

  test("the same paired readings and clock always produce the same displayed estimate", async () => {
    await withClock(T0, async () => {
      const lines: string[] = [];
      for (let run = 0; run < 2; run += 1) {
        // Each run gets its own archive home, so both start from the same
        // empty document rather than the estimate the previous run published.
        await withTemporaryHome(async () => {
          const session = mountCodexSession();
          session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
          await session.start();
          session.report({ fiveHour: 59, weekly: 6.9, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
          await session.turn();
          session.report({ fiveHour: 70, weekly: 9, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
          await session.turn();
          lines.push(session.line());
        });
      }

      expect(lines[1]).toBe(lines[0]);
      expect(lines[0]).toContain("ratio≈8.6");
    });
  });

  test("the segment carries the weekly quota number's semantic colour, muted included", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 12, weekly: 30, fiveHourResetsAt: R5, weeklyResetsAt: null });
      await session.start();
      expect(session.line(500, COLOR_THEME)).toContain("[muted]estimating…[/muted]");

      const weeklyResetsAt = T0 + WEEK_MS * 0.7;
      session.report({ fiveHour: 62, weekly: 40, fiveHourResetsAt: R5, weeklyResetsAt });
      await session.turn();

      const line = session.line(500, COLOR_THEME);
      expect(line).toContain("[success]40.0[/success]%");
      expect(line).toContain("[success]left≈3.0×5h · ratio≈5.0[/success]");
      expect(line.indexOf("40.0[/success]%")).toBeLessThan(line.indexOf("[success]left≈"));
      expect(line.indexOf("ratio≈5.0[/success]")).toBeLessThan(line.indexOf(" · resets in"));
    });
  });

  test("the segment survives alongside the percentages and drops before them when narrow", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();

      const wide = renderLastWidget(session.widgetContents, 200);
      expect(wide[2]).toContain("7.0% /");
      expect(wide[2]).toContain("ratio≈10.0");

      const narrow = renderLastWidget(session.widgetContents, 24);
      expect(narrow[2]).toContain("7.0% /");
      expect(narrow[2]).not.toContain("ratio≈");
      expect(narrow.length).toBe(wide.length);
    });
  });
});

describe("model-cost Codex remaining budget", () => {
  /** The minimal 7d form once a qualifying sample exists, ratio included. */
  const MINIMAL_LINE = "7d 7.0% / 57.1% · left≈9.3×5h · ratio≈10.0";

  /**
   * A qualifying sample of 50 five-hour points over 5 weekly points gives
   * `ratio≈10.0`; with 7.0% of the weekly quota used, the unconsumed share is
   * 93% and the remaining budget (100 − 7) × 10 / 100 = 9.3 full five-hour
   * quotas. The weekly window started four days before the frozen clock, so
   * one seventh of it remains and the reset text reads `3d 0h`.
   */
  async function sampledSession(): Promise<CodexSession> {
    const session = mountCodexSession();
    session.report({ fiveHour: 10, weekly: 2, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
    await session.start();
    session.report({ fiveHour: 60, weekly: 7, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
    await session.turn();
    return session;
  }

  test("estimating… stays free of numbers at wide and narrow widths", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 12, weekly: 34, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();

      expect(session.line(300)).toMatch(/7d .*34\.0% \/ 57\.1% · estimating… · resets in 3d 0h \(/);
      expect(session.line(300)).not.toMatch(/left≈|×5h/);
      expect(session.line(24)).not.toMatch(/left≈|×5h/);
    });
  });

  test("left is the unconsumed weekly share times the estimate, ahead of ratio", async () => {
    await withClock(T0, async () => {
      const session = await sampledSession();

      const line = session.line(300);
      expect(line).toMatch(/7d .*7\.0% \/ 57\.1% · left≈9\.3×5h · ratio≈10\.0 · resets in 3d 0h \(/);
    });
  });

  test("a redraw carrying no paired reading recomputes left from the displayed weekly percent", async () => {
    await withClock(T0, async () => {
      const session = await sampledSession();
      expect(session.line()).toContain("left≈9.3×5h · ratio≈10.0");

      // A header carrying only the weekly window moves the displayed percent
      // without delivering a pair, so the estimate stays put while left follows
      // the weekly consumption the line is now showing.
      session.headerReport(usageReport({ weekly: 20, weeklyResetsAt: R7 }));
      await session.headers();

      const line = session.line();
      expect(line).toContain("20.0% /");
      expect(line).toContain("left≈8.0×5h · ratio≈10.0");
    });
  });

  test("a stored estimate carried past a rollover reads left from the current weekly percent", async () => {
    await withClock(T0, async () => {
      const session = await sampledSession();

      // The five-hour window rolled over, so no sample spans the boundary and
      // the stored estimate is carried while the weekly percent moved on.
      session.report({ fiveHour: 5, weekly: 3, fiveHourResetsAt: R5 + FIVE_HOUR_MS, weeklyResetsAt: R7 });
      await session.turn();

      const line = session.line();
      expect(line).toContain("3.0% /");
      expect(line).toContain("left≈9.7×5h · ratio≈10.0");
    });
  });

  test("a saturated weekly window reads zero and credit overage never reads negative", async () => {
    await withClock(T0, async () => {
      const session = await sampledSession();

      session.report({ fiveHour: 60, weekly: 100, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("100.0% /");
      expect(session.line()).toContain("left≈0.0×5h · ratio≈10.0");

      // Consumption funded beyond the plan quota can only ever read zero.
      session.report({ fiveHour: 61, weekly: 104, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      expect(session.line()).toContain("104.0% /");
      expect(session.line()).toContain("left≈0.0×5h · ratio≈10.0");
    });
  });

  test("the appended numbers ride the width ladder and truncation drops ratio before left", async () => {
    await withClock(T0, async () => {
      const session = await sampledSession();

      const full = session.line(300);
      expect(full).toContain("━");
      expect(full).toContain("left≈9.3×5h · ratio≈10.0");

      const noBar = session.line(visibleDisplayWidth(full) - 1);
      expect(noBar).not.toContain("━");
      expect(noBar).toMatch(/resets in 3d 0h \(\d{2}\/\d{2} \d{2}:\d{2}\)$/);
      expect(noBar).toContain("left≈9.3×5h · ratio≈10.0");

      const countdownOnly = session.line(visibleDisplayWidth(noBar) - 1);
      expect(countdownOnly).not.toContain("━");
      expect(countdownOnly).toContain("resets in 3d 0h");
      expect(countdownOnly).not.toMatch(/\(\d{2}\/\d{2} \d{2}:\d{2}\)/);
      expect(countdownOnly).toContain("left≈9.3×5h · ratio≈10.0");

      const minimal = session.line(visibleDisplayWidth(countdownOnly) - 1);
      expect(minimal).not.toContain("resets in");
      expect(minimal).toBe(MINIMAL_LINE);

      // One column narrower than `7d quota% / time% · left≈N.N×5h`, so the
      // truncation eats ratio first and leaves left and both percentages.
      const leftOnly = "7d 7.0% / 57.1% · left≈9.3×5h";
      const truncated = session.line(visibleDisplayWidth(leftOnly) + 1);
      expect(truncated).toBe(`${leftOnly}…`);
      expect(truncated).not.toContain("ratio≈");

      const wide = renderLastWidget(session.widgetContents, 300);
      const narrow = renderLastWidget(session.widgetContents, visibleDisplayWidth(leftOnly) + 1);
      expect(narrow.length).toBe(wide.length);
    });
  });
});

describe("model-cost Codex quota estimate hiding", () => {
  test("while a usage refresh is loading, nothing is appended", async () => {
    await withClock(T0, async () => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      installFakeCodexModules({ fetchUsage: () => promise });
      const { handlers } = mountExtension();
      const { ctx, widgetContents } = codexContext();

      const pending = fire(handlers, "session_start", ctx);
      const line = weeklyLine(widgetContents);

      expect(line).toContain("正在获取");
      expect(line).not.toContain("estimating…");
      expect(line).not.toContain("ratio≈");

      resolve(usageReport({ fiveHour: 12, weekly: 34, weeklyResetsAt: R7 }));
      await pending;
    });
  });

  test("a missing five-hour window hides the segment and leaves the weekly line intact", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ weekly: 34, weeklyResetsAt: R7 });
      await session.start();

      const line = session.line();
      expect(line).toContain("34.0% /");
      expect(line).toMatch(/resets in/);
      expect(line.match(/ · /g)).toHaveLength(1);
      expect(line).not.toMatch(/estimating…|ratio≈/);
    });
  });

  test("a missing weekly window hides the segment", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 12, fiveHourResetsAt: R5 });
      await session.start();

      expect(session.line()).toBe("7d weekly limit not reported");
    });
  });

  test("an errored usage fetch hides the segment", async () => {
    await withClock(T0, async () => {
      installFakeCodexModules({ fetchUsage: async () => null });
      const { handlers } = mountExtension();
      const { ctx, widgetContents } = codexContext();

      await fire(handlers, "session_start", ctx);

      const line = weeklyLine(widgetContents);
      expect(line).toContain("7d");
      expect(line).not.toMatch(/estimating…|ratio≈/);
    });
  });

  test("a non-finite percentage in either window hides the segment", async () => {
    await withClock(T0, async () => {
      const session = mountCodexSession();
      session.report({ fiveHour: 12, weekly: Number.NaN, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.start();
      expect(session.line()).toMatch(/7d --%/);
      expect(session.line()).not.toMatch(/estimating…|ratio≈/);

      session.report({ fiveHour: Number.NaN, weekly: 34, fiveHourResetsAt: R5, weeklyResetsAt: R7 });
      await session.turn();
      const line = session.line();
      expect(line).toContain("34.0% /");
      expect(line).not.toMatch(/estimating…|ratio≈/);
    });
  });
});
