import { isPathInScope, buildScopeGuide } from "./scope";

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
  "cd", "pushd", "popd",
  "codebase-memory-mcp",
] as const;

// --- Git blacklist — subcommands blocked in read-only mode ---
const GIT_BLOCKED_SUBCOMMANDS = new Set([
  "commit", "merge", "rebase", "cherry-pick", "revert", "am",
  "push", "pull",
  "add", "mv", "rm",
  "reset", "checkout", "switch", "restore",
  "stash",
  "tag",
  "branch",
  "worktree",
]);

// Multi-word subcommands that override the blacklist
const GIT_ALLOWED_MULTI = new Set([
  "stash list",
  "worktree list",
]);

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

/** Extract the git subcommand and its args, skipping global flags like -C, -c, --no-pager. */
function extractGitSubcommand(command: string): { subcommand: string; args: string[] } | null {
  const tokens = command.split(/\s+/);
  let i = 0;
  if (tokens[i] === "sudo") i++;
  if (i >= tokens.length || tokens[i] !== "git") return null;
  i++;
  // Skip global flags before subcommand
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const flag = tokens[i];
    if (flag === "-C" || flag === "-c") {
      i += 2; // flag + value
    } else if (flag.includes("=")) {
      i += 1; // --flag=value
    } else {
      i += 1; // boolean flag
    }
  }
  if (i >= tokens.length) return null;
  return { subcommand: tokens[i], args: tokens.slice(i + 1) };
}

/** Check whether a git command uses a blocked subcommand. Returns block result if blocked, undefined if allowed. */
function checkGitBlocked(command: string): BlockResult | undefined {
  const extracted = extractGitSubcommand(command);
  if (!extracted) return undefined; // not a git command

  const { subcommand, args } = extracted;
  const firstArg = args[0] ?? "";
  const fullCmd = firstArg ? `${subcommand} ${firstArg}` : subcommand;

  // Whitelist: multi-word reads
  if (GIT_ALLOWED_MULTI.has(fullCmd)) return undefined;

  // Whitelist: bare tag listing
  if (subcommand === "tag" && (args.length === 0 || firstArg === "-l" || firstArg === "--list")) return undefined;

  // Whitelist: bare branch listing
  if (subcommand === "branch" && (args.length === 0 || firstArg === "-l" || firstArg === "--list")) return undefined;

  // Blacklist check
  if (GIT_BLOCKED_SUBCOMMANDS.has(subcommand)) {
    return {
      block: true,
      reason: `Git subcommand '${subcommand}' is blocked in read-only mode.`,
      hint: "switch_to_build",
    };
  }

  // Default: allow (git log, git clone, git fetch, git remote, etc.)
  return undefined;
}

export const ECO_READONLY_PATTERN = new RegExp(
  `^(?:sudo\\s+)?(?:${
    Object.entries(ECO_READONLY)
      .map(([cmd, subs]) => `${cmd}\\s+(?:${buildAlt(subs as readonly string[])})`)
      .join("|")
  })\\b`,
);
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
  // File writing (tee, redirect helpers)
  /^(?:\s*sudo\s+)?tee\b/,
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
// Tool policies (declarative — each check-type carries its guard)
// ============================================================

export type PolicyType = "allow" | "block" | "check";

/** Prefix for codebase-memory MCP tools — all are treated as read-only. */
export const CODEBASE_MEMORY_PREFIX = "mcp__codebase_memory_mcp_";

export type BlockHint = "switch_to_build" | "use_alternative" | "silent";

export interface BlockResult {
  block: true;
  reason: string;
  hint: BlockHint;
  alternatives?: string[];
}

/** Context passed to check-type guards by the dispatch in index.ts. */
export interface CheckContext {
  scope: string[];
  cwd: string;
}

export interface ToolPolicy {
  type: PolicyType;
  /** For type="check": the guard function that inspects the event. */
  check?: (event: { input: unknown }, ctx: CheckContext) => BlockResult | undefined;
  reason?: string;
  hint?: BlockHint;
  alternatives?: string[];
}

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // Full allow — tools the model can use freely
  // Core tools
  web_search:       { type: "allow" },
  ask:              { type: "allow" },
  todo:             { type: "allow" },
  read:             { type: "allow" },
  grep:             { type: "allow" },
  glob:             { type: "allow" },
  resolve:          { type: "allow" },
  // Inter-agent communication & job management (omp READ_ONLY_TOOL_NAMES)
  irc:              { type: "allow" },
  job:              { type: "allow" },
  // Subagent output submission (internal)
  yield:            { type: "allow" },
  // Memory — read/write to agent memory, never project files
  recall:           { type: "allow" },
  reflect:          { type: "allow" },
  retain:           { type: "allow" },
  memory_edit:      { type: "allow" },
  // Visualization & inspection
  render_mermaid:   { type: "allow" },
  inspect_image:    { type: "allow" },
  // Conversation checkpoints / rewind (no file mutation)
  checkpoint:       { type: "allow" },
  rewind:           { type: "allow" },
  // Review & search utilities
  report_finding:   { type: "allow" },
  search_tool_bm25: { type: "allow" },

  // Block — write / exec tools (Tier 1: no readonly alternative)
  write:    { type: "block", reason: "Tool 'write' modifies files.", hint: "switch_to_build" },
  edit:     { type: "block", reason: "Tool 'edit' modifies files.", hint: "switch_to_build" },
  ast_edit: { type: "block", reason: "Tool 'ast_edit' modifies files.", hint: "switch_to_build" },
  eval:     { type: "block", reason: "Tool 'eval' can execute arbitrary code.", hint: "switch_to_build" },
  task:     { type: "check", check: checkTask },
  debug:    { type: "block", reason: "Tool 'debug' can modify program state.", hint: "switch_to_build" },

  // Per-call checks — each carries its own guard
  search:   { type: "check", check: checkSearchPaths },
  find:     { type: "check", check: checkSearchPaths },
  ast_grep: { type: "check", check: checkSearchPaths },
  bash:     { type: "check", check: checkBash },
  lsp:      { type: "check", check: checkLsp },
  browser:  { type: "check", check: checkBrowser },
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
  bash:     { type: "check", check: checkDebugBash },

  // Task: expanded whitelist (oracle added)
  task:     { type: "check", check: checkDebugTask },

  // Browser: allow run for simulating user operations
  browser:  { type: "allow" },

  // Scope: all paths allowed, no path checking needed
  search:   { type: "allow" },
  find:     { type: "allow" },
  ast_grep: { type: "allow" },
};

/** Debug mode inherits all readonly policies, with specific overrides on top. */
export const MERGED_DEBUG_POLICIES: Record<string, ToolPolicy> = {
  ...TOOL_POLICIES,
  ...DEBUG_TOOL_POLICIES,
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

// ============================================================
// Command splitting — chain operators, pipes, quoting
// ============================================================

/** Split a bash command on chain operators (&&, ||, ;) and pipes (|),
 *  respecting single/double quotes, backticks, and $(…) nesting. */
function splitCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Single quote: consume until closing '
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      current += end === -1 ? command.slice(i) : command.slice(i, end + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    // Double quote: consume until unescaped "
    if (ch === '"') {
      current += ch;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\') { current += command[i]; i++; }
        if (i < command.length) { current += command[i]; i++; }
      }
      if (i < command.length) { current += command[i]; i++; } // closing "
      continue;
    }

    // Backtick: consume until closing `
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      current += end === -1 ? command.slice(i) : command.slice(i, end + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    // $( — consume until matching )
    if (ch === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
        j++;
      }
      current += command.slice(i, j);
      i = j;
      continue;
    }

    // && operator
    if (ch === "&" && command[i + 1] === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    // || operator
    if (ch === "|" && command[i + 1] === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    // | (single pipe)
    if (ch === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    // ; separator (only when followed by non-whitespace — lone ; is harmless)
    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      // skip whitespace after ;
      while (i < command.length && /\s/.test(command[i])) i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Extract sub-commands from $(…) and backtick substitutions for separate validation. */
function extractSubCommands(cmd: string): string[] {
  const subs: string[] = [];
  let i = 0;

  while (i < cmd.length) {
    // Skip quoted regions
    if (cmd[i] === "'") {
      const end = cmd.indexOf("'", i + 1);
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }
    if (cmd[i] === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\') i++;
        i++;
      }
      if (i < cmd.length) i++; // closing "
      continue;
    }

    // $()
    if (cmd[i] === "$" && cmd[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
        j++;
      }
      const inner = cmd.slice(start, j - 1).trim();
      if (inner) subs.push(inner);
      i = j;
      continue;
    }

    // Backtick
    if (cmd[i] === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end !== -1) {
        const inner = cmd.slice(i + 1, end).trim();
        if (inner) subs.push(inner);
        i = end + 1;
        continue;
      }
    }

    i++;
  }

  return subs;
}

/** Validate a single command segment against all read-only policies. */
function checkSingleCommand(cmd: string): BlockResult | undefined {
  if (!cmd.trim()) return undefined;

  // Block output redirection
  if (BASH_BLOCKED_REDIRECT.test(cmd) || BASH_BLOCKED_TEE.test(cmd)) {
    return {
      block: true,
      reason: "Output redirection (>, >>, &>, | tee) is not allowed.",
      hint: "use_alternative",
      alternatives: ["Use the read tool to view file content", "Pipe to stdout without redirecting"],
    };
  }

  // Block tee (file-writing command, often used with pipes)
  if (/^\s*tee\b/.test(cmd)) {
    return {
      block: true,
      reason: "tee writes to files.",
      hint: "use_alternative",
      alternatives: ["Use the read tool to view content"],
    };
  }

  // Block sed -i (in-place editing)
  if (/^\s*sed\b/.test(cmd) && /\s-i\b/.test(cmd)) {
    return {
      block: true,
      reason: "sed -i performs in-place editing.",
      hint: "use_alternative",
      alternatives: ["Use sed without -i for read-only filtering"],
    };
  }

  // Git check (blacklist-based)
  if (/^(?:sudo\s+)?git\b/.test(cmd)) {
    const blocked = checkGitBlocked(cmd);
    if (blocked) return blocked;
    return undefined; // git command, allowed
  }

  // Whitelist check
  if (BASH_READONLY_PATTERN.test(cmd)) return undefined;
  if (ECO_READONLY_PATTERN.test(cmd)) return undefined;

  return {
    block: true,
    reason: "Command not in read-only whitelist. Allowed: ls, cat, grep, rg, find, stat, awk, jq, sed, git log/diff/show, npm ls, cargo tree, pip list, node --version, etc.",
    hint: "silent",
  };
}

// ============================================================
// Guard functions — each check-type tool carries one of these.
// Moved here from checks.ts so policy data and check logic live
// together. Adding a tool restriction = one table entry edit.
// ============================================================

export function checkBash(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
  const input = event.input as { command?: string };
  const command = (input.command ?? "").trim();
  if (!command) return { block: true, reason: "Empty bash command.", hint: "silent" };

  // 1. Split the command on chain operators and pipes
  const segments = splitCommands(command);

  // 2. Validate each segment AND any sub-commands within them
  for (const seg of segments) {
    const result = checkSingleCommand(seg);
    if (result) {
      // Add context about which segment failed
      result.reason = `Command segment "${seg.length > 60 ? seg.slice(0, 57) + "..." : seg}" blocked: ${result.reason.toLowerCase()}`;
      return result;
    }

    // Check $() and backtick sub-commands within this segment
    const subs = extractSubCommands(seg);
    for (const sub of subs) {
      const subResult = checkSingleCommand(sub);
      if (subResult) return subResult;
    }
  }

  return undefined; // all segments passed
}

export function checkSearchPaths(
  event: { input: unknown },
  ctx: CheckContext,
): BlockResult | undefined {
  const input = event.input as { paths?: string | string[] };
  const paths = !input.paths ? [] : Array.isArray(input.paths) ? input.paths : [input.paths];

  // No paths specified → searches workspace root, always allowed
  if (paths.length === 0) return undefined;

  // "all" scope → all paths allowed (sentinel from ModeState.getScope)
  if (ctx.scope[0] === "all") return undefined;

  const outOfScope = paths.filter((p) => !isPathInScope(p, ctx.scope, ctx.cwd));
  if (outOfScope.length === 0) return undefined;

  return {
    block: true,
    reason: `Search path(s) outside allowed scope: ${outOfScope.join(", ")}.\n\nAllowed search paths:\n${buildScopeGuide(ctx.scope)}`,
    hint: "use_alternative",
    alternatives: ["Retry with paths scoped to the above directories", "Use /readonly <path> to expand scope"],
  };
}

export function checkLsp(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
  const input = event.input as { action?: string; apply?: boolean };

  // Block write actions
  if (input.action === "rename") {
    return {
      block: true,
      reason: "LSP rename modifies files.",
      hint: "switch_to_build",
    };
  }
  if (input.action === "rename_file") {
    return {
      block: true,
      reason: "LSP rename_file modifies files.",
      hint: "switch_to_build",
    };
  }
  if (input.action === "code_actions" && input.apply === true) {
    return {
      block: true,
      reason: "LSP code_actions with apply=true modifies files.",
      hint: "switch_to_build",
    };
  }

  return undefined;
}

export function checkBrowser(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
  const input = event.input as { action?: string };

  if (input.action === "run") {
    return {
      block: true,
      reason: "Browser 'run' action can execute JS in a real tab. Use 'open'/'close' only.",
      hint: "use_alternative",
      alternatives: ["Use 'open' to view pages, 'close' to release tabs"],
    };
  }

  return undefined;
}

export function checkTask(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
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
// Debug mode guard functions
// ============================================================

export function checkDebugBash(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
  const input = event.input as { command?: string };
  const command = (input.command ?? "").trim();
  if (!command) return { block: true, reason: "Empty bash command.", hint: "silent" };

  // 1. Split on chain operators and pipes — each segment checked independently
  const segments = splitCommands(command);

  for (const seg of segments) {
    if (!seg.trim()) continue;

    // Block output redirection
    if (BASH_BLOCKED_REDIRECT.test(seg) || BASH_BLOCKED_TEE.test(seg)) {
      return {
        block: true,
        reason: "Output redirection (>, >>, &>, | tee) is not allowed in Debug mode.",
        hint: "use_alternative",
        alternatives: ["Use the read or write tool instead"],
      };
    }

    // Block destructive commands
    for (const pattern of DEBUG_BASH_BLOCKED) {
      if (pattern.test(seg)) {
        return {
          block: true,
          reason: "Destructive command blocked in Debug mode.",
          hint: "silent",
        };
      }
    }

    // Check $() and backtick sub-commands
    const subs = extractSubCommands(seg);
    for (const sub of subs) {
      for (const pattern of DEBUG_BASH_BLOCKED) {
        if (pattern.test(sub)) {
          return {
            block: true,
            reason: "Destructive sub-command blocked in Debug mode.",
            hint: "silent",
          };
        }
      }
    }
  }

  return undefined;
}

export function checkDebugTask(event: { input: unknown }, _ctx: CheckContext): BlockResult | undefined {
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
