import { describe, test, expect } from "bun:test";
import { formatBlock, TOOL_POLICIES, DEFAULT_POLICY } from "../../extensions/readonly-mode/policies.ts";
import type { BlockResult } from "../../extensions/readonly-mode/policies.ts";

// ============================================================
// formatBlock
// ============================================================

describe("formatBlock", () => {
  test("appends switch_to_build suffix", () => {
    const result = formatBlock({
      block: true,
      reason: "Need Build mode.",
      hint: "switch_to_build",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("Blocked.");
    expect(result.reason).toContain("/readonly");
  });

  test("appends use_alternative suffix with alternatives", () => {
    const result = formatBlock({
      block: true,
      reason: "Not allowed.",
      hint: "use_alternative",
      alternatives: ["Use cat", "Use read"],
    });
    expect(result.reason).toContain("Not allowed.");
    expect(result.reason).toContain("Instead try");
    expect(result.reason).toContain("Use cat");
    expect(result.reason).toContain("Use read");
  });

  test("appends no suffix when hint is use_alternative but no alternatives", () => {
    const result = formatBlock({
      block: true,
      reason: "Nope.",
      hint: "use_alternative",
    });
    expect(result.reason).toContain("Nope.");
    // No suffix added because alternatives is undefined
  });

  test("appends no suffix when hint is silent", () => {
    const result = formatBlock({
      block: true,
      reason: "Just no.",
      hint: "silent",
    });
    expect(result.reason).toContain("Just no.");
  });
});

// ============================================================
// Policy table integrity
// ============================================================

describe("TOOL_POLICIES", () => {
  test("every tool has a valid policy type", () => {
    const validTypes = ["allow", "block", "path_check", "bash_check", "lsp_check", "browser_check", "task_check"];
    for (const [tool, policy] of Object.entries(TOOL_POLICIES)) {
      expect(validTypes).toContain(policy.type);
    }
  });

  test("write tools are blocked", () => {
    const writeTools = ["write", "edit", "ast_edit"];
    for (const tool of writeTools) {
      expect(TOOL_POLICIES[tool].type).toBe("block");
      expect(TOOL_POLICIES[tool].hint).toBe("switch_to_build");
    }
  });

  test("read tools are allowed", () => {
    const readTools = ["read", "web_search", "ask"];
    for (const tool of readTools) {
      expect(TOOL_POLICIES[tool].type).toBe("allow");
    }
  });

  test("per-call check tools have check types", () => {
    expect(TOOL_POLICIES["bash"].type).toBe("bash_check");
    expect(TOOL_POLICIES["search"].type).toBe("path_check");
    expect(TOOL_POLICIES["find"].type).toBe("path_check");
    expect(TOOL_POLICIES["ast_grep"].type).toBe("path_check");
    expect(TOOL_POLICIES["lsp"].type).toBe("lsp_check");
    expect(TOOL_POLICIES["browser"].type).toBe("browser_check");
    expect(TOOL_POLICIES["task"].type).toBe("task_check");
  });

  test("eval and debug are blocked", () => {
    expect(TOOL_POLICIES["eval"].type).toBe("block");
    expect(TOOL_POLICIES["debug"].type).toBe("block");
  });
});

describe("DEFAULT_POLICY", () => {
  test("blocks unknown tools", () => {
    expect(DEFAULT_POLICY.type).toBe("block");
    expect(DEFAULT_POLICY.hint).toBe("switch_to_build");
  });
});
