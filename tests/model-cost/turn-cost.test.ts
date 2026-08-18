import { describe, test, expect } from "bun:test";
import {
  createTurnCostState,
  anchorRequest,
  addMessageCost,
  finishTurn,
} from "../../extensions/model-cost/turn-cost";

const PRO_PEAK = { input: 9, cacheRead: 0.3, output: 27 };
const FLASH_OFF_PEAK = { input: 1.5, cacheRead: 0.05, output: 4.5 };

describe("createTurnCostState", () => {
  test("starts with no active tier or period and zero cost", () => {
    const state = createTurnCostState();
    expect(state.activeTier).toBeNull();
    expect(state.activePeriod).toBeNull();
    expect(state.turnCost).toBe(0);
  });
});

describe("anchorRequest", () => {
  test("sets the active tier and period", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    expect(state.activeTier).toEqual(PRO_PEAK);
    expect(state.activePeriod).toBe("peak");
  });

  test("clears active tier and period when model is not tracked", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    anchorRequest(state, undefined, undefined);
    expect(state.activeTier).toBeNull();
    expect(state.activePeriod).toBeNull();
  });
});

describe("addMessageCost", () => {
  test("returns zero and does not accumulate without an active tier", () => {
    const state = createTurnCostState();
    expect(addMessageCost(state, { input: 1_000_000, cacheRead: 0, output: 0 })).toBe(0);
    expect(state.turnCost).toBe(0);
  });

  test("accumulates cost using the active tier", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    // 1M input at pro peak = ¥9
    expect(addMessageCost(state, { input: 1_000_000, cacheRead: 0, output: 0 })).toBe(9);
    expect(state.turnCost).toBe(9);
  });

  test("accumulates multiple messages in the same turn", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    addMessageCost(state, { input: 500_000, cacheRead: 0, output: 0 }); // 4.5
    addMessageCost(state, { input: 0, cacheRead: 0, output: 100_000 }); // 2.7
    expect(state.turnCost).toBeCloseTo(7.2, 6);
  });

  test("uses the latest anchored tier for each message", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    addMessageCost(state, { input: 1_000_000, cacheRead: 0, output: 0 }); // 9
    anchorRequest(state, FLASH_OFF_PEAK, "offPeak");
    addMessageCost(state, { input: 0, cacheRead: 0, output: 1_000_000 }); // 4.5
    expect(state.turnCost).toBeCloseTo(13.5, 6);
  });
});

describe("finishTurn", () => {
  test("returns accumulated cost and resets state", () => {
    const state = createTurnCostState();
    anchorRequest(state, PRO_PEAK, "peak");
    addMessageCost(state, { input: 1_000_000, cacheRead: 0, output: 0 });
    const cost = finishTurn(state);
    expect(cost).toBe(9);
    expect(state.turnCost).toBe(0);
    expect(state.activeTier).toBeNull();
    expect(state.activePeriod).toBeNull();
  });

  test("returns zero for an empty turn", () => {
    const state = createTurnCostState();
    expect(finishTurn(state)).toBe(0);
    expect(state.activeTier).toBeNull();
    expect(state.activePeriod).toBeNull();
  });
});
