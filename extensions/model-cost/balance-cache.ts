/**
 * In-memory TTL cache for the two external data sources used by the widget:
 * DeepSeek account balance and ChatGPT/Codex weekly usage.
 *
 * The cache is intentionally not persisted; it lives for the extension load.
 */

import type { ChatGPTUsageSnapshot } from "./tracker-state";

export const CACHE_TTL_MS = 30_000;

export interface CacheEntry<T> {
  value: T | null;
  fetchedAt: number | null;
}

export interface BalanceCache {
  deepSeek: CacheEntry<number>;
  codex: CacheEntry<ChatGPTUsageSnapshot>;
}

export function createBalanceCache(): BalanceCache {
  return {
    deepSeek: { value: null, fetchedAt: null },
    codex: { value: null, fetchedAt: null },
  };
}

/** True when the entry was fetched within the TTL window. */
export function isCacheFresh(entry: CacheEntry<unknown>, now: number = Date.now()): boolean {
  return entry.fetchedAt !== null && now - entry.fetchedAt < CACHE_TTL_MS;
}

/** Store a fetched value (or null when unavailable) and its fetch time in an existing cache entry. */
export function setCacheEntry<T>(entry: CacheEntry<T>, value: T | null, now: number = Date.now()): void {
  entry.value = value;
  entry.fetchedAt = now;
}
