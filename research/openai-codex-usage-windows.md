# OpenAI Codex usage-window semantics

Research date: 2026-08-17  
Official Codex source revision: `21cfd369efca2df70c904c580b2e7e2e3eddb3c3`

## Conclusion

Do **not** treat `secondary` as a synonym for a weekly quota. OpenAI's public product documentation says additional weekly limits *may* apply, but does not assign fixed durations to the `primary` or `secondary` protocol slots. Current first-party Codex source parses both slots and classifies them from each window's reported duration. Official tests explicitly cover a weekly `primary` paired with a 5-hour or monthly `secondary`.

The extension should therefore:

- inspect both `primary` and `secondary`;
- classify a weekly window from its reported duration, not its slot name;
- follow the official client's approximate-duration behavior (currently ±5% around seven days) if UI consistency is desired;
- avoid labeling a duration-less or unknown window as weekly;
- treat raw `x-codex-*` headers and backend usage JSON as first-party implementation details rather than a versioned public API contract.

## Evidence

1. OpenAI's Codex pricing page states that local messages and cloud chats share a five-hour window and that “Additional weekly limits may apply.” This confirms that weekly limits exist conditionally, not that every account or response has one: [Codex pricing](https://developers.openai.com/codex/pricing#what-are-the-usage-limits-for-my-plan).
2. OpenAI Help describes a limited promotion where a reset affects both 5-hour and weekly windows and moves the weekly reset date roughly seven days forward. It does not map weekly to `secondary`: [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).
3. The official app-server protocol models `primary` and `secondary` as nullable instances of the same window type. Each window independently carries `windowDurationMins`: [RateLimitSnapshot](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/app-server-protocol/schema/typescript/v2/RateLimitSnapshot.ts#L1-L13), [RateLimitWindow](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/app-server-protocol/schema/typescript/v2/RateLimitWindow.ts#L1-L5).
4. The official header parser reads identical `used-percent`, `window-minutes`, and `reset-at` fields for both primary and secondary instead of assigning fixed periods by slot: [rate_limits.rs](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/codex-api/src/rate_limits.rs#L22-L93).
5. First-party backend models give both slots their own `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at`: [status details](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs#L13-L35), [window snapshot](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs#L13-L22).
6. The official TUI classifies approximately 5-hour, daily, weekly, monthly, and annual windows by duration. Its tests explicitly reverse the conventional roles: `primary=weekly` with `secondary=5h`, and `primary=weekly` with `secondary=monthly`: [duration classifier](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/tui/src/chatwidget/rate_limits.rs#L77-L120), [role-reversal tests](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/tui/src/chatwidget/tests/status_and_layout.rs#L654-L726).

## Caveat

No OpenAI Developers or Help Center page was found that presents the raw `x-codex-primary/secondary-*` headers or backend usage JSON as a stable, versioned public HTTP contract. Their presence in the official client is strong first-party implementation evidence, but not a compatibility guarantee.
