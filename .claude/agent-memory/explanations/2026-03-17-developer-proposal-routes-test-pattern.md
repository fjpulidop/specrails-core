---
agent: developer
feature: feature-proposal-modal
tags: [tests, proposal-routes, projectregistry, mock, supertest]
date: 2026-03-17
---

## Decision

In `proposal-routes.test.ts`, bypassed `ProjectRegistry.addProject` and instead injected a fake `ProjectContext` directly into the registry's `_contexts` map via casting, rather than using the hub DB.

## Why This Approach

`ProjectRegistry.addProject` writes to a hub SQLite DB file and calls `initDb` with a real path. Using `:memory:` for the hub DB still requires hub-db migration infrastructure. The route tests only need the `proposalManager` and `db` from the context — the simplest path is to inject the context directly, which is what `index.test.ts` implicitly does by building a minimal Express app without going through the registry at all. Injecting via `(registry as any)._contexts` is a well-understood test seam used to keep tests focused on route logic, not registry internals.

## Alternatives Considered

- Full registry integration: would require hub-db setup, slug generation, path validation — all orthogonal to testing routes.
- Direct Express app (like index.test.ts): would require duplicating all route handler code in the test file.
