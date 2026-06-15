import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";


import { CLEANUP_HISTORY } from "./prompts";

import { recordAudit, clearAudit, toggleAudit, showCollapsed, setAuditCtx } from "./audit";

import { ModeState, MODES, dispatchToolCall } from "./mode";

// ============================================================
// Audit helpers
// ============================================================

/** Write-capable tools — those that can mutate state and deserve audit recording.
 *  Derived from TOOL_POLICIES: block-type tools + check-type tools that can write. */
function isWriteTool(tool: string): boolean {
  const writeTools = new Set([
    "write", "edit", "ast_edit", "eval", "debug",
    "bash", "task", "browser", "lsp",
  ]);
  return writeTools.has(tool);
}

/** Extract unique file paths from hashline [PATH#TAG] headers in an input string. */
function extractHashlinePaths(input: string): string[] {
  const paths = new Set<string>();
  for (const m of input.matchAll(/^\[([^#\r\n]+)#/gm)) {
    paths.add(m[1]);
  }
  return [...paths];
}

/** Extract a human-readable detail string from tool input. */
function auditDetail(tool: string, input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return "";
  switch (tool) {
    case "write":
      return (inp.path as string) ?? "";
    case "edit": {
      if (typeof inp.path === "string") return inp.path;
      if (typeof inp.input === "string") {
        const paths = extractHashlinePaths(inp.input);
        return paths.join(", ") || "";
      }
      return "";
    }
    case "ast_edit":
      if (Array.isArray(inp.paths)) return (inp.paths as string[]).join(", ");
      return "";
    case "bash":
      return (inp.command as string)?.slice(0, 80) ?? "";
    case "eval": {
      const cells = inp.cells as Array<{ language?: string }> | undefined;
      if (cells?.length) {
        const lang = cells[0].language ?? "?";
        return cells.length === 1 ? `${lang} (1 cell)` : `${lang} (${cells.length} cells)`;
      }
      return "";
    }
    case "browser": {
      const action = inp.action as string | undefined;
      if (action === "run") return "run";
      return `${action ?? ""} ${inp.url ?? ""}`.trim().slice(0, 60);
    }
    case "debug":
      return `${inp.action ?? ""} ${inp.program ?? ""}`.trim().slice(0, 60);
    case "task":
      return `agent: ${inp.agent ?? "?"} \u2014 ${((inp.assignment as string) ?? "").slice(0, 50)}`;
    case "lsp": {
      const lspAction = inp.action as string | undefined;
      const file = (inp.file as string) ?? "";
      if (lspAction === "rename") {
        const newName = (inp.new_name as string) ?? "?";
        return `rename ${file} \u2192 ${newName}`;
      }
      if (lspAction === "code_actions" && inp.apply) {
        const codeAction = (inp.query as string) ?? "apply";
        return `code_actions:apply: ${codeAction} ${file}`.trim();
      }
      return `${lspAction ?? ""} ${file}`.trim().slice(0, 60);
    }
    default:
      return "";
  }
}

// ============================================================
// Main extension
// ============================================================

export default function readonlyMode(pi: ExtensionAPI) {
  const mode = new ModeState();

  // ──  Apply mode patch + widget side-effects  ──
  function applyWidget(ctx: ExtensionContext): void {
    const { label, color } = mode;
    ctx.ui.setWidget("readonly-mode", [
      `${color}┌${"\u2500".repeat(label.length)}┐\x1b[0m`,
      `${color}│${label}│\x1b[0m`,
      `${color}└${"\u2500".repeat(label.length)}┘\x1b[0m`,
    ]);
    setAuditCtx(ctx);
    showCollapsed();
  }

  pi.setLabel("Read-only Mode");

  // Default state: Build (read-write)
  pi.on("session_start", async (_event, ctx) => {
    mode.current = "build";
    applyWidget(ctx);
  });

  pi.registerCommand("readonly", {
    description: "Toggle read-only mode. /readonly debug: enter Debug mode. /readonly audit: toggle audit trail.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (argLower === "debug") {
        mode.current = "debug";
        applyWidget(ctx);
        ctx.ui.notify("\x1b[33mDebug mode on — expanded read/execute, write OK for instrumentation\x1b[0m", "info");
        return;
      }

      if (argLower === "audit") {
        toggleAudit(ctx);
        return;
      }

      // Toggle: build ↔ explore; any non-build → build
      if (mode.current === "build") {
        mode.current = "explore";
      } else {
        mode.current = "build";
      }
      applyWidget(ctx);

      ctx.ui.notify(`${mode.def.color}${mode.label} mode on\x1b[0m`, "info");
    },
  });

  // Inject mode declaration per configuration
  pi.on("before_agent_start", async (event, ctx) => {
    // Clear previous turn's audit entries (only agent turns, not commands)
    clearAudit();

    const injection = mode.buildInjection();
    if (!injection) return;

    return {
      systemPrompt: injection.systemPrompt
        ? [...event.systemPrompt, injection.systemPrompt]
        : undefined,
      message: injection.message
        ? { ...injection.message, display: false }
        : undefined,
    };
  });

  if (CLEANUP_HISTORY) {
    const MODE_TYPES = Object.values(MODES).map(d => d.customType);
    pi.on("context", async event => {
      const currentType = mode.def.customType;
      return {
        messages: event.messages.filter(m =>
          m.role !== "custom" || !MODE_TYPES.includes(m.customType) || m.customType === currentType,
        ),
      };
    });
  }

  // Unified tool call interception
  pi.on("tool_call", async (event, ctx) => {
    const result = dispatchToolCall(event, mode, ctx.cwd);

    if (isWriteTool(event.toolName)) {
      recordAudit(
        event.toolName,
        auditDetail(event.toolName, event.input),
        result.block !== undefined,
      );
    }

    return result.block;
  });
}
