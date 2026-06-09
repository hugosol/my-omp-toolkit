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
export const BASH_BLOCKED_REDIRECT = /[>&]+\s*(?:>>?)/;
export const BASH_BLOCKED_TEE = /\|\s*tee\b/;

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
// Tool policies (declarative)
// ============================================================

export type PolicyType = "allow" | "block" | "path_check" | "bash_check" | "lsp_check" | "browser_check" | "task_check";

export type BlockHint = "switch_to_build" | "use_alternative" | "none";

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
  write:    { type: "block", reason: "Tool 'write' requires Build mode.", hint: "switch_to_build" },
  edit:     { type: "block", reason: "Tool 'edit' requires Build mode.", hint: "switch_to_build" },
  ast_edit: { type: "block", reason: "Tool 'ast_edit' requires Build mode.", hint: "switch_to_build" },
  eval:     { type: "block", reason: "Tool 'eval' is blocked in read-only mode (can execute arbitrary code).", hint: "switch_to_build" },
  task:     { type: "task_check" },
  debug:    { type: "block", reason: "Tool 'debug' is blocked in read-only mode (can modify program state).", hint: "switch_to_build" },

  // Per-call checks
  search:   { type: "path_check" },
  find:     { type: "path_check" },
  ast_grep: { type: "path_check" },
  bash:     { type: "bash_check" },
  lsp:      { type: "lsp_check" },
  browser:  { type: "browser_check" },
};

export const DEFAULT_POLICY: ToolPolicy = {
  type: "block",
  reason: "Unknown tool — blocked in read-only mode.",
  hint: "switch_to_build",
};

/** Format a BlockResult into the final { block, reason } shape the framework expects. */
export function formatBlock(r: BlockResult): { block: true; reason: string } {
  let suffix = "";
  if (r.hint === "switch_to_build") {
    suffix = "\n→ Use /readonly to switch to Build mode.";
  } else if (r.hint === "use_alternative" && r.alternatives?.length) {
    suffix = `\n→ Instead try: ${r.alternatives.join("; ")}.`;
  }
  return { block: true, reason: r.reason + suffix };
}
