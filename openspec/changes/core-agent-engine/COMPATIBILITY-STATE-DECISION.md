# Bounded workflow state for legacy conversion

27 September 2026. The legacy manager has three durable logical obligations
that are not physical invocation attempts: a pass-failed flag, a count of
completed decider evaluations, and per-phase recovery allowances that survive
iteration boundaries. `$attempts` does not represent these values. Expanding
all combinations into duplicate decision/repair nodes grows exponentially and
also splits Core's per-node no-progress history.

Add a reviewed non-AI `assign` control piece for explicit scoped `$vars`
updates. Its only operations are setting JSON values and incrementing existing
safe integers. Names use the same restricted variable grammar as captures;
prototype names, overlapping operations, missing/noninteger counters and
arithmetic overflow fail before any update. Updates are returned as one piece
result and committed by the existing fenced terminal transaction; the piece
performs no filesystem, process, provider or project-store access. It cannot
execute code or introduce an unbounded expression language.

The compatibility compiler can then preserve the original execution-node IDs:
initialize dedicated variables, guard/increment decision counts, route a failed
pass through continue, reset that flag only where the legacy manager resets it,
and consume each recovery allowance exactly once. Repair control nodes return
to the failed validator without replaying already successful phases. Control
transitions count against the same global ceiling. Invalid/oversized converted
graphs remain actionable drafts, never silently truncated definitions.

Core must version and publish the catalog/schema addition, prove persistence,
resume, scope isolation and rollback behavior, and document the piece. Desktop
must mirror the schema, expose localized authoring controls through its catalog,
and compile through the existing definition compiler. Migration/publication
still require Core validation and immutable original-graph backup. This decision
does not declare parity, migration, legacy removal or release acceptance done.
