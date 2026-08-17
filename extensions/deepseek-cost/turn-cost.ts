/**
 * Per-turn cost accumulation for API requests.
 *
 * The extension anchors a price tier when a provider request is about to be
 * sent, then charges each completed message's usage against that tier. This
 * module keeps that per-turn state pure and testable.
 */

import { rmbCost, type PriceTier } from "./cost-calc";

export type PricePeriod = "peak" | "offPeak";

export interface TurnCostState {
  activeTier: PriceTier | null;
  activePeriod: PricePeriod | null;
  turnCost: number;
}

export function createTurnCostState(): TurnCostState {
  return { activeTier: null, activePeriod: null, turnCost: 0 };
}

/** Anchor the tier for the next provider request. `undefined` clears it. */
export function anchorRequest(
  state: TurnCostState,
  tier: PriceTier | undefined,
  period: PricePeriod | undefined,
): void {
  state.activeTier = tier ?? null;
  state.activePeriod = period ?? null;
}

/** Charge one completed message's usage against the active tier. */
export function addMessageCost(
  state: TurnCostState,
  usage: { input: number; cacheRead: number; output: number },
): number {
  if (!state.activeTier) return 0;
  const cost = rmbCost(usage.input, usage.cacheRead, usage.output, state.activeTier);
  state.turnCost += cost;
  return cost;
}

/** Return the turn's total cost and reset the accumulator for the next turn. */
export function finishTurn(state: TurnCostState): number {
  const cost = state.turnCost;
  state.turnCost = 0;
  state.activeTier = null;
  state.activePeriod = null;
  return cost;
}
