---
agent: developer
feature: job-queueing
tags: [testing, state-isolation, log-buffer]
date: 2026-03-15
---

## Decision

The log buffer was moved from a module-level variable in `queue-manager.ts` into a private class field `_logBuffer` on `QueueManager`.

## Why This Approach

The design doc specified a module-level buffer (same pattern as `spawner.ts`). However, module-level state persists across test instances in vitest's module system. Tests that create `new QueueManager()` would share the same buffer, causing the "returns a copy, not a reference" test to fail because prior tests had already populated the buffer.

Moving the buffer into the class gives each `QueueManager` instance its own buffer — zero state leakage between tests without needing `vi.resetModules()`.

## Alternatives Considered

- Keep module-level buffer, add `vi.resetModules()` in `beforeEach`: rejected — `vi.resetModules()` plus dynamic imports is verbose boilerplate. The class-field approach is cleaner and matches the encapsulation goal of the `QueueManager` class.
- Export a `clearLogBuffer()` function for tests: rejected — test-only escape hatches pollute production API.

## See Also

- spawner.test.ts used `vi.resetModules()` for the same reason. queue-manager.test.ts avoids it entirely.
