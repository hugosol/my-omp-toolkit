import { describe, test, expect } from "bun:test";
import {
  MODES,
  ModeState,
  buildScope,
  buildPrompt,
  resolveToolPolicy,
  dispatchToolCall,
} from "../../extensions/readonly-mode/mode";
import type { BuildInjectionResult, DispatchResult } from "../../extensions/readonly-mode/mode";
import { DEFAULT_POLICY } from "../../extensions/readonly-mode/policies";

// ============================================================
// MODES table integrity
// ============================================================

describe("MODES table", () => {
  test("every mode has valid injection config", () => {
    for (const [name, def] of Object.entries(MODES)) {
      const cfg = def.injection;
      // At least one injection slot must be configured
      expect(cfg.systemPrompt || cfg.everyTurnMessage || cfg.transitionMessage).toBeTruthy();
      // transitionMessage.reinjectAfter defaults to 0 when absent
      if (cfg.transitionMessage) {
        expect(typeof cfg.transitionMessage.reinjectAfter).toBe("number");
      }
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

  test("all three modes are defined", () => {
    expect(Object.keys(MODES).sort()).toEqual(["build", "debug", "explore"]);
  });

  test("build mode has no tool restrictions", () => {
    expect(MODES.build.toolKey).toBe("build");
  });

  test("explore mode uses readonly tool key", () => {
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
    expect(scope.some(s => s.includes("project"))).toBe(true);
  });

  test("'paths' kind appends scopePaths", () => {
    const scope = buildScope(cwd, "paths", ["/external/lib"]);
    expect(scope.some(s => s.includes("project"))).toBe(true);
    expect(scope.some(s => s.includes("lib") && s.includes("external"))).toBe(true);
  });

  test("'paths' kind with 'all' in scopePaths returns sentinel", () => {
    expect(buildScope(cwd, "paths", ["all"])).toEqual(["all"]);
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
    expect(resolveToolPolicy("bash", "readonly").type).toBe("check");
    expect(resolveToolPolicy("search", "readonly").type).toBe("check");
    expect(resolveToolPolicy("lsp", "readonly").type).toBe("check");
    expect(resolveToolPolicy("browser", "readonly").type).toBe("check");
    expect(resolveToolPolicy("task", "readonly").type).toBe("check");
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

  test("debug toolKey uses check for bash", () => {
    expect(resolveToolPolicy("bash", "debug").type).toBe("check");
  });

  test("debug toolKey uses check for task", () => {
    expect(resolveToolPolicy("task", "debug").type).toBe("check");
  });

  test("debug toolKey allows search/find/ast_grep without scope check", () => {
    expect(resolveToolPolicy("search", "debug").type).toBe("allow");
    expect(resolveToolPolicy("find", "debug").type).toBe("allow");
    expect(resolveToolPolicy("ast_grep", "debug").type).toBe("allow");
  });

  test("debug toolKey inherits readonly policies for tools not explicitly overridden", () => {
    expect(resolveToolPolicy("read", "debug").type).toBe("allow");
    expect(resolveToolPolicy("web_search", "debug").type).toBe("allow");
    expect(resolveToolPolicy("ask", "debug").type).toBe("allow");
    expect(resolveToolPolicy("todo", "debug").type).toBe("allow");
    expect(resolveToolPolicy("resolve", "debug").type).toBe("allow");
    expect(resolveToolPolicy("lsp", "debug").type).toBe("check");
  });
});

// ============================================================
// buildPrompt — prompt content per injection slot
// ============================================================

describe("buildPrompt", () => {
  test("build mode returns transitionMessage only", () => {
    const content = buildPrompt("build");
    expect(content.systemPrompt).toBeUndefined();
    expect(content.everyTurnMessage).toBeUndefined();
    expect(content.transitionMessage).toBeDefined();
    expect(content.transitionMessage!).toContain("BUILD MODE");
  });

  test("explore mode returns systemPrompt and transitionMessage", () => {
    const content = buildPrompt("explore");
    expect(content.systemPrompt).toBeDefined();
    expect(content.systemPrompt!).toContain("EXPLORE MODE");
    expect(content.everyTurnMessage).toBeUndefined();
    expect(content.transitionMessage).toBeDefined();
    expect(content.transitionMessage!).toContain("EXPLORE MODE");
    expect(content.transitionMessage!).toContain("switched to Explore");
  });

  test("explore mode systemPrompt does NOT mention scope", () => {
    const content = buildPrompt("explore");
    expect(content.systemPrompt!).not.toContain("scope");
    expect(content.systemPrompt!).not.toContain("workspace");
    expect(content.systemPrompt!).not.toContain("Allowed search paths");
  });

  test("debug mode returns everyTurnMessage only", () => {
    const content = buildPrompt("debug");
    expect(content.systemPrompt).toBeUndefined();
    expect(content.everyTurnMessage).toBeDefined();
    expect(content.everyTurnMessage!).toContain("DEBUG MODE");
    expect(content.transitionMessage).toBeUndefined();
  });
});

// ============================================================
// ModeState — buildInjection (core injection logic)
// ============================================================

describe("ModeState.buildInjection", () => {
  test("build mode injects transition message on first turn", () => {
    const m = new ModeState();
    m.current = "build";
    const inj = m.buildInjection();
    expect(inj).not.toBeNull();
    if (!inj) throw new Error("expected injection");
    expect(inj.systemPrompt).toBeUndefined();
    expect(inj.message).toBeDefined();
    expect(inj.message!.customType).toBe("build-mode-context");
    expect(inj.message!.content).toContain("BUILD MODE");
  });

  test("build mode does not inject on second turn (reinjectAfter=0)", () => {
    const m = new ModeState();
    m.current = "build";
    m.buildInjection(); // turn 1: injects (transition)
    const injection = m.buildInjection(); // turn 2: never re-injects
    expect(injection).toBeNull();
  });

  test("build mode never re-injects (reinjectAfter=0)", () => {
    const m = new ModeState();
    m.current = "build";
    m.buildInjection(); // turn 1: injects
    for (let i = 0; i < 10; i++) m.buildInjection();
    const injection = m.buildInjection();
    expect(injection).toBeNull();
  });

  test("debug mode injects message every turn", () => {
    const m = new ModeState();
    m.current = "debug";
    const inj1 = m.buildInjection();
    const inj2 = m.buildInjection();
    const inj3 = m.buildInjection();
    [inj1, inj2, inj3].forEach(inj => {
      expect(inj!.systemPrompt).toBeUndefined();
      expect(inj!.message).toBeDefined();
      expect(inj!.message!.content).toContain("DEBUG MODE");
    });
  });

  test("explore mode injects systemPrompt every turn", () => {
    const m = new ModeState();
    m.current = "explore";
    const inj1 = m.buildInjection();
    const inj2 = m.buildInjection();
    expect(inj1!.systemPrompt).toBeDefined();
    expect(inj1!.systemPrompt!).toContain("EXPLORE MODE");
    expect(inj2!.systemPrompt).toBeDefined();
  });

  test("explore mode injects both systemPrompt and transitionMessage on first turn", () => {
    const m = new ModeState();
    m.current = "explore";
    const inj = m.buildInjection();
    expect(inj!.systemPrompt).toBeDefined();
    expect(inj!.message).toBeDefined();
    expect(inj!.message!.content).toContain("switched to Explore");
  });

  test("explore mode injects only systemPrompt on second turn (no re-transition)", () => {
    const m = new ModeState();
    m.current = "explore";
    m.buildInjection(); // turn 1: systemPrompt + transition
    const inj = m.buildInjection(); // turn 2: systemPrompt only
    expect(inj!.systemPrompt).toBeDefined();
    expect(inj!.message).toBeUndefined();
  });

  test("mode switch from build to explore triggers transition", () => {
    const m = new ModeState();
    m.buildInjection(); // build turn 1: transition
    m.buildInjection(); // build turn 2: no inject

    m.current = "explore";
    const injection = m.buildInjection();
    expect(injection).not.toBeNull();
    expect(injection!.systemPrompt).toContain("EXPLORE MODE");
    expect(injection!.message).toBeDefined();
    expect(injection!.message!.content).toContain("switched to Explore");
  });

  test("null is returned when no injection needed (build, after transition)", () => {
    const m = new ModeState();
    m.current = "build";
    m.buildInjection(); // turn 1: injects (transition)
    const injection = m.buildInjection(); // turn 2: no transition, reinjectAfter=0 → null
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

  test("explore mode → Explore", () => {
    const m = new ModeState();
    m.current = "explore";
    expect(m.label).toBe("Explore");
  });

  test("debug mode → Debug", () => {
    const m = new ModeState();
    m.current = "debug";
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

  test("explore mode blocks write", () => {
    const m = new ModeState();
    m.current = "explore";
    expect(m.resolveToolPolicy("write").type).toBe("block");
  });

  test("debug mode allows write", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.resolveToolPolicy("write").type).toBe("allow");
  });

  test("debug mode uses check for bash", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.resolveToolPolicy("bash").type).toBe("check");
  });
});

// ============================================================
// ModeState — getScope (all modes return ["all"] since scopeKind is all)
// ============================================================

describe("ModeState.getScope", () => {
  const cwd = "/home/user/project";

  test("build mode returns all sentinel", () => {
    const m = new ModeState();
    expect(m.getScope(cwd)).toEqual(["all"]);
  });

  test("explore mode returns all sentinel", () => {
    const m = new ModeState();
    m.current = "explore";
    expect(m.getScope(cwd)).toEqual(["all"]);
  });

  test("debug mode returns all sentinel", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.getScope(cwd)).toEqual(["all"]);
  });
});

// ============================================================
// dispatchToolCall — integration of policy lookup + guard + format
// ============================================================

describe("dispatchToolCall", () => {
  const cwd = "/home/user/project";

  function mode(name: "build" | "explore" | "debug"): ModeState {
    const m = new ModeState();
    m.current = name;
    return m;
  }

  // ── Build mode: no interception ──

  test("build mode returns no block", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("build"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("build mode allows bash rm (everything is allowed)", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("build"), cwd);
    expect(result.block).toBeUndefined();
  });

  // ── Explore mode: block-level tools ──

  test("explore mode blocks write", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });

  test("explore mode blocks edit", () => {
    const result = dispatchToolCall({ toolName: "edit", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });

  test("explore mode blocks ast_edit", () => {
    const result = dispatchToolCall({ toolName: "ast_edit", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });

  test("explore mode blocks eval", () => {
    const result = dispatchToolCall({ toolName: "eval", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("arbitrary code");
  });

  test("explore mode blocks debug", () => {
    const result = dispatchToolCall({ toolName: "debug", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modify program state");
  });

  test("explore mode blocks unknown tool via DEFAULT_POLICY", () => {
    const result = dispatchToolCall({ toolName: "made_up_tool", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Unknown tool");
  });

  // ── Explore mode: allow-level tools ──

  test("explore mode allows read", () => {
    const result = dispatchToolCall({ toolName: "read", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows web_search", () => {
    const result = dispatchToolCall({ toolName: "web_search", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows ask", () => {
    const result = dispatchToolCall({ toolName: "ask", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows todo", () => {
    const result = dispatchToolCall({ toolName: "todo", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows resolve", () => {
    const result = dispatchToolCall({ toolName: "resolve", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  // ── Explore mode: search/find/ast_grep (no scope limits → always allowed) ──

  test("explore mode allows find with any path", () => {
    const result = dispatchToolCall({ toolName: "find", input: { paths: "/etc/passwd" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows search with any path", () => {
    const result = dispatchToolCall({ toolName: "search", input: { paths: "/etc/passwd" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows ast_grep with any paths", () => {
    const result = dispatchToolCall({ toolName: "ast_grep", input: { paths: ["/etc/secret.ts"] } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows search with no paths (workspace default)", () => {
    const result = dispatchToolCall({ toolName: "search", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  // ── Explore mode: check-level tools (guards exercised) ──

  test("explore mode allows bash ls", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls -la" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode blocks bash rm", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("whitelist");
  });

  test("explore mode blocks bash command chaining", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls && rm file" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("chaining");
  });

  test("explore mode blocks bash output redirection", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls > out.txt" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("redirection");
  });

  test("explore mode blocks sed -i", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "sed -i 's/a/b/' file" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("sed -i");
  });

  test("explore mode blocks LSP rename", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "rename" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("rename");
  });

  test("explore mode allows LSP definition", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "definition" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode blocks LSP rename_file", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "rename_file" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("rename_file");
  });

  test("explore mode blocks LSP code_actions with apply: true", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "code_actions", apply: true } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("code_actions");
  });

  test("explore mode allows LSP code_actions without apply", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "code_actions" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows LSP hover", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "hover" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode blocks browser run", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Browser");
  });

  test("explore mode allows browser open", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "open" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows browser close", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "close" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows task explore agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "explore" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows task librarian agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "librarian" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows task plan agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "plan" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode allows task reviewer agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "reviewer" } }, mode("explore"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode blocks task agent with alternative hint", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "task" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Instead try");
  });

  test("explore mode blocks task unknown agent with switch_to_build", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "oracle" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("switch to Build mode");
  });

  test("explore mode blocks task with missing agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: {} }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("switch to Build mode");
  });

  test("explore mode blocks task quick_task agent with alternative hint", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "quick_task" } }, mode("explore"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Instead try");
  });

  // ── Debug mode: expanded access + audit ──

  test("debug mode allows write", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode allows edit", () => {
    const result = dispatchToolCall({ toolName: "edit", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode allows eval", () => {
    const result = dispatchToolCall({ toolName: "eval", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode allows debug tool", () => {
    const result = dispatchToolCall({ toolName: "debug", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode allows browser run", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode blocks destructive bash", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm file.txt" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
  });

  test("debug mode blocks command chaining", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls && rm file" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  test("debug mode allows diagnostic bash", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "npm test" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode blocks destructive git commands", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "git push origin main" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
  });

  test("debug mode blocks package install", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "npm install pkg" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
  });

  test("debug mode blocks bash output redirection", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls > out.txt" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("redirection");
  });

  test("debug mode blocks sed -i", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "sed -i 's/a/b/' file" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
  });

  test("debug mode blocks empty bash command", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  test("debug mode allows task oracle", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "oracle" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode blocks task designer", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "designer" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  test("debug mode read is allowed", () => {
    const result = dispatchToolCall({ toolName: "read", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode allows task explore agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "explore" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("debug mode blocks task 'task' agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "task" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  test("debug mode blocks task quick_task agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "quick_task" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  test("debug mode blocks task with missing agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
  });

  // ── formatBlock integration: hints become formatted suffixes ──

  test("switch_to_build hint produces '/readonly' suffix", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("explore"), cwd);
    expect(result.block!.reason).toContain("/readonly");
  });

  test("use_alternative hint produces 'Instead try' suffix", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("explore"), cwd);
    expect(result.block!.reason).toContain("Instead try");
  });

  test("silent hint produces no extra suffix on whitelist violations", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("explore"), cwd);
    expect(result.block!.reason).not.toContain("/readonly");
    expect(result.block!.reason).not.toContain("Instead try");
  });
});
