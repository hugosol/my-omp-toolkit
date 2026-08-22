import { describe, test, expect } from "bun:test";
import {
  PRICE_RMB_PER_1M,
  priceForModel,
  resolvePriceTier,
  isPeakHour,
  nextBoundary,
  fmtTokens,
  rmbCost,
  fmtCost,
  cacheInOutRatio,
  buildStatusLine,
  usdCost,
  fmtUsd,
  cacheInOutWriteRatio,
  buildChatGPTStatusLine,
  buildChatGPTTokenLine,
} from "../../extensions/model-cost/cost-calc";

const PRO_PEAK = { input: 9, cacheRead: 0.3, output: 27 };
const PRO_OFF_PEAK = { input: 4.5, cacheRead: 0.15, output: 13.5 };
const FLASH_PEAK = { input: 3, cacheRead: 0.1, output: 9 };
const FLASH_OFF_PEAK = { input: 1.5, cacheRead: 0.05, output: 4.5 };

// ============================================================
// PRICE_RMB_PER_1M
// ============================================================

describe("PRICE_RMB_PER_1M", () => {
  test("has pro peak/off-peak schedules (RMB per 1M tokens)", () => {
    expect(PRICE_RMB_PER_1M["deepseek-v4-pro"].peak).toEqual(PRO_PEAK);
    expect(PRICE_RMB_PER_1M["deepseek-v4-pro"].offPeak).toEqual(PRO_OFF_PEAK);
  });

  test("has flash peak/off-peak schedules (RMB per 1M tokens)", () => {
    expect(PRICE_RMB_PER_1M["deepseek-v4-flash"].peak).toEqual(FLASH_PEAK);
    expect(PRICE_RMB_PER_1M["deepseek-v4-flash"].offPeak).toEqual(FLASH_OFF_PEAK);
  });
});

// ============================================================
// priceForModel
// ============================================================

describe("priceForModel", () => {
  test("returns pro schedule for deepseek-v4-pro", () => {
    expect(priceForModel("deepseek-v4-pro")).toEqual({
      peak: PRO_PEAK,
      offPeak: PRO_OFF_PEAK,
    });
  });

  test("returns flash schedule for deepseek-v4-flash", () => {
    expect(priceForModel("deepseek-v4-flash")).toEqual({
      peak: FLASH_PEAK,
      offPeak: FLASH_OFF_PEAK,
    });
  });

  test("returns undefined for unsupported model ids", () => {
    expect(priceForModel("gpt-5")).toBeUndefined();
    expect(priceForModel("deepseek-v3")).toBeUndefined();
  });

  test("returns undefined when no model is set", () => {
    expect(priceForModel(undefined)).toBeUndefined();
  });
});

// ============================================================
// isPeakHour
// ============================================================

describe("isPeakHour", () => {
  test("returns false before 09:00 Beijing", () => {
    // 2026-08-17 08:00 Asia/Shanghai = 00:00Z
    expect(isPeakHour(new Date("2026-08-17T00:00:00.000Z"))).toBe(false);
  });

  test("returns true at 09:00 Beijing (inclusive start)", () => {
    expect(isPeakHour(new Date("2026-08-17T01:00:00.000Z"))).toBe(true);
  });

  test("returns true during morning peak", () => {
    // 11:59:59.999 Asia/Shanghai
    expect(isPeakHour(new Date("2026-08-17T03:59:59.999Z"))).toBe(true);
  });

  test("returns true at 12:00 Beijing exactly (inclusive end)", () => {
    expect(isPeakHour(new Date("2026-08-17T04:00:00.000Z"))).toBe(true);
  });

  test("returns false just after 12:00 Beijing", () => {
    expect(isPeakHour(new Date("2026-08-17T04:00:00.001Z"))).toBe(false);
  });

  test("returns false during midday off-peak", () => {
    // 13:00 Asia/Shanghai
    expect(isPeakHour(new Date("2026-08-17T05:00:00.000Z"))).toBe(false);
  });

  test("returns true at 14:00 Beijing (inclusive start)", () => {
    expect(isPeakHour(new Date("2026-08-17T06:00:00.000Z"))).toBe(true);
  });

  test("returns true at 18:00 Beijing exactly (inclusive end)", () => {
    expect(isPeakHour(new Date("2026-08-17T10:00:00.000Z"))).toBe(true);
  });

  test("returns false just after 18:00 Beijing", () => {
    expect(isPeakHour(new Date("2026-08-17T10:00:00.001Z"))).toBe(false);
  });

  test("returns false during evening off-peak", () => {
    // 21:00 Asia/Shanghai
    expect(isPeakHour(new Date("2026-08-17T13:00:00.000Z"))).toBe(false);
  });

  test("returns false on Saturday 09:00 Beijing (weekend all-day off-peak)", () => {
    expect(isPeakHour(new Date("2026-08-22T01:00:00.000Z"))).toBe(false);
  });

  test("returns false on Saturday 12:00 Beijing (weekend all-day off-peak)", () => {
    expect(isPeakHour(new Date("2026-08-22T04:00:00.000Z"))).toBe(false);
  });

  test("returns false on Saturday 14:00 Beijing (weekend all-day off-peak)", () => {
    expect(isPeakHour(new Date("2026-08-22T06:00:00.000Z"))).toBe(false);
  });

  test("returns false on Sunday 18:00 Beijing (weekend all-day off-peak)", () => {
    expect(isPeakHour(new Date("2026-08-23T10:00:00.000Z"))).toBe(false);
  });
});

// ============================================================
// nextBoundary
// ============================================================

describe("nextBoundary", () => {
  test("from 08:00 Beijing returns 09:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T00:00:00.000Z"))).toEqual(new Date("2026-08-17T01:00:00.000Z"));
  });

  test("from exactly 09:00 Beijing returns 12:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T01:00:00.000Z"))).toEqual(new Date("2026-08-17T04:00:00.000Z"));
  });

  test("from 11:59 Beijing returns 12:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T03:59:00.000Z"))).toEqual(new Date("2026-08-17T04:00:00.000Z"));
  });

  test("from exactly 12:00 Beijing returns 14:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T04:00:00.000Z"))).toEqual(new Date("2026-08-17T06:00:00.000Z"));
  });

  test("from 13:59 Beijing returns 14:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T05:59:00.000Z"))).toEqual(new Date("2026-08-17T06:00:00.000Z"));
  });

  test("from exactly 14:00 Beijing returns 18:00 same day", () => {
    expect(nextBoundary(new Date("2026-08-17T06:00:00.000Z"))).toEqual(new Date("2026-08-17T10:00:00.000Z"));
  });

  test("from exactly 18:00 Beijing returns 09:00 next day", () => {
    expect(nextBoundary(new Date("2026-08-17T10:00:00.000Z"))).toEqual(new Date("2026-08-18T01:00:00.000Z"));
  });

  test("from evening returns 09:00 next day", () => {
    expect(nextBoundary(new Date("2026-08-17T13:00:00.000Z"))).toEqual(new Date("2026-08-18T01:00:00.000Z"));
  });
});

// ============================================================
// resolvePriceTier
// ============================================================

describe("resolvePriceTier", () => {
  const peakDate = new Date("2026-08-17T01:00:00.000Z"); // 09:00 Beijing
  const offPeakDate = new Date("2026-08-17T05:00:00.000Z"); // 13:00 Beijing

  test("returns pro peak tier during peak", () => {
    expect(resolvePriceTier("deepseek-v4-pro", peakDate)).toEqual(PRO_PEAK);
  });

  test("returns pro off-peak tier during off-peak", () => {
    expect(resolvePriceTier("deepseek-v4-pro", offPeakDate)).toEqual(PRO_OFF_PEAK);
  });

  test("returns flash peak tier during peak", () => {
    expect(resolvePriceTier("deepseek-v4-flash", peakDate)).toEqual(FLASH_PEAK);
  });

  test("returns flash off-peak tier during off-peak", () => {
    expect(resolvePriceTier("deepseek-v4-flash", offPeakDate)).toEqual(FLASH_OFF_PEAK);
  });

  test("returns pro off-peak tier on Saturday 09:00 Beijing", () => {
    expect(resolvePriceTier("deepseek-v4-pro", new Date("2026-08-22T01:00:00.000Z"))).toEqual(PRO_OFF_PEAK);
  });

  test("returns flash off-peak tier on Sunday 14:00 Beijing", () => {
    expect(resolvePriceTier("deepseek-v4-flash", new Date("2026-08-23T06:00:00.000Z"))).toEqual(FLASH_OFF_PEAK);
  });

  test("returns vision off-peak tier on Saturday 18:00 Beijing", () => {
    expect(resolvePriceTier("deepseek-v4-flash-vision-exp", new Date("2026-08-22T10:00:00.000Z"))).toEqual(FLASH_OFF_PEAK);
  });

  test("returns undefined for unsupported model", () => {
    expect(resolvePriceTier("gpt-5", peakDate)).toBeUndefined();
  });

  test("returns undefined when model is missing", () => {
    expect(resolvePriceTier(undefined, peakDate)).toBeUndefined();
  });
});

// ============================================================
// fmtTokens
// ============================================================

describe("fmtTokens", () => {
  test("formats small numbers without K suffix", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(99_999)).toBe("99,999");
  });

  test("formats large numbers with K suffix", () => {
    expect(fmtTokens(100_000)).toBe("100.0K");
    expect(fmtTokens(123_456)).toBe("123.5K");
    expect(fmtTokens(1_000_000)).toBe("1,000.0K");
  });

  test("handles rounding at K boundary", () => {
    expect(fmtTokens(123_500)).toBe("123.5K");
    expect(fmtTokens(123_999)).toBe("124.0K");
  });

  test("handles carry from fraction rounding", () => {
    expect(fmtTokens(999_950)).toBe("1,000.0K");
  });
});

// ============================================================
// rmbCost
// ============================================================

describe("rmbCost", () => {
  test("returns zero for zero tokens", () => {
    expect(rmbCost(0, 0, 0, PRO_PEAK)).toBe(0);
  });

  test("calculates pro peak input-only cost", () => {
    expect(rmbCost(1_000_000, 0, 0, PRO_PEAK)).toBe(9);
  });

  test("calculates pro peak output-only cost", () => {
    expect(rmbCost(0, 0, 1_000_000, PRO_PEAK)).toBe(27);
  });

  test("calculates pro peak cache-read cost", () => {
    expect(rmbCost(0, 1_000_000, 0, PRO_PEAK)).toBe(0.3);
  });

  test("calculates mixed cost for pro peak", () => {
    // 500K input (4.5) + 200K cache (0.06) + 100K output (2.7) = 7.26
    expect(rmbCost(500_000, 200_000, 100_000, PRO_PEAK)).toBeCloseTo(7.26, 6);
  });

  test("calculates flash off-peak input-only cost", () => {
    expect(rmbCost(1_000_000, 0, 0, FLASH_OFF_PEAK)).toBe(1.5);
  });

  test("calculates flash off-peak output-only cost", () => {
    expect(rmbCost(0, 0, 1_000_000, FLASH_OFF_PEAK)).toBe(4.5);
  });

  test("calculates flash off-peak cache-read cost", () => {
    expect(rmbCost(0, 1_000_000, 0, FLASH_OFF_PEAK)).toBe(0.05);
  });

  test("calculates mixed cost for flash off-peak", () => {
    // 500K input (0.75) + 200K cache (0.01) + 100K output (0.45) = 1.21
    expect(rmbCost(500_000, 200_000, 100_000, FLASH_OFF_PEAK)).toBeCloseTo(1.21, 6);
  });

  test("handles fractional tokens gracefully", () => {
    expect(rmbCost(1, 0, 0, PRO_PEAK)).toBe(9 / 1_000_000);
  });
});

// ============================================================
// fmtCost
// ============================================================

describe("fmtCost", () => {
  test("uses 2 decimals for cost >= 0.01", () => {
    expect(fmtCost(1)).toBe("\u00A51.00");
    expect(fmtCost(0.01)).toBe("\u00A50.01");
    expect(fmtCost(123.456)).toBe("\u00A5123.46");
  });

  test("uses 4 decimals for cost < 0.01", () => {
    expect(fmtCost(0.009)).toBe("\u00A50.0090");
    expect(fmtCost(0.0001)).toBe("\u00A50.0001");
    expect(fmtCost(0)).toBe("\u00A50.0000");
  });
});

// ============================================================
// cacheInOutRatio
// ============================================================

describe("cacheInOutRatio", () => {
  test("returns placeholder when total cost is zero", () => {
    expect(cacheInOutRatio({ input: 0, cacheRead: 0, output: 0 }, PRO_PEAK)).toBe("\uFFE5Cache/In/Out：--:--:--");
  });

  test("returns 0:100:0 when only input cost exists", () => {
    expect(cacheInOutRatio({ input: 1_000_000, cacheRead: 0, output: 0 }, PRO_PEAK)).toBe("\uFFE5Cache/In/Out：0:100:0");
  });

  test("returns 100:0:0 when only cache cost exists", () => {
    expect(cacheInOutRatio({ input: 0, cacheRead: 1_000_000, output: 0 }, PRO_PEAK)).toBe("\uFFE5Cache/In/Out：100:0:0");
  });

  test("returns 0:0:100 when only output cost exists", () => {
    expect(cacheInOutRatio({ input: 0, cacheRead: 0, output: 1_000_000 }, PRO_PEAK)).toBe("\uFFE5Cache/In/Out：0:0:100");
  });

  test("returns three-way cost ratio for mixed usage", () => {
    // input 1M (¥9) + cache 1M (¥0.30) + output 100K (¥2.70), total ¥12
    // raw: 2.5 : 75 : 22.5; largest remainder: cache wins tie -> 3:75:22
    const result = cacheInOutRatio({ input: 1_000_000, cacheRead: 1_000_000, output: 100_000 }, PRO_PEAK);
    expect(result).toBe("\uFFE5Cache/In/Out：3:75:22");
  });

  test("uses largest remainder so percentages sum to 100", () => {
    // input 500K (¥4.5) + cache 200K (¥0.06) + output 100K (¥2.70), total ¥7.26
    // raw: 0.826 : 61.983 : 37.190; floors 0+61+37=98, remainder goes to input then cache
    const result = cacheInOutRatio({ input: 500_000, cacheRead: 200_000, output: 100_000 }, PRO_PEAK);
    expect(result).toBe("\uFFE5Cache/In/Out：1:62:37");
  });
});

// ============================================================
// buildStatusLine
// ============================================================

describe("buildStatusLine", () => {
  const usage = { input: 100_000, cacheRead: 50_000, output: 20_000 };

  test("brief + pad mode shows cache hit rate and cost", () => {
    const line = buildStatusLine(usage, true, false, PRO_PEAK);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%"); // 50K / 150K
    expect(line).toContain("Sum:");
    expect(line).toContain("Cost:");
    expect(line).not.toContain("Input:");
    expect(line).not.toContain("Output:");
  });

  test("detail + pad mode shows input breakdown", () => {
    const line = buildStatusLine(usage, true, true, PRO_PEAK);
    expect(line).toContain("Input:");
    expect(line).toContain("Output:");
    expect(line).toContain("Sum:");
    expect(line).toContain("Cost:");
  });

  test("brief + no-pad mode", () => {
    const line = buildStatusLine(usage, false, false, PRO_PEAK);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%");
  });

  test("detail + no-pad mode", () => {
    const line = buildStatusLine(usage, false, true, PRO_PEAK);
    expect(line).toContain("Input:");
    expect(line).toContain("Output:");
  });

  test("zero usage displays 0% hit rate", () => {
    const line = buildStatusLine({ input: 0, cacheRead: 0, output: 0 }, false, false, PRO_PEAK);
    expect(line).toContain("0%");
  });

  test("handles all-cache-hit scenario", () => {
    const line = buildStatusLine({ input: 0, cacheRead: 100_000, output: 0 }, false, false, PRO_PEAK);
    expect(line).toContain("100%");
  });

  test("cost reflects the model tier", () => {
    // usage: 100K input + 50K cache + 20K output
    // flash off-peak: 0.15 + 0.0025 + 0.09 = 0.2425 -> "¥0.24"
    // pro peak: 0.9 + 0.015 + 0.54 = 1.455 -> "¥1.46"
    const flashLine = buildStatusLine(usage, false, true, FLASH_OFF_PEAK);
    const proLine = buildStatusLine(usage, false, true, PRO_PEAK);
    expect(flashLine).toContain("\u00A50.24");
    expect(proLine).toContain("\u00A51.46");
  });

  test("uses three-way cache/in/out cost ratio in all display modes", () => {
    const usage = { input: 1_000_000, cacheRead: 1_000_000, output: 100_000 };
    for (const pad of [true, false]) {
      for (const detail of [true, false]) {
        const line = buildStatusLine(usage, pad, detail, PRO_PEAK);
        expect(line).toContain("\uFFE5Cache/In/Out：");
        expect(line).not.toContain("\u00A5I/O:");
      }
    }
  });
});

// ============================================================
// usdCost
// ============================================================

describe("usdCost", () => {
  const LUNA_COST = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };

  test("calculates USD cost from per-million rates", () => {
    // 1M input ($0.20) + 1M cacheRead ($0.02) + 1M output ($1.20) = $1.42
    expect(usdCost({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }, LUNA_COST)).toBeCloseTo(1.42, 6);
  });

  test("includes cacheWrite and orchestration", () => {
    const usage = {
      input: 1_000_000,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      output: 0,
      orchestrationInput: 1_000_000,
      orchestrationCacheRead: 500_000,
      orchestrationOutput: 100_000,
    };
    // input 0.20 + write 0.25 + orch input 0.20 + orch cache 0.01 + orch output 0.12 = 0.78
    expect(usdCost(usage, LUNA_COST)).toBeCloseTo(0.78, 6);
  });
});

// ============================================================
// fmtUsd
// ============================================================

describe("fmtUsd", () => {
  test("uses 2 decimals for cost >= 0.01", () => {
    expect(fmtUsd(0.5)).toBe("$0.50");
    expect(fmtUsd(1)).toBe("$1.00");
  });

  test("uses 4 decimals for cost < 0.01", () => {
    expect(fmtUsd(0.005)).toBe("$0.0050");
    expect(fmtUsd(0)).toBe("$0.0000");
  });
});

// ============================================================
// cacheInOutWriteRatio
// ============================================================

describe("cacheInOutWriteRatio", () => {
  const SOL_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };

  test("returns placeholder when total cost is zero", () => {
    expect(cacheInOutWriteRatio({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, SOL_COST)).toBe("\u0024CacheRead/In/CacheWrite/Out：--:--:--:--");
  });

  test("returns 0:100:0:0 when only input cost exists", () => {
    expect(cacheInOutWriteRatio({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, SOL_COST)).toBe("\u0024CacheRead/In/CacheWrite/Out：0:100:0:0");
  });

  test("returns four-way ratio for mixed usage", () => {
    // input 1M ($5) + cache 1M ($0.5) + write 1M ($6.25) + output 100K ($3) = $14.75
    // raw: 3.39 : 33.90 : 42.37 : 20.34; floors 3+33+42+20=98, remainders to write, input, output
    const result = cacheInOutWriteRatio(
      { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 100_000 },
      SOL_COST,
    );
    expect(result).toMatch(/^\u0024CacheRead\/In\/CacheWrite\/Out：\d+:\d+:\d+:\d+$/);
    expect(result).toBe("\u0024CacheRead/In/CacheWrite/Out：4:34:42:20");
  });
});

// ============================================================
// buildChatGPTStatusLine
// ============================================================

describe("buildChatGPTStatusLine", () => {
  const LUNA_COST = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };
  const usage = { input: 100_000, cacheRead: 50_000, cacheWrite: 10_000, output: 20_000 };

  test("brief + pad mode shows cache hit rate, four-way ratio, sum and cost", () => {
    const line = buildChatGPTStatusLine(usage, LUNA_COST, true, false);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%"); // 50K / 150K
    expect(line).toContain("$CacheRead/In/CacheWrite/Out：");
    expect(line).toContain("Sum:");
    expect(line).toContain("Cost:");
    expect(line).toContain("$");
  });

  test("detail + pad mode includes Write and orchestration when present", () => {
    const line = buildChatGPTStatusLine(
      { ...usage, orchestrationInput: 10_000, orchestrationCacheRead: 2_000, orchestrationOutput: 5_000, reasoningTokens: 3_000 },
      LUNA_COST,
      true,
      true,
      200_000,
    );
    expect(line).toContain("Input:");
    expect(line).toContain("Output:");
    expect(line).toContain("Write:");
    expect(line).toContain("Reasoning:");
    expect(line).toContain("Orch:");
  });

  test("uses totalTokens for Sum when provided", () => {
    const line = buildChatGPTStatusLine(usage, LUNA_COST, false, false, 999_999);
    expect(line).toContain("Sum: 1,000.0K");
  });
});

// ============================================================
// buildChatGPTTokenLine
// ============================================================

describe("buildChatGPTTokenLine", () => {
  const usage = { input: 100_000, cacheRead: 50_000, cacheWrite: 10_000, output: 20_000 };

  test("brief mode shows cache hit rate and sum without cost", () => {
    const line = buildChatGPTTokenLine(usage, false, false);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%");
    expect(line).toContain("Sum:");
    expect(line).not.toContain("Cost:");
    expect(line).not.toContain("$Cache");
  });

  test("detail mode includes Write, Reasoning and Orch when present", () => {
    const line = buildChatGPTTokenLine(
      { ...usage, orchestrationInput: 10_000, orchestrationCacheRead: 2_000, orchestrationOutput: 5_000, reasoningTokens: 3_000 },
      false,
      true,
    );
    expect(line).toContain("Input:");
    expect(line).toContain("Write:");
    expect(line).toContain("Reasoning:");
    expect(line).toContain("Orch:");
  });
});
