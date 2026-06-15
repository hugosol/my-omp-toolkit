/**
 * Audit trail — tracks write-capable operations per turn.
 * Renders via setWidget for reliable updates, all modes.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================
// Audit entry
// ============================================================

export interface AuditEntry {
  tool: string;
  detail: string;
  blocked: boolean;
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

export function recordAudit(tool: string, detail: string, blocked: boolean): void {
  entries.push({ tool, detail, blocked });
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
const GRAY = "\x1b[90m";

const WIDGET_SLOT = "audit-bar";

/** File-modifying tools whose entries merge by file path. */
const FILE_TOOLS = new Set(["write", "edit", "ast_edit"]);

// ──  Collapsed widget (always shown)  ──

function renderCollapsed(): void {
  if (!currentCtx) return;
  const count = entries.length;
  if (count === 0) {
    currentCtx.ui.setWidget(WIDGET_SLOT, [
      `${DIM}Audit: \u2014${RESET}`,
    ]);
  } else {
    const blockedCount = entries.filter(e => e.blocked).length;
    let text = `${YELLOW}${count} write${count !== 1 ? "s" : ""} this turn${RESET}`;
    if (blockedCount > 0) {
      text += `  ${RED}(${blockedCount} blocked)${RESET}`;
    }
    text += `  ${DIM}| /readonly audit to expand${RESET}`;
    currentCtx.ui.setWidget(WIDGET_SLOT, [text]);
  }
}

// ──  Expanded widget  ──

function renderWidget(): void {
  if (!currentCtx) return;
  const lines: string[] = [];

  if (entries.length === 0) {
    lines.push(`${DIM}Audit: no operations recorded${RESET}`);
  } else {
    const bar = `${YELLOW}\u250c${"\u2500".repeat(10)} Audit ${"\u2500".repeat(44)}${RESET}`;
    lines.push(bar.slice(0, 80));

    const { merged, standalone } = partition(entries);

    // Merged file entries first
    for (const { path, tools, blocked, count } of merged) {
      const blockedTag = blocked ? `  ${RED}[\u2717 blocked]${RESET}` : "";
      const toolList = tools.join(", ");
      const countStr = count > 1 ? `  ${count} ops` : "";
      const detail = `${DIM}${path}${RESET}  ${GREEN}(${toolList})${RESET}${countStr}${blockedTag}`;
      lines.push(`${YELLOW}\u2502${RESET} ${detail.slice(0, 70)}`);
    }

    // Standalone (non-mergeable) entries
    for (const e of standalone) {
      const icon = toolIcon(e.tool);
      const blockedMark = e.blocked ? `${RED}\u2717${RESET}` : " ";
      const toolLabel = `${blockedMark}${icon} ${e.tool}`.padEnd(22);
      lines.push(`${YELLOW}\u2502${RESET} ${toolLabel} ${DIM}${e.detail.slice(0, 46)}${RESET}`);
    }

    const bottom = `${YELLOW}\u2514${"\u2500".repeat(60)}${RESET}`;
    lines.push(bottom.slice(0, 80));
  }

  lines.push(`${DIM}  /readonly audit to collapse${RESET}`);
  currentCtx.ui.setWidget(WIDGET_SLOT, lines);
}

// ──  Partition: merge file-tool entries by path, keep rest standalone  ──

interface MergedEntry {
  path: string;
  tools: string[];
  blocked: boolean;
  count: number;
}

function partition(entries: AuditEntry[]): {
  merged: MergedEntry[];
  standalone: AuditEntry[];
} {
  const mergedMap = new Map<string, MergedEntry>();
  const standalone: AuditEntry[] = [];

  for (const e of entries) {
    if (FILE_TOOLS.has(e.tool) && e.detail) {
      // Split multi-path entries (ast_edit with multiple paths)
      const paths = e.detail.split(", ").filter(p => p.length > 0);
      if (paths.length > 0) {
        for (const p of paths) {
          const existing = mergedMap.get(p);
          if (existing) {
            if (!existing.tools.includes(e.tool)) existing.tools.push(e.tool);
            existing.count++;
            existing.blocked = existing.blocked || e.blocked;
          } else {
            mergedMap.set(p, { path: p, tools: [e.tool], blocked: e.blocked, count: 1 });
          }
        }
        continue;
      }
    }
    standalone.push(e);
  }

  return { merged: [...mergedMap.values()], standalone };
}

// ──  Tool icons  ──

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
