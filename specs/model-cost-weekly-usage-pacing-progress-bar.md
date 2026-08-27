# Weekly Usage Pacing Progress Bar for Model Cost Tracker

Status: `ready-for-agent`

## Problem Statement

Model Cost Tracker 当前在 ChatGPT/Codex 模式下显示 `7d N%`、重置倒计时和绝对重置时间，但用户仍需自行推算七天周期已经过去多少比例，才能判断当前周额度消耗是否快于时间进度。

单独看到额度已使用百分比无法回答“当前用量是否超前、超前多少”这一核心问题。用户必须从重置时间倒推周期开始时间，再把当前时刻换算成七天周期百分比；这在终端中既不直观，也难以持续准确比较。现有显示还没有一种同时依靠位置、线条粗细、刻度和颜色表达额度节奏的视觉语言。

## Solution

在现有 `7d` 周额度位置加入一条固定 20 格的单轴进度条，同时编码额度使用进度和七天周期时间进度：

- 已使用额度以粗横线 `━` 表示。
- 未使用额度以细横线 `─` 表示。
- 七天周期已经流逝的位置以竖线 `│` 覆盖在同一条轨道上。
- 条后显示一位小数的 `额度百分比 / 时间百分比`。
- 当额度落后于时间时，`│` 位于细线中；两者相等时，`│` 位于粗细线交界；额度超前时，`│` 位于粗线中，且竖线后仍有粗线。
- 额度相对时间超前的百分点决定粗线和额度数字的语义颜色。
- 在窄终端中按信息优先级逐级移除图形和重置文案，始终优先保留两个精确百分比。

正常显示示例：

```text
7d ━━━│━━──── 60.0% / 30.0% · resets in 4d 21h (08/23 14:00)
```

## User Stories

1. As a Codex user, I want to see weekly usage and elapsed cycle time on one shared scale, so that I can judge consumption pace without doing mental arithmetic.
2. As a Codex user, I want the pacing visualization beside the existing `7d` label, so that it remains clearly associated with the weekly quota.
3. As a terminal user, I want one combined progress bar rather than two separate bars, so that the comparison consumes minimal vertical and horizontal space.
4. As a Codex user, I want used quota represented by a heavy line, so that the consumed portion is immediately recognizable.
5. As a Codex user, I want unused quota represented by a thin line, so that the remaining portion remains visible without competing with the consumed portion.
6. As a Codex user, I want elapsed time represented by a vertical marker on the quota track, so that both percentages share one visual coordinate system.
7. As a Codex user whose usage is behind elapsed time, I want the time marker to appear in the thin portion, so that I can immediately see that usage is behind pace.
8. As a Codex user whose usage matches elapsed time, I want the time marker at the heavy-to-thin transition, so that equality has an unambiguous visual form.
9. As a Codex user whose usage exceeds elapsed time, I want the time marker inside the heavy portion with heavy line after it, so that over-pace consumption is visible without reading the numbers.
10. As a Codex user, I want the exact quota and time percentages after the bar, so that character-cell resolution does not hide small differences.
11. As a Codex user, I want both percentages displayed to one decimal place, so that the comparison is precise without implying unnecessary second-level precision.
12. As a Codex user, I want the quota percentage listed before the time percentage, so that the numbers follow the same quota-first semantics as the bar.
13. As a Codex user whose usage does not exceed elapsed time, I want the quota portion shown in the normal theme text color, so that on-pace usage is neutral rather than alarming.
14. As a Codex user whose usage is up to 15 percentage points ahead, I want the quota portion shown with the theme success color, so that a small lead is distinguishable.
15. As a Codex user whose usage is more than 15 and up to 30 percentage points ahead, I want the quota portion shown with the theme warning color, so that a material lead is noticeable.
16. As a Codex user whose usage is more than 30 percentage points ahead, I want the quota portion shown with the theme error color, so that a large lead is immediately prominent.
17. As a themed-terminal user, I want semantic theme colors rather than hard-coded ANSI colors, so that the bar remains readable in light, dark, and custom themes.
18. As a user interpreting the pacing status, I want status color applied only to the heavy quota line and quota number, so that color meaning remains attached to quota usage.
19. As a user interpreting elapsed time, I want the time marker, thin line, separator, and time number to retain the default text color, so that time remains a stable reference.
20. As a user in a low-color or monochrome environment, I want heavy, thin, and vertical glyphs to retain distinct shapes, so that the comparison remains understandable without color.
21. As a Codex user, I want the cycle start derived as exactly seven days before the reported reset time, so that elapsed time follows a deterministic weekly model.
22. As a Codex user at the start of a valid cycle, I want elapsed time to show `0.0%`, so that the marker begins at the left edge.
23. As a Codex user at the exact reset instant, I want elapsed time to show `100.0%`, so that the marker reaches the right edge before refreshed quota data arrives.
24. As a Codex user, I want expired or implausibly distant reset times rejected, so that stale timestamps do not produce misleading pacing information.
25. As a Codex user whose reset time is missing, I want the quota track retained without a time marker and the time value shown as `--`, so that valid quota data remains useful.
26. As a Codex user whose time state is unknown, I want the heavy quota line and quota number shown with the muted theme color, so that unknown pacing is not mistaken for safe pacing.
27. As a Codex user, I want missing, expired, and invalid reset states described differently, so that I can understand why time progress is unavailable.
28. As a Codex user, I want the existing reset countdown and local absolute reset time preserved when space permits, so that I can verify and plan around the reset moment.
29. As a Codex user, I want an expired reset timestamp retained in the text, so that stale data remains diagnosable.
30. As a Codex user, I want weekly quota data from both active usage reports and response headers rendered consistently, so that the visualization does not depend on which existing data path updated it.
31. As a Codex user, I want the time percentage refreshed whenever the widget already redraws, so that visible data reflects the current render time.
32. As a Codex user, I do not want a new timer for the time marker, so that the extension does not redraw merely to animate a seven-day scale.
33. As a Codex user, I do not want additional quota requests for the pacing display, so that the feature does not increase network traffic or rate-limit pressure.
34. As a terminal user, I want the full 20-cell bar at normal widths, so that the visualization has stable resolution and aligns with the existing context bar scale.
35. As a narrow-terminal user, I want the bar removed before exact numbers are removed, so that precise comparison survives when graphics do not fit.
36. As a narrower-terminal user, I want absolute reset time removed before reset countdown, so that the most actionable reset information survives longer.
37. As an extremely narrow-terminal user, I want at least `7d quota% / time%` retained before truncation, so that the core feature remains available.
38. As a terminal user, I want the weekly segment to remain on one physical line, so that the existing widget layout does not grow or wrap unpredictably.
39. As a Codex user, I want loading, missing-quota, proxy, authentication, compatibility, and transport states to keep their current messages, so that the new visualization does not obscure established diagnostics.
40. As a Codex user whose quota percentage is unavailable, I do not want a fabricated empty bar, so that missing usage is not interpreted as zero usage.
41. As a Codex user receiving an over-100 percentage, I want the graphic clamped to full while the original number remains visible, so that the track stays bounded without hiding reported overage.
42. As a Codex user near a color threshold, I want color classification based on raw values rather than rounded labels, so that display rounding cannot change pacing status.
43. As an existing Model Cost Tracker user, I want the context-budget bar and cost lines to remain unchanged, so that the feature only enhances weekly Codex usage.
44. As an extension maintainer, I want the implementation confined to the extension and public OMP APIs, so that OMP core does not gain feature-specific behavior.
45. As an extension maintainer, I want width calculations to use terminal display width rather than JavaScript string length, so that ANSI styling and wide characters do not break fallback decisions.
46. As an extension maintainer, I want deterministic rendering under a controlled clock and theme, so that pacing behavior can be tested without real accounts, network access, or waiting for time to pass.

## Implementation Decisions

- The change is extension-only. OMP core, the global process environment, the Codex usage provider, and the raw usage protocol remain unchanged.
- Existing active-report and response-header paths continue to feed the same weekly-window selector and ChatGPT usage state. The feature consumes the already normalized `usedPercent` and epoch-millisecond `resetsAt` values.
- The selected window's reported duration will not be added to extension state. The elapsed-time model intentionally uses exactly 604,800,000 milliseconds, matching the requested fixed seven-day period.
- Cycle start is the reported reset time minus exactly seven days. Elapsed time is the proportion between cycle start and the current render time.
- A reset time is valid only when it is at or after the current time and no more than exactly seven days in the future. Equality at the current time is valid and yields 100%; equality at seven days in the future is valid and yields 0%.
- Missing, zero, non-finite, expired, or more-than-seven-days-distant reset values do not produce a time percentage or marker. There is no clock-skew tolerance or extrapolation.
- The pacing delta is an absolute percentage-point difference: raw quota percentage minus raw time percentage. It is not a relative ratio.
- Color boundaries are exact: `delta <= 0` uses normal text; `0 < delta <= 15` uses `success`; `15 < delta <= 30` uses `warning`; and `delta > 30` uses `error`.
- If time percentage cannot be computed, unknown status takes precedence over all quota values, including a quota value over 100%; the heavy quota line and quota number use `muted`.
- Status color applies only to every rendered heavy quota glyph and the quota percentage. The `7d` label, thin glyphs, time marker, separator, time percentage, and reset text use the theme's default text color.
- The combined progress bar has a fixed visible width of 20 terminal cells. It is not adaptive and does not become a 40-cell or sub-cell-resolution bar.
- The quota base track is rendered first: heavy `━` glyphs before the quota boundary and thin `─` glyphs after it. Quota position uses the nearest representable character-cell position after clamping the graphic to the 0–100 range.
- A valid time marker is rendered second at the nearest representable character-cell position and replaces the glyph in that cell. The marker does not increase total bar width.
- At equal quota and time positions, the marker appears at the heavy-to-thin boundary. When quota is ahead, heavy glyphs remain after the marker; when quota is behind, the marker falls in the thin region whenever the character resolution can represent the difference.
- Differences smaller than the 20-cell graphic resolution may not create a visible heavy glyph after the marker. Exact labels and raw-value status color remain authoritative; the renderer must not force or exaggerate a one-cell lead.
- Percentage labels are formatted with ordinary rounding to one decimal place as `quota% / time%`. Raw values remain authoritative for classification and glyph positioning.
- A quota value above 100 fills the graphic to 100 while retaining the original formatted numeric value and using the original value for a valid pacing delta. Current OMP normalization normally clamps this input, so this is defensive rendering behavior.
- The normal weekly segment is ordered as `7d`, combined bar, numeric comparison, reset countdown, and local absolute reset time.
- Normal reset text retains the existing countdown and host-local absolute date/time behavior. Missing reset text is `reset unknown`; expired text is `reset expired (<local time>)`; more-than-seven-days-distant text is `reset invalid (<local time>)`.
- A successful usage state with quota percentage but no valid reset renders the quota track without `│`, uses a muted quota presentation, and displays `quota% / --` plus the relevant reset-state text.
- A state without quota percentage does not render the new bar. Existing loading, missing-weekly, configuration, authentication, compatibility, and transport messages remain the observable behavior for their current states.
- Existing context-budget, Total, Turn, DeepSeek balance, pricing, daily archive, and segmented-cost rendering remain unchanged.
- The widget will use OMP's public component-factory form so rendering receives the actual available width and current theme. No private OMP progress helper or internal deep import will be used.
- The renderer will use public ANSI-aware display-width and truncation utilities. Width decisions must be based on visible terminal columns, not string length.
- The full first-line candidate is attempted first. If it does not fit, the weekly portion degrades in this order: remove the 20-cell bar; remove the absolute reset timestamp; remove the reset countdown; finally keep only `7d quota% / time%`. ANSI-aware right truncation is allowed only when the minimal form still does not fit.
- Width degradation must retain one physical line and must not wrap the weekly segment onto another line.
- No new interval, timeout, polling loop, or animation is introduced. The renderer computes time from the current clock whenever an existing extension refresh already occurs.
- Every existing refresh trigger may update the time percentage, including session lifecycle redraws, agent redraws, provider-response updates, active quota refresh completion, and existing pricing-boundary redraws. This computation does not itself trigger a redraw.
- Existing quota-fetch frequency and single-flight behavior remain unchanged. In particular, the pacing bar does not create an API request.
- The implementation should retain an explicit `now` input at the weekly rendering boundary so deterministic tests can exercise cycle and threshold edges without sleeping or relying on wall-clock timing.
- The extension documentation will be updated to describe the combined weekly pacing bar, fixed-seven-day calculation, status colors, and width fallback without changing unrelated usage-fetch documentation.

## Testing Decisions

- The primary acceptance seam is the existing mounted-extension harness: register the real Model Cost Tracker against a fake ExtensionAPI, drive its real lifecycle and provider-response events, capture the widget component factory, and render the resulting component at controlled widths with a controlled theme and clock. This is the highest existing seam that covers data ingestion, state transitions, theme selection, width fallback, line composition, and observable terminal output in one place.
- No production-only testing API should be added. Existing fake OMP module loading, fake provider/header reports, lifecycle event capture, and controlled clock facilities should supply the necessary inputs.
- Tests must assert externally visible behavior rather than private helper names, call graphs, or intermediate arrays. A good test should fail if a plausible regression swaps quota/time semantics, changes a threshold boundary, inserts the marker instead of overlaying it, colors the time reference, adds a timer/request, wraps the line, or drops precise values during width fallback.
- Theme tests should use distinguishable fake semantic formatters and assert that only heavy quota glyphs and the quota number receive normal/success/warning/error/muted status styling. Thin glyphs, `│`, `/`, the time number, and reset text must remain default text.
- Bar-shape tests should cover quota behind time, equal to time, and ahead of time. They should assert a 20-cell visible bar, heavy/thin transition, one overlay marker, and heavy glyphs after the marker when the represented quota lead is large enough to occupy a cell.
- Quantization tests should assert nearest-cell positioning and confirm that a sub-cell quota lead is not artificially expanded. Numeric labels and color must still reflect the raw values.
- Color-boundary tests should cover delta values at and immediately around 0, 15, and 30 percentage points. They must distinguish percentage-point subtraction from relative percentage calculations.
- Precision tests should use values whose one-decimal rendering differs from their raw threshold classification, proving that formatting does not feed back into color or position calculations.
- Time tests should cover exactly seven days before reset, intermediate progress, the exact reset instant, expired reset, more than seven days until reset, missing reset, zero, and non-finite reset values.
- Unknown-time tests should assert no `│`, `quota% / --`, muted heavy glyphs and quota number, default thin glyphs, and the correct `unknown`, `expired`, or `invalid` reset text.
- Missing-quota tests should assert that no combined progress bar is fabricated and that the established missing or error message remains visible.
- Defensive overage tests should inject quota above 100, assert a visually full track, retain the original one-decimal number, and verify that unknown-time muted status overrides otherwise valid color classification.
- Responsive tests should render at widths around every degradation boundary and assert the exact priority order: full form, no bar, no absolute reset time, no countdown, minimal comparison, then ANSI-aware truncation. No case may add a physical line.
- Existing-state tests should verify that loading, missing weekly window, configuration, authentication, compatibility, and transport errors continue to render their established messages.
- Refresh tests should verify that an existing redraw observes a later controlled time while introducing no new managed timer and no extra active usage request. Existing session and agent quota-fetch behavior remains unchanged.
- Regression tests should confirm that the context-budget bar and Total/Turn lines remain present and semantically unchanged around the modified weekly segment.
- Existing mounted-extension tests are prior art for lifecycle events, fake ExtensionAPI behavior, widget capture, provider mocking, and single-flight assertions. Existing ChatGPT usage tests are prior art for controlled OMP module loading, weekly-window reports, reset values, and partial data. Existing segment-bar tests are prior art for terminal glyph and theme assertions.
- Committed tests must be deterministic, isolated from the network, independent of local OAuth storage and proxy processes, and safe to run with the full repository suite.
- After implementation, a one-off smoke verification should launch the actual extension in OMP with Codex usage available, exercise an existing redraw path, and visually confirm the full bar, marker relationship, colors, reset text, and width fallback. The smoke check must not expose OAuth material.

## Out of Scope

- Rendering separate quota and time progress bars.
- Animating or periodically advancing the time marker with a new timer.
- Adding quota polling, retries, trailing refresh queues, or network requests.
- Predicting exhaustion dates, extrapolating future usage, or declaring that above-linear usage is inherently bad beyond the agreed colors.
- Making threshold values, glyphs, width, or colors configurable.
- Using relative-overage percentages instead of absolute percentage-point differences.
- Increasing the bar to 40 cells, using fractional terminal cells, or forcing a visible lead for differences below character resolution.
- Changing the existing context-budget progress bar or its thresholds.
- Changing DeepSeek pricing, balances, daily archives, token accounting, Total/Turn calculations, or segmented cost rendering.
- Changing weekly-window selection, primary/secondary handling, additional-limit handling, active-account selection, OAuth behavior, provider proxy behavior, timeout behavior, or single-flight behavior.
- Displaying daily, monthly, annual, reset-credit, Spark, or other additional usage limits.
- Modifying OMP core or publishing a new generic OMP ProgressBar API.
- Deep-importing OMP's internal progress helpers or status-line implementation.
- Persisting time progress, render state, or stale weekly values across OMP restarts.
- Changing the host-local timezone used by existing absolute reset text.
- Showing a stale last-known bar for states that no longer contain a reliable quota percentage.
- Wrapping the weekly segment onto a second physical line.
- Adding popup notifications for weekly pacing, loading, or error states.

## Further Notes

- Codebase-memory analysis confirms that the current weekly usage flow already normalizes both active usage reports and Codex response headers into the same ChatGPT usage state before the widget refreshes.
- The current selector accepts main-chat windows within ±5% of seven days, but the extension state intentionally discards the reported duration. This feature uses the explicitly agreed fixed-seven-day calculation rather than expanding state to preserve actual duration.
- OMP exposes component factories, semantic themes, managed redraw behavior, and ANSI-aware width utilities, but no public progress-bar or time-marker component. The combined track therefore belongs in the extension renderer while remaining on public APIs.
- The repository contains no domain glossary or applicable ADR for this area. Terminology follows the existing Model Cost Tracker README, Codex usage research, and scoped usage-proxy specification.
- This document is published locally with `ready-for-agent` status, as requested, rather than creating an issue-tracker item.
