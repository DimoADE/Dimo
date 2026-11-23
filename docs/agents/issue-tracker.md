# Issue Tracker: Local Markdown

Local implementation issues, PRDs, and exploration maps for repository automation skills live as Markdown files under `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- Feature PRD: `.scratch/<feature-slug>/PRD.md`
- Implementation issues: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state: recorded on a `Status:` line near the top of each issue file (see [`triage-labels.md`](triage-labels.md) for valid state strings)
- Discussion log: appended to the bottom of the file under a `## Comments` heading

## Publishing an issue

Create a new Markdown file under `.scratch/<feature-slug>/` (creating the directory if needed).

## Fetching a ticket

Read the Markdown file at the referenced `.scratch/` path or issue number supplied in the prompt or commit message.

## Wayfinding operations

For multi-step exploration efforts organized around a **map** with one **child ticket** per question:

- **Map**: `.scratch/<effort>/map.md` — holds the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research` / `prototype` / `grilling` / `task`); a `Status:` line records `claimed` / `resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; lowest number wins.
- **Claim**: set `Status: claimed` and save before starting work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, and append a context pointer (gist + link) to Decisions-so-far in `map.md`.
