import { afterEach, describe, test, expect } from "bun:test";
import {
  isOpenAICodexModel,
  pickWeeklyLimit,
  pickFiveHourLimit,
  formatReset,
  buildWeeklyUsagePart,
  buildFiveHourUsagePart,
  parseChatGPTUsageHeaders,
  parseChatGPTUsageHeadersSnapshot,
  fetchChatGPTUsage,
  fetchChatGPTUsageSnapshot,
  formatErrorText,
  visibleDisplayWidth,
  __setOmpModuleLoaderForTest,
} from "../../extensions/model-cost/chatgpt-usage";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const WEEK_MS = 7 * DAY_MS;

type FakeFetch = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;

function installFakeOmpModules(modules: {
  fetchUsage?: (params: unknown, ctx: { fetch: FakeFetch }) => Promise<unknown>;
  parseRateLimitHeaders?: (headers: Record<string, string>, now?: number) => unknown;
  wrapFetchForProxy?: (fetchImpl: FakeFetch) => FakeFetch;
  getProxyForProvider?: (provider: string) => string | undefined;
}): void {
  __setOmpModuleLoaderForTest(async () => ({
    openaiCodexUsageProvider: {
      fetchUsage: modules.fetchUsage ?? (async () => null),
    },
    parseCodexRateLimitHeaders: modules.parseRateLimitHeaders ?? (() => null),
    wrapFetchForProxy: modules.wrapFetchForProxy ?? ((fetchImpl: FakeFetch) => fetchImpl),
    getProxyForProvider:
      modules.getProxyForProvider ??
      ((_provider: string) => process.env.PI_PROXY_OPENAI_CODEX || process.env.PI_PROXY),
  }));
}

function scopedAuthCtx(overrides: {
  accounts?: Array<{ position: number; accountId?: string; email?: string }>;
  access?: { ok: true; accessToken: string; accountId?: string; email?: string } | { ok: false; error: string };
  fetchUsageReports?: () => Promise<unknown>;
} = {}) {
  const authStorage = {
    listOAuthAccounts: () => overrides.accounts ?? [{ position: 0, accountId: "acct-1", email: "u@example.com" }],
    getOAuthAccessAt: async () => overrides.access ?? { ok: true, accessToken: "token-1", accountId: "acct-1", email: "u@example.com" },
    fetchUsageReports: overrides.fetchUsageReports ?? (async () => { throw new Error("aggregate usage must not be called"); }),
  };
  return {
    modelRegistry: { authStorage },
    sessionManager: { getSessionId: () => "s1" },
  };
}

afterEach(() => {
  __setOmpModuleLoaderForTest(null);
  delete process.env.PI_PROXY_OPENAI_CODEX;
  delete process.env.PI_PROXY;
});

function weeklyLimit(overrides: Partial<{
  id?: string;
  accountId?: string;
  windowId?: string;
  durationMs?: number;
  resetsAt?: number;
  used?: number;
}> = {}) {
  const windowId = overrides.windowId ?? "7d";
  const durationMs = Object.prototype.hasOwnProperty.call(overrides, "durationMs")
    ? overrides.durationMs
    : windowId === "7d"
      ? WEEK_MS
      : undefined;
  return {
    id: overrides.id ?? "openai-codex:secondary",
    scope: { accountId: overrides.accountId ?? "acct-1", windowId },
    window: {
      id: windowId,
      ...(durationMs !== undefined ? { durationMs } : {}),
      resetsAt: overrides.resetsAt ?? 1_800_000_000_000,
    },
    amount: { used: overrides.used ?? 34 },
  };
}

describe("isOpenAICodexModel", () => {
  test("accepts openai-codex provider", () => {
    expect(isOpenAICodexModel({ provider: "openai-codex" })).toBe(true);
  });

  test("rejects other providers and undefined", () => {
    expect(isOpenAICodexModel({ provider: "deepseek" })).toBe(false);
    expect(isOpenAICodexModel(undefined)).toBe(false);
  });
});

describe("pickWeeklyLimit", () => {
  test("returns the 7d limit matching the active accountId", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ accountId: "other", windowId: "5h" }),
        weeklyLimit({ accountId: "acct-1" }),
      ],
    };
    const picked = pickWeeklyLimit(report, { accountId: "acct-1" });
    expect(picked?.scope.accountId).toBe("acct-1");
  });

  test("falls back to the first 7d limit without identity", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ accountId: "acct-2" })],
    };
    expect(pickWeeklyLimit(report)?.scope.accountId).toBe("acct-2");
  });

  test("matches by report email when accountId is absent", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      metadata: { email: "u@example.com" },
      limits: [weeklyLimit({ accountId: "acct-9" })],
    };
    expect(pickWeeklyLimit(report, { email: "u@example.com" })?.scope.accountId).toBe("acct-9");
  });

  test("returns undefined when no 7d window exists", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ windowId: "5h", durationMs: 5 * HOUR_MS })],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });

  test("recognizes weekly primary while secondary is short", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: 5 * HOUR_MS }),
      ],
    };
    const picked = pickWeeklyLimit(report, { accountId: "acct-1" });
    expect(picked?.id).toBe("openai-codex:primary");
  });

  test("recognizes weekly secondary while primary is short", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: 5 * HOUR_MS }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: WEEK_MS }),
      ],
    };
    const picked = pickWeeklyLimit(report, { accountId: "acct-1" });
    expect(picked?.id).toBe("openai-codex:secondary");
  });

  test("prefers weekly main chat over a monthly secondary", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: 30 * DAY_MS }),
      ],
    };
    const picked = pickWeeklyLimit(report, { accountId: "acct-1" });
    expect(picked?.id).toBe("openai-codex:primary");
  });

  test("ignores feature-specific additional weekly limits", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:spark:primary", durationMs: WEEK_MS }),
        weeklyLimit({ id: "openai-codex:spark:secondary", durationMs: WEEK_MS }),
      ],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });

  test("does not classify a duration-less 7d id as weekly", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ id: "openai-codex:primary", windowId: "7d", durationMs: undefined })],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });

  test("accepts durations just inside the weekly range", () => {
    const minMs = WEEK_MS * 0.95;
    const maxMs = WEEK_MS * 1.05;
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: minMs }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: maxMs }),
      ],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })?.id).toBe("openai-codex:primary");
  });

  test("rejects durations just outside the weekly range", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS * 0.949 }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: WEEK_MS * 1.051 }),
      ],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });

  test("accepts exactly seven days", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS })],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })?.id).toBe("openai-codex:primary");
  });

  test("picks the closest weekly window and keeps provider order on ties", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS * 1.04 }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: WEEK_MS }),
      ],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })?.id).toBe("openai-codex:secondary");

    const tie = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", durationMs: WEEK_MS }),
        weeklyLimit({ id: "openai-codex:secondary", durationMs: WEEK_MS }),
      ],
    };
    expect(pickWeeklyLimit(tie, { accountId: "acct-1" })?.id).toBe("openai-codex:primary");
  });
});

describe("formatReset", () => {
  test("formats countdown and absolute local time", () => {
    const now = 1_800_000_000_000;
    const resetsAt = now + 2 * DAY_MS + 14 * HOUR_MS + 5 * 60 * 1000;
    expect(formatReset(resetsAt, now)).toMatch(/^2d 14h \(\d{2}\/\d{2} \d{2}:\d{2}\)$/);
  });

  test("returns empty string when reset time is missing", () => {
    expect(formatReset(null, 1_800_000_000_000)).toBe("");
  });

  test("returns 0h for past reset time", () => {
    const now = 1_800_000_000_000;
    expect(formatReset(now - 1000, now)).toMatch(/^0h \(\d{2}\/\d{2} \d{2}:\d{2}\)$/);
  });
});

describe("buildWeeklyUsagePart", () => {
  test("formats percentage and reset suffix", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 34.4, resetsAt: now + DAY_MS, error: null },
      now,
    );
    expect(part).toContain("7d");
    expect(part).toContain("34.4% / 85.7%");
    expect(part).toContain("resets in");
  });

  test("returns empty string when usage is unavailable", () => {
    expect(buildWeeklyUsagePart({ kind: "idle", usedPercent: null, resetsAt: null, error: null })).toBe("");
  });

  test("still shows reset time when percent is unavailable", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart({ kind: "ok", usedPercent: null, resetsAt: now + DAY_MS, error: null }, now);
    expect(part).toContain("7d --%");
    expect(part).toContain("resets in");
  });

  test("renders reset placeholder when reset time is missing", () => {
    const part = buildWeeklyUsagePart({ kind: "ok", usedPercent: 34, resetsAt: null, error: null });
    expect(part).toContain("7d");
    expect(part).toContain("34.0% / --");
    expect(part).toContain("reset unknown");
  });

  test("renders explicit loading state", () => {
    expect(buildWeeklyUsagePart({ kind: "loading", usedPercent: null, resetsAt: null, error: null }))
      .toBe("7d … · 正在获取");
  });

  test("renders weekly limit not reported", () => {
    expect(buildWeeklyUsagePart({ kind: "missing", usedPercent: null, resetsAt: null, error: null }))
      .toBe("7d weekly limit not reported");
  });

  test("renders incompatible OMP version", () => {
    expect(buildWeeklyUsagePart({ kind: "incompatible", usedPercent: null, resetsAt: null, error: "incompatible OMP version" }))
      .toBe("7d incompatible OMP version");
  });

  test("renders config error naming both proxy variables", () => {
    const part = buildWeeklyUsagePart({
      kind: "config",
      usedPercent: null,
      resetsAt: null,
      error: "missing PI_PROXY_OPENAI_CODEX / PI_PROXY",
    });
    expect(part).toContain("PI_PROXY_OPENAI_CODEX");
    expect(part).toContain("PI_PROXY");
  });

  test("keeps header data visible beside an active-fetch error", () => {
    const part = buildWeeklyUsagePart({
      kind: "ok",
      usedPercent: 34,
      resetsAt: null,
      error: "missing PI_PROXY_OPENAI_CODEX / PI_PROXY",
    });
    expect(part).toContain("7d");
    expect(part).toContain("34.0% / --");
    expect(part).toContain("PI_PROXY_OPENAI_CODEX");
  });

  test("renders a fixed 20-cell combined bar with one marker", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS, error: null },
      now,
      200,
    );
    const bar = part.split(" ")[1] ?? "";
    expect(visibleDisplayWidth(bar)).toBe(20);
    expect((bar.match(/━/g) ?? []).length).toBe(11);
    expect((bar.match(/─/g) ?? []).length).toBe(8);
    expect((bar.match(/│/g) ?? []).length).toBe(1);
    expect(part).toContain("60.0% / 0.0%");
  });

  test("keeps the marker in the thin region when quota is behind time", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 40, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
    );
    const bar = part.split(" ")[1] ?? "";
    const markerAt = bar.indexOf("│");
    expect(markerAt).toBeGreaterThan(0);
    expect(bar.slice(0, markerAt)).toContain("━");
    expect(bar.slice(markerAt + 1)).not.toContain("━");
  });

  test("places the marker at the heavy-to-thin boundary when quota equals time", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
    );
    const bar = part.split(" ")[1] ?? "";
    const markerAt = bar.indexOf("│");
    expect((bar.slice(0, markerAt).match(/━/g) ?? []).length).toBe(12);
    expect(bar.slice(markerAt + 1)).not.toContain("━");
  });

  test("keeps heavy glyphs after the marker when quota is ahead of time", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS * 0.7, error: null },
      now,
      200,
    );
    const bar = part.split(" ")[1] ?? "";
    const markerAt = bar.indexOf("│");
    expect(markerAt).toBeGreaterThan(0);
    expect(bar.slice(markerAt + 1)).toContain("━");
  });

  test("uses semantic colors for heavy glyphs and quota number", () => {
    const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 70, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
      theme,
    );
    expect(part).toContain("[success]━[/success]");
    expect(part).toContain("[success]70.0[/success]%");
    expect(part).not.toContain("[success]│[/success]");
    expect(part).not.toContain("[success]─[/success]");
    expect(part).not.toContain("[success]/[/success]");
  });

  test("uses muted colors when time state is unknown", () => {
    const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: null, error: null },
      now,
      200,
      theme,
    );
    expect(part).toMatch(/\[muted\]━+\[\/muted\]/);
    expect(part).toContain("[muted]60.0[/muted]%");
    expect(part).toContain("% / --%");
    expect(part).toContain("reset unknown");
    expect(part).not.toContain("│");
  });

  test("renders expired and invalid reset states distinctly", () => {
    const now = 1_800_000_000_000;
    const expired = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now - 1, error: null },
      now,
      200,
    );
    expect(expired).toContain("reset expired");
    expect(expired).toContain("60.0% / --");
    expect(expired).not.toContain("│");

    const invalid = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS + 1, error: null },
      now,
      200,
    );
    expect(invalid).toContain("reset invalid");
    expect(invalid).toContain("60.0% / --");
    expect(invalid).not.toContain("│");
  });

  test("computes time percentages from the fixed seven-day cycle", () => {
    const now = 1_800_000_000_000;
    const start = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 10, resetsAt: now + WEEK_MS, error: null },
      now,
      200,
    );
    expect(start).toContain("10.0% / 0.0%");

    const middle = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 10, resetsAt: now + WEEK_MS * 0.5, error: null },
      now,
      200,
    );
    expect(middle).toContain("10.0% / 50.0%");

    const resetInstant = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 10, resetsAt: now, error: null },
      now,
      200,
    );
    expect(resetInstant).toContain("10.0% / 100.0%");
  });

  test("clamps an over-100 quota graphic while keeping the original number", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 150, resetsAt: now + WEEK_MS, error: null },
      now,
      200,
    );
    const bar = part.split(" ")[1] ?? "";
    expect(visibleDisplayWidth(bar)).toBe(20);
    expect(bar).not.toContain("─");
    expect(part).toContain("150.0% / 0.0%");
  });

  test("drops the bar before dropping the precise percentages", () => {
    const now = 1_800_000_000_000;
    const wide = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS, error: null },
      now,
      200,
    );
    expect(wide).toContain("━");

    const narrow = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: now + WEEK_MS, error: null },
      now,
      30,
    );
    expect(narrow).not.toContain("━");
    expect(narrow).toContain("60.0% / 0.0%");
  });

  test("truncates the minimal comparison when even it cannot fit", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 60, resetsAt: null, error: null },
      now,
      5,
    );
    expect(visibleDisplayWidth(part)).toBeLessThanOrEqual(5);
    expect(part).toContain("…");
  });

  test("degrades in the agreed order: bar, absolute reset time, countdown, then minimal", () => {
    const now = 1_800_000_000_000;
    const usage = { kind: "ok" as const, usedPercent: 60, resetsAt: now + WEEK_MS, error: null };
    const wide = buildWeeklyUsagePart(usage, now, 200);
    expect(wide).toContain("━");

    const noBar = buildWeeklyUsagePart(usage, now, visibleDisplayWidth(wide) - 1);
    expect(noBar).not.toContain("━");
    expect(noBar).toContain("resets in");
    expect(noBar).toMatch(/\(\d{2}\/\d{2} \d{2}:\d{2}\)/);

    const countdownOnly = buildWeeklyUsagePart(usage, now, visibleDisplayWidth(noBar) - 1);
    expect(countdownOnly).not.toContain("━");
    expect(countdownOnly).toContain("resets in");
    expect(countdownOnly).not.toMatch(/\(\d{2}\/\d{2} \d{2}:\d{2}\)/);

    const minimal = buildWeeklyUsagePart(usage, now, visibleDisplayWidth(countdownOnly) - 1);
    expect(minimal).not.toContain("resets in");
    expect(minimal).toContain("60.0% / 0.0%");
  });

  test("classifies color boundaries on raw percentage-point deltas", () => {
    const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
    const now = 1_800_000_000_000;
    const atBoundary = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 75, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
      theme,
    );
    expect(atBoundary).toContain("[success]75.0[/success]%");

    const justOverBoundary = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 75.1, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
      theme,
    );
    expect(justOverBoundary).toContain("[warning]75.1[/warning]%");

    const errorBoundary = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 90.1, resetsAt: now + WEEK_MS * 0.4, error: null },
      now,
      200,
      theme,
    );
    expect(errorBoundary).toContain("[error]90.1[/error]%");
  });

  test("uses raw values for color even when the one-decimal label rounds across a threshold", () => {
    const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: 15.04, resetsAt: now + WEEK_MS, error: null },
      now,
      200,
      theme,
    );
    expect(part).toContain("[warning]15.0[/warning]%");
  });

  test("does not fabricate a bar when quota percentage is unavailable", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart(
      { kind: "ok", usedPercent: null, resetsAt: null, error: null },
      now,
      200,
    );
    expect(part).not.toContain("━");
    expect(part).toContain("7d --%");
    expect(part).toContain("reset unknown");
  });

  test("treats zero and non-finite reset values as unknown time", () => {
    const now = 1_800_000_000_000;
    expect(buildWeeklyUsagePart({ kind: "ok", usedPercent: 30, resetsAt: 0, error: null }, now, 200))
      .toContain("reset unknown");
    expect(buildWeeklyUsagePart({ kind: "ok", usedPercent: 30, resetsAt: Number.NaN, error: null }, now, 200))
      .toContain("reset unknown");
    expect(buildWeeklyUsagePart({ kind: "ok", usedPercent: 30, resetsAt: Number.POSITIVE_INFINITY, error: null }, now, 200))
      .toContain("reset unknown");
  });
});

describe("formatErrorText", () => {
  test("escapes newlines, tabs, and ANSI control bytes", () => {
    expect(formatErrorText("line1\nline2\t\x1b[31mred")).toBe("line1\\nline2\\t\\x1b[31mred");
  });

  test("truncates to 48 display columns and adds an ellipsis", () => {
    const long = "x".repeat(60);
    const formatted = formatErrorText(long);
    expect(formatted).toBe(`${"x".repeat(47)}…`);
    expect(formatted.length).toBe(48);
  });

  test("counts wide Unicode characters as two display columns", () => {
    const wide = "你".repeat(30);
    expect(formatErrorText(wide)).toBe(`${"你".repeat(23)}…`);
  });

  test("keeps ordinary text unchanged when within the budget", () => {
    expect(formatErrorText("timeout after 10s")).toBe("timeout after 10s");
  });
});

describe("parseChatGPTUsageHeaders", () => {
  function installFakeHeaderParser() {
    installFakeOmpModules({
      parseRateLimitHeaders: (headers: Record<string, string>, now = Date.now()) => {
        const rawPercent = Number(headers["x-codex-primary-used-percent"] ?? headers["x-codex-secondary-used-percent"]);
        if (!Number.isFinite(rawPercent)) return null;
        const key = headers["x-codex-primary-used-percent"] !== undefined ? "primary" : "secondary";
        const usedPercent = Math.min(100, Math.max(0, rawPercent));
        const windowMinutes = Number(headers[`x-codex-${key}-window-minutes`]);
        const durationMs = Number.isFinite(windowMinutes) ? windowMinutes * 60_000 : undefined;
        const rawResetAt = Number(headers[`x-codex-${key}-reset-at`]);
        const resetsAt = Number.isFinite(rawResetAt)
          ? rawResetAt > 1_000_000_000_000 ? rawResetAt : rawResetAt * 1000
          : undefined;
        return {
          provider: "openai-codex",
          fetchedAt: now,
          limits: [{
            id: `openai-codex:${key}`,
            scope: { windowId: durationMs ? "7d" : key },
            window: {
              id: durationMs ? "7d" : key,
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(resetsAt !== undefined ? { resetsAt } : {}),
            },
            amount: { used: usedPercent, usedFraction: usedPercent / 100, unit: "percent" },
          }],
        };
      },
    });
  }

  test("parses weekly headers from either slot", async () => {
    const now = 1_800_000_000_000;
    installFakeHeaderParser();
    const result = await parseChatGPTUsageHeaders({
      "x-codex-secondary-used-percent": "34",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1800000000",
    }, now);
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(now);
    expect(result?.source).toBe("header");
  });

  test("accepts millisecond reset timestamps", async () => {
    installFakeHeaderParser();
    const result = await parseChatGPTUsageHeaders({
      "x-codex-secondary-used-percent": "10",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1800000000000",
    });
    expect(result?.resetsAt).toBe(1_800_000_000_000);
  });

  test("returns null when no percent header is present", async () => {
    installFakeHeaderParser();
    expect(await parseChatGPTUsageHeaders({})).toBeNull();
  });

  test("clamps percentage to 0..100", async () => {
    installFakeHeaderParser();
    const result = await parseChatGPTUsageHeaders({
      "x-codex-secondary-used-percent": "150",
      "x-codex-secondary-window-minutes": "10080",
    });
    expect(result?.usedPercent).toBe(100);
  });

  test("returns missing state when a duration-less window is reported", async () => {
    installFakeHeaderParser();
    const result = await parseChatGPTUsageHeaders({
      "x-codex-primary-used-percent": "34",
    });
    expect(result?.kind).toBe("missing");
    expect(result?.source).toBe("header");
  });
});

describe("fetchChatGPTUsage", () => {
  test("returns weekly snapshot for active account", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async () => ({
        provider: "openai-codex",
        fetchedAt: 123,
        limits: [weeklyLimit({ accountId: "acct-1", used: 34, resetsAt: 1_800_000_000_000 })],
      }),
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.kind).toBe("ok");
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(123);
  });

  test("falls back to usedFraction when amount.used is missing", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async () => ({
        provider: "openai-codex",
        fetchedAt: 123,
        limits: [{
          id: "openai-codex:secondary",
          scope: { accountId: "acct-1", windowId: "7d" },
          window: { id: "7d", durationMs: WEEK_MS, resetsAt: 1_800_000_000_000 },
          amount: { usedFraction: 0.34 },
        }],
      }),
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(123);
  });

  test("prefers usedFraction when both used and usedFraction are present", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async () => ({
        provider: "openai-codex",
        fetchedAt: 123,
        limits: [{
          id: "openai-codex:secondary",
          scope: { accountId: "acct-1", windowId: "7d" },
          window: { id: "7d", durationMs: WEEK_MS, resetsAt: 1_800_000_000_000 },
          amount: { used: 0.34, usedFraction: 0.34 },
        }],
      }),
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.usedPercent).toBe(34);
  });

  test("returns a transport state when provider returns null without a captured error", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({ fetchUsage: async () => null });

    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.kind).toBe("transport");
    expect(result?.error).toBe("usage request failed");
  });
});

describe("scoped ChatGPT usage fetch", () => {
  test("uses AuthStorage exact-account access and the scoped Codex provider proxy", async () => {
    process.env.PI_PROXY_OPENAI_CODEX = "http://127.0.0.1:10808";
    const seen: Array<{ init?: Record<string, unknown> }> = [];
    installFakeOmpModules({
      wrapFetchForProxy: () => async (_input, init) => {
        seen.push({ init: { ...init, proxy: process.env.PI_PROXY_OPENAI_CODEX || process.env.PI_PROXY } });
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
      fetchUsage: async (_params, ctx) => {
        await ctx.fetch("https://chatgpt.com/backend-api/wham/usage", { headers: {} });
        await ctx.fetch("https://chatgpt.com/backend-api/reset", { headers: {} });
        return {
          provider: "openai-codex",
          fetchedAt: 123,
          limits: [{
            id: "openai-codex:primary",
            scope: { accountId: "acct-1", windowId: "7d" },
            window: { id: "7d", durationMs: WEEK_MS, resetsAt: 1_800_000_000_000 },
            amount: { used: 34, limit: 100, usedFraction: 0.34, unit: "percent" },
          }],
        };
      },
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());

    expect(result?.kind).toBe("ok");
    expect(result?.usedPercent).toBe(34);
    expect(seen.length).toBe(2);
    expect(seen.every(call => call.init?.proxy === "http://127.0.0.1:10808")).toBe(true);
  });

  test("prefers PI_PROXY_OPENAI_CODEX over PI_PROXY", async () => {
    process.env.PI_PROXY_OPENAI_CODEX = "http://codex-proxy";
    process.env.PI_PROXY = "http://generic-proxy";
    const seen: Array<{ init?: Record<string, unknown> }> = [];
    installFakeOmpModules({
      wrapFetchForProxy: () => async (_input, init) => {
        seen.push({ init: { ...init, proxy: process.env.PI_PROXY_OPENAI_CODEX || process.env.PI_PROXY } });
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
      fetchUsage: async (_params, ctx) => {
        await ctx.fetch("https://chatgpt.com/backend-api/wham/usage");
        return { provider: "openai-codex", fetchedAt: 1, limits: [] };
      },
    });

    await fetchChatGPTUsage(scopedAuthCtx());

    expect(seen[0]?.init?.proxy).toBe("http://codex-proxy");
  });

  test("missing proxy produces a configuration error and no network call", async () => {
    let fetchCalls = 0;
    installFakeOmpModules({
      wrapFetchForProxy: fetchImpl => (input, init) => {
        fetchCalls += 1;
        return fetchImpl(input, init);
      },
      fetchUsage: async () => { fetchCalls += 1; return null; },
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());

    expect(result?.kind).toBe("config");
    expect(result?.error).toContain("PI_PROXY_OPENAI_CODEX");
    expect(result?.error).toContain("PI_PROXY");
    expect(fetchCalls).toBe(0);
  });

  test("zero OAuth accounts returns an authentication error", async () => {
    installFakeOmpModules({});
    const result = await fetchChatGPTUsage(scopedAuthCtx({ accounts: [] }));
    expect(result?.kind).toBe("auth");
  });

  test("multiple accounts uses the first stable account", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    let seenCredential: Record<string, unknown> | undefined;
    installFakeOmpModules({
      fetchUsage: async (params: { credential?: Record<string, unknown> }) => {
        seenCredential = params.credential;
        return { provider: "openai-codex", fetchedAt: 1, limits: [] };
      },
    });
    const ctx = scopedAuthCtx({
      accounts: [
        { position: 0, accountId: "first", email: "first@example.com" },
        { position: 1, accountId: "second", email: "second@example.com" },
      ],
      access: { ok: true, accessToken: "token-first", accountId: "first", email: "first@example.com" },
    });

    await fetchChatGPTUsage(ctx);

    expect(seenCredential?.accessToken).toBe("token-first");
    expect(seenCredential?.accountId).toBe("first");
  });

  test("OAuth access failure returns an authentication error", async () => {
    installFakeOmpModules({});
    const result = await fetchChatGPTUsage(scopedAuthCtx({
      access: { ok: false, error: "refresh failed" },
    }));
    expect(result?.kind).toBe("auth");
    expect(result?.error).toContain("refresh failed");
  });

  test("captures the original thrown error message for transport failures", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async (_params, ctx) => {
        await ctx.fetch("https://chatgpt.com/backend-api/wham/usage");
        return null;
      },
    });
    const ctx = scopedAuthCtx();
    // The provider wrapper captures thrown errors before the provider converts them to null.
    const originalFetch = globalThis.fetch;
    // We cannot replace global fetch here because the fake provider uses ctx.fetch; emulate via wrap.
    installFakeOmpModules({
      wrapFetchForProxy: fetchImpl => async () => {
        throw new Error("connect ECONNREFUSED");
      },
      fetchUsage: async (_params, ctx) => {
        try {
          await ctx.fetch("https://chatgpt.com/backend-api/wham/usage");
        } catch {
          // provider would swallow and return null
        }
        return null;
      },
    });

    const result = await fetchChatGPTUsage(ctx);
    expect(result?.kind).toBe("transport");
    expect(result?.error).toContain("connect ECONNREFUSED");
    void originalFetch;
  });

  test("HTTP failures without a thrown error receive a status-based message", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      wrapFetchForProxy: fetchImpl => async () => ({ ok: false, status: 500 }),
      fetchUsage: async (_params, ctx) => {
        const response = await ctx.fetch("https://chatgpt.com/backend-api/wham/usage");
        void response;
        return null;
      },
    });

    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.kind).toBe("transport");
    expect(result?.error).toContain("HTTP 500");
  });

  test("missing OMP modules produce an incompatible state", async () => {
    __setOmpModuleLoaderForTest(async () => {
      throw new Error("Cannot find package");
    });
    const result = await fetchChatGPTUsage(scopedAuthCtx());
    expect(result?.kind).toBe("incompatible");
    expect(result?.error).toContain("incompatible OMP version");
  });

  test("does not call the aggregate usage fetch", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    let aggregateCalled = false;
    installFakeOmpModules({
      fetchUsage: async () => ({ provider: "openai-codex", fetchedAt: 1, limits: [] }),
    });
    const ctx = scopedAuthCtx({
      fetchUsageReports: async () => {
        aggregateCalled = true;
        return [];
      },
    });

    await fetchChatGPTUsage(ctx);

    expect(aggregateCalled).toBe(false);
  });
});

describe("pickFiveHourLimit", () => {
  test("returns the 5h limit matching the active accountId", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ accountId: "other", windowId: "5h", durationMs: 5 * HOUR_MS }),
        weeklyLimit({ accountId: "acct-1", windowId: "5h", durationMs: 5 * HOUR_MS }),
      ],
    };
    const picked = pickFiveHourLimit(report, { accountId: "acct-1" });
    expect(picked?.scope.accountId).toBe("acct-1");
  });

  test("falls back to the first 5h limit without identity", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ accountId: "acct-9", windowId: "5h", durationMs: 5 * HOUR_MS })],
    };
    expect(pickFiveHourLimit(report)?.scope.accountId).toBe("acct-9");
  });

  test("returns undefined when no 5h window exists", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ windowId: "7d", durationMs: WEEK_MS })],
    };
    expect(pickFiveHourLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });

  test("recognizes 5h primary while secondary is weekly", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [
        weeklyLimit({ id: "openai-codex:primary", windowId: "5h", durationMs: 5 * HOUR_MS }),
        weeklyLimit({ id: "openai-codex:secondary", windowId: "7d", durationMs: WEEK_MS }),
      ],
    };
    expect(pickFiveHourLimit(report, { accountId: "acct-1" })?.id).toBe("openai-codex:primary");
  });

  test("ignores feature-specific additional 5h limits", () => {
    const report = {
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [weeklyLimit({ id: "openai-codex:spark:primary", windowId: "5h", durationMs: 5 * HOUR_MS })],
    };
    expect(pickFiveHourLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });
});

describe("fetchChatGPTUsageSnapshot", () => {
  test("returns both 5h and 7d windows from one active report", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async () => ({
        provider: "openai-codex",
        fetchedAt: 123,
        limits: [
          weeklyLimit({ id: "openai-codex:primary", windowId: "5h", durationMs: 5 * HOUR_MS, used: 12 }),
          weeklyLimit({ id: "openai-codex:secondary", windowId: "7d", durationMs: WEEK_MS, used: 34 }),
        ],
      }),
    });

    const result = await fetchChatGPTUsageSnapshot(scopedAuthCtx());
    expect(result?.weekly.kind).toBe("ok");
    expect(result?.weekly.usedPercent).toBe(34);
    expect(result?.fiveHour.kind).toBe("ok");
    expect(result?.fiveHour.usedPercent).toBe(12);
    expect(result?.fiveHour.source).toBe("api");
  });

  test("returns missing state for a window absent from the active report", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeOmpModules({
      fetchUsage: async () => ({
        provider: "openai-codex",
        fetchedAt: 123,
        limits: [weeklyLimit({ id: "openai-codex:secondary", windowId: "7d", durationMs: WEEK_MS, used: 34 })],
      }),
    });

    const result = await fetchChatGPTUsageSnapshot(scopedAuthCtx());
    expect(result?.weekly.usedPercent).toBe(34);
    expect(result?.fiveHour.kind).toBe("missing");
  });
});

describe("parseChatGPTUsageHeadersSnapshot", () => {
  test("returns both windows when headers carry both durations", async () => {
    installFakeOmpModules({
      parseRateLimitHeaders: (headers: Record<string, string>, now = Date.now()) => ({
        provider: "openai-codex",
        fetchedAt: now,
        limits: [
          {
            id: "openai-codex:primary",
            scope: { windowId: "5h" },
            window: { id: "5h", durationMs: 5 * HOUR_MS, resetsAt: 1_800_000_000_000 },
            amount: { used: 12, usedFraction: 0.12 },
          },
          {
            id: "openai-codex:secondary",
            scope: { windowId: "7d" },
            window: { id: "7d", durationMs: WEEK_MS, resetsAt: 1_800_100_000_000 },
            amount: { used: 34, usedFraction: 0.34 },
          },
        ],
      }),
    });

    const result = await parseChatGPTUsageHeadersSnapshot({}, 1_800_000_000_000);
    expect(result?.fiveHour.usedPercent).toBe(12);
    expect(result?.weekly.usedPercent).toBe(34);
    expect(result?.fiveHour.source).toBe("header");
  });

  test("returns missing for an absent window", async () => {
    installFakeOmpModules({
      parseRateLimitHeaders: () => ({
        provider: "openai-codex",
        fetchedAt: 1,
        limits: [
          {
            id: "openai-codex:primary",
            scope: { windowId: "5h" },
            window: { id: "5h", durationMs: 5 * HOUR_MS },
            amount: { used: 5, usedFraction: 0.05 },
          },
        ],
      }),
    });

    const result = await parseChatGPTUsageHeadersSnapshot({}, 1);
    expect(result?.fiveHour.usedPercent).toBe(5);
    expect(result?.weekly.kind).toBe("missing");
  });
});

describe("buildFiveHourUsagePart", () => {
  test("formats percentage and reset suffix", () => {
    const now = 1_800_000_000_000;
    const part = buildFiveHourUsagePart(
      { kind: "ok", usedPercent: 12, resetsAt: now + 2 * HOUR_MS, error: null },
      now,
      200,
    );
    expect(part).toContain("5h");
    expect(part).toContain("12.0%");
    expect(part).toContain("resets in");
  });

  test("renders explicit loading state", () => {
    expect(buildFiveHourUsagePart({ kind: "loading", usedPercent: null, resetsAt: null, error: null }))
      .toBe("5h … · 正在获取");
  });

  test("renders missing state", () => {
    expect(buildFiveHourUsagePart({ kind: "missing", usedPercent: null, resetsAt: null, error: null }))
      .toBe("5h 5h limit not reported");
  });

  test("renders a full pacing bar at wide widths", () => {
    const now = 1_800_000_000_000;
    const part = buildFiveHourUsagePart(
      { kind: "ok", usedPercent: 50, resetsAt: now + 5 * HOUR_MS, error: null },
      now,
      200,
    );
    expect(part).toContain("━");
    expect(part).toContain("50.0% / 0.0%");
  });
});
