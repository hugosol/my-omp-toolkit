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

export const BASH_READONLY_PATTERN = new RegExp(
  `^(?:command\\s+(?:-v\\s+)?)?(?:sudo\\s+)?(?:${buildAlt(READONLY_COMMANDS)})\\b`,
);

export const GIT_READONLY_PATTERN = new RegExp(
  `^(?:sudo\\s+)?git\\s+(?:${buildAlt(GIT_READONLY_SUBCOMMANDS)})\\b`,
);

export const ECO_READONLY_PATTERN = new RegExp(
  `^(?:sudo\\s+)?(?:${
    Object.entries(ECO_READONLY)
      .map(([cmd, subs]) => `${cmd}\\s+(?:${buildAlt(subs as readonly string[])})`)
      .join("|")
  })\\b`,
);
// Blocked patterns: command chaining
export const BASH_BLOCKED_CHAIN = /&&|\|\||;\s*\S|`|\$\(/;
// Blocked patterns: output redirection
export const BASH_BLOCKED_REDIRECT = /\s[>&]+\s*[^>&\s]/;
export const BASH_BLOCKED_TEE = /\|\s*tee\b/;

// ============================================================
// Debug mode — destructive bash patterns (core protection)
// ============================================================

/** Patterns that are blocked in Debug mode — destructive operations only. */
export const DEBUG_BASH_BLOCKED: RegExp[] = [
  // File/directory destruction
  /^(?:\s*sudo\s+)?rm\b/,
  /^(?:\s*sudo\s+)?rmdir\b/,
  /^(?:\s*sudo\s+)?mv\b/,
  /^(?:\s*sudo\s+)?mkdir\b/,
  /^(?:\s*sudo\s+)?touch\b/,
  /^(?:\s*sudo\s+)?chmod\b/,
  /^(?:\s*sudo\s+)?chown\b/,
  /^(?:\s*sudo\s+)?chgrp\b/,
  /^(?:\s*sudo\s+)?truncate\b/,
  /^(?:\s*sudo\s+)?dd\b/,
  /^(?:\s*sudo\s+)?shred\b/,
  /^(?:\s*sudo\s+)?ln\b/,
  /^(?:\s*sudo\s+)?cp\b/,
  // Git destructive subcommands
  /^(?:\s*sudo\s+)?git\s+(?:push|commit|merge|rebase|reset\s+--hard|tag\s+-d|checkout\s+-b|branch\s+-D|stash\s+drop|stash\s+clear)\b/,
  // In-place editing
  /^(?:\s*sudo\s+)?sed\b.*-i\b/,
  // Package management (install / remove deps changes the project)
  /^(?:\s*sudo\s+)?(?:npm|yarn|pnpm|pip|pip3|apt|apt-get|brew|cargo)\s+(?:install|uninstall|update|upgrade|remove|purge|add|publish|ci)\b/,
];


// ============================================================
// Task agent whitelist — agents allowed in read-only mode
// ============================================================

/** Agent names whose declared tools are all read-only or whose
 *  prompt constrains them to read-only project operations. */
export const READONLY_TASK_AGENTS = new Set([
  "explore",
  "librarian",
  "plan",
  "reviewer",
]);

/** Agents that have a read-only alternative (explore). */
export const HAS_ALTERNATIVE_AGENTS = new Set([
  "task",
  "quick_task",
]);

// ============================================================
// Debug-mode task agent whitelist
// ============================================================

/** Agents allowed in Debug mode. Adds oracle for reasoning/analysis. */
export const DEBUG_TASK_AGENTS = new Set([
  "explore",
  "librarian",
  "plan",
  "reviewer",
  "oracle",
]);

// ============================================================
// Tool policies (declarative)
// ============================================================

export type PolicyType = "allow" | "block" | "path_check" | "bash_check" | "lsp_check" | "browser_check" | "task_check" | "debug_bash_check" | "debug_task_check";

export type BlockHint = "switch_to_build" | "use_alternative" | "silent";

export interface BlockResult {
  block: true;
  reason: string;
  hint: BlockHint;
  alternatives?: string[];
}

interface ToolPolicy {
  type: PolicyType;
  reason?: string;
  hint?: BlockHint;
  alternatives?: string[];
}

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // Full allow — tools the model can use freely
  web_search: { type: "allow" },
  ask:        { type: "allow" },
  todo:       { type: "allow" },
  read:       { type: "allow" },
  resolve:    { type: "allow" },

  // Block — write / exec tools (Tier 1: no readonly alternative)
  write:    { type: "block", reason: "Tool 'write' modifies files.", hint: "switch_to_build" },
  edit:     { type: "block", reason: "Tool 'edit' modifies files.", hint: "switch_to_build" },
  ast_edit: { type: "block", reason: "Tool 'ast_edit' modifies files.", hint: "switch_to_build" },
  eval:     { type: "block", reason: "Tool 'eval' can execute arbitrary code.", hint: "switch_to_build" },
  task:     { type: "task_check" },
  debug:    { type: "block", reason: "Tool 'debug' can modify program state.", hint: "switch_to_build" },

  // Per-call checks
  search:   { type: "path_check" },
  find:     { type: "path_check" },
  ast_grep: { type: "path_check" },
  bash:     { type: "bash_check" },
  lsp:      { type: "lsp_check" },
  browser:  { type: "browser_check" },
};

// ============================================================
// Debug mode tool policies — overrides for expanded access
// ============================================================

export const DEBUG_TOOL_POLICIES: Record<string, ToolPolicy> = {
  // Allow write/edit for temporary instrumentation (prompt-level constraint)
  write:    { type: "allow" },
  edit:     { type: "allow" },
  ast_edit: { type: "allow" },
  eval:     { type: "allow" },
  debug:    { type: "allow" },

  // Bash: core protection against destructive ops
  bash:     { type: "debug_bash_check" },

  // Task: expanded whitelist (oracle added)
  task:     { type: "debug_task_check" },

  // Browser: allow run for simulating user operations
  browser:  { type: "allow" },

  // Scope: all paths allowed, no path checking needed
  search:   { type: "allow" },
  find:     { type: "allow" },
  ast_grep: { type: "allow" },
};

export const DEFAULT_POLICY: ToolPolicy = {
  type: "block",
  reason: "Unknown tool — not available in read-only mode.",
  hint: "switch_to_build",
};

/** Format a BlockResult into the final { block, reason } shape the framework expects. */
export function formatBlock(r: BlockResult): { block: true; reason: string } {
  let suffix = "";
  if (r.hint === "switch_to_build") {
    suffix = "\n→ Ask the user to switch to Build mode with /readonly.";
  } else if (r.hint === "use_alternative" && r.alternatives?.length) {
    suffix = `\n→ Instead try: ${r.alternatives.join("; ")}.`;
  }
  return { block: true, reason: "Blocked. " + r.reason + suffix };
}
