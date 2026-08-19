/**
 * Cross-process advisory file lock, backed by OMP's native lock implementation
 * (`@oh-my-pi/pi-utils/file-lock`): Windows named mutexes, Linux abstract Unix
 * sockets, `flock(2)` elsewhere. The extension keeps a lazy dynamic import and
 * a test-only injection seam so the tracker module stays testable outside the
 * OMP runtime.
 */

export interface FileLockOptions {
  retries?: number;
  retryDelayMs?: number;
}

export type WithFileLock = <T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
) => Promise<T>;

let testOverride: WithFileLock | null = null;
let implPromise: Promise<WithFileLock> | null = null;

/** Test-only injection seam (mirrors chatgpt-usage's module-loader seam). */
export function __setFileLockForTest(impl: WithFileLock | null): void {
  testOverride = impl;
  implPromise = null;
}

function loadOmpFileLock(): Promise<WithFileLock> {
  if (!implPromise) {
    implPromise = import("@oh-my-pi/pi-utils/file-lock").then(
      m => m.withFileLock as WithFileLock,
    );
  }
  return implPromise;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  if (testOverride) return testOverride(filePath, fn, options);
  const impl = await loadOmpFileLock();
  return impl(filePath, fn, options);
}
