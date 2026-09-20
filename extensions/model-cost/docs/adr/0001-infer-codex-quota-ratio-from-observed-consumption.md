# Infer the Codex quota ratio from observed consumption

Codex reports each window only as a used percentage and never exposes absolute quota sizes, and the ratio between the five-hour and weekly quotas is a mutable server policy (observed moving from roughly 33% to 15%, and absent on some accounts). We therefore estimate the quota ratio from paired used-percent movements inside a single five-hour window and persist the baseline and last qualifying estimate, rather than hardcoding a plan constant or assuming a uniform time share.

## Considered Options

- **Hardcode the reported policy share** (one five-hour quota ≈ 15% of the weekly quota): rejected because the value changes without notice and varies by plan and account.
- **Assume a uniform time share** (a five-hour window is 5/168 of the week): rejected because quota consumption is not proportional to elapsed time.
- **Do not show a count at all**: rejected because the remaining weekly budget in five-hour-quota units is what the user plans with.

## Consequences

- Requires persisted state (baseline pair plus last qualifying ratio) and a cold-start `estimating…` state until a first qualifying sample exists.
- Relearning every five-hour window means plan and policy changes surface within one window.
