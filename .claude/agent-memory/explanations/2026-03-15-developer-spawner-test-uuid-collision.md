---
agent: developer
feature: sqlite-job-persistence
tags: [testing, uuid, spawner, sqlite-constraint]
date: 2026-03-15
---

## Decision

In `spawner.test.ts`, the "allows spawning again after process exits" test explicitly mocks uuid to return different values for each call (`mockReturnValueOnce`) to prevent UNIQUE constraint failures in the in-memory DB.

## Why This Approach

The uuid mock returns a static value (`'test-uuid-1234'`) by default. When a test spawns twice using the same `db` instance, the second `createJob` call fails with `SqliteError: UNIQUE constraint failed: jobs.id` because both spawns would use the same processId. Using `mockReturnValueOnce` for each spawn call ensures distinct IDs without changing the overall mock strategy.

## See Also

This is only an issue in tests that (a) use the same `db` instance, (b) spawn more than once, and (c) the uuid mock isn't reset between calls. Other tests use `beforeEach` to create fresh db instances so this problem doesn't arise there.
