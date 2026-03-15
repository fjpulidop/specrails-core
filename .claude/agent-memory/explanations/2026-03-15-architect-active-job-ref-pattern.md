---
agent: architect
feature: sqlite-job-persistence
tags: [hooks, spawner, dependency-graph, mutable-ref, circular-import]
date: 2026-03-15
---

## Decision

Use a shared mutable reference object `activeJobRef: { current: string | null }` (created in `index.ts`, passed to both `spawner.ts` and `hooks.ts`) rather than having `hooks.ts` import from `spawner.ts` to get the current job id.

## Why This Approach

`hooks.ts` needs the current job id to persist phase transitions. The natural place to get it is from the spawner (which owns the job lifecycle). But `spawner.ts` already imports from `types.ts`, and if `hooks.ts` imported from `spawner.ts`, we'd risk creating a circular dependency chain as the codebase grows. The mutable ref pattern puts the shared state in `index.ts` (the composition root), which already imports from both modules. This keeps the module graph a DAG.

## Alternatives Considered

- Export `getCurrentJobId()` from `spawner.ts` and import it in `hooks.ts`: works today but creates an import edge from hooks to spawner that could become circular if spawner ever needs to call a hook.
- Store job id in a third shared module (`state.ts`): a reasonable alternative, but adds a fourth module for what is one field of state. The ref pattern is simpler.
- Pass job id on every `POST /hooks/events` request body: would require hooks instrumentation in every agent — a contract change to the hook protocol, not worth it for internal storage.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/sqlite-job-persistence/design.md` — Section 6 "Updated hooks.ts"
