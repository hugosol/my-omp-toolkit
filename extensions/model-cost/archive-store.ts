/**
 * Cost-archive document store — the single home for how JSON documents in
 * `~/.omp/cost-archive` are resolved, created, read and published.
 *
 * The daily cost archive and every sibling document in that directory share
 * these mechanics:
 *
 * - the archive directory is resolved from the current home directory;
 * - a document is published by writing a uniquely-named temp file and renaming
 *   it over the destination, with bounded retry because `renameSync` over a
 *   live file transiently fails with EPERM on Windows (Bun's reads do not share
 *   delete access);
 * - a read-merge-write runs inside OMP's native-backed cross-process file lock,
 *   so concurrent OMP processes serialize their mutations instead of clobbering
 *   each other;
 * - reads are lock-free: publication is atomic, and only a missing document is
 *   "absent" — a corrupt document throws so a mutation can never overwrite real
 *   data with a fresh default.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFileLock } from "./file-lock";

// ── Location ──

/** The shared cost-archive directory inside the current home directory. */
export function archiveDirectory(): string {
  return path.join(os.homedir(), ".omp", "cost-archive");
}

/** Resolve one document inside the shared cost-archive directory. */
export function archiveDocumentPath(name: string): string {
  return path.join(archiveDirectory(), name);
}

/** Create the archive directory when it does not exist yet. */
export function ensureArchiveDirectory(): void {
  const dir = archiveDirectory();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Reading ──

function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read a document from the archive, lock-free. A missing document reads as
 * absent (`null`); a corrupt or unreadable one throws so a mutation that
 * re-reads under the lock surfaces the error instead of silently resetting the
 * document, while display reads can fall back to their last good snapshot.
 */
export function readArchiveDocument<T = unknown>(name: string): T | null {
  try {
    const raw = fs.readFileSync(archiveDocumentPath(name), "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isEnoentError(err)) return null;
    throw err;
  }
}

/**
 * Cheap change-detection identity of a document, for readers that cache their
 * last parsed copy: `null` when the document is absent, while any other stat
 * error propagates so the caller can tell "gone" from "unreadable".
 */
export function archiveDocumentFingerprint(name: string): string | null {
  try {
    const stat = fs.statSync(archiveDocumentPath(name));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    if (isEnoentError(err)) return null;
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
 * not share delete access). Writers that merge are serialized by the lock, so
 * retrying with a short jittered backoff always finds a reader-free instant.
 */
function renameWithRetry(tmpPath: string, documentPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, documentPath);
      return;
    } catch (err) {
      if (attempt + 1 >= RENAME_MAX_ATTEMPTS) throw err;
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Publish a document atomically: a temp file beside the destination is renamed
 * over it, so a concurrent reader can never observe a half-written document.
 * Callers doing a read-merge-write must hold the document's lock
 * (`withArchiveLock`); a bare publication is already reader-safe.
 */
export function publishArchiveDocument(name: string, data: unknown): void {
  const documentPath = archiveDocumentPath(name);
  ensureArchiveDirectory();
  const tmpPath = `${documentPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameWithRetry(tmpPath, documentPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort temp cleanup; the next write uses a fresh unique name
    }
    throw err;
  }
}

// ── Locking ──

/** Up to 15s of lock waiting (300 × 50ms) — inside OMP's 30s handler budget. */
const LOCK_OPTIONS = { retries: 300, retryDelayMs: 50 };

/**
 * Run `fn` while holding this document's cross-process lock, so a
 * read-merge-write from concurrent OMP processes cannot interleave.
 */
export function withArchiveLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(archiveDocumentPath(name), fn, LOCK_OPTIONS);
}
