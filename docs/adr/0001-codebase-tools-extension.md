# codeBaseTools: persisted hidden routing prompt behind a manual toggle

`codeBaseTools` is an independent Oh My Pi extension that makes the agent prefer the
codebase-memory-mcp graph tools and the native `lsp` tool for structural code
understanding, while keeping text tools for literal search. It injects its routing
text as a hidden, persisted developer-role message — the full `init` once per session,
then a short `reminder` on every enabled turn — rather than rewriting the host system
prompt (activating mid-session would invalidate the whole prefix cache, while a tail
insertion only adds new tokens) or blocking native tools (`grep` remains correct for
literal and exhaustive search). `/codebase-tools` toggles injection: off only stops
injecting and never erases history. A non-LLM session entry `{on, initInjected}`
restores both states on resume; the same text is injected for main sessions and
subagents, with no MCP/LSP capability split and no index probing.

## Considered options

- **System-prompt append** — rejected: correct only when set from the first turn;
  activating mid-session invalidates the entire prefix, which is exactly this case.
- **TTSR rules** — rejected: not an extension-owned mechanism, and its regex/AST
  trigger model cannot express tool-selection policy.
- **Blocking or rewriting native tool calls** — rejected: `grep` stays correct for
  literal, exhaustive, and non-code text search; blocking also discards context
  already collected for the call.
- **Ephemeral `context` injection** — rejected: never persisted, so it cannot be
  replayed on resume as required.
