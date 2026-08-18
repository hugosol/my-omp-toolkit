import { describe, expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  createBalanceCache,
  isCacheFresh,
  setCacheEntry,
} from "../../extensions/deepseek-cost/balance-cache";

describe("isCacheFresh", () => {
  test("is false when never fetched", () => {
    expect(isCacheFresh({ value: null, fetchedAt: null }, 1_000)).toBe(false);
  });

  test("is true when age is less than TTL", () => {
    const now = 100_000;
    expect(isCacheFresh({ value: 1, fetchedAt: now - 10_000 }, now)).toBe(true);
  });

  test("is false when age equals or exceeds TTL", () => {
    const now = 100_000;
    expect(isCacheFresh({ value: 1, fetchedAt: now - CACHE_TTL_MS }, now)).toBe(false);
    expect(isCacheFresh({ value: 1, fetchedAt: now - CACHE_TTL_MS - 1 }, now)).toBe(false);
  });
});

describe("createBalanceCache", () => {
  test("starts with null deepSeek and codex entries", () => {
    const cache = createBalanceCache();
    expect(cache.deepSeek).toEqual({ value: null, fetchedAt: null });
    expect(cache.codex).toEqual({ value: null, fetchedAt: null });
  });
});

describe("setCacheEntry", () => {
  test("stores value and fetchedAt", () => {
    const entry = { value: null, fetchedAt: null };
    setCacheEntry(entry, 42, 123);
    expect(entry).toEqual({ value: 42, fetchedAt: 123 });
  });
});
