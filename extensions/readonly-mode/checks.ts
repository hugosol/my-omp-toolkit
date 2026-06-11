import type { BlockResult } from "./policies";
import {
  BASH_READONLY_PATTERN,
  GIT_READONLY_PATTERN,
  ECO_READONLY_PATTERN,
  BASH_BLOCKED_CHAIN,
  BASH_BLOCKED_REDIRECT,
  BASH_BLOCKED_TEE,
  READONLY_TASK_AGENTS,
  HAS_ALTERNATIVE_AGENTS,
  DEBUG_BASH_BLOCKED,
  DEBUG_TASK_AGENTS,
} from "./policies";
import { isPathInScope, buildScopeGuide } from "./scope";

// ============================================================
// Tool check functions
// ============================================================

export function checkBash(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { command?: string };
  const command = (input.command ?? "").trim();
  if (!command) return { block: true, reason: "Empty bash command.", hint: "silent" };

  // 1. Block command chaining → suggest running one at a time
  if (BASH_BLOCKED_CHAIN.test(command)) {
    return {
      block: true,
      reason: "Command chaining (&&, ||, ;, \`, $()) is not allowed.",
      hint: "use_alternative",
      alternatives: ["Run one read-only command at a time"],
    };
  }

  // 2. Block output redirection → suggest read tool
  if (BASH_BLOCKED_REDIRECT.test(command) || BASH_BLOCKED_TEE.test(command)) {
    return {
      block: true,
      reason: "Output redirection (>, >>, &>, | tee) is not allowed.",
      hint: "use_alternative",
      alternatives: ["Use the read tool to view file content", "Pipe to stdout without redirecting"],
    };
  }

  // 3. Block sed -i (in-place editing) → suggest sed without -i
  if (/^\s*sed\b/.test(command) && /\s-i\b/.test(command)) {
    return {
      block: true,
      reason: "sed -i performs in-place editing.",
      hint: "use_alternative",
      alternatives: ["Use sed without -i for read-only filtering"],
    };
  }

  // 4. Check command whitelist
  if (BASH_READONLY_PATTERN.test(command)) return undefined;
  if (GIT_READONLY_PATTERN.test(command)) return undefined;
  if (ECO_READONLY_PATTERN.test(command)) return undefined;

  return {
    block: true,
    reason: "Command not in read-only whitelist. Allowed: ls, cat, grep, rg, find, stat, awk, jq, sed, git log/diff/show, npm ls, cargo tree, pip list, node --version, etc.",
    hint: "silent",
  };
}

export function checkSearchPaths(
  event: { input: unknown },
  scope: string[],
  cwd: string,
): BlockResult | undefined {
  const input = event.input as { paths?: string | string[] };
  const paths = !input.paths ? [] : Array.isArray(input.paths) ? input.paths : [input.paths];

  // No paths specified → searches workspace root, always allowed
  if (paths.length === 0) return undefined;

  // "all" scope → all paths allowed (sentinel from ModeState.getScope)
  if (scope[0] === "all") return undefined;

  const outOfScope = paths.filter((p) => !isPathInScope(p, scope, cwd));
  if (outOfScope.length === 0) return undefined;

  return {
    block: true,
    reason: `Search path(s) outside allowed scope: ${outOfScope.join(", ")}.\n\nAllowed search paths:\n${buildScopeGuide(scope)}`,
    hint: "use_alternative",
    alternatives: ["Retry with paths scoped to the above directories", "Use /readonly <path> to expand scope"],
  };
}

export function checkLsp(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { action?: string; apply?: boolean };

  if (input.action === "rename" || input.action === "rename_file") {
    return {
      block: true,
      reason: `LSP '${input.action}' would modify files.`,
      hint: "use_alternative",
      alternatives: ["lsp definition", "lsp hover", "lsp references", "lsp symbols", "lsp diagnostics"],
    };
  }

  if (input.action === "code_actions" && input.apply) {
    return {
      block: true,
      reason: "LSP code_actions with apply may modify files.",
      hint: "use_alternative",
      alternatives: ["Use lsp code_actions without apply to list available fixes"],
    };
  }

  return undefined;
}

export function checkBrowser(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { action?: string };

  if (input.action === "run") {
    return {
      block: true,
      reason: "Browser 'run' can interact with pages.",
      hint: "use_alternative",
      alternatives: ["browser open", "browser close"],
    };
  }

  return undefined;
}

export function checkTask(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { agent?: string; tasks?: unknown[] };
  const agent = input.agent;

  // No agent specified — block (shouldn't happen, but safe)
  if (!agent) {
    return {
      block: true,
      reason: "Tool 'task' can spawn sub-agents that write files.",
      hint: "switch_to_build",
    };
  }

  // Read-only agents — allow
  if (READONLY_TASK_AGENTS.has(agent)) {
    return undefined;
  }

  // Agents with a read-only alternative
  if (HAS_ALTERNATIVE_AGENTS.has(agent)) {
    return {
      block: true,
      reason: `Agent '${agent}' can write files.`,
      hint: "use_alternative",
      alternatives: ["Use `explore` agent for code investigation", "Use read/search/find tools directly"],
    };
  }

  // All other agents — no read-only alternative
  return {
    block: true,
    reason: `Agent '${agent}' can write files.`,
    hint: "switch_to_build",
  };
}

// ============================================================
// Debug mode check functions
// ============================================================

export function checkDebugBash(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { command?: string };
  const command = (input.command ?? "").trim();
  if (!command) return { block: true, reason: "Empty bash command.", hint: "silent" };

  // 1. Block command chaining
  if (BASH_BLOCKED_CHAIN.test(command)) {
    return {
      block: true,
      reason: "Command chaining (&&, ||, ;, \`, $()) is not allowed in Debug mode.",
      hint: "use_alternative",
      alternatives: ["Run one command at a time"],
    };
  }

  // 2. Block output redirection
  if (BASH_BLOCKED_REDIRECT.test(command) || BASH_BLOCKED_TEE.test(command)) {
    return {
      block: true,
      reason: "Output redirection (>, >>, &>, | tee) is not allowed in Debug mode.",
      hint: "use_alternative",
      alternatives: ["Use the read or write tool instead"],
    };
  }

  // 3. Block destructive commands
  for (const pattern of DEBUG_BASH_BLOCKED) {
    if (pattern.test(command)) {
      return {
        block: true,
        reason: "Destructive command blocked in Debug mode.",
        hint: "silent",
      };
    }
  }

  return undefined;
}

export function checkDebugTask(event: { input: unknown }): BlockResult | undefined {
  const input = event.input as { agent?: string; tasks?: unknown[] };
  const agent = input.agent;

  if (!agent) {
    return {
      block: true,
      reason: "Tool 'task' can spawn sub-agents.",
      hint: "switch_to_build",
    };
  }

  if (DEBUG_TASK_AGENTS.has(agent)) {
    return undefined;
  }

  return {
    block: true,
    reason: `Agent '${agent}' can write files. Debug mode allows: ${[...DEBUG_TASK_AGENTS].join(", ")}.`,
    hint: "use_alternative",
    alternatives: ["Use `explore` for investigation", "Use `oracle` for analysis"],
  };
}
