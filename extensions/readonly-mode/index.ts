import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "path";

// ============================================================
// Bash patterns — array-driven, regex built once at load time
// ============================================================

// --- Standalone read-only commands ---
const READONLY_COMMANDS = [
  "ls", "dir", "cat", "head", "tail", "less", "more", "wc", "nl", "od", "xxd",
  "grep", "rg", "findstr", "find", "file", "stat", "du", "df", "diff", "cmp",
  "comm", "sort", "uniq", "cut", "tr", "fold", "column", "pr", "pwd", "echo",
  "printf", "which", "where", "type", "env", "printenv", "date", "whoami", "id",
  "uname", "uptime", "dirname", "basename", "realpath", "readlink", "cksum",
  "md5sum", "sha1sum", "sha256sum", "ps", "jobs", "tree", "awk", "jq", "sed",
] as const;

// --- Git read-only subcommands ---
const GIT_READONLY_SUBCOMMANDS = [
  "log", "diff", "show", "status", "branch", "tag", "describe", "ls-files",
  "ls-tree", "rev-parse", "rev-list", "cat-file", "check-ignore", "check-attr",
  "check-mailmap", "check-ref-format", "config", "remote", "help", "version",
  "merge-base", "name-rev", "shortlog", "stash list", "worktree list",
  "submodule status",
] as const;

// --- Ecosystem tools → read-only subcommands ---
const ECO_READONLY: Record<string, readonly string[]> = {
  npm:     ["ls", "list", "view", "info", "outdated"],
  cargo:   ["tree", "metadata", "pkgid", "version"],
  pip:     ["list", "show", "freeze"],
  pip3:    ["list", "show", "freeze"],
  go:      ["list", "doc", "version", "env"],
  node:    ["-v", "--version"],
  python:  ["--version", "-V"],
  python3: ["--version", "-V"],
  rustc:   ["--version", "-V"],
  rustup:  ["show", "check"],
  gcc:     ["--version"],
  clang:   ["--version"],
};

/** Escape regex-special characters and join alternation groups. */
function buildAlt(items: readonly string[]): string {
  return items.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

const BASH_READONLY_PATTERN = new RegExp(
  `^(?:command\\s+(?:-v\\s+)?)?(?:sudo\\s+)?(?:${buildAlt(READONLY_COMMANDS)})\\b`,
);

const GIT_READONLY_PATTERN = new RegExp(
  `^(?:sudo\\s+)?git\\s+(?:${buildAlt(GIT_READONLY_SUBCOMMANDS)})\\b`,
);

const ECO_READONLY_PATTERN = new RegExp(
  `^(?:sudo\\s+)?(?:${
    Object.entries(ECO_READONLY)
      .map(([cmd, subs]) => `${cmd}\\s+(?:${buildAlt(subs as readonly string[])})`)
      .join("|")
  })\\b`,
);
// Blocked patterns: command chaining
const BASH_BLOCKED_CHAIN = /&&|\|\||;\s*\S|`|\$\(/;
// Blocked patterns: output redirection
const BASH_BLOCKED_REDIRECT = /[>&]+\s*(?:>>?)/;
const BASH_BLOCKED_TEE = /\|\s*tee\b/;

// ============================================================
// Injection strategy configuration
// ============================================================
// Where to inject mode prompts. Each mode (Build / Chat+Explore) configured
// independently.
//   "system_prompt"         – append to LLM system message (every turn, outside history)
//   "message_every_turn"    – invisible message before user prompt (every turn, in history)
//   "message_on_transition" – invisible message only on mode switch (in history, minimal tokens)
const BUILD_PROMPT_LOCATION: "system_prompt" | "message_every_turn" | "message_on_transition" = "message_on_transition";
const READONLY_PROMPT_LOCATION: "system_prompt" | "message_every_turn" | "message_on_transition" = "system_prompt";

// When using "message_on_transition": re-inject after N same-mode turns to refresh
// model attention during long conversations. 0 = never re-inject.
const REINJECT_INTERVAL = 0;

// Filter stale mode-context messages from history via "context" event.
// WARNING: breaks DeepSeek prefix cache (history prefix changes every turn).
const CLEANUP_HISTORY = false;

// ============================================================
// Mode-specific system prompts
// ============================================================

const BUILD_SYSTEM_PROMPT = `[BUILD MODE ACTIVE]
You are in Build mode with full access. No tool restrictions apply.`;

const CHAT_SYSTEM_PROMPT = `[CHAT MODE ACTIVE]
You are in Chat mode (read-only, workspace-scoped). You can read, search, and analyze the codebase within the workspace, but write or execute operations are blocked by the system.

Before calling any tool, you MUST present a clear plan stating:
- What you intend to do
- Which files or commands you need to inspect
- What you expect to learn or conclude

Do not call tools silently or without first explaining your intent. If the user's request requires creating or modifying files, explain why it cannot be done in chat mode and suggest switching to Build mode.

Allowed tools: read, web_search, ask, todo, resolve, browser (open/close), lsp (read-only actions).
Blocked tools: write, edit, ast_edit, eval, task, debug, browser (run), lsp (rename/code_actions:apply).`;

function exploreSystemPrompt(scopeDescription: string): string {
  return `[EXPLORE MODE ACTIVE]
You are in Explore mode (read-only, expanded scope: ${scopeDescription}). You can read, search, and analyze the codebase including the paths listed below, but write or execute operations are blocked by the system.

Before calling any tool, you MUST present a clear plan stating:
- What you intend to do
- Which files or commands you need to inspect
- What you expect to learn or conclude

Do not call tools silently or without first explaining your intent. If the user's request requires creating or modifying files, explain why it cannot be done in explore mode and suggest switching to Build mode.

Allowed tools: read, web_search, ask, todo, resolve, browser (open/close), lsp (read-only actions).
Blocked tools: write, edit, ast_edit, eval, task, debug, browser (run), lsp (rename/code_actions:apply).`;
}

// ============================================================
// Path helpers
// ============================================================

/** Resolve a path to absolute, using cwd as the base for relative paths. */
function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, p.slice(1));
  }
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(cwd, p);
}

/** Compute the current set of allowed scope directories. */
function getAllowedScope(cwd: string, scopeOverride: string | null): string[] {
  const scope: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    scope.push(path.resolve(homeDir, ".omp", "agent"));
  }
  scope.push(cwd);
  if (scopeOverride && scopeOverride !== "all") {
    scope.push(resolvePath(scopeOverride, cwd));
  }
  return scope;
}

/** Check whether a file path lies within the given scope. */
function isPathInScope(filePath: string, scope: string[], cwd: string): boolean {
  // Internal URIs (skill://, omp://, artifact://, etc.)
  if (filePath.includes("://")) return true;

  const normalized = resolvePath(filePath, cwd).toLowerCase();
  return scope.some((prefix) => {
    const normPrefix = resolvePath(prefix, cwd).toLowerCase();
    return normalized === normPrefix || normalized.startsWith(normPrefix + path.sep);
  });
}

/** Build a human-readable list of allowed scope paths. */
function buildScopeGuide(scope: string[]): string {
  return scope.map((p) => `  - ${p}`).join("\n");
}

// ============================================================
// Tool policies (declarative)
// ============================================================

type PolicyType = "allow" | "block" | "path_check" | "bash_check" | "lsp_check" | "browser_check";

interface ToolPolicy {
  type: PolicyType;
  reason?: string;
}

const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // Full allow — tools the model can use freely
  web_search: { type: "allow" },
  ask:        { type: "allow" },
  todo:       { type: "allow" },
  read:       { type: "allow" },
  resolve:    { type: "allow" },

  // Block with reason — write / exec tools
  write:    { type: "block", reason: "Tool 'write' requires Build mode. Use /readonly to toggle." },
  edit:     { type: "block", reason: "Tool 'edit' requires Build mode. Use /readonly to toggle." },
  ast_edit: { type: "block", reason: "Tool 'ast_edit' requires Build mode. Use /readonly to toggle." },
  eval:     { type: "block", reason: "Tool 'eval' is blocked in read-only mode (can execute arbitrary code)." },
  task:     { type: "block", reason: "Tool 'task' is blocked in read-only mode (sub-agents can write files)." },
  debug:    { type: "block", reason: "Tool 'debug' is blocked in read-only mode (can modify program state)." },

  // Per-call checks
  search:   { type: "path_check" },
  find:     { type: "path_check" },
  ast_grep: { type: "path_check" },
  bash:     { type: "bash_check" },
  lsp:      { type: "lsp_check" },
  browser:  { type: "browser_check" },
};

const DEFAULT_POLICY: ToolPolicy = {
  type: "block",
  reason: "Unknown tool — blocked in read-only mode. Use /readonly to toggle to Build mode.",
};

// ============================================================
// Tool check functions
// ============================================================

function checkBash(event: { input: unknown }): { block: true; reason: string } | undefined {
  const input = event.input as { command?: string };
  const command = (input.command ?? "").trim();
  if (!command) return { block: true, reason: "Empty bash command." };

  // 1. Block command chaining
  if (BASH_BLOCKED_CHAIN.test(command)) {
    return {
      block: true,
      reason: "Command chaining (&&, ||, ;, `, $()) is blocked in read-only mode. Run one read-only command at a time.",
    };
  }

  // 2. Block output redirection
  if (BASH_BLOCKED_REDIRECT.test(command) || BASH_BLOCKED_TEE.test(command)) {
    return {
      block: true,
      reason: "Output redirection (>, >>, &>, | tee) is blocked in read-only mode.",
    };
  }

  // 3. Block sed -i (in-place editing)
  if (/^\s*sed\b/.test(command) && /\s-i\b/.test(command)) {
    return {
      block: true,
      reason: "sed -i (in-place editing) is blocked in read-only mode. Use sed without -i for read-only filtering.",
    };
  }

  // 4. Check command whitelist
  if (BASH_READONLY_PATTERN.test(command)) return undefined;
  if (GIT_READONLY_PATTERN.test(command)) return undefined;
  if (ECO_READONLY_PATTERN.test(command)) return undefined;

  return {
    block: true,
    reason: "Command not in read-only whitelist. Allowed: ls, cat, grep, rg, find, stat, awk, jq, sed, git log/diff/show, npm ls, cargo tree, pip list, node --version, etc.",
  };
}

function checkSearchPaths(
  event: { input: unknown },
  cwd: string,
  scopeOverride: string | null,
): { block: true; reason: string } | undefined {
  const input = event.input as { paths?: string | string[] };
  const paths = !input.paths ? [] : Array.isArray(input.paths) ? input.paths : [input.paths];

  // No paths specified → searches workspace root, always allowed
  if (paths.length === 0) return undefined;

  // "all" scope → all paths allowed
  if (scopeOverride === "all") return undefined;

  const scope = getAllowedScope(cwd, scopeOverride);
  const outOfScope = paths.filter((p) => !isPathInScope(p, scope, cwd));
  if (outOfScope.length === 0) return undefined;

  return {
    block: true,
    reason: `Search path(s) outside allowed scope: ${outOfScope.join(", ")}.\n\nAllowed search paths:\n${buildScopeGuide(scope)}\n\nUse /readonly <path> to expand scope, or retry with paths scoped to the above directories.`,
  };
}

function checkLsp(event: { input: unknown }): { block: true; reason: string } | undefined {
  const input = event.input as { action?: string; apply?: boolean };

  if (input.action === "rename" || input.action === "rename_file") {
    return {
      block: true,
      reason: `LSP '${input.action}' is blocked in read-only mode (modifies files). Use definition, hover, references, symbols, or diagnostics for code exploration.`,
    };
  }

  if (input.action === "code_actions" && input.apply) {
    return {
      block: true,
      reason: "LSP code_actions with apply is blocked in read-only mode (may modify files). Use code_actions without apply to list available fixes.",
    };
  }

  return undefined;
}

function checkBrowser(event: { input: unknown }): { block: true; reason: string } | undefined {
  const input = event.input as { action?: string };

  if (input.action === "run") {
    return {
      block: true,
      reason: "Browser 'run' is blocked in read-only mode (can interact with pages). Use browser 'open' to load pages and 'close' to release tabs.",
    };
  }

  return undefined;
}

// ============================================================
// Main extension
// ============================================================

export default function readonlyMode(pi: ExtensionAPI) {
  const state = { enabled: false, scopeOverride: null as string | null, previousEnabled: undefined as boolean | undefined, previousScopeOverride: undefined as string | null | undefined, turnsSinceTransition: 0 };

  function updateState(ctx: ExtensionContext, patch: Partial<typeof state>): void {
    Object.assign(state, patch);
    setWidget(ctx, state.enabled, state.scopeOverride);
  }

  pi.setLabel("Read-only Mode");

  function setWidget(ctx: ExtensionContext, on: boolean, override: string | null): void {
    let label: string;
    let color: string;

    if (!on) {
      label = "Build";
      color = "\x1b[34m";
    } else if (override) {
      const display = override === "all" ? "all" : override;
      label = `Explore: ${display}`;
      color = "\x1b[32m";
    } else {
      label = "Chat";
      color = "\x1b[38;5;214m";
    }

    ctx.ui.setWidget("readonly-mode", [
      `${color}┌${"─".repeat(label.length)}┐\x1b[0m`,
      `${color}│${label}│\x1b[0m`,
      `${color}└${"─".repeat(label.length)}┘\x1b[0m`,
    ]);
  }

  // Default state: Build (read-write)
  pi.on("session_start", async (_event, ctx) => {
    updateState(ctx, { enabled: false, scopeOverride: null });
  });

  // Slash command: /readonly, /readonly all, /readonly <path>
  pi.registerCommand("readonly", {
    description: "Toggle read-only mode. /readonly all: allow all paths. /readonly <path>: also allow <path>",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (!arg) {
        updateState(ctx, { enabled: !state.enabled, scopeOverride: null });
      } else if (argLower === "all") {
        updateState(ctx, { enabled: true, scopeOverride: "all" });
      } else {
        updateState(ctx, { enabled: true, scopeOverride: arg });
      }

      ctx.ui.notify(
        state.enabled
          ? `Read-only mode ON${state.scopeOverride ? ` (${state.scopeOverride})` : ""}`
          : "Read-only mode OFF",
        state.enabled ? "warning" : "info",
      );
    },
  });

  // Inject mode declaration per configuration
  pi.on("before_agent_start", async (event, ctx) => {
    const modeChanged = state.previousEnabled !== state.enabled
      || state.previousScopeOverride !== state.scopeOverride;

    const location = state.enabled ? READONLY_PROMPT_LOCATION : BUILD_PROMPT_LOCATION;

    // Build the prompt content and custom type for the current mode
    let content: string;
    let customType: string;
    if (!state.enabled) {
      content = BUILD_SYSTEM_PROMPT;
      customType = "build-mode-context";
    } else {
      const scope = getAllowedScope(ctx.cwd, state.scopeOverride);
      const paths = `\nAllowed search paths:\n${buildScopeGuide(scope)}`;
      if (state.scopeOverride) {
        const desc = state.scopeOverride === "all"
          ? "all directories (including workspace and ~/.omp/agent)"
          : `workspace + ${state.scopeOverride} (and ~/.omp/agent)`;
        content = exploreSystemPrompt(desc) + paths;
        customType = "explore-mode-context";
      } else {
        content = CHAT_SYSTEM_PROMPT + paths;
        customType = "chat-mode-context";
      }
    }

    // Decide whether to inject a message
    let shouldInject = false;
    if (location === "message_every_turn") {
      shouldInject = true;
    } else if (location === "message_on_transition") {
      if (modeChanged) {
        shouldInject = true;
      } else if (REINJECT_INTERVAL > 0 && state.turnsSinceTransition >= REINJECT_INTERVAL) {
        shouldInject = true;
      }
    }

    // Update tracking
    if (modeChanged) {
      state.turnsSinceTransition = 0;
    } else {
      state.turnsSinceTransition++;
    }
    state.previousEnabled = state.enabled;
    state.previousScopeOverride = state.scopeOverride;

    if (!shouldInject && location !== "system_prompt") return;

    const result: Record<string, unknown> = {};
    if (location === "system_prompt") {
      result.systemPrompt = [...event.systemPrompt, content];
    }
    if (shouldInject) {
      result.message = { customType, content, display: false };
    }
    return result;
  });

  // Conditionally filter stale mode-context messages from history
  if (CLEANUP_HISTORY) {
    const MODE_TYPES = ["build-mode-context", "chat-mode-context", "explore-mode-context"];
    pi.on("context", async event => {
      const current = !state.enabled ? "build-mode-context"
        : state.scopeOverride ? "explore-mode-context" : "chat-mode-context";
      return {
        messages: event.messages.filter(m =>
          m.role !== "custom" || !MODE_TYPES.includes(m.customType) || m.customType === current,
        ),
      };
    });
  }

  // Unified tool call interception
  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return;

    const policy = TOOL_POLICIES[event.toolName] ?? DEFAULT_POLICY;

    switch (policy.type) {
      case "allow":
        return;

      case "block":
        return { block: true, reason: policy.reason };

      case "bash_check":
        return checkBash(event);

      case "path_check":
        return checkSearchPaths(event, ctx.cwd, state.scopeOverride);

      case "lsp_check":
        return checkLsp(event);

      case "browser_check":
        return checkBrowser(event);
    }
  });
}
