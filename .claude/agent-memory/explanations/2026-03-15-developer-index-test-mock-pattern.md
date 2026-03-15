---
agent: developer
feature: job-queueing
tags: [testing, mocking, vitest, queuemanager]
date: 2026-03-15
---

## Decision

`index.test.ts` mocks `QueueManager` with `vi.mock('./queue-manager', async () => { ... })` returning a constructor that creates fresh `vi.fn()` method objects per-instance. Tests then call `queueManager.enqueue.mockReturnValue(...)` directly on the instance (no `vi.mocked()` wrapper needed).

## Why This Approach

`vi.mocked()` works on module exports but not on instance methods of a mocked class. After `vi.resetAllMocks()` or `vi.clearAllMocks()`, factory implementations may be cleared. Accessing mock methods directly on the constructed instance (`queueManager.enqueue`) is simpler and more reliable — each test's `createTestApp()` call returns a fresh instance, and per-test overrides like `queueManager.enqueue.mockReturnValue(...)` work directly.

## Alternatives Considered

- Using `vi.mocked(queueManager.enqueue).mockReturnValue(...)`: fails silently if the mock isn't set up correctly after `resetAllMocks`.
- Spy on individual methods: more verbose and not needed when the whole class is already mocked.

## See Also

- The `MockQueueManager` type alias in `index.test.ts` gives TypeScript access to `.mockReturnValue()` etc. without casting at every callsite.
