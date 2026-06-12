import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDailyTracker, type DailyTracker, type DailyData } from "../../extensions/deepseek-cost/daily-tracker";

// We override HOME to point at a temp directory so tests don't touch real data.
const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-daily-test-"));
  // os.homedir() reads from env on many platforms; set HOME and USERPROFILE
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalHome;
  // Clean up temp directory
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** Clean the archive directory between tests to ensure isolation. */
function cleanArchive(): void {
  const archiveDir = path.join(tempHome, ".omp", "cost-archive");
  if (fs.existsSync(archiveDir)) {
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanArchive();
});

function freshTracker(): DailyTracker {
  return createDailyTracker();
}

// ============================================================
// read / write
// ============================================================

describe("DailyTracker read / write", () => {
  test("read on fresh tracker returns default empty data", () => {
    const t = freshTracker();
    const data = t.read();
    expect(data.totalCost).toBe(0);
    expect(data.totalTokens).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(data.sessions).toEqual([]);
    expect(data.start).toBeTruthy();
  });

  test("write then read roundtrips", () => {
    const t = freshTracker();
    const data: DailyData = {
      start: "2024-01-01T00:00:00.000Z",
      totalCost: 12.5,
      totalTokens: { input: 1000, cacheRead: 500, output: 200 },
      sessions: [
        {
          id: "s1",
          name: "test session",
          lastInput: 1000,
          lastCacheRead: 500,
          lastOutput: 200,
          cost: 12.5,
        },
      ],
    };
    t.write(data);

    const read = t.read();
    expect(read.totalCost).toBe(12.5);
    expect(read.totalTokens.input).toBe(1000);
    expect(read.sessions).toHaveLength(1);
    expect(read.sessions[0].id).toBe("s1");
  });

  test("read normalizes missing fields from old files", () => {
    const t = freshTracker();
    // Write a partial record simulating an old file version
    t.write({ start: "2024-01-01T00:00:00.000Z", totalCost: 5 } as DailyData);

    // Create a new tracker (cache cleared) to force disk re-read
    const t2 = createDailyTracker();
    const read = t2.read();
    expect(read.totalTokens).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(read.sessions).toEqual([]);
  });
});

// ============================================================
// ensureSession
// ============================================================

describe("DailyTracker ensureSession", () => {
  test("creates a new session on first call", () => {
    const t = freshTracker();
    const data = t.ensureSession("s1", "my session", { input: 100, cacheRead: 50, output: 20 });
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].id).toBe("s1");
    expect(data.sessions[0].name).toBe("my session");
    expect(data.sessions[0].lastInput).toBe(100);
    expect(data.sessions[0].cost).toBe(0);
  });

  test("is idempotent — second call does not duplicate", () => {
    const t = freshTracker();
    t.ensureSession("s1", "my session", { input: 100, cacheRead: 50, output: 20 });
    t.ensureSession("s1", "my session", { input: 200, cacheRead: 60, output: 30 });
    const data = t.read();
    expect(data.sessions).toHaveLength(1);
    // lastKnown values are NOT updated on subsequent ensureSession calls
    // (that's the caller's job via write)
    expect(data.sessions[0].lastInput).toBe(100);
  });

  test("tracks multiple sessions independently", () => {
    const t = freshTracker();
    t.ensureSession("s1", "session one", { input: 100, cacheRead: 0, output: 0 });
    t.ensureSession("s2", "session two", { input: 200, cacheRead: 0, output: 0 });
    const data = t.read();
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions.map(s => s.id).sort()).toEqual(["s1", "s2"]);
  });
});

// ============================================================
// archive
// ============================================================

describe("DailyTracker archive", () => {
  test("returns null when no data to archive", () => {
    const t = freshTracker();
    expect(t.archive(null)).toBeNull();
  });

  test("archives current data and resets to fresh", () => {
    const t = freshTracker();
    t.write({
      start: "2024-01-01T00:00:00.000Z",
      totalCost: 50,
      totalTokens: { input: 1000, cacheRead: 500, output: 200 },
      sessions: [
        { id: "s1", name: "test", lastInput: 1000, lastCacheRead: 500, lastOutput: 200, cost: 50 },
      ],
    });

    const archivePath = t.archive(123.45);
    expect(archivePath).not.toBeNull();
    expect(archivePath!).toContain("deepseek-cost-");

    // Archive file should exist on disk
    expect(fs.existsSync(archivePath!)).toBe(true);

    // Verify archive content
    const archived = JSON.parse(fs.readFileSync(archivePath!, "utf-8")) as DailyData;
    expect(archived.totalCost).toBe(50);
    expect(archived.end_bal).toBe(123.45);

    // Current data should be reset
    const fresh = t.read();
    expect(fresh.totalCost).toBe(0);
    expect(fresh.totalTokens).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(fresh.sessions).toEqual([]);
    expect(fresh.start_bal).toBe(123.45);
  });

  test("archive with null balance omits balance fields", () => {
    const t = freshTracker();
    t.write({
      start: "2024-01-01T00:00:00.000Z",
      totalCost: 1,
      totalTokens: { input: 1, cacheRead: 0, output: 0 },
      sessions: [
        { id: "s1", name: "test", lastInput: 1, lastCacheRead: 0, lastOutput: 0, cost: 1 },
      ],
    });

    const archivePath = t.archive(null);
    const archived = JSON.parse(fs.readFileSync(archivePath!, "utf-8"));
    expect(archived.end_bal).toBeUndefined();

    const fresh = t.read();
    expect(fresh.start_bal).toBeUndefined();
  });
});
