/**
 * DeepSeek Cost Tracker — Session-level token usage and cost display.
 *
 * Shows cumulative and per-turn cost in the widget area with an inline
 * progress bar tracking context usage against a configurable budget
 * (default 220K).  Also tracks daily accumulated spend per session,
 * persisted to ~/.omp/cost-archive/deepseek-cost.json.
 *
 * Pricing (RMB per million tokens, deepseek-v4-pro):
 *   input (cache miss): ¥3     cacheRead (cache hit): ¥0.025     output: ¥6
 *
 * Commands:
 *   /budget <N>K   — Set progress bar max, session-scoped (e.g. /budget 300K).
 *   /budget detail — Toggle detail / brief display mode.
 *   /budget clear  — Archive current daily tracking file and start a fresh period.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { createTrackerState, DEFAULT_BUDGET, type TrackerState } from "./tracker-state";
import {
  MODEL_ID,
  rmbCost,
  fmtTokens,
  fmtCost,
  buildStatusLine,
} from "./cost-calc";
import { createDailyTracker, type DailyTracker } from "./daily-tracker";
import { buildSegmentBar } from "./segment-bar";

// ============================================================================
// Constants
// ============================================================================

const WIDGET_KEY = "z-deepseek-cost";
const BALANCE_PROVIDER = "deepseek";
const BAR_WIDTH = 20;

// ============================================================================
// Progress bar rendering (local helpers)
// ============================================================================

function buildBar(tokenCount: number | null, max: number): string {
  if (tokenCount === null || max <= 0) return "";
  const pct = (tokenCount / max) * 100;
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return `[\u2588${filled > 0 ? `\u2588`.repeat(filled - 1) : ""}${"\u2591".repeat(empty)} ${pct.toFixed(0).padStart(3)}% (${fmtTokens(tokenCount)}/${fmtTokens(max)})]`;
}

function barColor(pct: number): "dim" | "success" | "warning" | "error" {
  if (pct < 36) return "dim";
  if (pct < 64) return "success";
  if (pct < 82) return "warning";
  return "error";
}

function colorBar(bar: string, tokens: number, max: number, theme: { fg: (color: string, text: string) => string }): string {
  const pct = (tokens / max) * 100;
  return theme.fg(barColor(pct), bar);
}

// ============================================================================
// Balance fetching
// ============================================================================

async function fetchBalance(ctx: ExtensionContext): Promise<number | null> {
  try {
    const resolver = ctx.modelRegistry.resolver(BALANCE_PROVIDER);
    const apiKey = await resolver({ lastChance: false, error: undefined });
    if (!apiKey) return null;
    const rawBase = ctx.modelRegistry.getProviderBaseUrl(BALANCE_PROVIDER) ?? "https://api.deepseek.com";
    const base = rawBase.replace(/\/v1\/?$/, "");
    const resp = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { balance_infos?: Array<{ currency: string; total_balance: string }> };
    const cny = data.balance_infos?.find(b => b.currency === "CNY");
    if (cny) return parseFloat(cny.total_balance);
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// UI refresh
// ============================================================================

function refresh(
  state: TrackerState,
  daily: DailyTracker,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!ctx.hasUI) return;

  if (ctx.model?.id !== MODEL_ID) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const stats = ctx.sessionManager.getUsageStatistics();
  const cu = ctx.getContextUsage();
  state.lastContextTokens = cu?.tokens ?? state.lastContextTokens;

  const lines: string[] = [];

  // Line 1: progress bar + balance + accrued spend + per-session segment bar
  const dailyData = daily.read();
  const accruedCost = dailyData.totalCost;
  const segBar = buildSegmentBar(dailyData.sessions, accruedCost, ctx.ui.theme);
  const bar = buildBar(state.lastContextTokens, state.budget);

  const parts: string[] = [];
  if (bar && state.lastContextTokens !== null) {
    parts.push(colorBar(bar, state.lastContextTokens, state.budget, ctx.ui.theme));
  }
  if (state.balance !== null) {
    parts.push(`\u{1F4B0} Bal: \u00A5${state.balance.toFixed(2)}`);
  }
  const accruedPart = segBar
    ? `\u23F3 Accrued: ${fmtCost(accruedCost)} ${segBar}`
    : `\u23F3 Accrued: ${fmtCost(accruedCost)}`;
  parts.push(accruedPart);

  if (parts.length > 0) lines.push(parts.join("  "));

  // Line 2: total session stats
  lines.push(`\u{1F4CB} Total:  ${buildStatusLine({
    input: stats.input,
    cacheRead: stats.cacheRead,
    output: stats.output,
  }, true, state.detailMode)}`);

  // Line 3: turn stats (if available)
  if (state.turnDelta) {
    lines.push(`\u{1F4CA} Turn:   ${buildStatusLine(state.turnDelta, true, state.detailMode)}`);
  }

  ctx.ui.setWidget(WIDGET_KEY, lines);
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function deepseekCost(pi: ExtensionAPI): void {
  pi.setLabel("DeepSeek Cost Tracker");

  const state = createTrackerState();
  const daily = createDailyTracker();

  // ── /budget command ──
  pi.registerCommand("budget", {
    description: "Set context budget, toggle display mode, or clear daily tracking (/budget clear)",
    handler: async (args: string, ctx) => {
      const trimmed = args?.trim() ?? "";

      // /budget clear — archive daily tracking and reset
      if (/^clear$/i.test(trimmed)) {
        const bal = await fetchBalance(ctx);
        state.balance = bal;
        const archived = daily.archive(bal);
        if (archived) {
          ctx.ui.notify(`Daily tracking archived → ${path.basename(archived)}`, "info");
        } else {
          ctx.ui.notify("No daily data to archive (tracking is empty).", "info");
        }
        refresh(state, daily, pi, ctx);
        return;
      }

      // /budget detail — toggle display mode
      if (/^detail$/i.test(trimmed)) {
        state.detailMode = !state.detailMode;
        ctx.ui.notify(`Display: ${state.detailMode ? "detail" : "brief"}`, "info");
        refresh(state, daily, pi, ctx);
        return;
      }

      // /budget <N>K — set budget
      const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*K?$/i);
      if (!m) {
        ctx.ui.notify("Usage: /budget <number>K | /budget detail | /budget clear", "error");
        return;
      }
      const newBudget = Math.round(parseFloat(m[1]) * 1000);
      if (newBudget <= 0) {
        state.budget = DEFAULT_BUDGET;
        ctx.ui.notify(`Budget must be > 0, reset to ${fmtTokens(DEFAULT_BUDGET)}`, "warning");
      } else {
        state.budget = newBudget;
        ctx.ui.notify(`Budget: ${fmtTokens(newBudget)}`, "info");
      }
      refresh(state, daily, pi, ctx);
    },
  });

  // ── Session init ──
  const onInit = async (_event: unknown, ctx: ExtensionContext) => {
    const s = ctx.sessionManager.getUsageStatistics();
    state.previousTotal = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite };
    state.lastContextTokens = null;
    state.turnDelta = null;
    state.balance = null;

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";
    daily.ensureSession(sessionId, sessionName, {
      input: s.input,
      cacheRead: s.cacheRead,
      output: s.output,
    });

    refresh(state, daily, pi, ctx);
    state.balance = await fetchBalance(ctx);
    refresh(state, daily, pi, ctx);
  };

  pi.on("session_start", onInit);
  pi.on("session_branch", onInit);
  pi.on("session_switch", onInit);
  pi.on("session_tree", onInit);

  // ── Agent start — refresh context bar ──
  pi.on("agent_start", (_event, ctx) => {
    refresh(state, daily, pi, ctx);
  });

  // ── Agent end — accumulate daily cost + turn delta ──
  pi.on("agent_end", async (_event, ctx) => {
    const stats = ctx.sessionManager.getUsageStatistics();
    const cur = { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite };

    // Guard: only track DeepSeek model
    if (ctx.model?.id !== MODEL_ID) {
      state.previousTotal = cur;
      return;
    }

    // --- Daily accumulation ---
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      state.previousTotal = cur;
      return;
    }
    const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";

    try {
      const dailyData = daily.ensureSession(sessionId, sessionName, {
        input: stats.input,
        cacheRead: stats.cacheRead,
        output: stats.output,
      });

      const sess = dailyData.sessions.find(e => e.id === sessionId);
      if (!sess) {
        state.previousTotal = cur;
        return;
      }
      const deltaInput = Math.max(0, stats.input - sess.lastInput);
      const deltaCacheRead = Math.max(0, stats.cacheRead - sess.lastCacheRead);
      const deltaOutput = Math.max(0, stats.output - sess.lastOutput);

      if (deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0) {
        const deltaCost = rmbCost(deltaInput, deltaCacheRead, deltaOutput);
        dailyData.totalCost += deltaCost;
        dailyData.totalTokens.input += deltaInput;
        dailyData.totalTokens.cacheRead += deltaCacheRead;
        dailyData.totalTokens.output += deltaOutput;

        sess.lastInput = stats.input;
        sess.lastCacheRead = stats.cacheRead;
        sess.lastOutput = stats.output;
        sess.cost += deltaCost;

        daily.write(dailyData);
      }
    } catch {
      // Daily tracking is best-effort; never block the widget.
    }

    // --- Turn delta for widget ---
    const delta = {
      input: cur.input - state.previousTotal.input,
      output: cur.output - state.previousTotal.output,
      cacheRead: cur.cacheRead - state.previousTotal.cacheRead,
    };

    state.turnDelta = (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0) ? delta : null;
    state.previousTotal = cur;
    state.balance = await fetchBalance(ctx);
    refresh(state, daily, pi, ctx);
  });
}
