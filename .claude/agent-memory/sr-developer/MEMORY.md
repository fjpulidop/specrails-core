# Developer Agent Memory

- [Agent template pattern](agent-template-pattern.md) — how to create new agent templates and generated instances
- [Implement command structure](implement-command-structure.md) — phase ordering and insertion points in the pipeline command
- [Web manager architecture](web-manager-architecture.md) — structure of the web/ subtree: server (Express+WS) + client (React+Vite)
- [install-sh-conventions.md](install-sh-conventions.md) — install.sh uses $REPO_ROOT (not $TARGET); shared dirs added to Phase 3 mkdir block
- [placeholder-false-positives.md](placeholder-false-positives.md) — prose `{{PLACEHOLDER}}` in backtick code spans is documentation, not an unresolved token
- [Generated instance gaps](generated-instance-gaps.md) — known differences between templates and generated instances (e.g., missing CLAUDE.md bullet in developer.md)

## srm CLI notes

- `tsconfig.cli.json` extends root tsconfig, overrides `rootDir: "cli"`, `outDir: "cli/dist"`, `module: "commonjs"`, excludes `*.test.ts`
- In vitest (ESM-first), use `import { WebSocket as WsClient } from 'ws'` (named import) — default import is not a constructor in vitest context
- `vitest.config.ts` include array must be updated when adding new test directories (added `cli/**/*.test.ts`)
- `GET /api/state` now includes `version` field (read from `package.json` via `require('../package.json')` IIFE at startup)
- `/api/jobs` and `/api/jobs/:id` were already real endpoints (#57 landed first); Task 10 (501 stubs) was skipped
- `srm.ts` uses `require.main === module` guard to avoid running `main()` when imported in tests

## Web-Manager UI Redesign notes (2026-03-15)

- Web-manager installation path changed from `.claude/web-manager/` to `specrails/web-manager/` — check install.sh, update.sh, server/index.ts `resolveProjectName()`
- Client Tailwind v4: use `@theme inline` with `--color-*` variables in globals.css; add `"type": "module"` to client package.json
- shadcn/ui components are hand-written in `client/src/components/ui/` (no CLI)
- `server/config.ts`: new config detection module; tested with `vi.spyOn(fs, ...)` not `vi.mock('fs', ...)`
- `client/src/types.ts`: shared client type definitions
- Old components (AgentActivity, CommandInput, JobQueueSidebar etc.) removed; `useQueue.ts` removed

## SQLite / better-sqlite3 notes

- Use `type DbInstance = InstanceType<typeof Database>` — `Database.Database` doesn't work due to `export =` style
- `better-sqlite3@9.x` has no Node 25 prebuilt; use `^12.8.0` or latest on Node 25
- Client TypeScript errors about missing `react` module are pre-existing (client `node_modules` not installed in the template); only server `tsc --noEmit` is expected to pass
- `hooks.test.ts` must NOT be modified — make `db`/`activeJobRef` optional in `createHooksRouter`
- In spawner tests that spawn twice with same DB, mock uuid to return different values per call
