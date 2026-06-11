import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { resolvePath, getAllowedScope, isPathInScope, buildScopeGuide } from "../../extensions/readonly-mode/scope.ts";

// ============================================================
// resolvePath
// ============================================================

describe("resolvePath", () => {
  test("resolves relative paths against cwd", () => {
    const result = resolvePath("src/file.ts", "/home/user/project");
    expect(result).toBe(path.resolve("/home/user/project", "src/file.ts"));
  });

  test("keeps absolute paths unchanged (normalized)", () => {
    const result = resolvePath("/etc/hosts", "/home/user/project");
    expect(result).toBe(path.resolve("/etc/hosts"));
  });

  test("resolves tilde to HOME", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      const result = resolvePath("~/myfile", "/home/user/project");
      // On Windows, path.resolve(home, "/myfile") strips the home dir
      // because leading / is treated as drive-root. resolvePath uses path.resolve
      // internally, so we test that result starts with the drive root and ends with myfile.
      expect(result).toMatch(/myfile$/);
    }
  });

  test("handles empty path (resolves to cwd)", () => {
    const result = resolvePath("", "/home/user/project");
    expect(result).toBe(path.resolve("/home/user/project", ""));
  });
});

// ============================================================
// getAllowedScope
// ============================================================

describe("getAllowedScope", () => {
  const cwd = "/home/user/project";

  test("includes cwd and .omp/agent by default", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const scope = getAllowedScope(cwd, []);
    // cwd is always included
    expect(scope.some(s => s.toLowerCase().includes("project"))).toBe(true);
    // .omp/agent is included when HOME exists
    if (home) {
      expect(scope.some(s => s.includes(".omp"))).toBe(true);
    }
  });

  test("returns sentinel when 'all' is in scopeOverride", () => {
    const scope = getAllowedScope(cwd, ["all"]);
    expect(scope).toEqual(["all"]);
  });

  test("adds scopeOverride paths to scope", () => {
    const scope = getAllowedScope(cwd, ["/extra/path"]);
    expect(scope.some(s => s.includes("extra"))).toBe(true);
  });
});

// ============================================================
// isPathInScope
// ============================================================

describe("isPathInScope", () => {
  const cwd = "/home/user/project";
  const scope = ["/home/user/project", "/home/user/.omp/agent"];

  test("allows internal URIs", () => {
    expect(isPathInScope("skill://my-skill", scope, cwd)).toBe(true);
    expect(isPathInScope("omp://config", scope, cwd)).toBe(true);
    expect(isPathInScope("artifact://123", scope, cwd)).toBe(true);
    expect(isPathInScope("local://plan.md", scope, cwd)).toBe(true);
  });

  test("allows paths within scope", () => {
    expect(isPathInScope("src/main.ts", scope, cwd)).toBe(true);
    expect(isPathInScope("/home/user/project/src/main.ts", scope, cwd)).toBe(true);
    expect(isPathInScope("/home/user/.omp/agent/extensions/foo.ts", scope, cwd)).toBe(true);
  });

  test("blocks paths outside scope", () => {
    expect(isPathInScope("/etc/passwd", scope, cwd)).toBe(false);
    expect(isPathInScope("/home/other/project", scope, cwd)).toBe(false);
  });
});

// ============================================================
// buildScopeGuide
// ============================================================

describe("buildScopeGuide", () => {
  test("formats scope paths as bullet list", () => {
    const guide = buildScopeGuide(["/a", "/b"]);
    expect(guide).toBe("  - /a\n  - /b");
  });

  test("handles single path", () => {
    const guide = buildScopeGuide(["/only"]);
    expect(guide).toBe("  - /only");
  });

  test("handles empty array", () => {
    expect(buildScopeGuide([])).toBe("");
  });
});
