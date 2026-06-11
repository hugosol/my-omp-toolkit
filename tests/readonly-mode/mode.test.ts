import { describe, test, expect } from "bun:test";
import {
  MODES,
  ModeState,
  buildScope,
  buildPromptContent,
  resolveToolPolicy,
} from "../../extensions/readonly-mode/mode";
import type { TurnInjection } from "../../extensions/readonly-mode/mode";
import { TOOL_POLICIES, DEBUG_TOOL_POLICIES, DEFAULT_POLICY } from "../../extensions/readonly-mode/policies";

// ============================================================
// MODES table integrity
// ============================================================

describe("MODES table", () => {
  test("every mode has a valid injection kind", () => {
    for (const [name, def] of Object.entries(MODES)) {
      expect(["system_prompt", "message_every_turn", "message_on_transition"]).toContain(def.injection.kind);
    }
  });

  test("every mode has a valid scope kind", () => {
    for (const [name, def] of Object.entries(MODES)) {
      expect(["all", "workspace", "paths"]).toContain(def.scopeKind);
    }
  });

  test("every mode has a valid tool key", () => {
    for (const [name, def] of Object.entries(MODES)) {
      expect(["build", "readonly", "debug"]).toContain(def.toolKey);
    }
  });

  test("all four modes are defined", () => {
    expect(Object.keys(MODES).sort()).toEqual(["build", "chat", "debug", "explore"]);
  });

  test("build mode has no tool restrictions", () => {
    expect(MODES.build.toolKey).toBe("build");
  });

  test("chat and explore share readonly tool key", () => {
    expect(MODES.chat.toolKey).toBe("readonly");
    expect(MODES.explore.toolKey).toBe("readonly");
  });

  test("debug mode has its own tool key", () => {
    expect(MODES.debug.toolKey).toBe("debug");
  });
});

// ============================================================
// buildScope
// ============================================================

describe("buildScope", () => {
  const cwd = "/home/user/project";

  test("'all' kind returns sentinel array", () => {
    expect(buildScope(cwd, "all", [])).toEqual(["all"]);
    expect(buildScope(cwd, "all", ["/other"])).toEqual(["all"]);
  });

  test("'workspace' kind returns only cwd + .omp/agent", () => {
    const scope = buildScope(cwd, "workspace", []);
    expect(scope.length).toBeGreaterThanOrEqual(1);
    // cwd is always included
    expect(scope.some(s => s.includes("project"))).toBe(true);
  });

  test("'paths' kind appends scopePaths", () => {
    const scope = buildScope(cwd, "paths", ["/external/lib"]);
    expect(scope.some(s => s.includes("project"))).toBe(true);
    // OS-independent check: extra path contains its basename components
    expect(scope.some(s => s.includes("lib") && s.includes("external"))).toBe(true);
  });
});

// ============================================================
// resolveToolPolicy
// ============================================================

describe("resolveToolPolicy", () => {
  test("build toolKey returns allow for anything", () => {
    expect(resolveToolPolicy("write", "build").type).toBe("allow");
    expect(resolveToolPolicy("bash", "build").type).toBe("allow");
    expect(resolveToolPolicy("nonexistent", "build").type).toBe("allow");
  });

  test("readonly toolKey blocks write tools", () => {
    expect(resolveToolPolicy("write", "readonly").type).toBe("block");
    expect(resolveToolPolicy("edit", "readonly").type).toBe("block");
  });

  test("readonly toolKey allows read tools", () => {
    expect(resolveToolPolicy("read", "readonly").type).toBe("allow");
    expect(resolveToolPolicy("web_search", "readonly").type).toBe("allow");
  });

  test("readonly toolKey returns check types for conditional tools", () => {
    expect(resolveToolPolicy("bash", "readonly").type).toBe("bash_check");
    expect(resolveToolPolicy("search", "readonly").type).toBe("path_check");
    expect(resolveToolPolicy("lsp", "readonly").type).toBe("lsp_check");
    expect(resolveToolPolicy("browser", "readonly").type).toBe("browser_check");
    expect(resolveToolPolicy("task", "readonly").type).toBe("task_check");
  });

  test("readonly toolKey falls back to DEFAULT_POLICY for unknowns", () => {
    const policy = resolveToolPolicy("nonexistent_tool", "readonly");
    expect(policy.type).toBe("block");
    expect(policy.reason).toBe(DEFAULT_POLICY.reason);
  });

  test("debug toolKey allows write/edit for instrumentation", () => {
    expect(resolveToolPolicy("write", "debug").type).toBe("allow");
    expect(resolveToolPolicy("edit", "debug").type).toBe("allow");
    expect(resolveToolPolicy("eval", "debug").type).toBe("allow");
    expect(resolveToolPolicy("debug", "debug").type).toBe("allow");
  });

  test("debug toolKey uses debug_bash_check for bash", () => {
    expect(resolveToolPolicy("bash", "debug").type).toBe("debug_bash_check");
  });

  test("debug toolKey uses debug_task_check for task", () => {
    expect(resolveToolPolicy("task", "debug").type).toBe("debug_task_check");
  });

  test("debug toolKey allows search/find/ast_grep without scope check", () => {
    expect(resolveToolPolicy("search", "debug").type).toBe("allow");
    expect(resolveToolPolicy("find", "debug").type).toBe("allow");
    expect(resolveToolPolicy("ast_grep", "debug").type).toBe("allow");
  });
});

// ============================================================
// ModeState — beginTurn (core injection logic)
// ============================================================

describe("ModeState.beginTurn", () => {
  const cwd = "/home/user/project";

  test("build mode injects message on first turn (transition)", () => {
    const m = new ModeState();
    m.current = "build";
    const inj = m.beginTurn(cwd);
    expect(inj).not.toBeNull();
    if (!inj) throw new Error("expected injection");
    expect(inj.kind).toBe("message");
    if (inj.kind !== "message") throw new Error("expected message");
    expect(inj.customType).toBe("build-mode-context");
    expect(inj.content).toContain("BUILD MODE");
  });

  test("build mode does not inject on second turn (no transition, reinjectAfter=0)", () => {
    const m = new ModeState();
    m.current = "build";
    m.beginTurn(cwd); // turn 1: injects (transition)
    const injection = m.beginTurn(cwd); // turn 2: never re-injects
    expect(injection).toBeNull();
  });

  test("build mode never re-injects (reinjectAfter=0)", () => {
    const m = new ModeState();
    m.current = "build";
    m.beginTurn(cwd); // turn 1: injects
    for (let i = 0; i < 10; i++) m.beginTurn(cwd);
    const injection = m.beginTurn(cwd);
    expect(injection).toBeNull();
  });

  test("debug mode injects message every turn (message_every_turn)", () => {
    const m = new ModeState();
    m.current = "debug";
    m.scopePaths = ["all"];
    const inj1 = m.beginTurn(cwd);
    const inj2 = m.beginTurn(cwd);
    const inj3 = m.beginTurn(cwd);
    expect(inj1!.kind).toBe("message");
    expect(inj2!.kind).toBe("message");
    expect(inj3!.kind).toBe("message");
    expect(inj1!.content).toContain("DEBUG MODE");
  });

  test("chat mode injects system_prompt every turn", () => {
    const m = new ModeState();
    m.current = "chat";
    const inj1 = m.beginTurn(cwd);
    const inj2 = m.beginTurn(cwd);
    expect(inj1!.kind).toBe("system_prompt");
    expect(inj2!.kind).toBe("system_prompt");
    expect(inj1!.content).toContain("CHAT MODE");
  });

  test("chat mode system_prompt includes allowed search paths", () => {
    const m = new ModeState();
    m.current = "chat";
    const injection = m.beginTurn(cwd);
    expect(injection!.content).toContain("Allowed search paths");
  });

  test("explore mode injects system_prompt with scope description", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["all"];
    const injection = m.beginTurn(cwd);
    expect(injection!.kind).toBe("system_prompt");
    expect(injection!.content).toContain("EXPLORE MODE");
    expect(injection!.content).toContain("all directories");
  });

  test("explore mode with specific paths mentions them", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["/other/project"];
    const injection = m.beginTurn(cwd);
    expect(injection!.content).toContain("/other/project");
  });

  test("mode switch triggers injection even for message_on_transition", () => {
    const m = new ModeState();
    m.beginTurn(cwd); // build turn 1: injects
    m.beginTurn(cwd); // build turn 2: no inject

    // Switch to chat
    m.current = "chat";
    const injection = m.beginTurn(cwd);
    expect(injection).not.toBeNull();
    expect(injection!.content).toContain("CHAT MODE");
  });

  test("scope change triggers injection", () => {
    const m = new ModeState();
    m.current = "explore";
    m.beginTurn(cwd); // explore with no paths, injects

    m.scopePaths = ["/new/path"];
    const injection = m.beginTurn(cwd);
    expect(injection).not.toBeNull();
    expect(injection!.content).toContain("/new/path");
  });

  test("null is returned when no injection needed (build, after transition)", () => {
    const m = new ModeState();
    m.current = "build";
    m.beginTurn(cwd); // turn 1: injects (transition from undefined→build)
    const injection = m.beginTurn(cwd); // turn 2: no transition, reinjectAfter=0 → null
    expect(injection).toBeNull();
  });
});

// ============================================================
// ModeState — label and derived properties
// ============================================================

describe("ModeState label", () => {
  test("build mode → Build", () => {
    const m = new ModeState();
    expect(m.label).toBe("Build");
  });

  test("chat mode → Chat", () => {
    const m = new ModeState();
    m.current = "chat";
    expect(m.label).toBe("Chat");
  });

  test("explore mode with all → Explore: all", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["all"];
    expect(m.label).toBe("Explore: all");
  });

  test("explore mode with paths → Explore: <paths>", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["/a", "/b"];
    expect(m.label).toBe("Explore: /a, /b");
  });

  test("debug mode → Debug", () => {
    const m = new ModeState();
    m.current = "debug";
    m.scopePaths = ["all"];
    expect(m.label).toBe("Debug");
  });
});

// ============================================================
// ModeState — resolveToolPolicy delegation
// ============================================================

describe("ModeState.resolveToolPolicy", () => {
  test("build mode returns allow", () => {
    const m = new ModeState();
    expect(m.resolveToolPolicy("write").type).toBe("allow");
  });

  test("chat mode blocks write", () => {
    const m = new ModeState();
    m.current = "chat";
    expect(m.resolveToolPolicy("write").type).toBe("block");
  });

  test("debug mode allows write", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.resolveToolPolicy("write").type).toBe("allow");
  });

  test("debug mode uses debug_bash_check", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.resolveToolPolicy("bash").type).toBe("debug_bash_check");
  });
});

// ============================================================
// ModeState — getScope
// ============================================================

describe("ModeState.getScope", () => {
  const cwd = "/home/user/project";

  test("build mode returns all sentinel", () => {
    const m = new ModeState();
    const scope = m.getScope(cwd);
    expect(scope).toEqual(["all"]);
  });

  test("chat mode returns workspace scope", () => {
    const m = new ModeState();
    m.current = "chat";
    const scope = m.getScope(cwd);
    expect(scope.some(s => s.includes("project"))).toBe(true);
  });

  test("explore mode returns workspace + extra paths", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["/other/lib"];
    const scope = m.getScope(cwd);
    expect(scope.some(s => s.includes("project"))).toBe(true);
    expect(scope.some(s => s.includes("lib") && s.includes("other"))).toBe(true);
  });

  test("debug mode returns all sentinel", () => {
    const m = new ModeState();
    m.current = "debug";
    const scope = m.getScope(cwd);
    expect(scope).toEqual(["all"]);
  });
});

// ============================================================
// buildPromptContent
// ============================================================

describe("buildPromptContent", () => {
  const cwd = "/home/user/project";

  test("build mode returns BUILD_SYSTEM_PROMPT", () => {
    const content = buildPromptContent("build", [], cwd);
    expect(content).toContain("BUILD MODE");
    expect(content).not.toContain("Allowed search paths");
  });

  test("debug mode returns DEBUG_TRANSITION_PROMPT", () => {
    const content = buildPromptContent("debug", ["all"], cwd);
    expect(content).toContain("DEBUG MODE");
  });

  test("chat mode includes search paths", () => {
    const content = buildPromptContent("chat", [], cwd);
    expect(content).toContain("CHAT MODE");
    expect(content).toContain("Allowed search paths");
  });

  test("explore mode with all shows expanded scope", () => {
    const content = buildPromptContent("explore", ["all"], cwd);
    expect(content).toContain("EXPLORE MODE");
    expect(content).toContain("all directories");
  });
});
