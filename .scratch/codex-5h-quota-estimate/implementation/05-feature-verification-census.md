# 05: Feature verification — resource censuses, unchanged output, public surface

Source: [spec.md](../spec.md) · [contract.md](../contract.md)

**What to build:** The cross-cutting promises the feature must not break, verified at the mounted extension surface once every contributor has landed.

Across a redraw-only sweep — the widget rendered at several widths with no lifecycle events — the Codex usage provider is called exactly as often as before the feature, the extension registers no timer beyond the existing boundary timer, and no learning or write is triggered by a redraw. The feature is purely additive on screen: the pacing bar, the two percentages, the time marker, the reset text, and the five-hour line render byte-identically to pre-feature output, with the appended segment the only difference on the 7d line; DeepSeek-mode and token-only renders are untouched. The extension still mounts against the public OMP module surface, and when that surface is unavailable the existing incompatible-version message still renders with the extension observable.

**Delivers:** P12, P13 (pacing bar, percentages, time marker, reset text; the five-hour line; DeepSeek and token-only renders), P16.

**Blocked by:** 02, 03, 04.

**Status:** closed

- [ ] Provider call counts and timer registrations across a redraw-only sweep match the pre-feature baseline, and a redraw carrying no new observation triggers no document write.
- [ ] Rendered bytes for the pacing bar, the two percentages, the time marker, the reset text, and the five-hour line are identical to pre-feature output at every tested width.
- [ ] DeepSeek-mode and token-only renders are unchanged from pre-feature output.
- [ ] The loader-failure path still renders the existing incompatible-version message with the extension still observable.
