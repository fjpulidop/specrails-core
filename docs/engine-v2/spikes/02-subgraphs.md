# Nested graphs, fan-out and interrupts

Status: executable API probes passed on all three required platforms; [evidence accepted](README.md#accepted-evidence-2026-09-26).

Questions: on LangGraph 1.4.14 and checkpoint 1.1.5, prove the exact APIs for nested `interrupt`/`Command({ resume })`, concurrent `Send` branch interruption, branch namespaces and history, `updateState` on internal checkpoints for fork, `Command.PARENT`, deferred join, classified retry and `subgraphs: true` streams. Record whether recursion limits count nested node visits globally.

Exit criteria: each question has an executable fixture assertion and an API/limitation recorded here. Evidence must pass on macOS arm64, Linux x64 and Windows x64. Do not equate a same-thread time-travel checkpoint with an immutable new-run fork; the source must be verified unchanged when the probe claims cross-run fork support.

## Procedure and local result (2026-09-26)

`subgraph-probe.mjs` runs real graphs with the experimental SQLite saver on Node 22.22.3/macOS arm64. No provider is invoked.

| Question | API exercised | Observation |
| --- | --- | --- |
| Interrupted branch | `Send('branch', itemState)`, child `interrupt`, parent `Command({resume: {[interruptId]: answer}})` | Two branches keep distinct `branch:<task-id>` namespaces; the completed sibling does not repeat; deferred join waits and runs once after answer |
| Internal history | `getState(config, {subgraphs:true})`, `getStateHistory` with the child's checkpoint namespace | Both branch histories are accessible; the paused branch exposes a checkpoint before its internal `ask` |
| New-run seed | Child `updateState({thread_id: newId}, copiedInternalValues, 'prepare')` | A new child thread resumes from inspected internal state and leaves original checkpoint rows byte-equivalent |
| Parent routing | Child returns `Command({graph: Command.PARENT, goto:'after', update})` | Parent runs the declared target; it must declare the dynamic destination in `ends` |
| Retry classification | `retryPolicy` with `retryOn(error)` and `maxAttempts:2` | A fixture `provider_request_error` is retried once; second invocation succeeds |
| Nested progress | `stream(...,{streamMode:['updates','custom'],subgraphs:true})` | Five nested chunks carry branch namespaces in the measured interrupted fixture |
| Transition bound | Four internal nodes plus component and two parent nodes, `recursionLimit:5` | Seven visits finish; recursion limit 2 fails with `GraphRecursionError` |

## Decisions and limitations

Use the proven primitives, with explicit compiler metadata mapping task namespaces to definition paths and a shared visit counter enforcing global `maxTransitions`. LangGraph's recursion limit is an additional guard, not that global budget. Nested interrupts resume by interrupt ID; deferred join cannot run while a required branch is paused.

`updateState` is a viable state-seeding primitive. It does **not** automatically duplicate a full parent graph, pending branches or historical checkpoint lineage into a new run. C3/C6 must define and test that copy/remapping operation before claiming complete immutable nested fork. The prototype demonstrates only isolated child-state fork and verifies source immutability.

The schema's depth-three rule is an engine constraint, not a discovered LangGraph maximum. The two-branch probe does not establish production fan-out scheduling, shared-worktree write safety, lease behavior or budget allocation. These remain production design/robustness work. The [accepted CI run](README.md#accepted-evidence-2026-09-26) repeated all probes successfully on macOS arm64, Linux x64 and Windows x64.
