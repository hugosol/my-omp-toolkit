# Triage Labels

This repo uses two distinct ticket systems with separate status vocabularies.

## Decision tickets (wayfinder)

Decision tickets are **planning artifacts** produced by `/wayfinder`. They live in `.scratch/<feature>/decision/`. Each decision ticket asks "what should we decide?" and its lighthouse document records the decision.

| Status | Meaning |
|--------|---------|
| `open` | Not yet claimed by an agent |
| `claimed` | Agent is actively working on this decision |
| `resolved` | Decision made and recorded. **NO code has been written.** Code is written later from implementation tickets. |

Decision tickets are NEVER implementation tasks. A `resolved` decision ticket means the decision is locked, not that code exists.

## Implementation tickets (to-tickets)

Implementation tickets are produced by `/to-tickets`. They live in `.scratch/<feature>/implementation/`. Each implementation ticket is a tracer-bullet vertical slice that delivers working, testable behaviour.

| Status | Meaning |
|--------|---------|
| `ready-for-agent` | Fully specified, ready for an AFK agent to implement |
| `ready-for-human` | Requires human implementation |
| `in-progress` | Agent is actively implementing |
| `closed` | Code implemented, tested, and merged |

## Shared (both ticket types)

| Status | Meaning |
|--------|---------|
| `needs-triage` | Maintainer needs to evaluate this item |
| `needs-info` | Waiting on reporter for more information |
| `wontfix` | Will not be actioned |

---

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from the appropriate ticket type's table above. Decision tickets and implementation tickets use **different** status vocabularies; never cross them.
