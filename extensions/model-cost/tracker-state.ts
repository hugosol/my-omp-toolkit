/**
 * Tracker state — single source of truth for runtime extension state.
 * The extension factory creates one instance for its loaded lifetime.
 */

import { createTurnCostState, type TurnCostState } from "./turn-cost";

export const DEFAULT_DEEPSEEK_BUDGET = 450_000;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  orchestrationInput: number;
  orchestrationCacheRead: number;
  orchestrationOutput: number;
}

/** Per-turn token delta, including Codex orchestration buckets. */
export interface TurnDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  orchestrationInput: number;
  orchestrationCacheRead: number;
  orchestrationOutput: number;
}

/** Distinct ChatGPT/Codex usage widget states. */
export type ChatGPTUsageKind =
  | "idle"
  | "loading"
  | "ok"
  | "missing"
  | "incompatible"
  | "config"
  | "auth"
  | "transport";

/** ChatGPT/Codex usage snapshot for a single quota window (5h or 7d). */
export interface ChatGPTUsageState {
  kind: ChatGPTUsageKind;
  /** Quota used percent from this window, 0–100. */
  usedPercent: number | null;
  /** Absolute reset timestamp in epoch ms, when known. */
  resetsAt: number | null;
  /** Epoch ms when this snapshot was fetched/observed. */
  fetchedAt: number | null;
  /** Which successful source produced the data, when data is present. */
  source?: "api" | "header";
  /** Displayable error/status detail for config, auth, transport, incompatible. */
  error?: string | null;
}

/** Combined ChatGPT/Codex usage for the active OAuth account. */
export interface ChatGPTUsageSnapshot {
  /** Five-hour rolling quota window. */
  fiveHour: ChatGPTUsageState;
  /** Seven-day rolling quota window. */
  weekly: ChatGPTUsageState;
}

export interface TrackerState {
  deepSeekBudget: number;
  previousTotal: TokenCounts;
  lastContextTokens: number | null;
  turnDelta: TurnDelta | null;
  /** Raw balance amount in CNY, null when not yet fetched or unavailable. */
  balance: number | null;
  detailMode: boolean;
  /** Per-turn API request cost accumulator. */
  turnCost: TurnCostState;
  /** ChatGPT/Codex weekly usage for the active OAuth account. */
  chatgpt: ChatGPTUsageState;
  /** ChatGPT/Codex five-hour usage for the active OAuth account. */
  chatgptFiveHour: ChatGPTUsageState;
}

export function createTrackerState(): TrackerState {
  return {
    deepSeekBudget: DEFAULT_DEEPSEEK_BUDGET,
    previousTotal: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      orchestrationInput: 0,
      orchestrationCacheRead: 0,
      orchestrationOutput: 0,
    },
    lastContextTokens: null,
    turnDelta: null,
    balance: null,
    detailMode: false,
    turnCost: createTurnCostState(),
    chatgpt: { kind: "idle", usedPercent: null, resetsAt: null, fetchedAt: null },
    chatgptFiveHour: { kind: "idle", usedPercent: null, resetsAt: null, fetchedAt: null },
  };
}
