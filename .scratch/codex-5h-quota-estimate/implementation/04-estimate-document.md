# 04: Estimate document — persistence, validation, cadence, and concurrent publication

Source: [spec.md](../spec.md) · [contract.md](../contract.md)

**What to build:** The baseline pair and the stored estimate survive the process, and several OMP instances can share them safely. They live in one estimate state document in the extension's existing cost archive directory, published through the shared store's cross-process lock and atomic rename, so no reader ever parses a half-written document.

The document is exactly six numbers — the baseline's two used percentages, its two reset timestamps, its capture time, and the stored estimate — with no schema version field and nothing else. Before any estimate exists there is no writable document, because the six-number shape has no room for a baseline without an estimate; the baseline lives in memory until the first qualifying sample publishes the document, and the in-progress sample (current deltas and the candidate ratio) is never written at all.

Load-time validation checks shape and ranges: an object whose five baseline numbers are finite, used percentages between 0 and 100, and a positive estimate. A missing, unreadable, wrong-shape, or out-of-range document behaves as a first run — no crash, no fabricated value — and the next qualifying sample publishes a valid document again.

Writes are asynchronous and best-effort: a baseline change writes immediately, a qualifying ratio update writes at most once per 60 seconds and is otherwise withheld in memory until the next trigger, nothing else writes the file, and a failed write keeps in-memory state for the next trigger to retry. Event handling is never blocked by the write.

Publication merges rather than overwrites. Inside the lock the on-disk document is compared with the in-memory one by the baseline's capture time and the newer baseline wins, so an instance holding an older state can never replace a newer one; when the capture times are equal the writing instance's state is what lands. A baseline another instance published inside the same windows stays valid for a reader, because it anchors the same windows, so the reader adopts it and keeps sampling instead of restarting the measurement.

After a restart the loaded baseline and stored estimate continue the measurement, so a restart or a long idle stretch still shows a usable estimate instead of `estimating…`. `/budget clear` leaves the estimate document exactly as it was — archiving the daily tracking does not force a relearn.

**Delivers:** P9, P10, P11; contributes P4 (absent and corrupt document items), P7 (value-survives-long-idle item), P13 (command-effect item).

**Test owner for:** P4 (absent and corrupt document items), P7 (value-survives-long-idle item), P13 (command effect on both documents).

**Blocked by:** 01, 02.

**Touch point:** this ticket owns the estimate state, its document, and the write path. 03 owns the weekly line's composition. Splice between them at the appended-segment text, which 02 already produces; neither ticket changes the other's region.

**Status:** closed

- [ ] Publish-then-load round trip preserves all six numbers exactly, and the document carries no field beyond them.
- [ ] Cold start: no document exists before the first qualifying sample; the baseline is established in memory and re-anchored from the next paired reading if the process restarts first.
- [ ] First-run behaviour: an absent document, an unparseable document, a wrong-shape document, an out-of-range used percent, and a non-positive estimate each read as a first run — `estimating…`, no crash, and a valid document published once a sample qualifies.
- [ ] Cadence: a baseline change writes immediately; a ratio-only update 30 seconds after a write is withheld and one 61 seconds after a write is published; skipped samples and redraw-only passes write nothing.
- [ ] A failed write leaves in-memory state intact and the following trigger retries it successfully.
- [ ] Continuity: a fresh instance loading a valid document shows the stored estimate without relearning and continues sampling from the loaded baseline; the estimate is never expired, so an idle stretch longer than the five-hour window still shows a value.
- [ ] `/budget clear` leaves the estimate document byte-identical while the daily archive still archives and resets as before.
- [ ] Two instances over one archive home interleaving baseline and ratio writes never leave a document a reader cannot parse, and no temporary file is ever the visible document.
- [ ] An instance whose baseline capture time is older cannot overwrite a document carrying a newer baseline; with equal capture times the writing instance's state is what the document holds.
- [ ] An instance that finds a baseline written by another instance within the same windows adopts it and continues sampling from it rather than starting a fresh measurement.

## Comments

- 2026-09-21: Persisted shape revised after this ticket closed. The six-number document became a human-readable `baseline`/`ratio` shape with named windows, local-offset ISO-8601 timestamps and four-decimal numbers; the previous shape reinitializes as a first run instead of migrating. See `spec.md` §Implementation Decisions and `contract.md` P9.
- 2026-09-21: The first usable paired reading now publishes the baseline with `ratio: null` (superseding this ticket's "no writable document before an estimate" rule), so restarts resume the same measurement, and a known ratio is never downgraded to null. See P10/P11 and the ADR consequence.
