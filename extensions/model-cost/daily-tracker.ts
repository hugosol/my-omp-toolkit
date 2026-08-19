/**
 * Daily cost tracking — persisted to ~/.omp/cost-archive/deepseek-cost.json.
 * Provides a DailyTracker object with read/write/archive/ensureSession plus an
 * atomic recordTurnCost used by the DeepSeek accumulation path.
 *
 * Concurrency contract: several OMP processes (or several sessions in one
 * process) can each own a DailyTracker over the same archive file. Mutations
 * re-read the file inside OMP's native-backed cross-process file lock, merge
 * the change, and publish it with a write-temp-then-rename so concurrent
 * readers never observe a torn JSON file. Reads are lock-free but stat-cached,
 * so the widget keeps showing other processes' accrued cost.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFileLock } from "./file-lock";

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

// ── Path helpers ──

function getArchiveDir(): string {
  const home = os.homedir();
  return path.join(home, ".omp", "cost-archive");
}

function getDailyPath(): string {
  return path.join(getArchiveDir(), "deepseek-cost.json");
}

function ensureArchiveDir(): void {
  const dir = getArchiveDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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

function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read the archive from disk. Only a missing file is treated as "empty".
 * A corrupt file throws so mutations never overwrite real data with a fresh
 * default; display reads fall back to the last good snapshot instead.
 */
function readFromDisk(): DailyData {
  try {
    const raw = fs.readFileSync(getDailyPath(), "utf-8");
    return normalizeDailyData(JSON.parse(raw) as DailyData);
  } catch (err) {
    if (isEnoentError(err)) return defaultDailyData();
    throw err;
  }
}

// ── Atomic publication ──

const RENAME_MAX_ATTEMPTS = 50;

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * `renameSync` over a live file can transiently fail with EPERM on Windows
 * while another process has the destination open for reading (Bun's reads do
 * not share delete access). Writers are serialized by the lock, so retrying
 * with a short jittered backoff always finds a reader-free instant.
 */
function renameWithRetry(tmpPath: string, dailyPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, dailyPath);
      return;
    } catch (err) {
      if (attempt + 1 >= RENAME_MAX_ATTEMPTS) throw err;
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
}

// ── Factory ──

/** Up to 15s of lock waiting (300 × 50ms) — inside OMP's 30s handler budget. */
const LOCK_OPTIONS = { retries: 300, retryDelayMs: 50 };

export function createDailyTracker(): DailyTracker {
  /** Last successfully parsed archive, shared with display reads. */
  let cache: DailyData | null = null;
  /** `${size}:${mtimeMs}` fingerprint the cache was loaded from. */
  let cacheKey: string | null = null;

  /**
   * Publish via a temp file + atomic rename so a concurrent reader can never
   * observe a half-written JSON document, then refresh the local cache.
   */
  function writeAtomic(data: DailyData): void {
    const dailyPath = getDailyPath();
    ensureArchiveDir();
    const tmpPath = `${dailyPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameWithRetry(tmpPath, dailyPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort temp cleanup; the next write uses a fresh unique name
      }
      throw err;
    }
    const stat = fs.statSync(dailyPath);
    cache = data;
    cacheKey = `${stat.size}:${stat.mtimeMs}`;
  }

  function read(): DailyData {
    const dailyPath = getDailyPath();
    let key: string | null;
    try {
      const stat = fs.statSync(dailyPath);
      key = `${stat.size}:${stat.mtimeMs}`;
    } catch (err) {
      if (!isEnoentError(err)) return cache ?? defaultDailyData();
      key = null;
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
    return withFileLock(getDailyPath(), async () => {
      writeAtomic(data);
    }, LOCK_OPTIONS);
  }

  function archive(balance: number | null): Promise<string | null> {
    return withFileLock(getDailyPath(), async () => {
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
        getArchiveDir(),
        `deepseek-cost-${startSafe}-${endSafe}.json`,
      );

      ensureArchiveDir();
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
      writeAtomic(fresh);
      return archivePath;
    }, LOCK_OPTIONS);
  }

  /** Ensure current session is tracked in daily data (idempotent, lock-safe). */
  function ensureSession(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
  ): Promise<DailyData> {
    return withFileLock(getDailyPath(), async () => {
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
      writeAtomic(daily);
      return daily;
    }, LOCK_OPTIONS);
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
    return withFileLock(getDailyPath(), async () => {
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
      writeAtomic(daily);
      return daily;
    }, LOCK_OPTIONS);
  }

  return { read, write, archive, ensureSession, recordTurnCost };
}
