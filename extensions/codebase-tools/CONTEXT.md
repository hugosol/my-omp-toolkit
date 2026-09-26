# codeBaseTools

An independent OMP extension that routes the agent's code exploration toward the
codebase-memory-mcp graph tools and LSP, leaving literal text search to the native
text tools. The user controls it per session with the `/codebase-tools` command.

## Language

**Routing prompt**:
A hidden instruction that maps each kind of code-understanding sub-question to the
evidence source that should answer it — graph for structure, LSP for type semantics,
text tools for literals.
_Avoid_: tool prompt, system prompt, policy text

**Init injection**:
The full routing prompt, injected once on a session's first enabled turn and kept
resident in that session's history from then on.
_Avoid_: bootstrap prompt, startup prompt, one-shot prompt

**Reminder injection**:
The one-line pointer injected on every enabled turn after init. It invokes the
`【codeBaseTools 路由】` token defined by init so the routing rule stays near the end
of the context; it carries no routing detail of its own.
_Avoid_: repeat prompt, per-turn prompt, heartbeat

**Toggle**:
The binary on/off state of `/codebase-tools`. Off means "stop injecting"; it never
erases history and never changes any other agent behavior.
_Avoid_: mode, enabled flag, on/off switch

**Injected message**:
A hidden message the extension adds to the conversation. It is recorded in session
history, replayed on resume, and read by the model as a developer-role instruction.
_Avoid_: system prompt, ephemeral context

**Session state**:
The non-LLM record holding whether the toggle is on and whether init has been
injected, so resume can restore both without re-reading the conversation.
_Avoid_: marker, checkpoint, cache
