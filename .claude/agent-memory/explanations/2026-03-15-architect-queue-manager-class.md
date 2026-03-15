---
agent: architect
feature: job-queueing
tags: [queue, class-vs-module, state-management, web-manager]
date: 2026-03-15
---

## Decision

The queue state is implemented as a `QueueManager` class rather than extending the existing module-level variable pattern in `spawner.ts`.

## Why This Approach

`spawner.ts` works with a single `activeProcess` variable because it only has one invariant to maintain: process is running or it is not. The queue adds four simultaneously-active concerns: an ordered `_queue` array, a `_jobs` map, a `_paused` flag, and a `_killTimer` reference. These have non-trivial inter-invariants (e.g., `_activeJobId !== null` iff `_activeProcess !== null`; `_killTimer` only set when a cancel is in flight). A class enforces these invariants in private fields and makes them testable via constructor injection of the broadcast function, without `vi.resetModules()` gymnastics.

## Alternatives Considered

- **Extend spawner.ts with more module-level variables**: Would work but becomes a state-bag with no encapsulation. Testing requires module re-import isolation on every test.
- **Separate queue module that calls spawner.ts**: Creates a layering problem — the queue needs to own process lifecycle (kill, restart after exit) and spawner would need to call back into the queue on exit. Circular.
- **Keep spawner.ts, wrap it**: Adds indirection without benefit; deleting spawner.ts and creating queue-manager.ts is cleaner than a wrapper.

## See Also

- `templates/web-manager/server/spawner.ts` — the file being replaced
- `openspec/changes/job-queueing/design.md` — full class design
