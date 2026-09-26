# Definition engine

This module is the additive Core v2 engine. Public capabilities remain disabled until
the integrated CLI, retained package and platform acceptance gates pass. The legacy
workflow retains its frozen identity and independent entry point.

`definition-validator.ts` publishes a draft as an immutable JSON definition. It
validates the packaged schema, Core's closed piece registry, roles, routing,
components and verification policy before effects. `canonical-json.ts` implements
strict JSON admission and RFC 8785 hashing without applying runtime defaults.

`compiler.ts` translates the published definition into LangGraph. A component is an
inspectable child graph; `map` uses Send and a deferred join. State remains scoped
to each child invocation. The coordinator never holds repository or AI permits
while waiting for descendants. Private routing, map plans, component exits and
terminal markers cannot be edited through definition input or fork patches.

`contracts.ts` defines the seam between compilation and execution. Public LangGraph
ExecutionInfo binds a task to a durable visit and physical attempt. `execution.ts`
owns effect and AI permits through the terminal commit; `checkpoint/` owns the
SQLite transaction, pending writes, evidence, fencing, revision history and events.
Raw graph updates are observations; confirmed lifecycle comes from the ledger.

Pieces bind their own provider, verification, OpenSpec and memory ports at the
composition root. Their context exposes an immutable state snapshot, attempt,
signal, progress and interruption. Final piece failure commits through its marker;
an uncertain write rethrows, preserving explicit recovery instead of leaving a
completed task that would be skipped on resume. Local component completion cannot
settle the parent run: only the compiler can set `completesRun`.

The source schema and `schemas/workflow-definition.schema.json` must remain equal.
Focused tests cover strict hashing, semantic errors, expressions, bounded output,
reducers, actual graph metadata, nested interruption and SQLite reopening with
completed sibling reuse. `compiler-sqlite.test.ts` uses the real compiler, saver,
ledger and execution coordinator, including a local map limit below the global AI
limit. The normative decisions and outstanding acceptance gates live in
[`c3-protocol.md`](../../../../openspec/changes/core-agent-engine/c3-protocol.md).
