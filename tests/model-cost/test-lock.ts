import { __setFileLockForTest } from "../../extensions/model-cost/file-lock";

let chain: Promise<unknown> = Promise.resolve();

/**
 * Standalone toolkit tests run outside the OMP runtime, where
 * `@oh-my-pi/pi-utils/file-lock` is unavailable. Serialize all "file-locked"
 * sections inside the test process so the tracker's read-merge-write logic is
 * exercised deterministically. The native cross-process lock itself is owned
 * and tested by OMP.
 */
export function installInProcessFileLock(): void {
  __setFileLockForTest(<T>(_filePath: string, fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}
