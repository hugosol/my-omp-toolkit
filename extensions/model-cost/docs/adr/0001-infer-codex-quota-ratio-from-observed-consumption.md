# Infer the Codex quota ratio from observed consumption

Codex reports each window only as a used percentage and never exposes absolute quota sizes, and the ratio between the five-hour and weekly quotas is a mutable server policy (observed moving from roughly 33% to 15%, and absent on some accounts). We therefore estimate the quota ratio from paired used-percent movements inside a single five-hour window and persist the baseline and last qualifying estimate, rather than hardcoding a plan constant or assuming a uniform time share.

## Considered Options

- **Hardcode the reported policy share** (one five-hour quota ≈ 15% of the weekly quota): rejected because the value changes without notice and varies by plan and account.
- **Assume a uniform time share** (a five-hour window is 5/168 of the week): rejected because quota consumption is not proportional to elapsed time.
- **Do not show a count at all**: rejected because the remaining weekly budget in five-hour-quota units is what the user plans with.

## Consequences

- Requires persisted state (baseline pair plus the last qualifying ratio, if any) and a cold-start `estimating…` state until a first qualifying sample exists.
- The baseline is published as soon as the first usable paired reading arrives, with `ratio: null` until a sample qualifies, so a restart resumes the same measurement instead of re-anchoring; a known ratio is never downgraded to null by a later publication or an adopted peer baseline.
- Relearning every five-hour window means plan and policy changes surface within one window.
- A document whose baseline capture time is ahead of the local clock reads as a first run: an impossible timestamp is never treated as "newer", so a backwards clock step (or a foreign/fabricated document) cannot block publication forever.
- The document is stored human-readably — named baseline windows, local-time ISO-8601 timestamps with their UTC offset, four-decimal numbers — so a stale estimate can be diagnosed by reading the file directly. A shape change reinitializes the document instead of carrying a migration path.
