# Glossary Map

## Contexts

- [Semantic Extension Framework](./docs/extension-generation/GLOSSARY.md): the planned cross-host runtime package, its control patterns, behavior library, and feature templates.
- [Model Cost Tracking](./extensions/model-cost/GLOSSARY.md): DeepSeek spend accounting and ChatGPT/Codex allowance tracking for the OMP status widget.
- [codeBaseTools](./extensions/codebase-tools/GLOSSARY.md): routes the agent's code exploration toward the codebase-memory-mcp graph and LSP, controlled by `/codebase-tools`.

_Not yet documented_: `extensions/anchored-standard`, `extensions/readonly-mode` — add a context document lazily when their language is resolved.

## Relationships

The existing extension contexts remain independent OMP extensions. The Semantic Extension Framework defines shared control vocabulary for the planned runtime package; no existing extension has yet been migrated to it.
