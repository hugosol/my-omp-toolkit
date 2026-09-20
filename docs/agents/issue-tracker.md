# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- **Decision tickets** (planning): `.scratch/<feature-slug>/decision/<NN>-<slug>.md`, numbered from `01`
  → Produced by `/wayfinder`. Use Decision ticket statuses from `triage-labels.md`.
- **Implementation tickets**: `.scratch/<feature-slug>/implementation/<NN>-<slug>.md`, numbered from `01`
  → Produced by `/to-tickets`. Use Implementation ticket statuses from `triage-labels.md`.
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed). Decision tickets go in `decision/`; implementation tickets go in `implementation/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Decision ticket**: `.scratch/<effort>/decision/<NN>-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `open`/`claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/decision/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: write the discussion results to the ticket body, then call the Skill tool with "lighthouse" to produce the lighthouse document in `lighthouse/`. Set `Status: resolved`, and append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
