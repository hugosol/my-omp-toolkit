/**
 * Tracker state — single source of truth for runtime extension state.
 * Each extension session creates one instance via createTrackerState().
 */

export const DEFAULT_BUDGET = 220_000;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TrackerState {
  budget: number;
  previousTotal: TokenCounts;
  lastContextTokens: number | null;
  turnDelta: Omit<TokenCounts, "cacheWrite"> | null;
  /** Raw balance amount in CNY, null when not yet fetched or unavailable. */
  balance: number | null;
  detailMode: boolean;
}

export function createTrackerState(): TrackerState {
  return {
    budget: DEFAULT_BUDGET,
    previousTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastContextTokens: null,
    turnDelta: null,
    balance: null,
    detailMode: false,
  };
}
