# Host version and compatibility baseline

Recorded: 2026-10-03. This is the design investigation's version/evidence anchor, not a claim that the planned runtime framework package or fully certified adapters already exist. Exact versions below record observations; the policy for admitting version ranges or unknown installed versions is not yet decided.

## Host targets and evidence

| Host | Package | Source version / checkout | Observed installed runtime | Evidence status |
| --- | --- | --- | --- | --- |
| pi | `@earendil-works/pi-coding-agent` | 1.0.0; `a276dabe57911253350bffb93cb7d7aff6a73261` | `pi --version`: `1.0.0` | Source inspected; isolated RPC and local OpenAI-compatible request smoke performed. Not a full mode/provider certification. |
| oh-my-pi | `@oh-my-pi/pi-coding-agent` | 18.5.0; `9348320cc4a30a7195d36a1f05a6c11bcb701a17` | `omp --version`: `omp/18.4.6` | Source inspected at 18.5.0. Installed runtime differs; no equivalent OMP runtime smoke is claimed. |

Sources: the respective `packages/coding-agent/package.json` files, source-checkout `git log -1`, and direct executable version checks. Checking an executable version is not functional validation. No OMP runtime upgrade was performed in this investigation.

## Runtime-package deployment prerequisite

The initial framework is a separately maintained runtime package depended on by `my-omp-toolkit`; its host entrypoints must resolve that dependency when loaded by the actual installed pi and OMP CLIs. The source and prompt probes below did not load such a package as a dependency and therefore do not verify module resolution or deployment. Before claiming support for this organization, exercise a minimal toolkit extension importing the package under both loaders and record the result separately from behavior-contract tests. Pin or otherwise explicitly select the framework release validated with the toolkit; do not assume runtime consumers acquire framework changes automatically without updating their installed dependency.

## Investigated common behavior candidates

| Contract area | pi evidence | OMP evidence | Current limitation |
| --- | --- | --- | --- |
| Current system-prompt contribution | Source and actual local request capture | Source | Different host representations; final provider mapping and prefix stability need explicit contracts. |
| Persisted hidden custom messages | RPC/request smoke plus disk history inspection | Source | Visibility does not imply developer authority; message roles differ. |
| Conditional and mode-change contribution | Actual pi pipeline smoke; readonly-mode state logic exercised separately | Source | Shared scheduling contracts, restore semantics, and exact frequency units remain to be specified. |
| Filtering own contributed context | Actual outgoing request and unchanged disk history observed | Source | Changes the request prefix despite not deleting disk history; incompatible with stronger request-prefix preservation. |
| Universal developer-role conversation injection | Not established; installed custom-message path produces user messages | Not established across provider protocols | Cannot advertise as an unconditional common behavior. |

Detailed source references and exercised scenarios: [prompt-injection research](prompt-injection-research.md).

## Meaning of the support list

This file concerns host/package version compatibility, not which tools an agent may call. Whether an unlisted version should be blocked, warned about, or only marked unverified remains undecided; recording versions does not itself implement an admission check.

The first release requires strict history preservation: no mutation or reordering of existing conversation entries, and no alteration of their history-derived request content. Request-context filtering, even of the extension's own earlier messages, is deferred. It permits new messages to be appended through the host's normal recording path; once recorded, they receive the same protection. Non-persisted request contributions are not inherently history mutations, but their inclusion in the first release and their insertion positions remain undecided. Mechanism availability in the table above does not by itself establish policy compliance.

## Compatibility rules already agreed

- Common framework behaviors must be satisfiable across all declared supported host targets, possibly through different adapter implementations.
- Required semantics must not be silently weakened. Unsupported role or insertion requirements are rejected.
- Version claims must retain their evidence level. Source inspection, executable startup, and exercised behavior are distinct.
- Cross-host semantic contract scenarios are regression alarms: a failure signals an incompatibility to investigate, while a pass never automatically approves a host version. A framework maintainer reviews the changed host source and/or further test evidence and explicitly decides whether to declare support.

## Decisions still open

- Which exact host versions or version ranges form the initial supported release set.
- Whether an unlisted installed version is refused at startup and how that check is implemented.
- Admission of new hosts without silently weakening already-established common contracts.
- Mode/provider constraints for each published contract and the evidence needed to certify them.

Future support declarations require an explicit maintainer decision based on source review and/or exercised scenarios for the declared target; passing tests alone is not that decision. This file deliberately does not label OMP 18.5.0 as runtime-verified merely because its source was inspected.
