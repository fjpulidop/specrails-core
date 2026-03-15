---
agent: developer
feature: web-manager-ui-redesign
tags: [testing, vitest, mocking, fs]
date: 2026-03-15
---

## Decision

Used `vi.spyOn(fs, 'existsSync')` rather than `vi.mock('fs', ...)` for mocking Node.js built-in fs functions in config.test.ts.

## Why This Approach

`vi.mock('fs', ...)` with a factory function creates a hoisted module mock, but when the test calls `vi.resetAllMocks()` in `beforeEach`, the mock return values set in the factory are reset. Re-setting them via `const mockExistsSync = fs.existsSync as ...` after the module mock is applied creates a stale reference issue — the `fs` default import in the module under test may not share the same reference as the named imports in the test file.

`vi.spyOn` creates a spy on the actual module's method, making `mockRestore()` safe in `afterEach` and `vi.resetAllMocks()` benign. The spy reference stays aligned with the actual module.

## See Also

- `server/config.test.ts` — `existsSyncSpy`, `readdirSyncSpy`, `readFileSyncSpy` pattern
