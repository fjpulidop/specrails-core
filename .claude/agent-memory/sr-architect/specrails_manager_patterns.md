---
name: specrails-manager architecture patterns
description: Key patterns in specrails-manager for server classes, DB migrations, WS messaging, and client hooks — needed when designing features for that repo
type: project
---

## Repo: specrails-manager at /Users/javi/repos/specrails-manager

### Server patterns

**Manager classes** (ChatManager, QueueManager, SetupManager):
- Constructed with `(broadcast, db, cwd)` signature
- One per ProjectContext — instantiated in `project-registry.ts` `_loadProjectContext`
- `cwd` = `project.path` — Claude CLI spawns in the target project directory
- `broadcast` is already bound with `projectId` by ProjectRegistry before being passed in

**DB migrations** (`server/db.ts`):
- Append to `MIGRATIONS` array — version = index + 1, automatic
- `initDb` runs orphan sweeps after migrations (mark running jobs as failed)
- New table orphan sweeps also go in `initDb`
- Always use `CREATE TABLE IF NOT EXISTS` for idempotency

**Route pattern** (`server/project-router.ts`):
- Routes go under `router.post('/:projectId/<resource>', ...)`
- Access project context via `ctx(req)` helper
- Async operations: respond 202 immediately, fire async with `.catch(console.error)`
- 409 for conflicts (busy, wrong status), 400 for missing input, 404 for unknown resources

**WsMessage union** (`server/types.ts`):
- All messages carry optional `projectId: string`
- New messages are added as interfaces + appended to `WsMessage` union
- Additive only — never remove from union

### Client patterns

**useSharedWebSocket hook**:
- `registerHandler(id, fn)` / `unregisterHandler(id)` — must unregister on unmount
- Fan-out to all handlers — filter by `projectId` in each handler
- Handler ID must be stable (string constant or derived from stable value)

**API base**: `getApiBase()` from `lib/api.ts` — returns `/api` (single project) or `/api/projects/:id` (hub mode). Always use this.

**Streaming markdown**: `ReactMarkdown` + `remarkGfm` with `MD_CLASSES` string (copy verbatim from SetupChat.tsx). Do not import MD_CLASSES — copy it.

**Modal pattern**: uses shadcn `Dialog` + `DialogContent` + `DialogHeader` + `DialogTitle` + `DialogFooter`. Glass card style: `className="max-w-3xl glass-card"`.

**Test framework**: Vitest. Test files in `server/`. Mock child_process and tree-kill for manager tests. Use `:memory:` DB. Use supertest for route integration tests.

### Command template location

- Source: `templates/commands/propose-spec.md` (flat, no `sr/` subdir in templates)
- Installed to: `.claude/commands/sr/propose-spec.md` in target repo
- install.sh maps templates/commands/ → .claude/commands/sr/ during installation
