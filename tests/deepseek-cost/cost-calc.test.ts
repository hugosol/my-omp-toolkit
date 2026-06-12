import { describe, test, expect } from "bun:test";
import {
  MODEL_ID,
  PRICE_RMB_PER_1M,
  fmtTokens,
  rmbCost,
  fmtCost,
  ioRatio,
  buildStatusLine,
} from "../../extensions/deepseek-cost/cost-calc";

// ============================================================
// Constants
// ============================================================

describe("MODEL_ID", () => {
  test("is the expected model", () => {
    expect(MODEL_ID).toBe("deepseek-v4-pro");
  });
});

describe("PRICE_RMB_PER_1M", () => {
  test("has correct pricing tiers", () => {
    expect(PRICE_RMB_PER_1M.input).toBe(3);
    expect(PRICE_RMB_PER_1M.cacheRead).toBe(0.025);
    expect(PRICE_RMB_PER_1M.output).toBe(6);
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
    // 123,500 -> 123.5 -> 123.5K
    expect(fmtTokens(123_500)).toBe("123.5K");
    // 123,999 -> 123.999... -> rounds to 124.0K
    expect(fmtTokens(123_999)).toBe("124.0K");
  });

  test("handles carry from fraction rounding", () => {
    // 999,950 -> k=999.95, frac=10 -> carry=1 -> 1,000.0K
    expect(fmtTokens(999_950)).toBe("1,000.0K");
  });
});

// ============================================================
// rmbCost
// ============================================================

describe("rmbCost", () => {
  test("returns zero for zero tokens", () => {
    expect(rmbCost(0, 0, 0)).toBe(0);
  });

  test("calculates input-only cost", () => {
    // 1M input tokens x 3 RMB = 3 RMB
    expect(rmbCost(1_000_000, 0, 0)).toBe(3);
  });

  test("calculates output-only cost", () => {
    // 1M output tokens x 6 RMB = 6 RMB
    expect(rmbCost(0, 0, 1_000_000)).toBe(6);
  });

  test("calculates cache-read cost", () => {
    // 1M cache read tokens x 0.025 RMB = 0.025 RMB
    expect(rmbCost(0, 1_000_000, 0)).toBe(0.025);
  });

  test("calculates mixed cost", () => {
    // 500K input (1.5 RMB) + 200K cache (0.005 RMB) + 100K output (0.6 RMB) = 2.105 RMB
    const cost = rmbCost(500_000, 200_000, 100_000);
    expect(cost).toBeCloseTo(2.105, 6);
  });

  test("handles fractional tokens gracefully", () => {
    const cost = rmbCost(1, 0, 0);
    expect(cost).toBe(3 / 1_000_000);
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
// ioRatio
// ============================================================

describe("ioRatio", () => {
  test("returns placeholder when total cost is zero", () => {
    expect(ioRatio({ input: 0, cacheRead: 0, output: 0 })).toBe("\u00A5I/O: --:--");
  });

  test("returns 100:0 when only input cost exists", () => {
    const result = ioRatio({ input: 1_000_000, cacheRead: 0, output: 0 });
    expect(result).toBe("\u00A5I/O: 100:0");
  });

  test("returns 0:100 when only output cost exists", () => {
    const result = ioRatio({ input: 0, cacheRead: 0, output: 1_000_000 });
    expect(result).toBe("\u00A5I/O: 0:100");
  });

  test("returns proportional ratio for mixed usage", () => {
    // input 1M (3 RMB) + cache 0 + output 500K (3 RMB) -> 50:50
    const result = ioRatio({ input: 1_000_000, cacheRead: 0, output: 500_000 });
    expect(result).toContain("50:50");
  });
});

// ============================================================
// buildStatusLine
// ============================================================

describe("buildStatusLine", () => {
  const usage = { input: 100_000, cacheRead: 50_000, output: 20_000 };

  test("brief + pad mode shows cache hit rate and cost", () => {
    const line = buildStatusLine(usage, true, false);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%");  // 50K / 150K
    expect(line).toContain("Sum:");
    expect(line).toContain("Cost:");
    expect(line).not.toContain("Input:");
    expect(line).not.toContain("Output:");
  });

  test("detail + pad mode shows input breakdown", () => {
    const line = buildStatusLine(usage, true, true);
    expect(line).toContain("Input:");
    expect(line).toContain("Output:");
    expect(line).toContain("Sum:");
    expect(line).toContain("Cost:");
  });

  test("brief + no-pad mode", () => {
    const line = buildStatusLine(usage, false, false);
    expect(line).toContain("Cache:");
    expect(line).toContain("33%");
  });

  test("detail + no-pad mode", () => {
    const line = buildStatusLine(usage, false, true);
    expect(line).toContain("Input:");
    expect(line).toContain("Output:");
  });

  test("zero usage displays 0% hit rate", () => {
    const line = buildStatusLine({ input: 0, cacheRead: 0, output: 0 }, false, false);
    expect(line).toContain("0%");
  });

  test("handles all-cache-hit scenario", () => {
    const line = buildStatusLine({ input: 0, cacheRead: 100_000, output: 0 }, false, false);
    expect(line).toContain("100%");
  });
});
