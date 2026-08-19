/**
 * Regression tests: two CLI processes (each with its own DailyTracker instance)
 * running DeepSeek at the same time must both keep their accrued costs in the
 * shared daily archive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDailyTracker } from "../../extensions/model-cost/daily-tracker";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-concurrent-daily-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tempHome, ".omp"), { recursive: true, force: true });
});

describe("concurrent DeepSeek CLI cost accumulation", () => {
  test("two tracker instances do not clobber each other's accrued cost", async () => {
    // Two CLI processes each own a tracker over the same ~/.omp archive file.
    const cliA = createDailyTracker();
    const cliB = createDailyTracker();

    // CLI A finishes a turn first.
    await cliA.recordTurnCost("session-a", "cli A", { input: 100, cacheRead: 0, output: 50 }, 0.5);

    // CLI B starts later, sees A's session on disk, and records its own turn.
    await cliB.recordTurnCost("session-b", "cli B", { input: 200, cacheRead: 0, output: 80 }, 0.7);

    // CLI A finishes a second turn afterwards.
    await cliA.recordTurnCost("session-a", "cli A", { input: 120, cacheRead: 0, output: 60 }, 0.5);

    // A third process re-reads the archive: both CLIs' accrued fees must survive.
    const onDisk = createDailyTracker().read();
    expect(onDisk.totalCost).toBe(1.7);
    expect(onDisk.sessions).toHaveLength(2);
    const aOnDisk = onDisk.sessions.find(s => s.id === "session-a");
    const bOnDisk = onDisk.sessions.find(s => s.id === "session-b");
    expect(aOnDisk?.cost).toBe(1.0);
    expect(bOnDisk?.cost).toBe(0.7);
    expect(aOnDisk?.lastInput).toBe(120);
    expect(aOnDisk?.lastOutput).toBe(60);
    expect(bOnDisk?.lastInput).toBe(200);
    expect(bOnDisk?.lastOutput).toBe(80);
    // The first turn for each session establishes the baseline; only the
    // second turn of session-a (120 - 100 input, 60 - 50 output) is a delta.
    expect(onDisk.totalTokens).toEqual({ input: 20, cacheRead: 0, output: 10 });
  });

  test("read reflects another tracker's write without an explicit reload", async () => {
    const cliA = createDailyTracker();
    const cliB = createDailyTracker();

    // CLI B rendered its widget while the archive was still empty.
    expect(cliB.read().totalCost).toBe(0);

    // CLI A then records a turn.
    await cliA.recordTurnCost("session-a", "cli A", { input: 100, cacheRead: 0, output: 50 }, 0.5);

    // CLI B's widget must pick up the shared accrued cost.
    const seenByB = cliB.read();
    expect(seenByB.totalCost).toBe(0.5);
    expect(seenByB.sessions).toHaveLength(1);
    expect(seenByB.sessions[0].cost).toBe(0.5);
  });

  test("no lock or temp files are left behind after concurrent updates", async () => {
    const cliA = createDailyTracker();
    const cliB = createDailyTracker();
    await cliA.recordTurnCost("session-a", "cli A", { input: 1, cacheRead: 0, output: 1 }, 0.1);
    await cliB.recordTurnCost("session-b", "cli B", { input: 1, cacheRead: 0, output: 1 }, 0.1);

    const archiveDir = path.join(tempHome, ".omp", "cost-archive");
    const entries = fs.readdirSync(archiveDir);
    expect(entries.filter((name: string) => name.endsWith(".lock"))).toEqual([]);
    expect(entries.filter((name: string) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("deepseek-cost.json");
  });
});
