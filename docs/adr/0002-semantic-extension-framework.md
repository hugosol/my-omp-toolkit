---
status: accepted
---

# Host-independent semantic framework as a runtime package

For the initial, single-maintainer use case, build the framework as an independent project that produces an installable runtime package. `my-omp-toolkit` depends on that package and refactors its extensions to provide one shared behavior definition and one shared TypeScript implementation, with thin pi/oh-my-pi host entrypoints selecting the respective adapters. The framework package remains a runtime dependency of those extensions: an entrypoint copied without resolvable dependencies is not a supported standalone artifact. This replaces the earlier first-release plan to generate independently runnable extension source. Avoid building a code generator before shared semantic behavior has been exercised on both hosts.

Keep the semantic core separate from reusable behaviors, feature templates, and host adapters, so common functionality can be configuration-only without moving all feature-specific business logic into the core. Own the event contracts while choosing names close to pi terminology to ease migration. If future distribution requires independent host artifacts, bundling or generation can be added later without maintaining duplicate feature logic. That future option is not part of the initial deliverable; arbitrary edits to such artifacts would be independently maintained rather than merged back into framework-managed sources.

This chooses lower initial build and distribution complexity for one maintainer over standalone installability. Dependency resolution and framework version coupling become explicit deployment constraints: `my-omp-toolkit` should select a tested framework version, and actual installed pi and OMP loaders must be exercised with an extension importing that package before claiming the organization works.

## Scope map

The discussion covers nine areas: (1) extension definition/configuration and shared TypeScript logic; (2) control patterns, commands, and subfeatures; (3) semantic hooks and State orchestration; (4) State ownership, storage, restoration, archives, and shared-file concurrency; (5) ongoing work and lifecycle effects; (6) instruction contribution and mandatory history preservation; (7) basic status feedback driven by State; (8) host adapters and declared version/capability support; and (9) framework verification as upgrade regression detection. This map records responsibilities and exclusions, not a claim that these modules or all five migrations have been implemented.

## Initial control scope

Support three independent control patterns: configuration switches applied after restart, idempotent selection of a named mode, and command toggles alternating between two modes. Mixed control, such as the current Build/Explore/Debug interaction, is explicitly deferred rather than implicitly implemented through the initial patterns.

## Shared behavior scope

Include activation and mode controls, state storage (in-memory values, host-owned session entries, and extension-owned files), session state and restoration, and basic status feedback. Storage is not limited to framework-declared switches and parameters: business history and archival are explicitly in scope, motivated by existing model-cost requirements; shared-file concurrency safety is also an explicit framework capability, while its precise interface and failure contract remain to be designed. Command actions and parameter settings are also suitable reusable subfeatures, distinct from mode transitions; their exact contracts remain to be defined. A command subfeature and its State/storage are orthogonal: `/budget holiday` is an idempotent command subfeature activating the persisted Holiday pricing flag, not a mutually exclusive submode, while quota-ratio data may be stored without becoming a command or mode. Storage choice does not by itself define state ownership or restoration semantics. `codebase-tools` already persists `{on, initInjected}` in host-owned non-LLM session entries via `appendEntry` and restores it from the active branch; it does not store that state in a separate extension JSON file. These state entries are distinct from LLM conversation messages, so the history-preservation guarantee must not accidentally prohibit them.

Include configurable instruction contribution, using readonly-mode's injection slots and mode-dependent rules as a starting point. The goal is to configure content and contribution rules instead of editing host-specific hook code. Exact timing, context placement, retention, and role guarantees must be established separately; including instruction contribution does not automatically authorize arbitrary history rewrites or promise identical provider wire roles. See [prompt-injection research](../extension-generation/prompt-injection-research.md) for the verified current behavior.

Do not include operation guards in the initial common behavior library: the current evidence is specific to `readonly-mode`, rather than a demonstrated shared behavior across the extensions. This does not remove its existing protection requirements or settle how it will migrate.

## Shared-file concurrency scope

When multiple sessions or agent processes update one extension-owned document, the framework should provide a coordinated read-modify-publish operation and reader-safe atomic publication so one writer cannot silently replace another writer's completed update or expose a partially written document. The fresh on-disk value must be considered within the coordination scope; locking only the final write is insufficient. Feature-specific merge decisions (such as choosing the newer model-cost measurement baseline while retaining a known ratio) remain feature logic, not a universal last-writer-wins policy. After a peer's publication, State may need reconciliation before it is used as the current value. The first implementation must not rely on an OMP-only runtime module for a shared pi/OMP capability.

Existing model-cost tests exercise multiple tracker instances sharing a file but substitute an in-process serialization lock (`tests/model-cost/test-lock.ts`); they do not independently verify a real inter-process lock. A framework-owned implementation therefore needs its own actual cross-process and crash/atomic-read contract tests. Lock portability, timeout/failure behavior, and State freshness are detailed-design decisions, not guarantees inferred from the present tests.

## Semantic hooks at the scope level

The framework should offer extension-owned code injection at meaningful agent lifecycle points as well as declarative behaviors. Examples such as agent start and message completion are candidate concepts, not yet a published event inventory or a claim of equivalent timing across pi and OMP. Selecting and verifying the exact hook set, its payloads and ordering belongs to detailed design against existing extensions and both hosts. An extension supplies one shared TypeScript implementation for each chosen semantic hook; host adapters bind that same implementation at the corresponding host lifecycle point and expose host-independent inputs and framework capabilities. Thin pi/OMP entrypoints must not require maintaining two copies of the feature logic. Treat source-code text splicing into host-specific templates as a different, fragile approach, not the intended meaning of "injection." Do not confuse message completion with an entire agent run settling.

## State and recovery seam

Treat state value, ownership, storage medium, restore policy, and lifecycle effects as related but distinct aspects of a behavior definition. A resumed session can restore state without replaying an earlier command or assuming its external effects are still active; reacquiring timers or remote registrations needs an explicit reconciliation policy. Persisted business values such as model-cost's holiday flag and quota estimate/baseline are not automatically modes or state-machine states. Exact reconciliation semantics and which values belong in the initial declarative state model remain open.

## State as the current-value source

Call the unified per-extension current-value source **State**, borrowing React's vocabulary without adopting its component or hook model. Framework-managed behaviors read declared values from State, including extension-defined values; UI, command feedback, and instruction conditions do not each maintain a separate current-value copy. Framework-provided and extension-defined State variables may drive basic notifications and persistent status indicators; complex widget layout remains feature-specific rather than a universal UI language. State's read surface is not its mutation surface: control transitions, declared actions, host-event projections, and restore/persistence reconciliation are candidate update sources, while renderer code should not bypass them. Persistence media and remote providers remain external inputs; their observations must be reconciled into State before framework consumers read a current value. Cross-process freshness and the exact write/reconciliation contract remain open rather than implied by the phrase "single source of truth."

## Behavior orchestration around State

Treat State as the shared current-value source connecting control, commands, host events, persistence, instruction contribution, feedback, and ongoing lifecycle effects. Ongoing effects depend on both State and their owning scope: entering an active condition may start work, leaving it or losing the scope must stop work, and restoring State alone does not prove earlier effects are still active. One-shot command actions remain distinct from ongoing effects; neither every State update nor every restore automatically replays side effects. Framework-managed model-context behavior observes the same State but is additionally bound by the mandatory history-preservation contract.

## History preservation and execution frequency

Defer request-context filtering, including filtering this extension's own earlier contributions, to a later, more flexible policy. Arbitrary edits to other participants' messages or deletion of persisted conversations are not part of the initial common behavior. In the first release, strict history preservation is mandatory: the framework preserves existing host-owned conversation entries and the history-derived portion of each request without filtering, substitution, or reordering. New extension messages may be appended through the host's normal conversation-recording path; those entries then belong to the history that subsequent requests preserve. Request-only contributions do not themselves mutate stored history, but whether the first release supports them is not yet decided; their placement must not silently violate the history-derived prefix contract. This supersedes the earlier blanket prohibition of persisted extension-added messages: preserving existing history does not prohibit appending new recorded messages. Persistence alone is not sufficient; insertion into the middle of existing history, later removal, or rewriting the recorded contribution remains prohibited.

Appending temporary material after the history-derived content is the proposed cache-conscious placement: it can preserve that historical prefix, whereas insertion before or among existing history can change the reusable prefix despite leaving disk untouched. Exact allowed insertion positions remain to be confirmed. Temporary contributions are not automatically retained in subsequent requests, and their disappearance or change can limit reuse beyond the stable history prefix.

The guarantee concerns framework-managed behavior, not the host's normal message recording, compaction, other extensions, or a future independently modified generated artifact. Keeping chat history intact does not by itself guarantee cache hits: system instructions, tool declarations, and provider behavior are separate concerns. Whether system-prompt changes receive a separate stability policy remains open.

Distinguish agent-run initiation from individual model requests for all context-processing behaviors, not only prompt insertion. There is no established requirement yet for a public per-model-request insertion option. Filtering is excluded from the first release; if later enabled, it must apply consistently across the requests it governs, including tool continuations.

## Business logic versus model-context behavior

Keep the contracts for ordinary extension actions separate from instruction contribution and request-context processing. They may share configuration, state, and lifecycle infrastructure, but history-preservation constraints do not prohibit unrelated business computation, extension-owned archives, or status feedback. Apply the constraint according to effects: custom TS that changes host conversation data or outgoing chat history is context-affecting behavior, not exempt merely because it is custom code. The mechanism for keeping custom code within framework-managed interfaces remains a design decision; arbitrary in-process TS is not implicitly sandboxed.

## Supported-host compatibility

Only extract a common behavior when its semantic contract can be satisfied across all declared supported host targets; identical native API names are not required. Reject a behavior whose required role or insertion semantics cannot be met rather than silently substituting a weaker behavior. Anchor the host targets and evidence in a [version baseline file](../extension-generation/host-support.md), separating source inspection from runtime validation; a version number alone does not establish compatibility across provider protocols or operating modes. Run shared semantic contract scenarios against host upgrades to detect regressions quickly: failure is an investigation signal, while success does not automatically approve support. A framework maintainer explicitly assesses source changes and/or additional evidence before declaring a new host version supported.

## Framework verification as a separate concern

Treat framework verification as a ninth scope area alongside definition/configuration, control/commands, semantic events and State orchestration, storage/recovery, ongoing lifecycle work, instruction contribution, status feedback, and host adaptation. Shared semantic contract scenarios serve as upgrade regression alarms; the maintainer, not a green test run, decides when a host version is supported. The specific scenarios and test harness belong to detailed design.

## Consequences and unresolved details

- This records the agreed direction, not implementation completion or compatibility of the existing five extensions.
- Existing `readonly-mode` mixed control cannot be claimed as a behavior-preserving migration within the initial control scope. Its migration treatment remains to be decided.
- The existing `codebase-tools` developer-role injection requirement in ADR-0001 remains in force; this decision does not authorize weakening it for another host.
- Restart versus extension reload, definition syntax, runtime package installation and resolution under both loaders, exact-version versus version-range admission, treatment of a newly added host that cannot meet an existing common contract, and the precise set of reusable behaviors remain open. Standalone generated artifact packaging is explicitly deferred.
- Cross-behavior composition and conflict rules remain open: multiple contributions to the same slot, multiple transitions triggered by one semantic event, and competing State updates must not be resolved implicitly by host registration order.
- The mechanism for enforcing history preservation through custom-code interfaces, system-prefix treatment, and the precise shared-file coordination, failure, and freshness guarantees remain open. The scope of the history guarantee is framework-managed behavior; host behavior and other extensions are excluded.
