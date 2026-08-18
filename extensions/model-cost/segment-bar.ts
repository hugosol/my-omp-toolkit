/**
 * Multi-segment bar rendering for daily cost visualization.
 *
 * Two modes:
 * - Fine (≤ ¥20.00): 1/8 block = ¥0.05, each session ≥ 1 block (ceil).
 * - Coarse (> ¥20.00): 1 full block = ¥1.00, sessions < ¥1.00 hidden.
 * Both modes capped at MAX_SEGMENT_BAR (50) characters.
 */

import type { DailySession } from "./daily-tracker";

/** Palette for per-session segment bar (8 colors, cycles). */
const SEGMENT_PALETTE = [
  "success",
  "warning",
  "error",
  "thinkingHigh",
  "thinkingXhigh",
  "syntaxType",
  "syntaxNumber",
  "syntaxKeyword",
] as const;

const BLOCKS_PER_CHAR = 8;
const MAX_SEGMENT_BAR = 50;
const FINE_BLOCK_RMB = 0.05;
const COARSE_BLOCK_RMB = 1.00;
const SCALE_THRESHOLD = 20.00;
const MAX_FINE_BLOCKS = 400;

/** Map a number of 1/8 blocks (1–8) to the corresponding Unicode partial block character. */
function blockChar(eighths: number): string {
  const chars = ["", "\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589", "\u2588"];
  return chars[eighths] ?? "";
}

/**
 * Scale raw allocations to fit within a cap, keeping a floor of 1 per entry.
 * Returns integer allocations summing to at most `cap` (cap-corrected).
 */
function scaleAlloc(rawTotal: number, cap: number, raws: number[]): number[] {
  if (rawTotal <= cap) return raws;

  const scale = cap / rawTotal;
  const allocs = raws.map(r => Math.max(1, Math.round(r * scale)));
  const sum = allocs.reduce((a, b) => a + b, 0);
  const diff = cap - sum;

  if (diff !== 0 && allocs.length > 0) {
    // Adjust the largest entry to absorb the rounding discrepancy
    let largestIdx = 0;
    for (let i = 1; i < allocs.length; i++) {
      if (allocs[i] > allocs[largestIdx]) largestIdx = i;
    }
    allocs[largestIdx] = Math.max(1, allocs[largestIdx] + diff);
  }
  return allocs;
}

/** Fine mode: 1/8 block = ¥0.05, each session ≥ 1 block (ceil). */
function buildFineBar(
  sessions: DailySession[],
  totalCost: number,
  theme: { fg: (color: string, text: string) => string },
): string {
  const entries: { color: string; rawBlocks: number }[] = [];
  let rawTotal = 0;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.cost <= 0) continue;
    const blocks = Math.ceil(s.cost / FINE_BLOCK_RMB);
    entries.push({
      color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length],
      rawBlocks: blocks,
    });
    rawTotal += blocks;
  }
  if (entries.length === 0) return "";

  const blocks = scaleAlloc(rawTotal, MAX_FINE_BLOCKS, entries.map(e => e.rawBlocks));

  let bar = "[";
  for (let i = 0; i < entries.length; i++) {
    const b = blocks[i];
    const fullChars = Math.floor((b - 1) / BLOCKS_PER_CHAR);
    const remainder = ((b - 1) % BLOCKS_PER_CHAR) + 1;
    if (fullChars > 0) {
      bar += theme.fg(entries[i].color, "\u2588".repeat(fullChars));
    }
    bar += theme.fg(entries[i].color, blockChar(remainder));
  }
  bar += "]";
  return bar;
}

/** Coarse mode: 1 full block = ¥1.00, sessions < ¥1.00 hidden, capped at MAX_SEGMENT_BAR. */
function buildCoarseBar(
  sessions: DailySession[],
  theme: { fg: (color: string, text: string) => string },
): string {
  const entries: { color: string; rawChars: number }[] = [];
  let rawTotal = 0;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.cost < COARSE_BLOCK_RMB) continue;
    const chars = Math.ceil(s.cost / COARSE_BLOCK_RMB);
    entries.push({
      color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length],
      rawChars: chars,
    });
    rawTotal += chars;
  }
  if (entries.length === 0) return "";

  const widths = scaleAlloc(rawTotal, MAX_SEGMENT_BAR, entries.map(e => e.rawChars));

  let bar = "[";
  for (let i = 0; i < entries.length; i++) {
    bar += theme.fg(entries[i].color, "\u2588".repeat(widths[i]));
  }
  bar += "]";
  return bar;
}

/**
 * Build a colored multi-segment bar showing each session's cost proportion.
 * Returns empty string when there is no cost to display.
 */
export function buildSegmentBar(
  sessions: DailySession[],
  totalCost: number,
  theme: { fg: (color: string, text: string) => string },
): string {
  let hasCost = false;
  for (const s of sessions) {
    if (s.cost > 0) { hasCost = true; break; }
  }
  if (!hasCost || totalCost <= 0) return "";

  if (totalCost <= SCALE_THRESHOLD) {
    return buildFineBar(sessions, totalCost, theme);
  }
  return buildCoarseBar(sessions, theme);
}
