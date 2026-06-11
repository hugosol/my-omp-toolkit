import { describe, test, expect } from "bun:test";
import {
  MODES,
  ModeState,
  buildScope,
  buildPromptContent,
  resolveToolPolicy,
  dispatchToolCall,
} from "../../extensions/readonly-mode/mode";
import type { TurnInjection, DispatchResult } from "../../extensions/readonly-mode/mode";
import { DEFAULT_POLICY } from "../../extensions/readonly-mode/policies";

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
    // read-only tools inherited from TOOL_POLICIES via MERGED_DEBUG_POLICIES
    expect(resolveToolPolicy("read", "debug").type).toBe("allow");
    expect(resolveToolPolicy("web_search", "debug").type).toBe("allow");
    expect(resolveToolPolicy("ask", "debug").type).toBe("allow");
    expect(resolveToolPolicy("todo", "debug").type).toBe("allow");
    expect(resolveToolPolicy("resolve", "debug").type).toBe("allow");
    // lsp — inherited from readonly baseline, not overridden in DEBUG_TOOL_POLICIES
    expect(resolveToolPolicy("lsp", "debug").type).toBe("check");
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

  test("debug mode uses check for bash", () => {
    const m = new ModeState();
    m.current = "debug";
    expect(m.resolveToolPolicy("bash").type).toBe("check");
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

  test("explore mode with 'all' scopePaths returns all sentinel", () => {
    const m = new ModeState();
    m.current = "explore";
    m.scopePaths = ["all"];
    const scope = m.getScope(cwd);
    expect(scope).toEqual(["all"]);
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

  test("explore mode with all shows expanded scope without path footer", () => {
    const content = buildPromptContent("explore", ["all"], cwd);
    expect(content).toContain("EXPLORE MODE");
    expect(content).toContain("all directories");
    expect(content).not.toContain("Allowed search paths");
  });
});

// ============================================================
// dispatchToolCall — integration of policy lookup + guard + format
// ============================================================

describe("dispatchToolCall", () => {
  const cwd = "/home/user/project";

  function mode(name: "build" | "chat" | "explore" | "debug", scopePaths: string[] = []): ModeState {
    const m = new ModeState();
    m.current = name;
    m.scopePaths = scopePaths;
    return m;
  }

  // ── Build mode: no interception ──

  test("build mode returns no block and no audit", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("build"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("build mode allows bash rm (everything is allowed)", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("build"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(false);
  });

  // ── Chat mode: block-level tools ──

  test("chat mode blocks write", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
    expect(result.shouldAudit).toBe(false);
  });

  test("chat mode blocks edit", () => {
    const result = dispatchToolCall({ toolName: "edit", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });

  test("chat mode blocks ast_edit", () => {
    const result = dispatchToolCall({ toolName: "ast_edit", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });

  test("chat mode blocks eval", () => {
    const result = dispatchToolCall({ toolName: "eval", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("arbitrary code");
  });

  test("chat mode blocks debug", () => {
    const result = dispatchToolCall({ toolName: "debug", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modify program state");
  });

  test("chat mode blocks unknown tool via DEFAULT_POLICY", () => {
    const result = dispatchToolCall({ toolName: "made_up_tool", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Unknown tool");
  });

  // ── Chat mode: allow-level tools ──

  test("chat mode allows read", () => {
    const result = dispatchToolCall({ toolName: "read", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("chat mode allows web_search", () => {
    const result = dispatchToolCall({ toolName: "web_search", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows ask", () => {
    const result = dispatchToolCall({ toolName: "ask", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows todo", () => {
    const result = dispatchToolCall({ toolName: "todo", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows resolve", () => {
    const result = dispatchToolCall({ toolName: "resolve", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  // ── Chat mode: find / ast_grep (scope-check tools like search) ──

  test("chat mode allows find within scope", () => {
    const result = dispatchToolCall({ toolName: "find", input: { paths: "src/main.ts" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks find outside scope", () => {
    const result = dispatchToolCall({ toolName: "find", input: { paths: "/etc/passwd" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("outside allowed scope");
  });

  test("chat mode allows ast_grep within scope", () => {
    const result = dispatchToolCall({ toolName: "ast_grep", input: { paths: ["src/**/*.ts"] } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks ast_grep outside scope", () => {
    const result = dispatchToolCall({ toolName: "ast_grep", input: { paths: ["/etc/secret.ts"] } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("outside allowed scope");
  });

  // ── Chat mode: check-level tools (guards exercised) ──

  test("chat mode allows bash ls", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls -la" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks bash rm", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("whitelist");
  });

  test("chat mode blocks bash command chaining", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls && rm file" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("chaining");
  });

  test("chat mode blocks bash output redirection", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls > out.txt" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("redirection");
  });

  test("chat mode blocks sed -i", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "sed -i 's/a/b/' file" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("sed -i");
  });

  test("chat mode allows search within scope", () => {
    const result = dispatchToolCall({ toolName: "search", input: { paths: "src/main.ts" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks search outside scope", () => {
    const result = dispatchToolCall({ toolName: "search", input: { paths: "/etc/passwd" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("outside allowed scope");
  });

  test("chat mode blocks LSP rename", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "rename" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("rename");
  });

  test("chat mode allows LSP definition", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "definition" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks LSP rename_file", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "rename_file" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("rename_file");
  });

  test("chat mode blocks LSP code_actions with apply: true", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "code_actions", apply: true } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("code_actions");
  });

  test("chat mode allows LSP code_actions without apply", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "code_actions" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows LSP hover", () => {
    const result = dispatchToolCall({ toolName: "lsp", input: { action: "hover" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks browser run", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Browser");
  });

  test("chat mode allows browser open", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "open" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows browser close", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "close" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows task explore agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "explore" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows task librarian agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "librarian" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows task plan agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "plan" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode allows task reviewer agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "reviewer" } }, mode("chat"), cwd);
    expect(result.block).toBeUndefined();
  });

  test("chat mode blocks task agent with alternative hint", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "task" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    // formatBlock applies use_alternative → "Instead try"
    expect(result.block!.reason).toContain("Instead try");
  });

  test("chat mode blocks task unknown agent with switch_to_build", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "oracle" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("switch to Build mode");
  });

  test("chat mode blocks task with missing agent", () => {
    const result = dispatchToolCall({ toolName: "task", input: {} }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("switch to Build mode");
  });

  test("chat mode blocks task quick_task agent with alternative hint", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "quick_task" } }, mode("chat"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Instead try");
  });

  // ── Debug mode: expanded access + audit ──

  test("debug mode allows write and flags audit", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode allows edit and flags audit", () => {
    const result = dispatchToolCall({ toolName: "edit", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode allows eval and flags audit", () => {
    const result = dispatchToolCall({ toolName: "eval", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode allows debug tool and flags audit", () => {
    const result = dispatchToolCall({ toolName: "debug", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode allows browser run", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode blocks destructive bash and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm file.txt" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks command chaining and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls && rm file" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode allows diagnostic bash and flags audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "npm test" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode blocks destructive git commands and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "git push origin main" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks package install and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "npm install pkg" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks bash output redirection and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "ls > out.txt" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("redirection");
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks sed -i and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "sed -i 's/a/b/' file" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("Destructive");
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks empty bash command and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode allows task oracle and flags audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "oracle" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode blocks task designer and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "designer" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode read is allowed but still flags audit (caller filters)", () => {
    const result = dispatchToolCall({ toolName: "read", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    // read is allowed in debug mode, so shouldAudit is true.
    // The caller (index.ts) applies isReadonlyAuditTool to filter it out.
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode allows task explore agent and flags audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "explore" } }, mode("debug"), cwd);
    expect(result.block).toBeUndefined();
    expect(result.shouldAudit).toBe(true);
  });

  test("debug mode blocks task 'task' agent and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "task" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });

  test("debug mode blocks task quick_task agent and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: { agent: "quick_task" } }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });


  test("debug mode blocks task with missing agent and does NOT flag audit", () => {
    const result = dispatchToolCall({ toolName: "task", input: {} }, mode("debug"), cwd);
    expect(result.block).toBeDefined();
    expect(result.shouldAudit).toBe(false);
  });

  // ── Explore mode: scope enforcement ──

  test("explore mode with 'all' scopePaths allows search anywhere", () => {
    const m = mode("explore", ["all"]);
    const result = dispatchToolCall({ toolName: "search", input: { paths: "/etc/passwd" } }, m, cwd);
    expect(result.block).toBeUndefined();
  });

  test("explore mode with specific scopePaths blocks search outside them", () => {
    const m = mode("explore", ["/other/lib"]);
    const result = dispatchToolCall({ toolName: "search", input: { paths: "/etc/passwd" } }, m, cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("outside allowed scope");
  });


  test("explore mode blocks write", () => {
    const m = mode("explore", ["/other/lib"]);
    const result = dispatchToolCall({ toolName: "write", input: {} }, m, cwd);
    expect(result.block).toBeDefined();
    expect(result.block!.reason).toContain("modifies files");
  });
  // ── formatBlock integration: hints become formatted suffixes ──

  test("switch_to_build hint produces '/readonly' suffix", () => {
    const result = dispatchToolCall({ toolName: "write", input: {} }, mode("chat"), cwd);
    expect(result.block!.reason).toContain("/readonly");
  });

  test("use_alternative hint produces 'Instead try' suffix", () => {
    const result = dispatchToolCall({ toolName: "browser", input: { action: "run" } }, mode("chat"), cwd);
    expect(result.block!.reason).toContain("Instead try");
  });

  test("silent hint produces no extra suffix on whitelist violations", () => {
    const result = dispatchToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, mode("chat"), cwd);
    expect(result.block!.reason).not.toContain("/readonly");
    expect(result.block!.reason).not.toContain("Instead try");
  });
});
