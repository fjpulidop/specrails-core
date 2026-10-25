## Context

The architect declares the blast radius in `design.md`; the archive node publishes OpenSpec archives with a recoverable write set and then marks the archive phase done against the reviewed candidate hash. The developer node already measures the change set from git and can undo out-of-scope edits. Verification receipts are durable (`receipts/<id>.json`).

## Decisions

1. **Map lives in the repository, outside the candidate.** `openspec/capability-map.json` must persist with the code (the host commits it), but writing it at archive time must not invalidate the reviewed candidate. New journals list it in `artifactExclusions` at initialization; the archive hook writes it only when the journal excludes it, so a journal created by an older Core is never broken mid-run.
2. **Coverage is generous.** A file is covered by the map or by its path or a specific parent directory (not `src/`, `lib/` …) in any canonical spec. New files, tests, docs and lockfiles never need a baseline. False "covered" costs nothing; false "uncovered" costs a Baseline group, so the rule errs toward covered.
3. **An extra architect turn, not a new graph node.** The Baseline plan is one more structured turn in the architect's session (kind `baseline`), validated in `accept` (Baseline group with a task, ADDED requirement) with the single repair turn. A new graph node would change the frozen built-in workflow fingerprint.
4. **Stage inside the developer visit.** The first developer visit runs the baseline stage before its normal turn: the developer writes only tests and artifacts, Core checks the git change set (non-test edits are a violation), checks reachability and runs the full verification plan on the unchanged code. The receipt is an ordinary verification receipt; the post-implementation verification replaces it as the current one.
5. **Explicit host blocker.** Every way the stage can fail returns `blocked` with a sentence naming what to fix and the code `baseline_characterization_failed`; `baseline.json` records `failed` or `violated`. Resume reruns the stage. The module is never edited first.
6. **Cost from the invocation ledger.** Baseline turns carry invocation kind `baseline`; `efficiencySummary.baseline` sums their usage from the same per-invocation ledger hosts already read, keeping unknown values unknown. No parallel accounting.

## Non-Goals

- Desktop settings UI, packet section and documentation.
- Engine 2 ledger-only archives (`openspec-archive` piece) updating the map.
- Inferring capabilities from code without a design blast radius.

## Risks / Trade-offs

- Running the full verification plan twice costs time when a baseline is needed. Accepted: the setting is opt-in and the base run is the evidence the rule asks for.
- A pre-existing failing test also blocks the stage; the message names the failing command so the operator can tell.
