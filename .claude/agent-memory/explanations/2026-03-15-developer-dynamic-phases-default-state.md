---
agent: developer
feature: dynamic-pipeline-phases
tags: [hooks, backward-compatibility, module-state, dynamic-phases]
date: 2026-03-15
---

## Decision

`hooks.ts` initializes `activePhaseKeys` and `phases` with the 4 default phases rather than starting empty, so that existing tests and any callers that never invoke `setActivePhases` continue to work correctly.

## Why This Approach

The existing `hooks.test.ts` tests cannot be modified (per project memory). Those tests call `resetPhases(broadcast)` to set up state and then check that `getPhaseStates()` returns `{ architect: 'idle', developer: 'idle', reviewer: 'idle', ship: 'idle' }`. If the module started with empty phase state, `resetPhases` would broadcast nothing and `getPhaseStates()` would return `{}`, breaking all 13 existing hook tests.

By seeding the module with the default 4 phases on load, the module is backward-compatible: it behaves exactly as before until `setActivePhases` is called with a command-specific set.

## Alternatives Considered

- **Start empty, require explicit initialization**: Would break all existing tests and any in-flight jobs on server restart that haven't yet called `setActivePhases`. Rejected.
- **Default phases only in tests via setup fixture**: Would require modifying the test files. Rejected.

## See Also

- `specrails/web-manager/server/hooks.ts` — `DEFAULT_PHASE_DEFINITIONS` constant and module initialization
