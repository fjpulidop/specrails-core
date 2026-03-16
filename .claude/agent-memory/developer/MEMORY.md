# Developer Agent Memory

## Key architecture facts

- Agent files live in `.claude/agents/sr-*.md` — all use `sr-` prefix to avoid collisions with user-defined agents in target repos
- Workflow command files live in `.claude/commands/sr/*.md` — the `sr/` subdir enables `/sr:command` syntax in Claude Code
- Template agents are in `templates/agents/sr-*.md`; template commands are in `templates/commands/sr/*.md`
- `update.sh` runs `do_migrate_sr_prefix()` before `do_core/do_agents` for `all`, `commands`, `agents`, `core` components

## Patterns

- Agent `name:` frontmatter field must match the file's stem exactly (e.g. `sr-architect.md` → `name: sr-architect`)
- `subagent_type:` in command files must match the `name:` field of the target agent
- Memory dirs are at `.claude/agent-memory/sr-<agent>/` (e.g. `sr-reviewer/common-fixes.md`)

## QueueManager notes (job-queueing feature)

- `_logBuffer` is a class field (not module-level) — prevents cross-test state pollution in vitest
- `index.test.ts` mocks QueueManager class wholesale; tests access mock methods directly on the instance (`queueManager.enqueue.mockReturnValue(...)`) not via `vi.mocked()`
- `tree-kill` has bundled types in `index.d.ts`; do NOT add `@types/tree-kill` to package.json (package does not exist on npm)
- DB migrations M002 (queue_position column on jobs) and M003 (queue_state table) added to MIGRATIONS array in db.ts
- `JobRow` in types.ts now includes `queue_position: number | null` field; `SpawnHandle` and `SpawnBusyError` removed
- HTTP 202 (not 200) for `POST /api/spawn`; response body is `{ jobId, position }` not `{ processId }`
- `activeJobRef` in index.ts replaced by static `{ current: null }` passed to hooksRouter — hooks.ts uses optional chaining so phase persistence still works when activeJobId is available

## Web-Manager UI Redesign notes (2026-03-15)

- Web-manager now lives at `<project>/specrails/web-manager/` (not `.claude/web-manager/`) — `resolveProjectName()` checks `immediateParent === 'specrails'`
- Client uses Tailwind v4 + `@theme inline` CSS-first config (no `tailwind.config.js`); must add `"type": "module"` to client `package.json` for `@tailwindcss/vite` (ESM-only)
- shadcn/ui components created manually in `client/src/components/ui/` — no `npx shadcn init` (can't run interactively in templates)
- `server/config.ts` — new module for CLI detection (gh/jira), command scanning, git remote parsing
- `config.test.ts` — use `vi.spyOn(fs, 'existsSync')` not `vi.mock('fs', ...)` for per-test fs mocking
- `server/index.test.ts` mocks `./config` module at top-level with `vi.mock('./config', ...)` — imports `getConfig` and `fetchIssues` as typed mock fns
- `client/src/types.ts` — shared client types (JobSummary, EventRow, CommandInfo, ProjectConfig, IssueItem)
- `usePipeline.ts` updated to use local `QueueJob` type (no longer imports from deleted `JobQueueSidebar`)
- Old components removed: AgentActivity, CommandInput, JobHistory, JobQueueSidebar, LogStream, PipelineSidebar, SearchBox, StatsBar, useQueue hook

## Multi-project hub notes (2026-03-16)

- Hub mode enabled via `--hub` flag or `SPECRAILS_HUB=1` env var on `server/index.ts`
- Hub SQLite at `~/.specrails/hub.sqlite`; per-project SQLite at `~/.specrails/projects/<slug>/jobs.sqlite`
- `server/hub-db.ts` — hub-level DB (projects table, hub_settings table)
- `server/project-registry.ts` — holds one QueueManager/ChatManager/DB per project; `boundBroadcast` closure injects `projectId` into all WS messages
- `server/hub-router.ts` — routes: `GET/POST/DELETE /api/hub/projects`, `GET /api/hub/state`, `GET /api/hub/resolve`, `GET/PUT /api/hub/settings`
- `server/project-router.ts` — per-project routes under `/api/projects/:projectId/*`; middleware resolves ProjectContext from registry
- `server/config.ts` — `getConfig()` detects hub mode by checking if `.claude/` exists at `cwd` (bypasses `cwd/../..` walk)
- `client/src/lib/api.ts` — `getApiBase()` returns `/api` or `/api/projects/<id>` based on active project; `setApiContext()` called by `HubProvider` on project switch
- `client/src/hooks/useHub.tsx` — `HubProvider` manages project list, active project; calls `setApiContext` on every project change
- `cli/srm.ts` — `srm hub start/stop/status/add/remove/list`; CWD-based project routing via `/api/hub/resolve`
- usePipeline and useChat filter WS messages by `projectId` in hub mode to avoid cross-project contamination

## Detailed notes

- [sr-prefix-namespace explanation](../../agent-memory/explanations/) — see dated files for rationale
