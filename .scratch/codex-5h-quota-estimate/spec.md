# Codex 5h Quota Estimate for Model Cost Tracker

Status: `ready-for-agent`

Contract: [contract.md](./contract.md)

## Problem Statement

在 ChatGPT/Codex（`openai-codex`）模式下，Model Cost Tracker 现在显示 `5h` 与 `7d` 两条额度窗口，各带一条按"额度 vs 时间"编码的 pacing 条和 `额度% / 时间%` 数值。这回答了"这周是不是用超了"，但没有回答规划用量时最关键的问题：**剩下的周额度还够我满额用几个 5h 窗口？**

用户实际按 5h 窗口分配用量：5h 窗口每 5 小时刷新一次。但两个窗口各自只报告自己额度的已用百分比，二者之间的额度比例（7d 额度 ≈ 多少个 5h 额度）既不在界面上，也不在任何 API 返回里——OMP 的 Codex usage provider 只归一化出百分比（`used: 0–100, limit: 100, unit: "percent"`），上游 payload 也只带 `used_percent`、窗口时长与重置时间，没有任何绝对额度数值。

这个比例也不是固定常数，而是服务端策略：公开记录显示 5h 窗口占周额度的比例曾从约 33% 调整为约 15%，部分账号甚至没有 5h 窗口；不同套餐、不同时间点并不相同。它既不能硬编码，也无法从官方资料取得，只能在用户自己的观测数据上动态测量。

结果：用户看到 `7d 60.0%` 时，无法把它换算成"还能满额用几个 5h 窗口"，只能凭感觉分配本周剩余用量。

## Solution

在 7d 行末尾追加两个数字，例如：

```text
7d ━━━│─── 60.0% / 30.0% · left≈2.7×5h · ratio≈6.7 · resets in 4d 21h (08/23 14:00)
```

- `left≈2.7×5h`：当前剩余周额度约等于多少个"满额 5h 额度"，由 `left = (100 − u7) × R̂ / 100` 得出。
- `ratio≈6.7`：当前估算比例 R̂，含义是 7d 额度 ≈ 6.7 × 5h 额度。

R̂ 由同一 5h 窗口（且同一 7d 窗口）内的一对观测差值推得：`R̂ = Δ5h / Δ7d`，其中两个 Δ 都来自同一份成对快照，且期间没有任何窗口重置、两个计数器都未饱和。

每个 5h 窗口重置后重建基线；新窗口内样本跨度达到质量阈值（Δ5h ≥ 50 个百分点）之前，继续显示上一次达标估算值；从未产生过达标样本时显示 `estimating…`。基线与最近一次达标估算持久化在扩展既有的成本档案目录下的单一状态文件中，进程重启后测量可以继续。

整个功能只消费既有的额度观测（主动用量拉取与响应头两条件），不新增网络请求、不新增定时器，也不改动任何既有显示。

## User Stories

1. As a Codex user, I want my remaining weekly budget expressed in full 5h-quota units, so that I can see at a glance how many full 5h windows it can still fund.
2. As a Codex user, I want the estimated ratio between the 7d quota and the 5h quota displayed, so that I understand how the two windows relate on my plan.
3. As a Codex user, I want both numbers appended to the existing 7d line, so that they stay attached to the weekly quota without adding a widget line.
4. As a Codex user, I want the numbers shown to one decimal place, so that they match the precision of the existing percentages without implying false accuracy.
5. As a Codex user, I want `left` shown before `ratio`, so that the more actionable number survives first when horizontal space runs out.
6. As a Codex user, I want the appended numbers to reuse the 7d quota number's semantic theme color, so that the widget remains visually consistent.
7. As a Codex user, I want English labels consistent with the existing reset text, so that the weekly line reads uniformly.
8. As a Codex user, I want the appended numbers recomputed on every existing widget redraw, so that they stay current without any extra refresh request.
9. As a Codex user, I want the estimate recomputed on every paired usage observation inside a window, so that I can watch it converge as I work.
10. As a Codex user, I want a newly qualifying estimate to replace the stored one immediately, so that plan or policy changes are reflected within one 5h window.
11. As a Codex user whose 5h window just reset, I want the last qualifying estimate displayed instead of a short-window noisy value, so that the widget remains useful immediately after the reset.
12. As a Codex user, I want the remaining-unit number derived from the current weekly percentage and the displayed ratio, so that it always reflects the present moment.
13. As a first-time user, I want `estimating…` until a qualifying sample exists, so that no fabricated value is ever shown.
14. As a Codex user, I want samples with fewer than 50 percentage points of 5h movement excluded from the stored estimate, so that noisy short-window values are never persisted.
15. As a Codex user, I want samples taken while either counter is saturated excluded, so that credits-funded overage cannot understate the ratio.
16. As a Codex user, I want intervals where only the weekly counter moved excluded from learning, so that usage which is not shared between the counters cannot skew the ratio.
17. As a Codex user, I want the baseline re-established whenever either window resets, so that every sample spans exactly one 5h window inside one weekly window.
18. As a Codex user, I want reset detection to prefer the reported reset timestamps, so that a rollover that does not lower the percentages is still detected.
19. As a Codex user, I want a percentage-decrease fallback used only when reset timestamps are unavailable, so that detection still works for partial reports.
20. As a Codex user, I want a five-hour cap on baseline age, so that a missed reset cannot silently corrupt the estimate.
21. As a Codex user, I want the baseline and the last qualifying ratio persisted, so that restarting OMP does not lose measurement continuity.
22. As a Codex user, I want baseline changes persisted immediately and ratio refinements throttled, so that crash safety does not cost constant disk writes.
23. As a Codex user, I want the persisted state to contain only the six necessary numbers, so that the state file stays minimal and auditable.
24. As a Codex user, I want a missing or malformed state file treated as a first run, so that corruption can never break the widget.
25. As a user running multiple OMP instances against one account, I want writes serialized and published atomically, so that no instance ever reads a torn state file.
26. As a Codex user, I want the stored estimate to never expire, so that a light-usage stretch still shows a useful value.
27. As a Codex user with a missing 5h or weekly window, I want the appended numbers hidden, so that the widget never implies data that does not exist.
28. As a Codex user whose weekly quota is exhausted, I want `left` to read `0.0×5h`, so that the exhausted state is unambiguous.
29. As a Codex user who has purchased credits, I want the remaining-unit number to ignore credits entirely, so that it strictly reflects the plan allowance.
30. As a Codex user, I want existing pacing bars, percentages, time markers, reset text, and the 5h line unchanged, so that this feature is purely additive.
31. As a terminal user on a narrow terminal, I want the new numbers to survive alongside the percentages while the existing bar and reset text degrade first, so that planning data is not dropped early.
32. As a Codex user, I want no additional network requests, so that this feature cannot increase rate-limit pressure.
33. As a Codex user, I want no new timers or polling loops, so that the extension never redraws on its own.
34. As a Codex user, I want `/budget clear` to leave the learned estimate intact, so that archiving daily tracking does not force a relearn.
35. As a DeepSeek-mode user, I want this feature absent and my daily archive untouched, so that unrelated behavior does not change.
36. As an extension maintainer, I want the estimator expressed as a deterministic function of stored state, observation, and clock, so that it can be tested without network access or real time.
37. As an extension maintainer, I want learning to consume the paired snapshots delivered by the existing usage paths rather than the merged widget state, so that a stale window can never be paired with a fresh one.
38. As an extension maintainer, I want the feature built on public OMP extension APIs, so that the extension does not depend on internal APIs.
39. As a Codex user who switches models mid-week, I want R̂ to be relearned from fresh windows, so that a changed quota relationship does not persist forever.
40. As a Codex user, I want the estimate computed from absolute percentage-point deltas rather than relative changes, so that the arithmetic matches quota semantics.

## Implementation Decisions

- **Data reality**: the Codex usage provider normalizes both windows to percentages (`used: 0–100`, `limit: 100`, `unit: "percent"`); the upstream payload carries `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at` only. No absolute quota size exists on either path, so the 5h:7d quota ratio cannot be read and must be inferred.
- **Inference model**: within one 5h window (and one weekly window), two paired observations give `Δ5 = u5 − b5` and `Δ7 = u7 − b7`; because both counters measure the same shared consumption, `R̂ = Δ5 / Δ7 = Q7 / Q5`. The displayed remaining budget is `left = (100 − u7) × R̂ / 100`, expressed in units of full 5h quotas. `left` and `ratio` are quota-unit quantities, not time quantities.
- **Observation source**: learning consumes only paired snapshots where both windows come from a single usage fetch or a single rate-limit header parse, and only when both windows are successful with finite percentages. The merged widget state must not be used as the learning input, because per-window merge rules can retain a stale value for a missing window.
- **Baseline**: the pair `(u5, u7, r5, r7, at)` — the two used percentages, the two reported reset timestamps, and the local capture timestamp. It is established at the first observation ever seen and re-established from the current observation whenever a reset is detected.
- **Reset detection** (in priority order): baseline age `≥ 5h`; or a reported reset timestamp moved by more than a 30-minute tolerance (a real rollover moves about 5 or 7 days, while the tolerance absorbs second-level rounding in relative reset fields); or, only when reset timestamps are unavailable, a percentage decrease greater than 1 percentage point in either window. On reset, the baseline is rebuilt and no sample is computed across the boundary.
- **Sample validity**: `Δ5 > 0`, `Δ7 > 0`, `u5 < 100`, `u7 < 100`. Invalid intervals are skipped without touching stored state.
- **Sample quality**: a sample qualifies only when `Δ5 ≥ 50` percentage points. The latest qualifying sample replaces the stored ratio — no median, no averaging, no span weighting, no expiry.
- **Persisted state** (single document, exactly six numbers, settled during requirements discussion):

  ```json
  {
    "base": { "u5": 12.4, "u7": 3.1, "r5": 1799999999000, "r7": 1800400000000, "at": 1799900000000 },
    "ratio": 6.67
  }
  ```

  There is deliberately no schema version field. Load-time validation checks shape and ranges (object present, five finite numbers, `0 ≤ u ≤ 100`, `ratio > 0`); a missing or invalid document is treated as a first run. The live in-progress sample (current deltas and candidate ratio) is never persisted because it is recomputable from the baseline plus the latest observation.
- **Storage mechanics**: one state file named `codex-usage-estimate.json` in the extension's existing cost-archive directory, written through the extension's cross-process file lock and the existing temp-file + atomic-rename pattern (with the Windows rename retry). Writes are asynchronous and best-effort: a failed write keeps in-memory state and is retried at the next trigger; event handling is never blocked. Concurrent OMP instances publish through the shared lock with a read-compare-write merge: inside the lock the on-disk document is compared by baseline capture time (`at`), and the document with the newer baseline wins, so older state can never overwrite newer state; a within-window baseline written by another instance remains valid because it anchors the same windows.
- **Write policy**: a baseline change writes immediately; a qualifying ratio update writes at most once per 60 seconds. No other event writes the file.
- **Display contract**: the appended text sits between the existing `quota% / time%` numbers and the reset text, as `· left≈N.N×5h · ratio≈R.R`, one decimal, English labels, and reuses the same semantic theme color as the 7d quota number for the whole appended segment. When no ratio exists yet the segment is `· estimating…`. When either window is unavailable or its percentage is unusable, nothing is appended. At `u7 = 100%` the remaining number reads `0.0`. Credits and overage are never included.
- **Degradation**: the existing width fallback order is unchanged (pacing bar first, then absolute reset time, then countdown). The appended numbers share the survival priority of the two percentages, so the minimal form is `7d quota% / time% · left≈N.N×5h · ratio≈R.R`; `left` precedes `ratio` so ANSI truncation drops `ratio` first.
- **Resource budget**: no new timers, no new network requests, no polling. Learning runs only when the existing usage paths deliver a paired observation; ordinary widget redraws only recompute display text from in-memory state.
- **Scope**: applies only to `openai-codex` (ChatGPT/Codex) mode. A single-account assumption is taken; account switching and multi-account attribution are not handled. DeepSeek mode, the daily cost archive, balance, pricing, context budget, turn cost, and the 5h line are unchanged. `/budget clear` does not touch the estimate state file.
- **Seams**: test seams and module boundaries are intentionally left open for `/to-contract`. The conversation settled behavioral contracts only; the sole data-flow fact recorded here is that learning consumes paired snapshots delivered by the existing usage paths rather than the merged widget state.

## Testing Decisions

- Prior art in this repository: the mounted-extension harness drives the real extension against a fake ExtensionAPI, captures the widget component factory, and renders at controlled widths with a controlled clock and theme; pure usage tests cover duration-driven window selection, header normalization, and reset formatting; bar tests cover glyph and theme assertions.
- Determinism constraints: tests must not touch the network, OAuth storage, or a proxy process; they must control the clock and use temporary home directories for the state file. Existing test seams for module loading and file locking should be reused instead of adding production-only hooks.
- The estimator must be exercisable as a deterministic function of persisted state, an observation, and a clock, covering at least: qualifying and non-qualifying spans, all three reset signals, saturated windows, zero weekly movement, missing or unusable windows, missing/corrupt state documents, write throttling, fallback to the stored ratio, `estimating…`, hiding, and width degradation.
- Seams, the promises tested at them, and coverage are decided in `/to-contract`, not in this document.

## Out of Scope

- A time-based count of remaining 5h refreshes and a per-window allocation metric.
- Any new bar or graphic, and any change to the existing pacing bar, time marker, percentages, colors, or reset text.
- Multi-account and account-rotation handling, including attributing header observations to an account.
- Expiry, aging, averaging, median, or span-weighting of the stored estimate.
- Credits and overage accounting in the remaining-budget number.
- New timers, polling loops, or network requests.
- Hardcoding or fetching a plan-specific 5h:7d policy constant, or treating the ratio as fixed.
- Changes to DeepSeek mode, the daily cost archive, balance, pricing, context budget, turn cost, or the 5h line.
- README or other documentation updates; whether documentation is produced is decided separately by the maintainer.
- Verifying against a real account as an acceptance criterion.

## Further Notes

- Public evidence that the quota ratio is mutable policy — community and first-party issue reports of the 5h share moving from roughly 33% to roughly 15%, temporary removal of the 5h window, and plan-dependent behavior — is the reason the ratio is relearned every 5h window and never hardcoded.
- `left` is intentionally not capped by the remaining time in the week; it is a quota-unit quantity. The existing reset countdown stays visible so the user can still see when the budget will expire.
- Detection quality depends on the reporting precision of `used_percent`, which is not documented; the design assumes integer-percent worst case and the 50-point span threshold is chosen accordingly.
- Related earlier specs in the same area, extended additively and not modified: the weekly pacing progress bar spec (pacing bar contract) and the scoped Codex usage proxy spec (usage plumbing).
- The domain language for this area is recorded in the Model Cost Tracking context glossary (`extensions/model-cost/CONTEXT.md`); this spec uses its canonical terms (five-hour window, weekly window, quota ratio, remaining budget, baseline pair, qualifying sample).
- The decision to infer the quota ratio from observed consumption rather than hardcoding a policy constant is recorded as an ADR in the Model Cost Tracking context.
- This document is published to the repository's local markdown tracker at `.scratch/codex-5h-quota-estimate/spec.md` with `Status: ready-for-agent`.
