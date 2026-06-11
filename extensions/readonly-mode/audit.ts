/**
 * Debug audit trail — tracks non-readonly operations per turn.
 * Renders via setWidget for reliable updates.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================
// Audit entry
// ============================================================

export interface AuditEntry {
  tool: string;
  detail: string;
}

// ============================================================
// Module state
// ============================================================

let entries: AuditEntry[] = [];
let expanded = false;
let currentCtx: ExtensionContext | null = null;

// ============================================================
// Public API
// ============================================================

export function recordAudit(tool: string, detail: string): void {
  entries.push({ tool, detail });
  if (expanded) renderWidget();
}

export function clearAudit(): void {
  entries = [];
  if (expanded) renderWidget();
}

export function toggleAudit(ctx: ExtensionContext): void {
  currentCtx = ctx;
  expanded = !expanded;
  if (expanded) {
    renderWidget();
  } else {
    renderCollapsed();
  }
}

export function setAuditCtx(ctx: ExtensionContext): void {
  currentCtx = ctx;
}

export function showCollapsed(): void {
  expanded = false;
  renderCollapsed();
}

// ============================================================
// Widget rendering
// ============================================================

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";

function renderCollapsed(): void {
  if (!currentCtx) return;
  const count = entries.length;
  if (count === 0) {
    currentCtx.ui.setWidget("debug-audit", undefined);
  } else {
    currentCtx.ui.setWidget("debug-audit", [
      `${YELLOW}Debug Audit: ${count} op${count !== 1 ? "s" : ""}${RESET}  ${DIM}| /readonly audit to expand${RESET}`,
    ]);
  }
}

function renderWidget(): void {
  if (!currentCtx) return;
  const lines: string[] = [];

  if (entries.length === 0) {
    lines.push(`${DIM}Debug Audit: no operations recorded${RESET}`);
  } else {
    const bar = `${YELLOW}\u250c${"\u2500".repeat(10)} Debug Audit ${"\u2500".repeat(38)}${RESET}`;
    lines.push(bar.slice(0, 80));

    for (const e of entries) {
      const icon = toolIcon(e.tool);
      const toolLabel = `${icon} ${e.tool}`.padEnd(20);
      lines.push(`${YELLOW}\u2502${RESET} ${toolLabel} ${DIM}${e.detail.slice(0, 54)}${RESET}`);
    }

    const bottom = `${YELLOW}\u2514${"\u2500".repeat(60)}${RESET}`;
    lines.push(bottom.slice(0, 80));
  }

  lines.push(`${DIM}  /readonly audit to collapse${RESET}`);
  currentCtx.ui.setWidget("debug-audit", lines);
}

function toolIcon(tool: string): string {
  switch (tool) {
    case "write":    return `${GREEN}+`;
    case "edit":     return `${YELLOW}~`;
    case "ast_edit": return `${YELLOW}~`;
    case "bash":     return `${CYAN}>`;
    case "eval":     return `${MAGENTA}{}`;
    case "debug":    return `${RED}\u25b6`;
    case "browser":  return `${BLUE}\u25a0`;
    default:         return "  ";
  }
}
