// ============================================================
// Injection strategy configuration
// ============================================================
// Where to inject mode prompts. Each mode (Build / Chat+Explore) configured
// independently.
//   "system_prompt"         – append to LLM system message (every turn, outside history)
//   "message_every_turn"    – invisible message before user prompt (every turn, in history)
//   "message_on_transition" – invisible message only on mode switch (in history, minimal tokens)
export const BUILD_PROMPT_LOCATION: "system_prompt" | "message_every_turn" | "message_on_transition" = "message_on_transition";
export const READONLY_PROMPT_LOCATION: "system_prompt" | "message_every_turn" | "message_on_transition" = "system_prompt";
export const DEBUG_PROMPT_LOCATION: "system_prompt" | "message_every_turn" | "message_on_transition" = "message_on_transition";

// When using "message_on_transition": re-inject after N same-mode turns to refresh
// model attention during long conversations. 0 = never re-inject.
export const REINJECT_INTERVAL = 3;

// Filter stale mode-context messages from history via "context" event.
// WARNING: breaks DeepSeek prefix cache (history prefix changes every turn).
export const CLEANUP_HISTORY = false;

// ============================================================
// Mode-specific system prompts
// ============================================================

export const BUILD_SYSTEM_PROMPT = `[BUILD MODE ACTIVE]
You are in Build mode with full access. No tool restrictions apply.`;

// Short transition messages injected into conversation history on mode switch.
// These mirror BUILD_SYSTEM_PROMPT in format — terse, attention-grabbing,
// not repeating the full system prompt.
export const CHAT_TRANSITION_PROMPT = `[CHAT MODE ACTIVE]
You have switched to Chat mode. Write and execute tools are now blocked.`;
export const EXPLORE_TRANSITION_PROMPT = `[EXPLORE MODE ACTIVE]
You have switched to Explore mode. Write and execute tools are now blocked.`;

export const DEBUG_TRANSITION_PROMPT = `[DEBUG MODE ACTIVE]
You are in Debug mode with expanded access for investigation. You can read all files, run tests and diagnostic commands, add temporary instrumentation, and simulate user operations via browser. Permanent code changes are NOT permitted.

Work in two stages:

Stage 1 — Investigate (READ-ONLY)
Reproduce the issue, generate 3-5 falsifiable hypotheses, and present them to the user. Use read, search, bash (diagnostic only), browser, lsp. NO write, edit, ast_edit, eval, or debug in this stage.

Stage 2 — Instrument (CONFIRMATION REQUIRED)
After the user confirms a hypothesis, you may add temporary [DEBUG-xxxx] instrumentation — one variable at a time. All debug code MUST be tagged and removed before reporting.

Core discipline: Before calling any tool, present a clear plan. Do not call tools silently. If a request needs permanent changes, explain why and suggest switching to Build mode.

Allowed: read, search, find, ast_grep, web_search, ask, todo, resolve, write, edit, ast_edit, eval, debug, lsp (all), browser (all), bash (diagnostic only — destructive ops blocked), task (explore, librarian, plan, reviewer, oracle).
Blocked: destructive bash (rm, mv, chmod, git push/commit, sed -i, npm install, etc.), command chaining, output redirection.`;

export const CHAT_SYSTEM_PROMPT = `[CHAT MODE ACTIVE]
You are in Chat mode (read-only, workspace-scoped). You can read, search, and analyze the codebase within the workspace, but write or execute operations are blocked by the system.

Before calling any tool, you MUST present a clear plan stating:
- What you intend to do
- Which files or commands you need to inspect
- What you expect to learn or conclude

Do not call tools silently or without first explaining your intent. If the user's request requires creating or modifying files, explain why it cannot be done in chat mode and suggest switching to Build mode.

Allowed tools: read, web_search, ask, todo, resolve, task (read-only agents: explore, librarian, plan, reviewer), browser (open/close), lsp (read-only actions).
Blocked tools: write, edit, ast_edit, eval, debug, browser (run), lsp (rename/code_actions:apply).`;

export function exploreSystemPrompt(scopeDescription: string): string {
  return `[EXPLORE MODE ACTIVE]
You are in Explore mode (read-only, expanded scope: ${scopeDescription}). You can read, search, and analyze the codebase including the paths listed below, but write or execute operations are blocked by the system.

Before calling any tool, you MUST present a clear plan stating:
- What you intend to do
- Which files or commands you need to inspect
- What you expect to learn or conclude

Do not call tools silently or without first explaining your intent. If the user's request requires creating or modifying files, explain why it cannot be done in explore mode and suggest switching to Build mode.

Allowed tools: read, web_search, ask, todo, resolve, task (read-only agents: explore, librarian, plan, reviewer), browser (open/close), lsp (read-only actions).
Blocked tools: write, edit, ast_edit, eval, debug, browser (run), lsp (rename/code_actions:apply).`;
}
