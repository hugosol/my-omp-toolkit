# Model Cost Tracking

The Model Cost Tracker extension: DeepSeek spend accounting and ChatGPT/Codex allowance tracking for the OMP status widget.

## Language

### Allowance windows

**Five-hour window**:
The Codex allowance period that refreshes every five hours; the widget labels it `5h`.
_Avoid_: 5-hour quota, primary window, 5h limit, 5h额度

**Weekly window**:
The Codex allowance period that refreshes every seven days; the widget labels it `7d`.
_Avoid_: secondary window, weekly limit, 7d额度

**Quota**:
The 100% reference a window's used percent is measured against; the server never exposes its absolute size.
_Avoid_: limit, allowance, amount, 额度（单用）

**Used percent**:
The share of a window's quota that the server reports as consumed.
_Avoid_: usage, utilization

**Quota ratio** (displayed as `ratio`):
How many five-hour quotas one weekly quota amounts to; a server policy value that is not exposed and can change, so this project estimates it rather than assuming it.
_Avoid_: 5h/7d ratio, conversion factor, 比例（单用）

**Remaining budget** (displayed as `left`):
The unconsumed share of the weekly quota, expressed as a count of full five-hour quotas.
_Avoid_: 剩余额度, remaining percentage, remaining time

**Refresh count**:
How many five-hour windows will still begin before the weekly window rolls over; a time quantity, distinct from remaining budget.
_Avoid_: 剩余次数, 剩余几个5h（when the budget is meant）

### Lifecycle events

**Window rollover**:
The moment a window refreshes and its used percent returns to zero.
_Avoid_: reset (alone), refresh (alone)

**Saved reset** (also banked reset; OMP: reset credit):
A user-held credit that refreshes both Codex windows early and moves the weekly reset time; for measurement it invalidates the baseline exactly like a rollover.
_Avoid_: reset (alone)

### Measurement

**Paired reading**:
Both windows' used percentages obtained from a single usage fetch or a single set of rate-limit headers; the only acceptable input for measuring consumption.
_Avoid_: snapshot (when the merged widget state is meant)

**Baseline pair**:
A paired reading that anchors consumption measurement for the current windows.
_Avoid_: initial value, 初始额度

**Sample**:
The movement of both used percentages measured from the baseline pair while both windows stay the same.
_Avoid_: delta, 采样值

**Qualifying sample**:
A sample whose five-hour movement is large enough to be trusted; only qualifying samples may replace the stored estimate.
_Avoid_: valid sample (validity is a weaker, separate condition)

**Stored estimate**:
The quota ratio from the last qualifying sample, kept for display until a newer qualifying sample replaces it.
_Avoid_: history, cache

**Estimate**:
The quota ratio the widget shows: the current window's qualifying sample when one exists, otherwise the stored estimate; `estimating…` marks the absence of any estimate.
_Avoid_: guess, approximation

**Saturation**:
The state of a window whose used percent has reached its maximum, so that later consumption is invisible to it.
_Avoid_: exhaustion, full

**Credit overage**:
Consumption funded by purchased credits beyond the plan quota; never part of remaining budget.
_Avoid_: credits, overage (alone)

**Shared consumption**:
The property that one unit of Codex usage consumes both windows' quotas, making their percentage movements proportional.
_Avoid_: shared pool (that names the cross-product allowance pool)

### Pricing

**Peak / off-peak**:
The two DeepSeek price tiers. Peak applies on weekday Beijing `[09:00, 12:00]` and `[14:00, 18:00]` (inclusive); everything else, including all weekends, is off-peak.
_Avoid_: high/low rate, 高峰价/谷价（as bare nouns）

**Holiday pricing**:
The manual override that prices every DeepSeek request at off-peak until `/budget clear`; enabled with `/budget holiday`, stored as `holiday: true` in the daily archive, and shown as `🏖️`. It covers statutory holidays and make-up work days that the clock rule would otherwise bill as peak. It is a flag, not a recorded fact: requests made before it is enabled keep their peak cost, so an archive's `holiday` field only records the state at archive time.
_Avoid_: holiday mode, off-peak override, 谷价开关

### Existing widget language

**Pacing**:
The relationship between quota consumed and time elapsed inside one window, encoded by the existing progress bars.
_Avoid_: progress, remaining

**Period icon**:
The glyph leading the DeepSeek widget line that encodes the pricing period: `🔥` for peak, `🌙` for off-peak, and `🏖️` for holiday pricing. `🏖️` is a pure function of the holiday flag and does not switch with time of day.
_Avoid_: emoji, status icon
