# Configurable prompt contribution across pi and OMP

Investigated on 2026-10-03 to scope cross-host semantics, before the initial delivery plan changed from standalone generation to a runtime framework package. This did not implement or migrate an extension. pi runtime evidence uses the globally installed `@earendil-works/pi-coding-agent` 1.0.0. OMP findings below are source inspection of the local 18.5.0 checkout, not an OMP runtime test.

## Conclusion

Both hosts expose the mechanisms needed for system-prompt contributions, persisted custom messages, and request-context filtering. Mode-dependent frequency and transition rules can live in the runtime framework's shared behavior implementation. This supports binding one semantic definition through host-specific adapters, but does not establish identical message roles, arbitrary insertion positions, or complete extension compatibility.

## What readonly-mode actually implements

- [`InjectionConfig`](../../extensions/readonly-mode/mode.ts#L32) declares `systemPrompt`, `everyTurnMessage`, and `transitionMessage.reinjectAfter` slots.
- The current [mode table](../../extensions/readonly-mode/mode.ts#L62) selects transition messages for Build and repeated messages for Explore/Debug. No mode enables the system slot.
- More importantly, [`buildPrompt`](../../extensions/readonly-mode/mode.ts#L124) provides only transition/every-turn content, never `systemPrompt` content. Merely enabling the system flag is insufficient. A direct run of `ModeState` with that flag enabled still returned no system contribution.
- [`ModeState.buildInjection`](../../extensions/readonly-mode/mode.ts#L190) makes the first evaluation count as a change; selects transition content on change or the configured counter threshold; and gives transition content priority when both message rules qualify. Its counter advances when this method is invoked, not on an independently defined model-request or tool-turn clock.
- [`before_agent_start`](../../extensions/readonly-mode/index.ts#L146) appends system content to the OMP array and returns a hidden custom message. Mode switches themselves do not immediately insert that message; the next hook evaluation makes the decision.
- Optional [`context` filtering](../../extensions/readonly-mode/index.ts#L163) removes custom messages belonging to other known modes from the request context. [`CLEANUP_HISTORY`](../../extensions/readonly-mode/prompts.ts#L3) is currently false. This hook does not erase stored history; the flag's name should not define the framework's terminology.
- The configuration comment says the repeated message is before the user prompt. Actual pi runtime ordering and OMP source ordering put these returned custom messages after the current user message.

Direct execution of the existing mode logic produced:

| Evaluated modes | Message contributions |
| --- | --- |
| Build, Build | Build, none |
| Explore, Explore | Explore, Explore |
| Debug, Debug | Debug, Debug |
| Return to Build | Build |

This verifies existing decision logic, not an implementation of the planned framework.

## Host mechanisms and differences

| Behavior | pi 1.0.0 | OMP local source |
| --- | --- | --- |
| System contribution | `before_agent_start` can return a replacement string assembled from the incoming system prompt; structured prompt options are also available | Hook input/output uses `string[]`; the extension assembles the desired array |
| Hidden custom message | Returned messages are collected, appended after user input, and persisted | Returned messages are collected, appended after user input, and persisted |
| Visibility | `display: false` is display metadata, not a model-role selector | Same distinction |
| Request filtering | `context` modifies a copy used for the request; pi additionally has `context_with_system` | `context` modifies a copy used for the request |
| Timing | `before_agent_start` is not the hook for every provider request; request context transformation also covers tool continuations | Same distinction; exact prompt/dequeue/re-entry behavior differs |
| Frequency rules | Extension-owned state can decide first/each/mode-change contributions | Same, rather than a host-provided mode-injection primitive |

Primary source references:

- pi [before-agent-start composition](../../../pi/packages/coding-agent/src/core/extensions/runner.ts#L1411), [context transformation](../../../pi/packages/coding-agent/src/core/extensions/runner.ts#L1289), [prompt message ordering](../../../pi/packages/coding-agent/src/core/agent-session.ts#L2015), [custom-message persistence](../../../pi/packages/coding-agent/src/core/agent-session.ts#L1119), [system-prompt construction](../../../pi/packages/coding-agent/src/core/system-prompt.ts#L180).
- pi [per-request context transform](../../../pi/packages/agent/src/agent-loop.ts#L389). A framework must define its own frequency unit rather than assume an agent run, a turn, and a model request are identical.
- OMP [before-agent-start composition](../../../oh-my-pi/packages/coding-agent/src/extensibility/extensions/runner.ts#L2072), [context transformation](../../../oh-my-pi/packages/coding-agent/src/extensibility/extensions/runner.ts#L1935), [prompt message ordering](../../../oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L7434), [preparation](../../../oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L7315), [custom-message persistence](../../../oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L3352), [per-call context transform](../../../oh-my-pi/packages/agent/src/agent-loop.ts#L1871).

## Role guarantees require the provider path, not just the host hook

pi converts custom messages to `user` in [`convertToLlm`](../../../pi/packages/coding-agent/src/core/messages.ts#L161). This was verified both by invoking the installed converter and by observing an actual local OpenAI-compatible HTTP request.

OMP's core [custom-message conversion](../../../oh-my-pi/packages/agent/src/compaction/messages.ts#L216) produces `developer`, but this is not a universal wire-role guarantee:

- [OpenAI Chat Completions](../../../oh-my-pi/packages/ai/src/providers/openai-completions.ts#L2384) chooses developer versus user according to `supportsDeveloperRole`.
- [OpenAI Responses](../../../oh-my-pi/packages/ai/src/providers/openai-shared.ts#L2086) emits ordinary converted user/developer history as user messages on the inspected path.

Therefore hidden visibility, conversation position, and instruction authority are separate semantic dimensions. Neither matching hook names nor matching intermediate message roles prove provider-level equivalence. The existing codebase-tools ADR's developer-role requirement remains a requirement, not proof that every OMP provider preserves that role.

## Actual pi runtime smoke

A temporary extension was loaded by the installed pi CLI in RPC mode with isolated configuration/session directories, no discovered extensions/context files/tools, and offline startup. A loopback OpenAI-compatible capture server returned fixed assistant responses; no real model or account credentials were used. This tests the host request pipeline, not model obedience.

Five ordinary prompts exercised:

1. Explore: append `[SYSTEM:explore]` and persist `[MODE:explore]`.
2. Explore again: append another mode message; the earlier one remains in history.
3. Set Build via an extension command, then prompt: use `[SYSTEM:build]` and contribute one Build transition message.
4. Build again: contribute no additional transition message.
5. Enable request filtering, then prompt: omit Explore custom messages from the outgoing request while retaining the Build message.

Assertions passed for five captured requests, mode-message counts, current system contribution, user/custom ordering, and request filtering. Example first-request order:

```text
system: base system prompt + [SYSTEM:explore]
user:   turn-one
user:   [MODE:explore]
```

After filtering, both `sessionManager.getEntries()` and the actual session JSONL still contained the two Explore custom messages and one Build custom message, all with `display: false`. Filtering changed the outgoing context, not persisted history.

The probe emitted one `before_agent_start` observation per ordinary prompt; this smoke did not exercise tools, steering, retry, compaction, branch restoration, or real TUI display. The transition scheduler in this probe was deliberately small and demonstrates host capability, not that a framework scheduler already exists. The original ModeState behavior was exercised separately as described above.

Temporary processes, the capture server, probe files, isolated configuration, and session records were removed. No production extension code was changed.

## Scope implications, not settled interface syntax

A candidate definition should separate content, activation conditions, contribution timing, destination, repetition, retention, visibility, and role requirements. Request-context projection should be named separately from stored-history deletion. System contribution and conversation contribution may coexist; if multiple rules share a slot, composition/precedence must be explicit rather than silently inherited from readonly-mode's current one-message result shape.

The agreed scope includes configurable prompt contribution and general business history/archival storage. Subsequent design decisions defer request-context filtering from the first release under mandatory history preservation, require rejection of unmet role/insertion requirements, and require a versioned supported-host baseline. Exact field names, counter semantics, enforcement of mandatory history preservation through custom-code interfaces, the detailed failure and State-freshness contract for the now-in-scope shared-file concurrency mechanism, and complete migration of all existing extensions remain unsettled.
