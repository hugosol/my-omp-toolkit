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

// When using "message_on_transition": re-inject after N same-mode turns to refresh
// model attention during long conversations. 0 = never re-inject.
export const REINJECT_INTERVAL = 0;

// Filter stale mode-context messages from history via "context" event.
// WARNING: breaks DeepSeek prefix cache (history prefix changes every turn).
export const CLEANUP_HISTORY = false;

// ============================================================
// Mode-specific system prompts
// ============================================================

export const BUILD_SYSTEM_PROMPT = `[BUILD MODE ACTIVE]
You are in Build mode with full access. No tool restrictions apply.`;

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
