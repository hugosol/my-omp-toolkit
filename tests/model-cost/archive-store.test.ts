import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  archiveDocumentFingerprint,
  archiveDocumentPath,
  publishArchiveDocument,
  readArchiveDocument,
  withArchiveLock,
} from "../../extensions/model-cost/archive-store";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

// HOME/USERPROFILE point at a temp directory so tests never touch the real archive.
const originalHome = os.homedir();
let tempHome: string;

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-archive-store-"));
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

describe("archive document store", () => {
  test("publishes a document that a later read returns", async () => {
    const document = {
      base: { u5: 12.4, u7: 3.1, at: 1_799_900_000_000 },
      ratio: 6.67,
    };

    await withArchiveLock("estimate.json", async () => {
      publishArchiveDocument("estimate.json", document);
    });

    expect(readArchiveDocument("estimate.json")).toEqual(document);
  });

  test("an absent document reads as absent instead of throwing", () => {
    expect(readArchiveDocument("never-written.json")).toBeNull();
    expect(archiveDocumentFingerprint("never-written.json")).toBeNull();
  });

  test("creates the archive directory when it is absent", async () => {
    const documentDir = path.dirname(archiveDocumentPath("fresh.json"));
    expect(fs.existsSync(documentDir)).toBe(false);

    await withArchiveLock("fresh.json", async () => {
      publishArchiveDocument("fresh.json", { ok: true });
    });

    expect(fs.existsSync(documentDir)).toBe(true);
    expect(readArchiveDocument("fresh.json")).toEqual({ ok: true });
  });

  test("a corrupt document throws instead of reading as absent", () => {
    const documentPath = archiveDocumentPath("corrupt.json");
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    fs.writeFileSync(documentPath, '{"ratio": 6.6', "utf-8");

    expect(() => readArchiveDocument("corrupt.json")).toThrow();
  });
});
