# 02: Learning core — paired readings to a qualifying sample, and `ratio≈R.R` on the 7d line

Source: [spec.md](../spec.md) · [contract.md](../contract.md)

**What to build:** In Codex mode the 7d line gains the appended estimate segment, and the estimate itself is learned from the usage the session already observes.

Learning consumes only paired readings — both windows taken from one usage fetch or one set of rate-limit headers — delivered by the existing usage paths. The merged widget state is never the learning input, because its per-window merge retains a stale value for a missing window and could pair that stale five-hour value with a fresh weekly one.

The first paired reading establishes the baseline pair. Each later paired reading inside the same windows yields a sample from the absolute percentage-point deltas of both windows. A sample is usable only when both deltas are positive and neither window is saturated; it qualifies only when the five-hour movement reaches 50 points. Only a qualifying sample may replace the stored estimate, and the newest one wins outright — no averaging, median, or span weighting. A rollover of either window rebuilds the baseline, and no sample is ever computed across a boundary: detection prefers the reported reset timestamps, falls back to a percentage decrease greater than one point only when those timestamps are unavailable, and never trusts a baseline older than the five-hour window.

On the widget, the segment sits between the existing `quota% / time%` numbers and the reset text, uses English labels, and carries the same semantic colour as the 7d quota number, including the muted case when the reset timestamp is unusable. With no estimate the segment reads `· estimating…` and shows no numbers; when either window is loading, missing, errored, or reports a non-finite percentage, nothing is appended and the rest of the line is unchanged.

**Delivers:** P2, P5, P6, P8, P15; contributes P3 (position, label language, semantic colour), P4 (first-run item), P7 (second-qualifying-sample and relearn items).

**Test owner for:** P4 (first-run item), P7 (second-qualifying-sample-wins and relearn-within-one-window items).

**Blocked by:** 01 (shared test harness).

**Status:** closed

- [ ] First run: a first paired reading with both windows usable renders `· estimating…` in the appended position and shows no numeric values.
- [ ] A qualifying sample — five-hour movement of at least 50 percentage points, both deltas positive, neither window saturated — makes the 7d line read `ratio≈R.R` at one decimal, matching that sample's ratio.
- [ ] Non-qualifying and unusable intervals leave the displayed estimate untouched: five-hour movement below the threshold (including zero movement), a saturated five-hour window, a saturated weekly window, weekly-only movement, and non-positive deltas.
- [ ] A later qualifying sample replaces the earlier estimate outright, and a second qualifying sample inside one five-hour window is what surfaces a changed quota relationship.
- [ ] A rollover of either window rebuilds the baseline, no sample spans the boundary, and the line keeps showing the previous estimate — for a moved five-hour reset timestamp, a moved weekly reset timestamp, an equal-percentage rollover that only the timestamp reveals, the percentage-drop fallback used when timestamps are unavailable, and a baseline aged five hours.
- [ ] Hiding: while either window is loading, missing, errored, or reports an unusable percentage, the appended segment is absent and the remainder of the line is unchanged from today's output.
- [ ] Intake and determinism: the same paired readings and clock always produce the same displayed estimate, and a reading is never assembled from the merged widget state — a stale five-hour value retained for a missing window must not pair with a fresh weekly value.
