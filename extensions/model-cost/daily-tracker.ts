/**
 * Daily cost tracking — persisted as `deepseek-cost.json` in the shared cost
 * archive (`~/.omp/cost-archive`, see archive-store.ts, which owns directory
 * resolution, locking and atomic publication).
 * Provides a DailyTracker object with read/write/archive/ensureSession plus an
 * atomic recordTurnCost used by the DeepSeek accumulation path.
 *
 * Concurrency contract: several OMP processes (or several sessions in one
 * process) can each own a DailyTracker over the same archive file. Mutations
 * re-read the file inside OMP's native-backed cross-process file lock, merge
 * the change, and publish it atomically so concurrent readers never observe a
 * torn JSON file. Reads are lock-free but fingerprint-cached, so the widget
 * keeps showing other processes' accrued cost.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  archiveDirectory,
  archiveDocumentFingerprint,
  ensureArchiveDirectory,
  publishArchiveDocument,
  readArchiveDocument,
  withArchiveLock,
} from "./archive-store";

export interface DailySession {
  id: string;
  name: string;
  lastInput: number;
  lastCacheRead: number;
  lastOutput: number;
  cost: number;
}

export interface DailyData {
  start: string;
  totalCost: number;
  totalTokens: { input: number; cacheRead: number; output: number };
  sessions: DailySession[];
  start_bal?: number;
  end_bal?: number;
}

export interface DailyTracker {
  read(): DailyData;
  write(data: DailyData): Promise<void>;
  archive(balance: number | null): Promise<string | null>;
  ensureSession(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
  ): Promise<DailyData>;
  /** Atomically merge one finished turn into the shared archive. */
  recordTurnCost(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
    turnCost: number,
  ): Promise<DailyData>;
}

// ── Document ──

/** The daily archive document inside the shared cost-archive directory. */
const DAILY_DOCUMENT = "deepseek-cost.json";

// ── Data helpers ──

function defaultDailyData(): DailyData {
  return {
    start: new Date().toISOString(),
    totalCost: 0,
    totalTokens: { input: 0, cacheRead: 0, output: 0 },
    sessions: [],
  };
}

function normalizeDailyData(data: DailyData): DailyData {
  // Normalize missing fields from older files
  data.totalTokens ??= { input: 0, cacheRead: 0, output: 0 };
  data.sessions ??= [];
  for (const s of data.sessions) {
    s.lastInput ??= 0;
    s.lastCacheRead ??= 0;
    s.lastOutput ??= 0;
    s.cost ??= 0;
  }
  return data;
}

/**
 * Read the archive from the shared store. Only a missing file is treated as
 * "empty". A corrupt file throws so mutations never overwrite real data with a
 * fresh default; display reads fall back to the last good snapshot instead.
 */
function readFromDisk(): DailyData {
  const data = readArchiveDocument<DailyData>(DAILY_DOCUMENT);
  return data === null ? defaultDailyData() : normalizeDailyData(data);
}

// ── Factory ──

export function createDailyTracker(): DailyTracker {
  /** Last successfully parsed archive, shared with display reads. */
  let cache: DailyData | null = null;
  /** Document fingerprint the cache was loaded from. */
  let cacheKey: string | null = null;

  /**
   * Publish through the shared store — temp file plus atomic rename, so a
   * concurrent reader can never observe a half-written JSON document — then
   * refresh the local cache. The caller holds the archive lock.
   */
  function publish(data: DailyData): void {
    publishArchiveDocument(DAILY_DOCUMENT, data);
    cache = data;
    cacheKey = archiveDocumentFingerprint(DAILY_DOCUMENT);
  }

  function read(): DailyData {
    let key: string | null;
    try {
      key = archiveDocumentFingerprint(DAILY_DOCUMENT);
    } catch {
      // Unreadable archive: keep serving the last good snapshot for display.
      return cache ?? defaultDailyData();
    }
    if (cache && cacheKey === key) return cache;
    try {
      const data = readFromDisk();
      cache = data;
      cacheKey = key;
      return data;
    } catch {
      // Corrupt or unreadable archive: keep serving the last good snapshot for
      // display. Mutations re-read under the lock and will surface the error
      // instead of silently resetting the archive.
      return cache ?? defaultDailyData();
    }
  }

  function write(data: DailyData): Promise<void> {
    return withArchiveLock(DAILY_DOCUMENT, async () => {
      publish(data);
    });
  }

  function archive(balance: number | null): Promise<string | null> {
    return withArchiveLock(DAILY_DOCUMENT, async () => {
      let data: DailyData;
      try {
        data = readFromDisk();
      } catch {
        // Never archive a corrupt file by treating it as empty and overwriting
        // it; report "nothing to archive" and leave the data untouched.
        return null;
      }
      if (data.totalCost <= 0 && data.sessions.length === 0) {
        cache = data;
        return null;
      }

      const end = new Date().toISOString();
      const startSafe = data.start.replace(/[:.]/g, "-");
      const endSafe = end.replace(/[:.]/g, "-");
      const archivePath = path.join(
        archiveDirectory(),
        `deepseek-cost-${startSafe}-${endSafe}.json`,
      );

      ensureArchiveDirectory();
      const archived = { ...data, end, ...(balance !== null ? { end_bal: balance } : {}) };
      fs.writeFileSync(archivePath, JSON.stringify(archived, null, 2), "utf-8");

      // Start fresh
      const fresh: DailyData = {
        start: end,
        totalCost: 0,
        totalTokens: { input: 0, cacheRead: 0, output: 0 },
        sessions: [],
        ...(balance !== null ? { start_bal: balance } : {}),
      };
      publish(fresh);
      return archivePath;
    });
  }

  /** Ensure current session is tracked in daily data (idempotent, lock-safe). */
  function ensureSession(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
  ): Promise<DailyData> {
    return withArchiveLock(DAILY_DOCUMENT, async () => {
      const daily = readFromDisk();
      let s = daily.sessions.find(e => e.id === sessionId);
      if (!s) {
        s = {
          id: sessionId,
          name: sessionName,
          lastInput: stats.input,
          lastCacheRead: stats.cacheRead,
          lastOutput: stats.output,
          cost: 0,
        };
        daily.sessions.push(s);
      }
      publish(daily);
      return daily;
    });
  }

  /**
   * Merge a finished turn into the archive: token deltas are measured against
   * the session's own last-known values, so concurrent CLIs only ever advance
   * their own rows and the shared total — never clobber another process's.
   */
  function recordTurnCost(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
    turnCost: number,
  ): Promise<DailyData> {
    return withArchiveLock(DAILY_DOCUMENT, async () => {
      const daily = readFromDisk();
      let s = daily.sessions.find(e => e.id === sessionId);
      if (!s) {
        s = {
          id: sessionId,
          name: sessionName,
          lastInput: stats.input,
          lastCacheRead: stats.cacheRead,
          lastOutput: stats.output,
          cost: 0,
        };
        daily.sessions.push(s);
      }
      const deltaInput = Math.max(0, stats.input - s.lastInput);
      const deltaCacheRead = Math.max(0, stats.cacheRead - s.lastCacheRead);
      const deltaOutput = Math.max(0, stats.output - s.lastOutput);
      const hasTokenDelta = deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0;

      if (hasTokenDelta || turnCost > 0) {
        daily.totalCost += turnCost;
        if (hasTokenDelta) {
          daily.totalTokens.input += deltaInput;
          daily.totalTokens.cacheRead += deltaCacheRead;
          daily.totalTokens.output += deltaOutput;

          s.lastInput = stats.input;
          s.lastCacheRead = stats.cacheRead;
          s.lastOutput = stats.output;
        }
        s.cost += turnCost;
      }
      publish(daily);
      return daily;
    });
  }

  return { read, write, archive, ensureSession, recordTurnCost };
}
