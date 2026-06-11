import * as path from "path";

/** Resolve a path to absolute, using cwd as the base for relative paths. */
export function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, p.slice(1));
  }
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(cwd, p);
}

/** Compute the current set of allowed scope directories. */
export function getAllowedScope(cwd: string, scopeOverride: string[]): string[] {
  if (scopeOverride.includes("all")) return ["all"];
  const scope: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    scope.push(path.resolve(homeDir, ".omp", "agent"));
  }
  scope.push(cwd);
  for (const p of scopeOverride) {
    scope.push(resolvePath(p, cwd));
  }
  return scope;
}

/** Check whether a file path lies within the given scope. */
export function isPathInScope(filePath: string, scope: string[], cwd: string): boolean {
  // Internal URIs (skill://, omp://, artifact://, etc.)
  if (filePath.includes("://")) return true;

  const normalized = resolvePath(filePath, cwd).toLowerCase();
  return scope.some((prefix) => {
    const normPrefix = resolvePath(prefix, cwd).toLowerCase();
    return normalized === normPrefix || normalized.startsWith(normPrefix + path.sep);
  });
}

/** Build a human-readable list of allowed scope paths. */
export function buildScopeGuide(scope: string[]): string {
  return scope.map((p) => `  - ${p}`).join("\n");
}
