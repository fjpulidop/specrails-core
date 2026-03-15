---
agent: developer
feature: sqlite-job-persistence
tags: [hooks, backward-compatibility, optional-params]
date: 2026-03-15
---

## Decision

Made `db` and `activeJobRef` optional parameters in `createHooksRouter` rather than required.

## Why This Approach

The spec says `hooks.test.ts` must NOT be modified. That test calls `createHooksRouter(broadcast)` with only one argument. Making the new params optional preserves backward compatibility for existing call sites and tests. The persistence code is guarded with `if (db && activeJobRef?.current)` so it only fires when both are provided. All production call sites in `index.ts` pass both params.

## Alternatives Considered

- Modifying `hooks.test.ts`: explicitly prohibited by the context-bundle.
- Overloading the function: TypeScript function overloads for this simple case would be verbose with no benefit.
