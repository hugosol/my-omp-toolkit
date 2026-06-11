import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { formatBlock } from "./policies";
import type { BlockResult } from "./policies";

import { checkBash, checkDebugBash, checkSearchPaths, checkLsp, checkBrowser, checkTask, checkDebugTask } from "./checks";

import { CLEANUP_HISTORY } from "./prompts";

import { recordAudit, clearAudit, toggleAudit, showCollapsed, setAuditCtx } from "./audit";

import { ModeState, MODES } from "./mode";

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
    if (mode.current === "debug") {
      showCollapsed();
    } else {
      clearAudit();
      showCollapsed();
    }
  }

  pi.setLabel("Read-only Mode");

  // Default state: Build (read-write)
  pi.on("session_start", async (_event, ctx) => {
    mode.current = "build";
    mode.scopePaths = [];
    applyWidget(ctx);
  });

  pi.registerCommand("readonly", {
    description: "Toggle read-only mode. /readonly debug: enter Debug mode. /readonly audit: toggle audit trail. /readonly all: allow all paths. /readonly <paths...>: allow specific paths.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (argLower === "debug") {
        mode.current = "debug";
        mode.scopePaths = ["all"];
        applyWidget(ctx);
        ctx.ui.notify("\x1b[33mDebug mode on — expanded read/execute, write OK for instrumentation\x1b[0m", "info");
        return;
      }

      if (argLower === "audit") {
        if (mode.current !== "debug") {
          ctx.ui.notify("Audit trail is only available in Debug mode. Use /readonly debug first.", "warning");
          return;
        }
        toggleAudit(ctx);
        return;
      }

      if (!arg) {
        // Toggle: debug/chat/explore → build; build → chat
        if (mode.current === "build") {
          mode.current = "chat";
          mode.scopePaths = [];
        } else {
          mode.current = "build";
          mode.scopePaths = [];
        }
        applyWidget(ctx);
      } else if (argLower === "all") {
        mode.current = "explore";
        mode.scopePaths = ["all"];
        applyWidget(ctx);
      } else if (argLower === "clear") {
        mode.current = "chat";
        mode.scopePaths = [];
        applyWidget(ctx);
      } else if (argLower.startsWith("add ")) {
        const toAdd = arg.slice(4).trim();
        if (!toAdd) {
          ctx.ui.notify("Usage: /readonly add <path>", "error");
          return;
        }
        mode.scopePaths = [...mode.scopePaths.filter(p => p !== "all"), toAdd];
        mode.current = "explore";
        applyWidget(ctx);
      } else if (argLower.startsWith("remove ")) {
        const toRemove = arg.slice(7).trim();
        if (!toRemove) {
          ctx.ui.notify("Usage: /readonly remove <path>", "error");
          return;
        }
        mode.scopePaths = mode.scopePaths.filter(p => p !== "all" && p !== toRemove);
        mode.current = "explore";
        applyWidget(ctx);
      } else {
        // Space-separated paths: replace existing overrides
        const paths = arg.split(/\s+/).filter(p => p.length > 0);
        mode.current = "explore";
        mode.scopePaths = paths;
        applyWidget(ctx);
      }

      ctx.ui.notify(`${mode.def.color}${mode.label} mode on\x1b[0m`, "info");
    },
  });

  // Inject mode declaration per configuration
  pi.on("before_agent_start", async (event, ctx) => {
    // Clear previous turn's audit entries (only agent turns, not commands)
    if (mode.current === "debug") clearAudit();

    const injection = mode.beginTurn(ctx.cwd);
    if (!injection) return;

    if (injection.kind === "system_prompt") {
      return { systemPrompt: [...event.systemPrompt, injection.content] };
    }
    return { message: { customType: injection.customType, content: injection.content, display: false } };
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
    // Build mode: no interception
    if (mode.current === "build") return;

    const policy = mode.resolveToolPolicy(event.toolName);

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
        raw = checkSearchPaths(event, mode.getScope(ctx.cwd), ctx.cwd);
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
    if (mode.current === "debug" && !raw && !isReadonlyAuditTool(event.toolName)) {
      recordAudit(event.toolName, auditDetail(event.toolName, event.input));
    }

    if (!raw) return;
    return formatBlock(raw);
  });
}
