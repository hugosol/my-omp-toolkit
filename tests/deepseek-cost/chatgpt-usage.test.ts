import { describe, test, expect } from "bun:test";
import {
  isOpenAICodexModel,
  pickWeeklyLimit,
  formatReset,
  buildWeeklyUsagePart,
  parseChatGPTUsageHeaders,
  fetchChatGPTUsage,
} from "../../extensions/deepseek-cost/chatgpt-usage";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function weeklyLimit(overrides: Partial<{
  accountId?: string;
  windowId?: string;
  resetsAt?: number;
  used?: number;
}> = {}) {
  return {
    scope: { accountId: overrides.accountId ?? "acct-1", windowId: overrides.windowId ?? "7d" },
    window: { id: overrides.windowId ?? "7d", resetsAt: overrides.resetsAt ?? 1_800_000_000_000 },
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
      limits: [weeklyLimit({ windowId: "5h" })],
    };
    expect(pickWeeklyLimit(report, { accountId: "acct-1" })).toBeUndefined();
  });
});

describe("formatReset", () => {
  test("formats countdown and absolute local time", () => {
    const now = 1_800_000_000_000;
    const resetsAt = now + 2 * DAY_MS + 14 * HOUR_MS + 5 * 60 * 1000;
    expect(formatReset(resetsAt, now)).toMatch(/^2d14h \(\d{2}\/\d{2} \d{2}:\d{2}\)$/);
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
      { usedPercent: 34.4, resetsAt: now + DAY_MS },
      now,
    );
    expect(part).toContain("7d 34%");
    expect(part).toContain("重置");
  });

  test("returns empty string when usage is unavailable", () => {
    expect(buildWeeklyUsagePart({ usedPercent: null, resetsAt: null })).toBe("");
  });

  test("still shows reset time when percent is unavailable", () => {
    const now = 1_800_000_000_000;
    const part = buildWeeklyUsagePart({ usedPercent: null, resetsAt: now + DAY_MS }, now);
    expect(part).toContain("7d --%");
    expect(part).toContain("重置");
  });
});

describe("parseChatGPTUsageHeaders", () => {
  test("parses secondary weekly headers", () => {
    const now = 1_800_000_000_000;
    const result = parseChatGPTUsageHeaders({
      "x-codex-secondary-used-percent": "34",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1800000000",
    }, now);
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(now);
  });

  test("accepts millisecond reset timestamps", () => {
    const result = parseChatGPTUsageHeaders({
      "x-codex-secondary-used-percent": "10",
      "x-codex-secondary-reset-at": "1800000000000",
    });
    expect(result?.resetsAt).toBe(1_800_000_000_000);
  });

  test("returns null when secondary percent header is missing", () => {
    expect(parseChatGPTUsageHeaders({})).toBeNull();
  });

  test("clamps percentage to 0..100", () => {
    expect(parseChatGPTUsageHeaders({ "x-codex-secondary-used-percent": "150" })?.usedPercent).toBe(100);
  });
});

describe("fetchChatGPTUsage", () => {
  function makeCtx(reports: unknown, identity?: { accountId?: string; email?: string }) {
    return {
      modelRegistry: {
        authStorage: {
          getOAuthAccountIdentity: () => identity,
          fetchUsageReports: async () => reports,
        },
      },
      sessionManager: { getSessionId: () => "s1" },
    };
  }

  test("returns weekly snapshot for active account", async () => {
    const reports = [{
      provider: "openai-codex",
      fetchedAt: 123,
      limits: [weeklyLimit({ accountId: "acct-1", used: 34, resetsAt: 1_800_000_000_000 })],
    }];
    const result = await fetchChatGPTUsage(makeCtx(reports, { accountId: "acct-1" }));
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(123);
  });

  test("falls back to usedFraction when amount.used is missing", async () => {
    const reports = [{
      provider: "openai-codex",
      fetchedAt: 123,
      limits: [{
        scope: { accountId: "acct-1", windowId: "7d" },
        window: { id: "7d", resetsAt: 1_800_000_000_000 },
        amount: { usedFraction: 0.34 },
      }],
    }];
    const result = await fetchChatGPTUsage(makeCtx(reports, { accountId: "acct-1" }));
    expect(result?.usedPercent).toBe(34);
    expect(result?.resetsAt).toBe(1_800_000_000_000);
    expect(result?.fetchedAt).toBe(123);
  });

  test("prefers usedFraction when both used and usedFraction are present", async () => {
    const reports = [{
      provider: "openai-codex",
      fetchedAt: 123,
      limits: [{
        scope: { accountId: "acct-1", windowId: "7d" },
        window: { id: "7d", resetsAt: 1_800_000_000_000 },
        amount: { used: 0.34, usedFraction: 0.34 },
      }],
    }];
    const result = await fetchChatGPTUsage(makeCtx(reports, { accountId: "acct-1" }));
    expect(result?.usedPercent).toBe(34);
  });

  test("returns null when no openai-codex report exists", async () => {
    const result = await fetchChatGPTUsage(makeCtx([], { accountId: "acct-1" }));
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    const ctx = {
      modelRegistry: {
        authStorage: {
          getOAuthAccountIdentity: () => ({ accountId: "acct-1" }),
          fetchUsageReports: async () => { throw new Error("boom"); },
        },
      },
      sessionManager: { getSessionId: () => "s1" },
    };
    expect(await fetchChatGPTUsage(ctx)).toBeNull();
  });
});
