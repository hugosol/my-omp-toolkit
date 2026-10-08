# Refresh the Codex usage API on each assistant message

Codex usage was refreshed only on `/model`-family input (30s TTL), session/agent start when stale, and `agent_end`, while every provider response updated the 5h/7d windows instantly from rate-limit headers; `message_end` deliberately made no active request. We now also refresh the usage API on each assistant `message_end` — every model response in a run, including the ones that only request tools — throttled by the same 30s cache TTL, so the panel tracks context growth during a run instead of only at run boundaries. `agent_end` keeps its unconditional refresh, and the response-header path remains the instant one.

## Considered Options

- **Detect the context-bar change inside `render()`**: rejected because the host repaints up to 30fps during streaming, so a change-based fetch would fire near-per-frame, and render is the one path this extension keeps free of extra requests and timers.
- **Trigger on `after_provider_response`**: already fires per response, but it delivers only HTTP headers, not the authoritative usage payload, and it precedes the message landing.
- **Keep the run boundary (`agent_end`) as the only active refresh**: rejected because long multi-turn runs show 5h/7d lagging the context bar exactly while the user watches consumption grow.
- **Refresh on every assistant message with no throttle**: rejected because a single run can contain many turns and would hammer the usage endpoint.

## Consequences

- A run makes at least one forced fetch (`agent_end`) plus at most one mid-run fetch per 30 seconds; concurrent triggers still collapse through the existing single-flight.
- A failed active fetch also stamps the cache (`applyChatGPTUsageSnapshot` stores the error snapshot), so it counts toward the 30-second throttle; `agent_end` still retries unconditionally.
- Response headers continue to win instantly on success; an API refresh refines or replaces them afterwards.
- The README's "`message_end` 不新增主动 API 请求" contract is reversed; the render contract ("渲染不新增定时器、不发起额外额度请求") is untouched.
- The `message_end` handler now takes the extension context in addition to the event.
