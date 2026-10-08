# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- **Decision tickets** (planning): `.scratch/<feature-slug>/decision/<NN>-<slug>.md`, numbered from `01`
  → Produced by `/wayfinder`; see Wayfinding operations below.
- **Implementation tickets**: `.scratch/<feature-slug>/implementation/<NN>-<slug>.md`, numbered from `01`
  → Produced by `/to-tickets`. Use Implementation ticket statuses from `triage-labels.md`.
- Record a `Status:` line near the top of each ticket. Decision tickets use the lifecycle below; only implementation tickets use triage roles from `triage-labels.md`.
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed). Decision tickets go in `decision/`; implementation tickets go in `implementation/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Decision ticket**: `.scratch/<effort>/decision/<NN>-<slug>.md`, numbered from `01`, with the question in the body. `Type:` records the processing method (`research`/`prototype`/`grilling`/`task`). `Status:` is only `open` (unclaimed), `claimed` (being worked), or `resolved` (decision or confirmed out-of-scope disposition recorded, independent of production delivery).
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every listed decision ticket is `resolved` and its recorded outcome satisfies the prerequisite. For a blocker listed in the map’s Out of scope, follow wayfinder’s disposition dependency review; status alone never unblocks its dependents.
- **Frontier**: scan `.scratch/<effort>/decision/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: follow wayfinder’s Work through the map procedure. For a confirmed out-of-scope disposition, use its Out of scope branch.
