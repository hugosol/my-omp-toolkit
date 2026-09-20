# 03: Remaining budget — `left≈N.N×5h` and the full appended segment

Source: [spec.md](../spec.md) · [contract.md](../contract.md)

**What to build:** Once an estimate exists, the 7d line answers the planning question directly: it shows how many full five-hour quotas the remaining weekly budget can still fund. The number is the unconsumed weekly share times the displayed estimate, at one decimal, recomputed from the currently displayed weekly used percent on every redraw — including redraws that carry no new observation, so it tracks weekly consumption rather than the sample that produced the estimate. It is a quota-unit number, not a time number: credits and overage never enter it, and a saturated weekly window reads `0.0×5h`.

The appended segment then reads `· left≈N.N×5h · ratio≈R.R`, with `left` first because it is the more actionable number. The appended numbers share the survival priority of the two percentages rather than the reset text's: the existing width fallback order is untouched (pacing bar first, then the absolute reset time, then the countdown), and at narrow widths the minimal form still carries both percentages plus `left`, with `ratio` dropped first by truncation. The widget never gains a line, and while no estimate exists the segment stays `· estimating…` with no numbers.

**Delivers:** P1, P14; contributes P3 (order).

**Test owner for:** P3 (order item).

**Blocked by:** 02.

**Touch point:** this ticket owns the weekly line's composition (segment order, colour, width ladder). 04 owns the estimate state and its persistence. Splice between them at the appended-segment text, which 02 already produces; neither ticket changes the other's region.

**Status:** closed

- [ ] `left` equals the unconsumed weekly share times the displayed estimate, at one decimal, for both a fresh qualifying sample and a stored estimate carried past a rollover.
- [ ] A redraw carrying no new observation recomputes `left` from the current weekly used percent, so a weekly percentage change alone moves the number.
- [ ] A saturated weekly window reads `0.0×5h`, and credits or overage never raise the number above the plan allowance.
- [ ] Composition: `left` precedes `ratio`; segment position, English labels, and the 7d quota number's semantic colour are unchanged from the estimate-only form.
- [ ] Degradation: at widths around every existing boundary the fallback order is unchanged, the minimal form `7d quota% / time% · left≈N.N×5h · ratio≈R.R` survives on one line, and truncation drops `ratio` before `left`.
- [ ] While `estimating…` is shown, no numeric values appear anywhere in the segment.
