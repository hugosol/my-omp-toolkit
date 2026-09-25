# Persist holiday pricing in the daily archive

DeepSeek bills statutory holidays and make-up work days as off-peak all day, but the clock rule would bill the weekdays they fall on at peak. We expose `/budget holiday` as a manual override and store it as `holiday: true` in `deepseek-cost.json` — the same document `/budget clear` archives and resets — rather than in extension memory or as a dated flag, so that "until `/budget clear`" is automatic, the flag persists across restarts, and it is shared account-wide by every session and CLI process.

## Considered Options

- **In-memory runtime state** (like `detailMode` and the custom budget): rejected because a restart would silently end holiday pricing while the user still expects valley rates, understating every later request.
- **A separate document or OMP config entry**: rejected because the daily archive already provides the persistence, cross-process locking and clear semantics the flag needs; a second lifecycle would add cleanup surface for no benefit.
- **An expiry date instead of a boolean**: rejected because statutory holidays can span several days and the requested control is explicit; the boolean plus the fixed `🏖️` icon is the simplest scheme that still makes a forgotten flag visible.
- **A dedicated `/budget holiday off`**: rejected because the user wants the flag tied to `/budget clear` — ending the holiday and archiving the period's spend are the same natural action — and wants the command surface kept small.

## Consequences

- `holiday` is written only while on and deleted when off; a missing field means off, so older documents need no migration.
- `setHoliday(false)` is a no-op when the flag and file are absent, so `/budget clear` never creates an empty archive just to clear. `/budget clear` runs it after `archive()`, which guarantees the flag drops even when the archive was empty (a case `archive()` leaves untouched) while the archived snapshot keeps the flag as a reference.
- Requests anchor their tier in `before_provider_request`, so a flag change only affects later requests; an already-sent peak-anchored turn keeps its rate.
- The flag is a manual estimate override, not a guarantee: turning it on after peak-priced requests leaves those earlier costs at peak, and an archive's `holiday` field only records the state at archive time.
- The widget shows a fixed `🏖️` for as long as the flag is on, so a forgotten flag is visible instead of silently under-billing.
- Holiday pricing is settable only in official DeepSeek mode; token-only DeepSeek models on other providers and Codex modes reject it because they have no RMB billing.
