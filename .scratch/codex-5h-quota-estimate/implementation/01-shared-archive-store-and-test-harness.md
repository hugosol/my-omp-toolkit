# 01: Prefactor — shared archive document store and mounted-extension test harness

Source: [spec.md](../spec.md) · [contract.md](../contract.md)

**What to build:** Nothing user-visible changes. Two pieces of infrastructure become shared before the estimate feature lands, so the new work does not duplicate either one.

First, the cost-archive publication mechanics the daily archive already owns — archive directory resolution, ensure-directory, the cross-process lock options, temp-file plus retrying rename, and JSON read — become a store that any document in that directory is published through and observed through. The daily archive keeps its current behaviour exactly; it simply stops owning a private copy of those mechanics.

Second, the mounted-extension test harness becomes importable instead of file-local: mounting the real extension against a fake ExtensionAPI, installing the fake Codex module loader, building a context factory with an injectable clock, firing lifecycle events and commands, capturing and rendering the widget factory at a chosen width, and substituting the archive home. The suites that currently keep private copies of these helpers use the shared one, so the new suites do not add a third and fourth copy; the suite that drives a fully fake clock keeps that clock facility and borrows only the mount and context helpers it needs.

**Delivers:** enabling: unblocks P9, P10, P11, and the test surface for every other promise.

**Blocked by:** None (can start immediately).

**Status:** closed

- [ ] The daily archive suites pass with unchanged assertions: read/write round trip, archive-and-reset, session merge, the concurrency leftovers census.
- [ ] A caller can publish a JSON document into the cost archive directory and read it back without re-implementing directory resolution, lock options, or the Windows rename retry; a missing document reads as absent rather than throwing.
- [ ] No production copy of the archive-directory or rename-retry logic remains duplicated after the daily archive delegates to the shared store.
- [ ] The shared harness mounts the real extension, substitutes the archive home for a temporary directory, controls the clock, and captures the rendered widget; the existing mounted suites use it with their assertions unchanged, and the fake-clock suite keeps its own clock substitution and assertions.
- [ ] No test in the repository writes into the real home directory.
