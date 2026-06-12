/**
 * Daily cost tracking — persisted to ~/.omp/cost-archive/deepseek-cost.json.
 * Provides a DailyTracker object with read/write/archive/ensureSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  write(data: DailyData): void;
  archive(balance: number | null): string | null;
  ensureSession(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
  ): DailyData;
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

// ── Factory ──

export function createDailyTracker(): DailyTracker {
  let cache: DailyData | null = null;

  function read(): DailyData {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(getDailyPath(), "utf-8");
      const data = JSON.parse(raw) as DailyData;
      // Normalize missing fields from older files
      data.totalTokens ??= { input: 0, cacheRead: 0, output: 0 };
      data.sessions ??= [];
      for (const s of data.sessions) {
        s.lastInput ??= 0;
        s.lastCacheRead ??= 0;
        s.lastOutput ??= 0;
        s.cost ??= 0;
      }
      cache = data;
      return data;
    } catch {
      const data: DailyData = {
        start: new Date().toISOString(),
        totalCost: 0,
        totalTokens: { input: 0, cacheRead: 0, output: 0 },
        sessions: [],
      };
      cache = data;
      return data;
    }
  }

  function write(data: DailyData): void {
    ensureArchiveDir();
    // Write disk first, then update cache — prevents cache-disk divergence on error.
    fs.writeFileSync(getDailyPath(), JSON.stringify(data, null, 2), "utf-8");
    cache = data;
  }

  function archive(balance: number | null): string | null {
    const data = read();
    if (data.totalCost <= 0 && data.sessions.length === 0) return null;

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
    write(fresh);
    return archivePath;
  }

  /** Ensure current session is tracked in daily data (idempotent). */
  function ensureSession(
    sessionId: string,
    sessionName: string,
    stats: { input: number; cacheRead: number; output: number },
  ): DailyData {
    const daily = read();
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
      write(daily);
    }
    return daily;
  }

  return { read, write, archive, ensureSession };
}
