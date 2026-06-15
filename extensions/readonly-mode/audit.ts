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
  refreshWidget();
}

export function clearAudit(): void {
  entries = [];
  refreshWidget();
}

export function toggleAudit(ctx: ExtensionContext): void {
  currentCtx = ctx;
  expanded = !expanded;
  refreshWidget();
}

export function setAuditCtx(ctx: ExtensionContext): void {
  currentCtx = ctx;
}

export function showCollapsed(): void {
  expanded = false;
  refreshWidget();
}

function refreshWidget(): void {
  if (!currentCtx) return;
  if (expanded) {
    renderWidget();
  } else {
    renderCollapsed();
  }
}

// ============================================================
// Widget rendering
// ============================================================

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const RED = "\x1b[31m";

const WIDGET_SLOT = "audit-bar";

/** File-modifying tools whose entries merge by file path. */
const FILE_TOOLS = new Set(["write", "edit"]);

// ── ANSI-aware width helpers ──

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function displayWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function termCols(): number {
  try {
    return process.stdout?.columns ?? 80;
  } catch {
    return 80;
  }
}

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
  const cols = termCols();
  const lines: string[] = [];

  // ── Empty state: frame with placeholder ──

  if (entries.length === 0) {
    const placeholder = `${DIM}(no operations recorded)${RESET}`;
    const prefix = `${YELLOW}\u2502${RESET}  `;
    const suffix = ` ${YELLOW}\u2502${RESET}`;
    const minW = displayWidth(prefix) + displayWidth(placeholder) + displayWidth(suffix);
    const fw = Math.min(Math.max(30, minW), cols);

    const dashRight = Math.max(0, fw - 19);
    lines.push(`${YELLOW}\u250c${"\u2500".repeat(10)} Audit ${"\u2500".repeat(dashRight)}\u2510${RESET}`);

    const pad = Math.max(0, fw - displayWidth(prefix) - displayWidth(placeholder) - displayWidth(suffix));
    lines.push(prefix + placeholder + " ".repeat(pad) + suffix);

    lines.push(`${YELLOW}\u2514${"\u2500".repeat(fw - 2)}\u2518${RESET}`);
    lines.push(`${DIM}  /readonly audit to collapse${RESET}`);
    currentCtx.ui.setWidget(WIDGET_SLOT, lines);
    return;
  }

  // ── First pass: measure raw lines to determine frame width ──

  const { merged, standalone } = partition(entries);
  const rawLines: string[] = [];

  for (const { path, tools, blocked, count } of merged) {
    const blockedPrefix = blocked ? `${RED}\u2717${RESET} ` : "";
    const leftCol = `${blockedPrefix}[${tools.join(", ")}]`.padEnd(22);
    const countStr = count > 1 ? ` (${count} ops)` : "";
    rawLines.push(`${YELLOW}\u2502${RESET} ${leftCol} ${DIM}${path}${RESET}${countStr}`);
  }

  for (const e of standalone) {
    const blockedMark = e.blocked ? `${RED}\u2717${RESET}` : " ";
    const toolLabel = `${blockedMark}${e.tool}`.padEnd(22);
    rawLines.push(`${YELLOW}\u2502${RESET} ${toolLabel} ${DIM}${e.detail}${RESET}`);
  }

  const maxRaw = Math.max(...rawLines.map(l => displayWidth(l)), 0);
  const fw = Math.min(Math.max(30, maxRaw + 2), cols); // +2 for right " \u2502"

  // ── Top border ──

  const dashRight = Math.max(0, fw - 19);
  lines.push(`${YELLOW}\u250c${"\u2500".repeat(10)} Audit ${"\u2500".repeat(dashRight)}\u2510${RESET}`);

  // ── Helper: pad a line to frame width ──

  function padLine(left: string, body: string): string {
    const suffix = ` ${YELLOW}\u2502${RESET}`;
    const avail = fw - displayWidth(left) - displayWidth(suffix);
    const bw = displayWidth(body);
    const pad = Math.max(0, avail - bw);
    return left + body + " ".repeat(pad) + suffix;
  }

  // ── Merged file entries ──

  for (const { path, tools, blocked, count } of merged) {
    const blockedPrefix = blocked ? `${RED}\u2717${RESET} ` : "";
    const leftCol = `${blockedPrefix}[${tools.join(", ")}]`.padEnd(22);
    const countStr = count > 1 ? ` (${count} ops)` : "";

    // Truncate path to fit available width
    const leftPart = `${YELLOW}\u2502${RESET} ${leftCol} `;
    const suffixW = 2; // " \u2502"
    const avail = fw - displayWidth(leftPart) - suffixW;
    const pathMax = avail - countStr.length;
    let displayPath = path;
    if (displayPath.length > pathMax && pathMax > 1) {
      displayPath = path.slice(0, pathMax - 1) + "\u2026";
    } else if (pathMax <= 1) {
      displayPath = "\u2026";
    }

    const body = `${DIM}${displayPath}${RESET}${countStr}`;
    lines.push(padLine(leftPart, body));
  }

  // ── Standalone entries ──

  for (const e of standalone) {
    const blockedMark = e.blocked ? `${RED}\u2717${RESET}` : " ";
    const toolLabel = `${blockedMark}${e.tool}`.padEnd(22);

    // Truncate detail to fit available width
    const leftPart = `${YELLOW}\u2502${RESET} ${toolLabel} `;
    const suffixW = 2; // " \u2502"
    const avail = fw - displayWidth(leftPart) - suffixW;
    let displayDetail = e.detail;
    if (displayDetail.length > avail && avail > 1) {
      displayDetail = e.detail.slice(0, avail - 1) + "\u2026";
    } else if (avail <= 1) {
      displayDetail = "\u2026";
    }

    const body = `${DIM}${displayDetail}${RESET}`;
    lines.push(padLine(leftPart, body));
  }

  // ── Bottom border ──

  lines.push(`${YELLOW}\u2514${"\u2500".repeat(fw - 2)}\u2518${RESET}`);

  // ── Hint ──

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


