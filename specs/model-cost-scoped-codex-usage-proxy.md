# Scoped Codex Usage Proxy for Model Cost Extension

Status: `ready-for-agent`

## Problem Statement

在 ChatGPT/Codex 模式下，Model Cost Tracker 应显示当前周额度使用百分比和重置时间。当前 extension 通过 OMP 的聚合用量接口获取这些数据，但该接口使用裸 `fetch`，不会应用模型主请求已经使用的 `PI_PROXY_OPENAI_CODEX` provider proxy。

对于必须通过本地代理访问 ChatGPT 官方域名的用户，模型对话可以正常工作，但 `/wham/usage` 请求会直连并超时。OMP 将失败折叠为空用量报告，extension 随后静默省略周额度组件。设置进程全局 `HTTPS_PROXY` 可以恢复显示，但会影响 OMP 进程内其他 provider、扩展和网络请求，作用域过大。

OpenAI 官方产品资料确认额外周限额可能存在，但没有把 `primary` 或 `secondary` 固定定义为周窗口。当前 extension 只读取 `x-codex-secondary-*` 响应头，因此在周窗口出现在 primary 时，响应头备用路径也无法恢复显示。

## Solution

Model Cost Tracker 将在 extension 内建立一条仅用于 Codex usage provider 的 scoped proxy 调用链。它复用 OMP 的公开 OAuth access、Codex usage provider、响应规范化和 provider proxy 工具，不修改进程全局代理环境，也不复制 OpenAI backend payload parser。

extension 将从 `PI_PROXY_OPENAI_CODEX` 读取代理，缺失时回退到 `PI_PROXY`。代理只注入本次 Codex usage provider 调用及该 provider 触发的 ChatGPT 辅助请求。缺少代理、请求失败、版本不兼容或报告缺少周窗口时，周额度组件保持可见并展示确定的状态或错误摘要。

primary 和 secondary 将被视为无固定周期语义的窗口槽位。extension 同时检查两者，并仅根据服务端报告的窗口时长识别 7 天窗口。响应头和主动用量接口共用相同的周窗口选择规则。

## User Stories

1. As a Codex user behind a local proxy, I want weekly usage requests to use my Codex provider proxy, so that the quota widget works without a process-global proxy.
2. As a Codex user, I want to see my current weekly usage percentage, so that I can judge how much of the weekly allowance I have consumed.
3. As a Codex user, I want to see the weekly reset time, so that I know when capacity becomes available again.
4. As an OMP user with multiple providers configured, I want the usage proxy to be request-scoped, so that unrelated providers are not routed through the Codex proxy.
5. As an extension user, I want the extension to leave `HTTPS_PROXY` unchanged, so that it cannot alter process-wide networking behavior.
6. As an existing OMP user, I want the extension to reuse `PI_PROXY_OPENAI_CODEX`, so that model traffic and usage traffic use the same provider-specific configuration.
7. As an OMP user relying on the generic provider proxy, I want `PI_PROXY` to be used when the Codex-specific variable is absent, so that existing proxy configuration remains useful.
8. As a user with no Codex provider proxy configured, I want the widget to remain visible with a configuration error, so that I know why usage data is unavailable.
9. As a user missing proxy configuration, I want the error to name `PI_PROXY_OPENAI_CODEX` and `PI_PROXY`, so that I know which settings can fix the problem.
10. As a user opening a Codex session, I want an explicit loading state, so that the widget does not silently appear and disappear while the first request is pending.
11. As a user opening a Codex session, I want one initial usage refresh, so that the widget starts with a current snapshot.
12. As a user completing a conversation turn, I want usage refreshed after `agent_end`, so that the widget tracks usage once per completed round.
13. As a user, I do not want a second proactive request at `agent_start`, so that the usage endpoint is not called more often than necessary.
14. As a user, I want overlapping refresh triggers to share one in-flight request, so that the extension does not issue duplicate usage calls.
15. As a user, I accept that a trigger joining an in-flight request does not enqueue a trailing refresh, so that request coordination stays simple and bounded.
16. As a user with a stalled proxy, I want the usage request to time out after the same ten-second budget used by current OMP usage requests, so that the widget does not wait indefinitely.
17. As a user, I want provider transport failures shown inside the widget rather than as popup notifications, so that failures remain visible without interrupting chat.
18. As a user debugging connectivity, I want the original `error.message` prefix displayed, so that I can distinguish timeout, refusal, TLS, and HTTP failures.
19. As a user, I accept that displayed error text is not credential-redacted, so that the extension does not rewrite the original message.
20. As a terminal user, I want control characters in errors rendered visibly, so that raw messages cannot split widget lines or alter terminal styling.
21. As a terminal user, I want up to 48 display columns of error-message content, so that errors carry useful detail without consuming the entire widget.
22. As a terminal user, I want fixed widget prefixes excluded from the 48-column error budget, so that the diagnostic content receives the full allowance.
23. As a user whose API refresh fails, I want the previous API-derived snapshot cleared, so that stale API data is not presented as current.
24. As a user whose current model response contains valid rate-limit headers, I want that fresh header-derived data preserved even when the active usage fetch fails, so that available facts are not discarded.
25. As a user missing proxy configuration, I want the proxy warning retained beside valid header-derived usage, so that I am still reminded to repair active usage fetching.
26. As a user whose next scoped usage request succeeds, I want the prior request error cleared, so that recovered failures do not remain on screen.
27. As a user whose weekly limit is in primary, I want it recognized, so that slot ordering does not hide valid usage.
28. As a user whose weekly limit is in secondary, I want it recognized, so that both observed slot arrangements work.
29. As a user, I want weekly classification based on reported duration, so that primary and secondary are not assigned invented fixed meanings.
30. As a user, I want only windows within seven days plus or minus five percent classified as weekly, so that daily, monthly, and unknown limits are not mislabeled.
31. As a user, I want duration-less windows left unclassified, so that the extension does not guess that secondary means weekly.
32. As a user whose plan does not report a weekly window, I want `weekly limit not reported` shown, so that absence of a weekly quota is distinguishable from transport failure.
33. As a user receiving a weekly percentage without a reset time, I want the percentage retained and the reset shown as `--`, so that partial data remains useful.
34. As a user receiving a weekly reset time without a percentage, I want the reset retained and the percentage shown as `--%`, so that partial data remains useful.
35. As a user, I want the widget to display the main ChatGPT/Codex chat limit, so that feature-specific additional limits do not replace the account chat quota.
36. As a user, I want any ChatGPT auxiliary requests made by the official Codex usage provider to use the same scoped proxy, so that reset-credit details do not unexpectedly attempt a direct connection.
37. As an OAuth user, I want the extension to obtain a refreshed access token through AuthStorage, so that refresh tokens and refresh policy remain owned by OMP.
38. As a single-account user, I want the sole stored Codex OAuth account used for the quota request, so that no unproxied account-ranking path is required.
39. As a user with no Codex OAuth account, I want an explicit account error, so that missing authentication is not mistaken for a network problem.
40. As a user who unexpectedly has multiple Codex OAuth accounts, I accept that the extension uses the first account in AuthStorage stable order, so that multi-account selection remains outside this feature.
41. As a user on an incompatible OMP version, I want the rest of the extension to load and the quota widget to report incompatibility, so that DeepSeek cost tracking is not disabled by one missing Codex API.
42. As a user on an older OMP version, I do not want a silent fallback to the known unscoped usage transport, so that proxy isolation is never weakened without notice.
43. As a DeepSeek-mode user, I want existing balance, context-budget, token, and cost behavior unchanged, so that the Codex fix does not alter DeepSeek tracking.
44. As a user changing proxy environment variables, I accept that OMP must be restarted, so that the extension does not introduce runtime proxy-cache invalidation.
45. As a user, I assume `PI_PROXY_OPENAI_CODEX` and `NO_PROXY` are not configured in a contradictory way, so that conflict resolution remains outside this feature.

## Implementation Decisions

- The change is extension-only. OMP core behavior and the global process environment remain untouched.
- The ChatGPT usage adapter will dynamically load the current OMP public Codex usage provider and proxy utilities. Dynamic loading allows the extension to stay operational and render an incompatibility state if those exports do not exist.
- The extension will use AuthStorage's public account-list and exact-account OAuth access APIs. With one account, it selects position zero and obtains a refreshed access token and account identity without exposing a refresh token.
- If there are zero Codex OAuth accounts, the adapter returns an explicit authentication error. If there are multiple accounts, it uses the first entry in AuthStorage stable order. Correct multi-account affinity is not part of this feature.
- The adapter will call the public `openaiCodexUsageProvider.fetchUsage` rather than issuing and parsing `/wham/usage` itself. OMP remains responsible for the canonical ChatGPT URL, bearer header, ChatGPT account header, payload normalization, and related provider behavior.
- The fetch passed to the Codex usage provider will be wrapped with OMP's public provider proxy utility for `openai-codex`. The wrapper may proxy every ChatGPT request made during that provider invocation, including reset-credit detail requests.
- Proxy discovery is limited to `PI_PROXY_OPENAI_CODEX`, then `PI_PROXY`. A standard `HTTPS_PROXY` without either provider variable does not satisfy this feature's configuration contract.
- Missing provider proxy configuration produces a generated error naming both supported variables. The extension does not attempt an unproxied request and does not fall back to AuthStorage's aggregate usage fetch.
- The design assumes there is no contradictory `NO_PROXY` entry for ChatGPT. Existing OMP proxy-wrapper semantics are retained rather than overridden.
- The active usage request receives a ten-second abort budget, mirroring the current OMP usage-request default.
- `session_start` initiates the first active usage refresh. Each Codex `agent_end` initiates another refresh. `agent_start` may refresh rendering state but must not issue an active usage request.
- Active usage refreshes are single-flight. A trigger that arrives during an existing request receives the same promise and does not queue another request after it completes.
- The response-header path will reuse OMP's public Codex rate-limit-header parser instead of maintaining a secondary-only parser.
- Both active reports and response-header reports pass through one shared main-chat window selector for the 5h and 7d windows. The selector evaluates primary and secondary main-chat windows and excludes feature-specific additional limits.
- A window is five-hour only when its reported duration is within ±5% of five hours; a window is weekly only within ±5% of seven days. Slot name alone is never sufficient.
- When more than one eligible main-chat window of the same duration family exists, the selector chooses the one whose duration is closest to the canonical duration; exact ties follow provider order.
- A valid report with no eligible window for a duration family produces a stable `5h limit not reported` / `weekly limit not reported` state rather than hiding the component or choosing another duration.
- Percentage and reset time are independent optional facts. Missing percentage renders `--%`; missing reset time renders `重置 --`.
- ChatGPT usage state distinguishes loading, successful API data, successful response-header data, missing-window data, compatibility/configuration/authentication failures, and transport failures for each window.
- A failed active refresh invalidates prior API-sourced data for that window. It does not invalidate fresh response-header data from the current conversation round.
- A proxy configuration error remains displayable beside header-derived data. A later successful active refresh clears the active-fetch error.
- The initial active request renders `5h … · 正在获取` and `7d … · 正在获取` until it settles.
- Request and compatibility errors render in the widget only; the extension must not call the notification surface for these states.
- Provider fetch wrappers capture the original thrown `Error.message` before the public provider converts a failed fetch into a null report. HTTP failures without a thrown error receive a deterministic status-based error message.
- Error text is intentionally not credential-redacted. This accepted risk includes possible exposure in screenshots, terminal logs, and captured sessions.
- Control characters are escaped into visible sequences without rewriting ordinary message text. Error truncation uses terminal display width, not JavaScript string length, and adds an ellipsis when the 48-column message budget is exceeded.
- Missing public OMP modules or methods produce `incompatible OMP version`. There is no compatibility fallback to the aggregate usage API or to a copied protocol parser.
- Existing DeepSeek pricing, balance, daily tracking, context-budget, and turn-cost behavior remain unchanged.
- Proxy configuration is read from the process environment and follows OMP's cached provider-proxy model. Changing it requires restarting OMP.

## Testing Decisions

- The primary test seam is the existing mounted-extension harness: register the real extension against a fake ExtensionAPI, fire lifecycle/provider events, and assert observable widget output and outbound usage behavior. This is the highest existing seam that covers scheduling, state transitions, rendering, and integration with AuthStorage without a real account or network.
- Tests must verify externally visible contracts rather than private helper structure. A good test should fail if a plausible regression reintroduces global proxy mutation, secondary-only parsing, stale API display, duplicate requests, or disappearing widget states.
- The mounted-extension seam will assert that `session_start` starts one refresh, each non-overlapping `agent_end` starts one refresh, `agent_start` starts none, and overlapping triggers share one in-flight request without a trailing call.
- The proxy contract test will provide `PI_PROXY_OPENAI_CODEX` and observe that the Codex provider fetch receives the scoped proxy while `HTTPS_PROXY` and unrelated fetches remain unchanged.
- A proxy-precedence test will verify that `PI_PROXY_OPENAI_CODEX` wins over `PI_PROXY`, and a missing-proxy test will verify that no network call occurs and the generated configuration error is rendered.
- A provider-auxiliary-request test will verify that every fetch made within one Codex usage-provider invocation receives the scoped proxy.
- OAuth tests will cover exactly one account, zero accounts, and multiple accounts using the first stable entry. They will assert that the public exact-account access path is used and no aggregate usage fetch is invoked.
- A compatibility test will make the dynamic OMP module load fail and assert that the extension remains mounted while the widget reports `incompatible OMP version`.
- Header behavior tests will feed primary-weekly/secondary-short, secondary-weekly/primary-short, primary-weekly/secondary-monthly, missing-window, and unknown-duration snapshots. Only duration-qualified main-chat windows may render as weekly.
- Boundary tests will cover durations just inside and just outside the ±5% weekly range, exact seven days, and ties between eligible main-chat windows.
- Additional-limit tests will include a feature-specific weekly limit alongside the main chat limit and assert that only the main chat limit is shown.
- Partial-data tests will independently omit percentage and reset time and assert stable placeholders for the missing field.
- State-transition tests will cover loading to success, loading to error, API success to API failure, header success plus proxy failure, and subsequent API recovery clearing the active-fetch error.
- Error-rendering tests will use long messages containing wide Unicode characters, newlines, tabs, and ANSI bytes. They will assert visible escaping, a 48-display-column message budget, an ellipsis on truncation, and no popup notification.
- Because raw error text is intentionally unredacted, a behavior test will document that token-like text is preserved; test data must use an obviously fake token and must never contain a real credential.
- Existing pure ChatGPT-usage tests are prior art for duration selection, reset formatting, header normalization, and partial-field rendering. Existing extension tests are prior art for lifecycle events and widget assertions. New acceptance coverage should prefer the mounted-extension seam and retain focused pure tests only where terminal-width boundary cases would be unnecessarily opaque at the higher seam.
- Permanent tests must be deterministic, isolated from the network, and must not depend on the developer's proxy process or OAuth database.
- After implementation, a one-off smoke verification should launch the actual extension with a configured `PI_PROXY_OPENAI_CODEX`, exercise a Codex turn, and observe weekly percentage, reset time, and per-turn refresh. This smoke check is verification evidence, not a committed test and must not expose OAuth material.

## Out of Scope

- Modifying OMP core so that aggregate usage reports honor provider-specific proxies.
- Changing the behavior of the `omp usage` command.
- Setting or mutating global `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` values.
- Falling back to a direct request when provider proxy configuration is missing.
- Supporting live proxy-environment changes without restarting OMP.
- Defining behavior for contradictory `PI_PROXY_OPENAI_CODEX` and `NO_PROXY` settings.
- Correct active-account selection, aggregation, or display for multiple Codex OAuth accounts.
- Supporting API-key-only Codex authentication for the ChatGPT account usage endpoint.
- Supporting OMP versions that do not expose the required OAuth, usage-provider, header-parser, and proxy APIs.
- Copying or independently maintaining the OpenAI backend usage JSON parser.
- Displaying feature-specific additional limits, reset-credit counts, daily limits, monthly limits, or annual limits.
- Persisting weekly usage or error state across OMP process restarts.
- Retrying failed usage requests or queuing a trailing refresh after a shared in-flight request.
- Adding popup notifications for usage-loading or usage-error states.
- Redacting credentials or account identifiers from the explicitly requested raw error-message prefix.
- Treating OpenAI's raw backend headers or usage payload as a stable, versioned public API contract.
- Changing existing DeepSeek budgets, pricing tiers, balance fetching, daily archives, token calculations, or widget behavior.

## Further Notes

- Diagnosis demonstrated that a direct ChatGPT usage request timed out in the target environment, while the same authenticated request through `http://127.0.0.1:10808` returned HTTP 200 with `used_percent`, a seven-day `limit_window_seconds`, `reset_after_seconds`, and `reset_at`.
- Setting `HTTPS_PROXY` made the existing OMP aggregate usage report and current extension renderer work, proving that the backend returned the values and that the missing widget was caused by transport scope rather than absent API fields.
- OpenAI's public Codex pricing documentation says additional weekly limits may apply; it does not guarantee a weekly limit for every account or bind weekly semantics to secondary.
- Current first-party OpenAI Codex source parses both primary and secondary windows and classifies display roles from each window's reported duration. Official tests explicitly include weekly in primary with 5-hour or monthly data in secondary.
- The raw `x-codex-*` headers and ChatGPT backend usage JSON are visible in first-party source but were not found as a stable public HTTP contract. The implementation must remain field-driven and tolerant of missing windows.
- Supporting primary/secondary role reversal and unknown future durations is an intentional compatibility property, not an assertion that OpenAI guarantees the current wire format.
- The repository contains a separate primary-source research note documenting the OpenAI evidence and links used for the duration-driven decision.
