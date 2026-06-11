import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { TOOL_POLICIES, DEBUG_TOOL_POLICIES, DEFAULT_POLICY, formatBlock } from "./policies";
import type { BlockResult } from "./policies";

import { checkBash, checkDebugBash, checkSearchPaths, checkLsp, checkBrowser, checkTask, checkDebugTask } from "./checks";

import {
  BUILD_PROMPT_LOCATION,
  READONLY_PROMPT_LOCATION,
  DEBUG_PROMPT_LOCATION,
  REINJECT_INTERVAL,
  CLEANUP_HISTORY,
  BUILD_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  CHAT_TRANSITION_PROMPT,
  EXPLORE_TRANSITION_PROMPT,
  DEBUG_TRANSITION_PROMPT,
  exploreSystemPrompt,
} from "./prompts";

import { getAllowedScope, buildScopeGuide } from "./scope";

import { recordAudit, clearAudit, toggleAudit, showCollapsed, setAuditCtx } from "./audit";

// ============================================================
// Audit helpers
// ============================================================

/** Tools that don't produce meaningful audit entries. */
function isReadonlyAuditTool(tool: string): boolean {
  return tool === "read" || tool === "web_search" || tool === "ask" || tool === "todo" || tool === "resolve";
}

/** Extract a human-readable detail string from tool input. */
function auditDetail(tool: string, input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return "";
  switch (tool) {
    case "write":
    case "edit":
    case "ast_edit":
      return (inp.path as string) ?? (inp.filePath as string) ?? "";
    case "bash":
      return (inp.command as string)?.slice(0, 80) ?? "";
    case "eval":
      return (inp.code as string)?.split("\n")[0]?.slice(0, 60) ?? "";
    case "browser":
      return `${inp.action ?? ""} ${inp.url ?? ""}`.trim().slice(0, 60);
    case "debug":
      return `${inp.action ?? ""} ${inp.program ?? ""}`.trim().slice(0, 60);
    case "task":
      return `agent: ${inp.agent ?? "?"} — ${((inp.assignment as string) ?? "").slice(0, 50)}`;
    case "lsp":
      return `${inp.action ?? ""} ${(inp.file as string) ?? ""}`.trim().slice(0, 60);
    default:
      return "";
  }
}

// ============================================================
// Main extension
// ============================================================

export default function readonlyMode(pi: ExtensionAPI) {
  const state = { enabled: false, debugMode: false, scopeOverride: [] as string[], previousEnabled: undefined as boolean | undefined, previousDebugMode: undefined as boolean | undefined, previousScopeOverride: undefined as string[] | undefined, turnsSinceTransition: 0 };

  function updateState(ctx: ExtensionContext, patch: Partial<typeof state>): void {
    Object.assign(state, patch);
    setWidget(ctx);
    setAuditCtx(ctx);
    if (state.debugMode) {
      showCollapsed();
    } else {
      clearAudit();
      showCollapsed();
    }
  }

  pi.setLabel("Read-only Mode");

  function setWidget(ctx: ExtensionContext): void {
    let label: string;
    let color: string;

    if (state.debugMode) {
      label = "Debug";
      color = "\x1b[33m";
    } else if (!state.enabled) {
      label = "Build";
      color = "\x1b[34m";
    } else if (state.scopeOverride.length > 0) {
      const display = state.scopeOverride.includes("all") ? "all" : state.scopeOverride.join(", ");
      label = `Explore: ${display}`;
      color = "\x1b[32m";
    } else {
      label = "Chat";
      color = "\x1b[38;5;214m";
    }

    ctx.ui.setWidget("readonly-mode", [
      `${color}┌${"\u2500".repeat(label.length)}┐\x1b[0m`,
      `${color}│${label}│\x1b[0m`,
      `${color}└${"\u2500".repeat(label.length)}┘\x1b[0m`,
    ]);
  }

  // Default state: Build (read-write)
  pi.on("session_start", async (_event, ctx) => {
    updateState(ctx, { enabled: false, debugMode: false, scopeOverride: [] });
  });
  pi.registerCommand("readonly", {
    description: "Toggle read-only mode. /readonly debug: enter Debug mode. /readonly audit: toggle audit trail. /readonly all: allow all paths. /readonly <paths...>: allow specific paths.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (argLower === "debug") {
        updateState(ctx, { enabled: true, debugMode: true, scopeOverride: ["all"] });
        ctx.ui.notify("\x1b[33mDebug mode on — expanded read/execute, write OK for instrumentation\x1b[0m", "info");
        return;
      }

      if (argLower === "audit") {
        if (!state.debugMode) {
          ctx.ui.notify("Audit trail is only available in Debug mode. Use /readonly debug first.", "warning");
          return;
        }
        toggleAudit(ctx);
        return;
      }

      if (!arg) {
        // Toggle: Debug → Build, Build → Chat, Chat → Build, Explore → Build
        if (state.debugMode) {
          updateState(ctx, { enabled: false, debugMode: false });
        } else {
          updateState(ctx, { enabled: !state.enabled });
        }
      } else if (argLower === "all") {
        updateState(ctx, { enabled: true, debugMode: false, scopeOverride: ["all"] });
      } else if (argLower === "clear") {
        updateState(ctx, { enabled: true, debugMode: false, scopeOverride: [] });
      } else if (argLower.startsWith("add ")) {
        const toAdd = arg.slice(4).trim();
        if (!toAdd) {
          ctx.ui.notify("Usage: /readonly add <path>", "error");
          return;
        }
        const updated = [...state.scopeOverride.filter(p => p !== "all"), toAdd];
        updateState(ctx, { enabled: true, debugMode: false, scopeOverride: updated });
      } else if (argLower.startsWith("remove ")) {
        const toRemove = arg.slice(7).trim();
        if (!toRemove) {
          ctx.ui.notify("Usage: /readonly remove <path>", "error");
          return;
        }
        const updated = state.scopeOverride.filter(p => p !== "all" && p !== toRemove);
        updateState(ctx, { enabled: true, debugMode: false, scopeOverride: updated });
      } else {
        // Space-separated paths: replace existing overrides
        const paths = arg.split(/\s+/).filter(p => p.length > 0);
        updateState(ctx, { enabled: true, debugMode: false, scopeOverride: paths });
      }

      let notifyLabel: string;
      let color: string;
      if (state.debugMode) {
        notifyLabel = "Debug mode on";
        color = "\x1b[33m";
      } else if (!state.enabled) {
        notifyLabel = "Build mode on";
        color = "\x1b[34m";
      } else if (state.scopeOverride.length > 0) {
        const scopeLabel = state.scopeOverride.includes("all") ? "all" : state.scopeOverride.join(", ");
        notifyLabel = `Explore mode on, scope: ${scopeLabel}`;
        color = "\x1b[32m";
      } else {
        notifyLabel = "Chat mode on";
        color = "\x1b[38;5;214m";
      }
      ctx.ui.notify(`${color}${notifyLabel}\x1b[0m`, "info");
    },
  });

  // Inject mode declaration per configuration
  pi.on("before_agent_start", async (event, ctx) => {
    // Clear previous turn's audit entries (only agent turns, not commands)
    if (state.debugMode) clearAudit();
    const prevKey = (state.previousScopeOverride ?? []).join("|");
    const currKey = state.scopeOverride.join("|");
    const prevDebug = state.previousDebugMode ?? false;
    const modeChanged = state.previousEnabled !== state.enabled
      || prevDebug !== state.debugMode
      || prevKey !== currKey;

    // Determine prompt location: Debug uses message_on_transition (same as Build)
    // to keep system prompt stable for cache hits
    let location: typeof BUILD_PROMPT_LOCATION;
    if (state.debugMode) {
      location = DEBUG_PROMPT_LOCATION;
    } else if (state.enabled) {
      location = READONLY_PROMPT_LOCATION;
    } else {
      location = BUILD_PROMPT_LOCATION;
    }

    // Build the prompt content and custom type for the current mode
    let content: string;
    let customType: string;
    if (state.debugMode) {
      content = DEBUG_TRANSITION_PROMPT;
      customType = "debug-mode-context";
    } else if (!state.enabled) {
      content = BUILD_SYSTEM_PROMPT;
      customType = "build-mode-context";
    } else {
      const scope = getAllowedScope(ctx.cwd, state.scopeOverride);
      const paths = `\nAllowed search paths:\n${buildScopeGuide(scope)}`;
      if (state.scopeOverride.length > 0) {
        const desc = state.scopeOverride.includes("all")
          ? "all directories (including workspace and ~/.omp/agent)"
          : `workspace + ${state.scopeOverride.join(", ")} (and ~/.omp/agent)`;
        content = exploreSystemPrompt(desc) + paths;
        customType = "explore-mode-context";
      } else {
        content = CHAT_SYSTEM_PROMPT + paths;
        customType = "chat-mode-context";
      }
    }

    // Decide whether to inject a message
    let shouldInject = false;
    let injectContent = content;
    if (location === "message_every_turn") {
      shouldInject = true;
    } else if (location === "message_on_transition") {
      if (modeChanged) {
        shouldInject = true;
      } else if (REINJECT_INTERVAL > 0 && state.turnsSinceTransition >= REINJECT_INTERVAL) {
        shouldInject = true;
      }
    }
    // When switching to readonly/debug mode, also inject a brief transition
    // message into conversation history.
    if (!shouldInject && modeChanged && (state.enabled || state.debugMode)) {
      shouldInject = true;
      if (state.debugMode) {
        injectContent = DEBUG_TRANSITION_PROMPT;
      } else {
        injectContent = state.scopeOverride.length > 0
          ? EXPLORE_TRANSITION_PROMPT
          : CHAT_TRANSITION_PROMPT;
      }
    }

    // Update tracking
    if (modeChanged) {
      state.turnsSinceTransition = 0;
    } else {
      state.turnsSinceTransition++;
    }
    state.previousEnabled = state.enabled;
    state.previousDebugMode = state.debugMode;
    state.previousScopeOverride = [...state.scopeOverride];

    if (!shouldInject && location !== "system_prompt") return;

    const result: Record<string, unknown> = {};
    if (location === "system_prompt") {
      result.systemPrompt = [...event.systemPrompt, content];
    }
    if (shouldInject) {
      result.message = { customType, content: injectContent, display: false };
    }
    return result;
  });

  // Conditionally filter stale mode-context messages from history
  if (CLEANUP_HISTORY) {
    const MODE_TYPES = ["build-mode-context", "chat-mode-context", "explore-mode-context", "debug-mode-context"];
    pi.on("context", async event => {
      const current = state.debugMode ? "debug-mode-context"
        : !state.enabled ? "build-mode-context"
        : state.scopeOverride.length > 0 ? "explore-mode-context" : "chat-mode-context";
      return {
        messages: event.messages.filter(m =>
          m.role !== "custom" || !MODE_TYPES.includes(m.customType) || m.customType === current,
        ),
      };
    });
  }

  // Unified tool call interception
  pi.on("tool_call", async (event, ctx) => {
    // Build mode: no interception
    if (!state.enabled && !state.debugMode) return;

    // Pick policy table based on mode
    // Debug mode uses its own overrides first, falling back to readonly policies
    const policy = (state.debugMode
      ? (DEBUG_TOOL_POLICIES[event.toolName] ?? TOOL_POLICIES[event.toolName])
      : TOOL_POLICIES[event.toolName]) ?? DEFAULT_POLICY;

    let raw: BlockResult | undefined;

    switch (policy.type) {
      case "allow":
        break;

      case "block":
        raw = {
          block: true,
          reason: policy.reason ?? "",
          hint: policy.hint ?? "switch_to_build",
          alternatives: policy.alternatives,
        };
        break;

      case "bash_check":
        raw = checkBash(event);
        break;

      case "debug_bash_check":
        raw = checkDebugBash(event);
        break;

      case "path_check":
        raw = checkSearchPaths(event, ctx.cwd, state.scopeOverride);
        break;

      case "lsp_check":
        raw = checkLsp(event);
        break;

      case "browser_check":
        raw = checkBrowser(event);
        break;

      case "task_check":
        raw = checkTask(event);
        break;

      case "debug_task_check":
        raw = checkDebugTask(event);
        break;
    }

    // Record audit trail for allowed non-readonly tools in Debug mode
    if (state.debugMode && !raw && !isReadonlyAuditTool(event.toolName)) {
      recordAudit(event.toolName, auditDetail(event.toolName, event.input));
    }

    if (!raw) return;
    return formatBlock(raw);
  });

}
