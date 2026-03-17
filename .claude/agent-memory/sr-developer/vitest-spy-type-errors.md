# Vitest Spy Type Errors (Pre-existing)

## Issue

`config.test.ts` has pre-existing `TS2322` errors on all 3 `vi.spyOn` variable declarations:
```typescript
let existsSyncSpy: ReturnType<typeof vi.spyOn>  // TS2322
let readdirSyncSpy: ReturnType<typeof vi.spyOn>  // TS2322
let readFileSyncSpy: ReturnType<typeof vi.spyOn>  // TS2322
```

These are known and unfixed in the codebase.

## Additional Gotcha: Dirent Type

When mocking `fs.readdirSync` return values for Vitest, use `as any` instead of `as unknown as fs.Dirent[]`:

```typescript
// Wrong — causes TS2345 Dirent<string>[] vs Dirent<NonSharedBuffer>[] error:
readdirSyncSpy.mockReturnValue(['test.md'] as unknown as fs.Dirent[])

// Correct:
readdirSyncSpy.mockReturnValue(['test.md'] as any)
```

The inline-in-test version `as unknown as fs.Dirent[]` (used in config.test.ts line 77) works at the call site but not in `beforeEach` variable assignments.

## Baseline

Before automated-test-writer-agent change: 38 lines of TS errors (3 from config.test.ts + scanCommands not exported).
After: 36 lines (same 3 + 3 new matching pattern = 6 total, but removed 2 scanCommands-related errors).
