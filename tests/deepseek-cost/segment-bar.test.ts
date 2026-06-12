import { describe, test, expect } from "bun:test";
import { buildSegmentBar } from "../../extensions/deepseek-cost/segment-bar";
import type { DailySession } from "../../extensions/deepseek-cost/daily-tracker";

// Minimal theme stub — just wraps text with color name for assertion
const theme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};

function makeSession(overrides: Partial<DailySession> = {}): DailySession {
  return {
    id: "s1",
    name: "test",
    lastInput: 0,
    lastCacheRead: 0,
    lastOutput: 0,
    cost: 0,
    ...overrides,
  };
}

// ============================================================
// buildSegmentBar
// ============================================================

describe("buildSegmentBar", () => {
  test("returns empty string for empty sessions", () => {
    expect(buildSegmentBar([], 10, theme)).toBe("");
  });

  test("returns empty string when totalCost <= 0", () => {
    const sessions = [makeSession({ cost: 5 })];
    expect(buildSegmentBar(sessions, 0, theme)).toBe("");
  });

  test("returns empty string when all sessions have zero cost", () => {
    const sessions = [makeSession({ cost: 0 }), makeSession({ cost: 0 })];
    expect(buildSegmentBar(sessions, 0, theme)).toBe("");
  });

  test("fine mode: renders bar for small total cost (≤ ¥20)", () => {
    // ¥0.50 → 10 blocks (0.50 / 0.05), each session gets at least 1 char
    const sessions = [makeSession({ cost: 0.50 })];
    const result = buildSegmentBar(sessions, 0.50, theme);
    expect(result).toStartWith("[");
    expect(result).toEndWith("]");
    // Should contain colored blocks
    expect(result).toContain("[success]");
  });

  test("fine mode: renders multiple sessions", () => {
    const sessions = [
      makeSession({ id: "s1", cost: 1.00 }),
      makeSession({ id: "s2", cost: 2.00 }),
    ];
    const result = buildSegmentBar(sessions, 3.00, theme);
    expect(result).toStartWith("[");
    expect(result).toEndWith("]");
    // Both sessions should appear
    expect(result).toContain("[success]");
    expect(result).toContain("[warning]");
  });

  test("coarse mode: triggers when totalCost > ¥20", () => {
    // ¥30 total → coarse mode (1 full block = ¥1.00)
    const sessions = [makeSession({ cost: 30 })];
    const result = buildSegmentBar(sessions, 30, theme);
    expect(result).toStartWith("[");
    expect(result).toEndWith("]");
  });

  test("coarse mode: hides sessions < ¥1.00", () => {
    const sessions = [
      makeSession({ id: "s1", cost: 0.50 }),   // hidden
      makeSession({ id: "s2", cost: 25.00 }),   // visible (25 blocks)
    ];
    const result = buildSegmentBar(sessions, 25.50, theme);
    // Should only contain one color segment (session 2)
    expect(result).toContain("[warning]");
    // s1 color (success) should not appear since it was hidden
    const successCount = (result.match(/\[success\]/g) || []).length;
    expect(successCount).toBe(0);
  });

  test("coarse mode: bar scales down to fit within cap", () => {
    // Use sessions with uneven costs so scaling's largest-entry adjustment works
    const sessions = [
      makeSession({ id: "s1", cost: 10.00 }),
      makeSession({ id: "s2", cost: 20.00 }),
      makeSession({ id: "s3", cost: 30.00 }),
    ];
    const result = buildSegmentBar(sessions, 60, theme);
    const inner = result.slice(1, -1);
    const blockCount = (inner.match(/\u2588/g) || []).length;
    // Scaled to fit within 50
    expect(blockCount).toBeLessThanOrEqual(50);
    expect(blockCount).toBeGreaterThan(0);
  });

  test("respects palette cycling", () => {
    // 9 sessions should cycle through 8-color palette
    const sessions = Array.from({ length: 9 }, (_, i) =>
      makeSession({ id: `s${i}`, cost: 1.00 }),
    );
    const result = buildSegmentBar(sessions, 9, theme);
    // session 0 and session 8 should both use "success" (palette[0])
    const matches = result.match(/\[success\]/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
