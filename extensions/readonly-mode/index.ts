import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { TOOL_POLICIES, DEFAULT_POLICY, formatBlock } from "./policies";
import type { BlockResult } from "./policies";

import { checkBash, checkSearchPaths, checkLsp, checkBrowser, checkTask } from "./checks";

import {
  BUILD_PROMPT_LOCATION,
  READONLY_PROMPT_LOCATION,
  REINJECT_INTERVAL,
  CLEANUP_HISTORY,
  BUILD_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  CHAT_TRANSITION_PROMPT,
  EXPLORE_TRANSITION_PROMPT,
  exploreSystemPrompt,
} from "./prompts";

import { getAllowedScope, buildScopeGuide } from "./scope";

// ============================================================
// Main extension
// ============================================================

export default function readonlyMode(pi: ExtensionAPI) {
  const state = { enabled: false, scopeOverride: [] as string[], previousEnabled: undefined as boolean | undefined, previousScopeOverride: undefined as string[] | undefined, turnsSinceTransition: 0 };

  function updateState(ctx: ExtensionContext, patch: Partial<typeof state>): void {
    Object.assign(state, patch);
    setWidget(ctx, state.enabled, state.scopeOverride);
  }

  pi.setLabel("Read-only Mode");

  function setWidget(ctx: ExtensionContext, on: boolean, override: string[]): void {
    let label: string;
    let color: string;

    if (!on) {
      label = "Build";
      color = "\x1b[34m";
    } else if (override.length > 0) {
      const display = override.includes("all") ? "all" : override.join(", ");
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
    updateState(ctx, { enabled: false, scopeOverride: [] });
  });

  // Slash command: /readonly, /readonly all, /readonly <path...>, /readonly add <path>, /readonly remove <path>, /readonly clear
  pi.registerCommand("readonly", {
    description: "Toggle read-only mode. /readonly all: allow all paths. /readonly <paths...>: allow specific paths. /readonly add <p> / remove <p> / clear.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (!arg) {
        // Toggle: preserve overrides when turning back on
        updateState(ctx, { enabled: !state.enabled });
      } else if (argLower === "all") {
        updateState(ctx, { enabled: true, scopeOverride: ["all"] });
      } else if (argLower === "clear") {
        updateState(ctx, { enabled: true, scopeOverride: [] });
      } else if (argLower.startsWith("add ")) {
        const toAdd = arg.slice(4).trim();
        if (!toAdd) {
          ctx.ui.notify("Usage: /readonly add <path>", "error");
          return;
        }
        const updated = [...state.scopeOverride.filter(p => p !== "all"), toAdd];
        updateState(ctx, { enabled: true, scopeOverride: updated });
      } else if (argLower.startsWith("remove ")) {
        const toRemove = arg.slice(7).trim();
        if (!toRemove) {
          ctx.ui.notify("Usage: /readonly remove <path>", "error");
          return;
        }
        const updated = state.scopeOverride.filter(p => p !== "all" && p !== toRemove);
        updateState(ctx, { enabled: true, scopeOverride: updated });
      } else {
        // Space-separated paths: replace existing overrides
        const paths = arg.split(/\s+/).filter(p => p.length > 0);
        updateState(ctx, { enabled: true, scopeOverride: paths });
      }

      const notifyLabel = state.scopeOverride.includes("all") ? "all"
        : state.scopeOverride.length > 0 ? state.scopeOverride.join(", ")
        : "chat";
      ctx.ui.notify(
        state.enabled
          ? `Read-only mode ON (${notifyLabel})`
          : "Read-only mode OFF",
        state.enabled ? "warning" : "info",
      );
    },
  });

  // Inject mode declaration per configuration
  pi.on("before_agent_start", async (event, ctx) => {
    const prevKey = (state.previousScopeOverride ?? []).join("|");
    const currKey = state.scopeOverride.join("|");
    const modeChanged = state.previousEnabled !== state.enabled || prevKey !== currKey;

    const location = state.enabled ? READONLY_PROMPT_LOCATION : BUILD_PROMPT_LOCATION;

    // Build the prompt content and custom type for the current mode
    let content: string;
    let customType: string;
    if (!state.enabled) {
      content = BUILD_SYSTEM_PROMPT;
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
    // When switching to readonly mode, also inject a brief transition
    // message into conversation history so the model explicitly sees
    // the mode change (mirrors BUILD_PROMPT_LOCATION="message_on_transition").
    if (!shouldInject && modeChanged && state.enabled) {
      shouldInject = true;
      injectContent = state.scopeOverride.length > 0
        ? EXPLORE_TRANSITION_PROMPT
        : CHAT_TRANSITION_PROMPT;
    }

    // Update tracking
    if (modeChanged) {
      state.turnsSinceTransition = 0;
    } else {
      state.turnsSinceTransition++;
    }
    state.previousEnabled = state.enabled;
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
    const MODE_TYPES = ["build-mode-context", "chat-mode-context", "explore-mode-context"];
    pi.on("context", async event => {
      const current = !state.enabled ? "build-mode-context"
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
    if (!state.enabled) return;

    const policy = TOOL_POLICIES[event.toolName] ?? DEFAULT_POLICY;

    let raw: BlockResult | undefined;

    switch (policy.type) {
      case "allow":
        return;

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
    }

    if (!raw) return;
    return formatBlock(raw);
  });
}
