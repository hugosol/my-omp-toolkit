/**
 * Model Cost Tracker — Session-level token usage and cost display.
 *
 * Shows cumulative and per-turn cost in the widget area with an inline
 * progress bar tracking context usage against a display-only budget. DeepSeek
 * defaults to 450K and supports transient overrides; ChatGPT/Codex is fixed at
 * 272K. Also tracks daily accumulated spend per session, persisted to
 * ~/.omp/cost-archive/deepseek-cost.json.
 *
 * When the active model is an `openai-codex` (ChatGPT/Codex OAuth) model,
 * the widget switches to ChatGPT/Codex mode: context progress bar, weekly
 * 7-day usage percentage + reset time, and USD-estimated token/cost stats.
 *
 * Pricing (RMB per million tokens, Beijing peak/off-peak):
 *   deepseek-v4-pro:   peak input ¥9 / cache ¥0.30 / output ¥27
 *                      off-peak input ¥4.5 / cache ¥0.15 / output ¥13.5
 *   deepseek-v4-flash: peak input ¥3 / cache ¥0.10 / output ¥9
 *                      off-peak input ¥1.5 / cache ¥0.05 / output ¥4.5
 *
 * Commands:
 *   /budget <N>K   — Override the DeepSeek display budget, capped at 1000K.
 *   /budget detail — Toggle detail / brief display mode.
 *   /budget clear  — Archive current daily tracking file and start a fresh period.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { createTrackerState, DEFAULT_DEEPSEEK_BUDGET, type ChatGPTUsageState, type TrackerState } from "./tracker-state";
import {
  resolvePriceTier,
  isPeakHour,
  nextBoundary,
  fmtTokens,
  fmtCost,
  buildStatusLine,
  buildChatGPTStatusLine,
  buildChatGPTTokenLine,
  type ModelCost,
} from "./cost-calc";
import { createDailyTracker, type DailyTracker } from "./daily-tracker";
import { anchorRequest, addMessageCost, finishTurn } from "./turn-cost";
import { buildSegmentBar } from "./segment-bar";
import { classifyModelMode } from "./model-mode";
import {
  createBalanceCache,
  isCacheFresh,
  setCacheEntry,
  type BalanceCache,
} from "./balance-cache";
import { fetchChatGPTUsage, isOpenAICodexModel, buildWeeklyUsagePart, parseChatGPTUsageHeaders, visibleDisplayWidth } from "./chatgpt-usage";

// ============================================================================
// Constants
// ============================================================================

const WIDGET_KEY = "z-model-cost";
const BALANCE_PROVIDER = "deepseek";
const BAR_WIDTH = 20;
const CHATGPT_BUDGET = 272_000;
const MAX_DEEPSEEK_BUDGET = 1_000_000;

interface MessageUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  orchestrationInput?: number;
  orchestrationCacheRead?: number;
  orchestrationOutput?: number;
  reasoningTokens?: number;
}

function getMessageUsage(message: unknown): MessageUsage | null {
  if (!message || typeof message !== "object" || !("usage" in message)) return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const input = typeof record.input === "number" ? record.input : 0;
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  const reasoningTokens = typeof record.reasoningTokens === "number" ? record.reasoningTokens : undefined;

  const orchestration = record.orchestration && typeof record.orchestration === "object"
    ? record.orchestration as Record<string, unknown>
    : undefined;
  const orchestrationInput = orchestration && typeof orchestration.input === "number" ? orchestration.input : undefined;
  const orchestrationCacheRead = orchestration && typeof orchestration.cacheRead === "number"
    ? orchestration.cacheRead
    : undefined;
  const orchestrationOutput = orchestration && typeof orchestration.output === "number" ? orchestration.output : undefined;

  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(orchestrationInput !== undefined ? { orchestrationInput } : {}),
    ...(orchestrationCacheRead !== undefined ? { orchestrationCacheRead } : {}),
    ...(orchestrationOutput !== undefined ? { orchestrationOutput } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

// ============================================================================
// Progress bar rendering (local helpers)
// ============================================================================

function buildBar(tokenCount: number | null, max: number): string {
  if (tokenCount === null || max <= 0) return "";
  const pct = (tokenCount / max) * 100;
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return `[${"\u2588".repeat(filled)}${"\u2591".repeat(empty)} ${pct.toFixed(0).padStart(3)}% (${fmtTokens(tokenCount)}/${fmtTokens(max)})]`;
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

function buildChatGPTWidgetLines(
  state: TrackerState,
  ctx: ExtensionContext,
  theme: { fg: (color: string, text: string) => string },
  width: number,
): string[] {
  const stats = ctx.sessionManager.getUsageStatistics();
  const cu = ctx.getContextUsage();
  state.lastContextTokens = cu?.tokens ?? state.lastContextTokens;
  const budget = CHATGPT_BUDGET;
  const bar = buildBar(state.lastContextTokens, budget);

  const parts: string[] = [];
  let prefixWidth = 0;
  if (bar && state.lastContextTokens !== null) {
    const coloredBar = colorBar(bar, state.lastContextTokens, budget, theme);
    parts.push(coloredBar);
    prefixWidth = visibleDisplayWidth(coloredBar);
  }
  const weeklyWidth = Math.max(0, width - (parts.length > 0 ? prefixWidth + 2 : 0));
  const weekly = buildWeeklyUsagePart(state.chatgpt, Date.now(), weeklyWidth, theme);
  if (weekly) parts.push(weekly);

  const lines: string[] = [];
  if (parts.length > 0) lines.push(parts.join("  "));

  const cost = ctx.model?.cost as ModelCost | undefined;
  const totalUsage = {
    input: stats.input,
    cacheRead: stats.cacheRead,
    cacheWrite: stats.cacheWrite,
    output: stats.output,
    orchestrationInput: stats.orchestrationInput,
    orchestrationCacheRead: stats.orchestrationCacheRead,
    orchestrationOutput: stats.orchestrationOutput,
  };
  if (cost) {
    lines.push(`\u{1F4CB} Total:  ${buildChatGPTStatusLine(totalUsage, cost, true, state.detailMode, stats.totalTokens)}`);
    if (state.turnDelta) {
      lines.push(`\u{1F4CA} Turn:   ${buildChatGPTStatusLine(state.turnDelta, cost, true, state.detailMode)}`);
    }
  } else {
    lines.push(`\u{1F4CB} Total:  ${buildChatGPTTokenLine(totalUsage, true, state.detailMode, stats.totalTokens)}`);
    if (state.turnDelta) {
      lines.push(`\u{1F4CA} Turn:   ${buildChatGPTTokenLine(state.turnDelta, true, state.detailMode)}`);
    }
  }
  return lines;
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
// Widget content
// ============================================================================

function buildWidgetLines(
  state: TrackerState,
  daily: DailyTracker,
  ctx: ExtensionContext,
  theme: { fg: (color: string, text: string) => string },
  _width: number,
): string[] {
  const mode = classifyModelMode(ctx.model);
  if (mode === "hidden") return [];

  const stats = ctx.sessionManager.getUsageStatistics();
  const cu = ctx.getContextUsage();
  state.lastContextTokens = cu?.tokens ?? state.lastContextTokens;
  const now = new Date();

  if (mode === "codex") {
    return buildChatGPTWidgetLines(state, ctx, theme, _width);
  }

  const budget = state.deepSeekBudget;
  const bar = buildBar(state.lastContextTokens, budget);
  const lines: string[] = [];

  if (mode === "token-only") {
    const parts: string[] = [];
    if (bar && state.lastContextTokens !== null) {
      parts.push(colorBar(bar, state.lastContextTokens, budget, theme));
    }
    if (parts.length > 0) lines.push(parts.join("  "));

    const totalUsage = {
      input: stats.input,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      output: stats.output,
      orchestrationInput: stats.orchestrationInput,
      orchestrationCacheRead: stats.orchestrationCacheRead,
      orchestrationOutput: stats.orchestrationOutput,
    };
    lines.push(`\u{1F4CB} Total:  ${buildChatGPTTokenLine(totalUsage, true, state.detailMode, stats.totalTokens)}`);
    if (state.turnDelta) {
      lines.push(`\u{1F4CA} Turn:   ${buildChatGPTTokenLine(state.turnDelta, true, state.detailMode)}`);
    }
    return lines;
  }

  // DeepSeek mode
  const tier = state.turnCost.activeTier ?? resolvePriceTier(ctx.model?.id, now);
  if (!tier) return [];

  const period = state.turnCost.activePeriod ?? (isPeakHour(now) ? "peak" : "offPeak");
  const periodIcon = period === "peak" ? "\u{1F525}" : "\u{1F319}";

  // Line 1: progress bar + balance + accrued spend + per-session segment bar
  const dailyData = daily.read();
  const accruedCost = dailyData.totalCost;
  const segBar = buildSegmentBar(dailyData.sessions, accruedCost, theme);

  const parts: string[] = [periodIcon];
  if (bar && state.lastContextTokens !== null) {
    parts.push(colorBar(bar, state.lastContextTokens, budget, theme));
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
  }, true, state.detailMode, tier)}`);

  // Line 3: turn stats (if available)
  if (state.turnDelta) {
    lines.push(`\u{1F4CA} Turn:   ${buildStatusLine(state.turnDelta, true, state.detailMode, tier)}`);
  }

  return lines;
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

  const mode = classifyModelMode(ctx.model);
  if (mode === "hidden") {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(WIDGET_KEY, (_tui: unknown, theme: { fg: (color: string, text: string) => string }) => ({
    render(width: number) {
      return buildWidgetLines(state, daily, ctx, theme, width);
    },
  }));
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function modelCost(pi: ExtensionAPI): void {
  pi.setLabel("Model Cost Tracker");

  const state = createTrackerState();
  const daily = createDailyTracker();
  const balanceCache: BalanceCache = createBalanceCache();
  let boundaryTimer: Timer | undefined;
  let chatgptUsagePromise: Promise<ChatGPTUsageState> | null = null;

  function applyChatGPTUsageResult(ctx: ExtensionContext, result: ChatGPTUsageState): void {
    const current = state.chatgpt;
    if (
      result.kind === "config" ||
      result.kind === "auth" ||
      result.kind === "transport" ||
      result.kind === "incompatible"
    ) {
      if (current.source === "header") {
        state.chatgpt = { ...current, error: result.error ?? null };
      } else {
        state.chatgpt = result;
      }
    } else {
      state.chatgpt = result;
    }
    setCacheEntry(balanceCache.codex, result);
    refresh(state, daily, pi, ctx);
  }

  function refreshChatGPTUsage(ctx: ExtensionContext): Promise<ChatGPTUsageState> {
    if (!chatgptUsagePromise) {
      chatgptUsagePromise = fetchChatGPTUsage(ctx)
        .then(result => {
          applyChatGPTUsageResult(ctx, result);
          return result;
        })
        .finally(() => {
          chatgptUsagePromise = null;
        });
    }
    return chatgptUsagePromise;
  }

  function startChatGPTUsageRefresh(ctx: ExtensionContext): Promise<ChatGPTUsageState> {
    if (state.chatgpt.kind === "idle" || state.chatgpt.kind === "loading") {
      state.chatgpt = { kind: "loading", usedPercent: null, resetsAt: null, fetchedAt: null };
      refresh(state, daily, pi, ctx);
    }
    return refreshChatGPTUsage(ctx);
  }

  function scheduleBoundaryRefresh(ctx: ExtensionContext): void {
    if (boundaryTimer) ctx.clearTimer(boundaryTimer);
    const now = new Date();
    const delay = Math.max(0, nextBoundary(now).getTime() - now.getTime());
    boundaryTimer = ctx.setTimeout(() => {
      boundaryTimer = undefined;
      refresh(state, daily, pi, ctx);
      scheduleBoundaryRefresh(ctx);
    }, delay);
  }

  /**
   * Unified per-model initialization. Called from session init, agent_start,
   * and after a `/model` switch so every model starts with the same lifecycle.
   */
  async function initializeForModel(ctx: ExtensionContext): Promise<void> {
    const mode = classifyModelMode(ctx.model);

    if (mode !== "deepseek") {
      state.balance = null;
    }

    refresh(state, daily, pi, ctx);

    if (mode === "deepseek") {
      if (isCacheFresh(balanceCache.deepSeek)) {
        state.balance = balanceCache.deepSeek.value;
      } else {
        state.balance = await fetchBalance(ctx);
        setCacheEntry(balanceCache.deepSeek, state.balance);
      }
    } else if (mode === "codex") {
      if (isCacheFresh(balanceCache.codex) && balanceCache.codex.value) {
        state.chatgpt = balanceCache.codex.value;
      } else {
        await startChatGPTUsageRefresh(ctx);
      }
    }

    refresh(state, daily, pi, ctx);
    scheduleBoundaryRefresh(ctx);
  }

  /** Fetch DeepSeek balance and Codex weekly usage together and cache both. */
  async function refreshBoth(ctx: ExtensionContext): Promise<void> {
    const [balance, usage] = await Promise.all([
      fetchBalance(ctx),
      fetchChatGPTUsage(ctx).catch(() => null),
    ]);
    setCacheEntry(balanceCache.deepSeek, balance);
    state.balance = balance;
    setCacheEntry(balanceCache.codex, usage);
    if (usage) state.chatgpt = usage;
    refresh(state, daily, pi, ctx);
  }

  // ── Input: typed model commands prefetch both data sources with TTL ──
  pi.on("input", (event, ctx) => {
    const text = event.text?.trim() ?? "";
    if (!/^\/(model|models|switch)\b/.test(text)) return;
    if (!isCacheFresh(balanceCache.deepSeek) || !isCacheFresh(balanceCache.codex)) {
      void refreshBoth(ctx);
    }
  });

  // ── /budget command ──
  pi.registerCommand("budget", {
    description: "Set the DeepSeek display budget, toggle detail, or clear daily tracking",
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
      if (isOpenAICodexModel(ctx.model)) {
        ctx.ui.notify(`ChatGPT context budget is fixed at ${fmtTokens(CHATGPT_BUDGET)}.`, "warning");
        return;
      }
      if (classifyModelMode(ctx.model) !== "deepseek") {
        ctx.ui.notify("Context budget can only be changed in DeepSeek mode.", "warning");
        return;
      }
      const newBudget = Math.min(
        Math.round(parseFloat(m[1]) * 1000),
        MAX_DEEPSEEK_BUDGET,
      );
      if (newBudget <= 0) {
        state.deepSeekBudget = DEFAULT_DEEPSEEK_BUDGET;
        ctx.ui.notify(`Budget must be > 0, reset to ${fmtTokens(DEFAULT_DEEPSEEK_BUDGET)}`, "warning");
      } else {
        state.deepSeekBudget = newBudget;
        ctx.ui.notify(`Budget: ${fmtTokens(newBudget)}`, "info");
      }
      refresh(state, daily, pi, ctx);
    },
  });

  // ── Session init ──
  const onInit = async (_event: unknown, ctx: ExtensionContext) => {
    const s = ctx.sessionManager.getUsageStatistics();
    state.previousTotal = {
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      orchestrationInput: s.orchestrationInput,
      orchestrationCacheRead: s.orchestrationCacheRead,
      orchestrationOutput: s.orchestrationOutput,
    };
    state.lastContextTokens = null;
    state.turnDelta = null;
    state.balance = null;
    state.chatgpt = { kind: "idle", usedPercent: null, resetsAt: null, fetchedAt: null };
    finishTurn(state.turnCost);

    if (classifyModelMode(ctx.model) === "deepseek") {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";
      daily.ensureSession(sessionId, sessionName, {
        input: s.input,
        cacheRead: s.cacheRead,
        output: s.output,
      });
    }

    await initializeForModel(ctx);
  };

  pi.on("session_start", onInit);
  pi.on("session_branch", onInit);
  pi.on("session_switch", onInit);
  pi.on("session_tree", onInit);

  // ── Agent start — run the same per-model initialization as /model switches ──
  pi.on("agent_start", async (_event, ctx) => {
    await initializeForModel(ctx);
  });

  // ── Provider response — absorb Codex weekly usage headers ──
  pi.on("after_provider_response", async (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    const headerUsage = await parseChatGPTUsageHeaders(event.headers);
    if (headerUsage) {
      state.chatgpt = { ...headerUsage, error: state.chatgpt.error ?? null };
      refresh(state, daily, pi, ctx);
    }
  });

  // ── Provider request — anchor price tier for the request being sent ──
  pi.on("before_provider_request", (_event, ctx) => {
    const now = new Date();
    const isDeepSeek = classifyModelMode(ctx.model) === "deepseek";
    const tier = isDeepSeek ? resolvePriceTier(ctx.model?.id, now) : undefined;
    anchorRequest(state.turnCost, tier, tier ? (isPeakHour(now) ? "peak" : "offPeak") : undefined);
    refresh(state, daily, pi, ctx);
  });

  // ── Message end — charge the completed message against the anchored tier ──
  pi.on("message_end", (event) => {
    const usage = getMessageUsage(event.message);
    if (!usage) return;
    addMessageCost(state.turnCost, usage);
  });

  // ── Agent end — accumulate daily cost + turn delta ──
  pi.on("agent_end", async (_event, ctx) => {
    const stats = ctx.sessionManager.getUsageStatistics();
    const cur = {
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      orchestrationInput: stats.orchestrationInput,
      orchestrationCacheRead: stats.orchestrationCacheRead,
      orchestrationOutput: stats.orchestrationOutput,
    };
    const isDeepSeek = classifyModelMode(ctx.model) === "deepseek";
    const isChatGPT = isOpenAICodexModel(ctx.model);

    // Guard: only track official DeepSeek or ChatGPT/Codex models.
    // Token-only DeepSeek models on other providers (e.g. opencode-go) are excluded.
    if (!isDeepSeek && !isChatGPT) {
      finishTurn(state.turnCost);
      state.previousTotal = cur;
      return;
    }

    // --- ChatGPT/Codex: no daily cost archive, just turn delta + weekly refresh ---
    if (isChatGPT) {
      const delta = {
        input: cur.input - state.previousTotal.input,
        output: cur.output - state.previousTotal.output,
        cacheRead: cur.cacheRead - state.previousTotal.cacheRead,
        cacheWrite: cur.cacheWrite - state.previousTotal.cacheWrite,
        orchestrationInput: cur.orchestrationInput - state.previousTotal.orchestrationInput,
        orchestrationCacheRead: cur.orchestrationCacheRead - state.previousTotal.orchestrationCacheRead,
        orchestrationOutput: cur.orchestrationOutput - state.previousTotal.orchestrationOutput,
      };
      state.turnDelta = (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0 || delta.cacheWrite > 0 ||
        delta.orchestrationInput > 0 || delta.orchestrationCacheRead > 0 || delta.orchestrationOutput > 0)
        ? delta
        : null;
      state.previousTotal = cur;
      finishTurn(state.turnCost);

      await refreshChatGPTUsage(ctx);
      return;
    }

    // --- Daily accumulation ---
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      finishTurn(state.turnCost);
      state.previousTotal = cur;
      return;
    }
    const sessionName = ctx.sessionManager.getSessionName() ?? ctx.cwd ?? "";
    const turnCost = finishTurn(state.turnCost);

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
      const hasTokenDelta = deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0;

      if (hasTokenDelta || turnCost > 0) {
        dailyData.totalCost += turnCost;
        if (hasTokenDelta) {
          dailyData.totalTokens.input += deltaInput;
          dailyData.totalTokens.cacheRead += deltaCacheRead;
          dailyData.totalTokens.output += deltaOutput;

          sess.lastInput = stats.input;
          sess.lastCacheRead = stats.cacheRead;
          sess.lastOutput = stats.output;
        }
        sess.cost += turnCost;

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
      cacheWrite: cur.cacheWrite - state.previousTotal.cacheWrite,
      orchestrationInput: cur.orchestrationInput - state.previousTotal.orchestrationInput,
      orchestrationCacheRead: cur.orchestrationCacheRead - state.previousTotal.orchestrationCacheRead,
      orchestrationOutput: cur.orchestrationOutput - state.previousTotal.orchestrationOutput,
    };

    state.turnDelta = (delta.input > 0 || delta.output > 0 || delta.cacheRead > 0 || delta.cacheWrite > 0 ||
      delta.orchestrationInput > 0 || delta.orchestrationCacheRead > 0 || delta.orchestrationOutput > 0)
      ? delta
      : null;
    state.previousTotal = cur;
    state.balance = await fetchBalance(ctx);
    setCacheEntry(balanceCache.deepSeek, state.balance);
    refresh(state, daily, pi, ctx);
  });
}
