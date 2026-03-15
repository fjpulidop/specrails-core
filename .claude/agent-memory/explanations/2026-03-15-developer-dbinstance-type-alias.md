---
agent: developer
feature: sqlite-job-persistence
tags: [better-sqlite3, typescript, type-alias]
date: 2026-03-15
---

## Decision

Used `type DbInstance = InstanceType<typeof Database>` in `db.ts` instead of `Database.Database` or importing from `BetterSqlite3` namespace.

## Why This Approach

`better-sqlite3` uses `export = Database` (CommonJS-style default export). The default export is the constructor (`DatabaseConstructor`), not the instance type. TypeScript doesn't allow using a namespace `Database` as a type directly — you get `error TS2709: Cannot use namespace 'Database' as a type`. The correct pattern is `InstanceType<typeof Database>` which extracts the instance type from the constructor type. All other modules (`spawner.ts`, `hooks.ts`) import `DbInstance` from `db.ts`, keeping the type definition in one place.

## Alternatives Considered

- `BetterSqlite3.Database` (from the namespace): requires importing the namespace explicitly which is less clean.
- `import type { Database } from 'better-sqlite3'`: The type named `Database` in the module refers to the constructor, not the instance — same problem.
