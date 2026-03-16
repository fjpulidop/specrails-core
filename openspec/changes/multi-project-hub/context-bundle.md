# Context Bundle: Web Manager Multi-Project Hub

## Key files to read before implementing

### Server layer

- `/Users/javi/repos/specrails/templates/web-manager/server/index.ts` — current single-project entry point; will be rewritten as hub entry point
- `/Users/javi/repos/specrails/templates/web-manager/server/db.ts` — per-project DB module; reused unchanged per project; the hub-db.ts pattern mirrors this file's structure
- `/Users/javi/repos/specrails/templates/web-manager/server/queue-manager.ts` — must accept `projectId` constructor param
- `/Users/javi/repos/specrails/templates/web-manager/server/chat-manager.ts` — must accept `projectId` constructor param
- `/Users/javi/repos/specrails/templates/web-manager/server/config.ts` — `getConfig(cwd, db, projectName)` takes the project root path; still works per-project; `cwd` changes from `process.cwd()` to `project.path`
- `/Users/javi/repos/specrails/templates/web-manager/server/hooks.ts` — hook events router; will be mounted at `/api/projects/:projectId/hooks` instead of `/hooks`
- `/Users/javi/repos/specrails/templates/web-manager/server/analytics.ts` — `getAnalytics(db, opts)` unchanged; called with per-project DB
- `/Users/javi/repos/specrails/templates/web-manager/server/types.ts` — `WsMessage` union type and `JobRow`, `EventRow` types live here; `ProjectRow` must be added

### CLI layer

- `/Users/javi/repos/specrails/templates/web-manager/cli/srm.ts` — current srm CLI; `parseArgs`, `detectWebManager`, `runViaWebManager`, `runDirect` all stay; add `hub` subcommand parser and CWD resolution logic

### Client layer

- `/Users/javi/repos/specrails/templates/web-manager/client/src/App.tsx` — routing root; complete rewrite for hub structure
- `/Users/javi/repos/specrails/templates/web-manager/client/src/components/Navbar.tsx` — becomes `ProjectNavbar.tsx` (per-project nav); `TabBar.tsx` is new above it
- `/Users/javi/repos/specrails/templates/web-manager/client/src/components/RootLayout.tsx` — wraps all pages; update to embed ProjectNavbar, remove embedded ChatPanel
- `/Users/javi/repos/specrails/templates/web-manager/client/src/hooks/useSharedWebSocket.tsx` — add hub-level message dispatch
- `/Users/javi/repos/specrails/templates/web-manager/client/src/types.ts` — add `ProjectRow` type; update `WsMessage` union

### Config and build

- `/Users/javi/repos/specrails/templates/web-manager/package.json` — update package name to `@specrails/web-manager`, version to 1.0.0; keep `bin.srm`
- `/Users/javi/repos/specrails/templates/web-manager/tsconfig.json` — verify it covers `server/hub-db.ts` and `server/project-registry.ts`

---

## Exact changes per file

### `server/types.ts`

Add `ProjectRow` interface:
```typescript
export interface ProjectRow {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  added_at: string
  last_seen_at: string
}
```

Add hub-level WS message variants to `WsMessage` union:
```typescript
| { type: 'hub.project_added'; project: ProjectRow }
| { type: 'hub.project_removed'; projectId: string }
| { type: 'hub.project_updated'; project: ProjectRow }
```

Add `projectId: string` to all existing project-scoped message types (`init`, `log`, `phase`, `queue_update`).

---

### `server/queue-manager.ts`

Constructor signature change:
```typescript
// Before:
constructor(broadcast: BroadcastFn, db: DbInstance)
// After:
constructor(broadcast: BroadcastFn, db: DbInstance, projectId: string)
```

All internal `broadcast()` calls add `projectId: this.projectId` to the message object.

---

### `server/chat-manager.ts`

Same constructor change as `queue-manager.ts`:
```typescript
constructor(broadcast: BroadcastFn, db: DbInstance, projectId: string)
```

---

### `server/config.ts`

The `getConfig(cwd, db, projectName)` function's `cwd` parameter currently means the web-manager's working directory (from which it walks `../..` to find the project root). In hub mode, pass `project.path` directly instead of `process.cwd()` and skip the `../..` walk:

```typescript
// Before (per-project install):
const projectRoot = path.resolve(cwd, '../..')

// After (hub mode):
// cwd IS the project root, no walk needed
const projectRoot = cwd
```

Add an optional `isHubMode: boolean` parameter to `getConfig` to switch this behavior, or just pass `project.path` directly as `cwd` from the project-scoped router.

---

### `cli/srm.ts`

Add to `ParsedArgs` union:
```typescript
| { mode: 'hub'; subcommand: 'start' | 'stop' | 'status' | 'add' | 'remove' | 'list'; args: string[]; port: number }
```

New detection flow in `main()`:
1. Check `GET /api/hub/state` first (hub mode detection)
2. If hub running: resolve project via `GET /api/hub/resolve?path=<cwd>`
3. If project found: use `/api/projects/:projectId/spawn`
4. If project not found: print actionable message and exit 1
5. If hub not running: check `/api/state` (legacy single-project fallback)
6. If legacy server running: use `/api/spawn` (old path, preserved for backwards compat)
7. If nothing running: `runDirect()`

---

### `client/src/types.ts`

Add:
```typescript
export interface ProjectRow {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  added_at: string
  last_seen_at: string
}

export interface HubState {
  version: string
  projects: number
  uptime: number
}
```

---

## Critical implementation notes

### ProjectContext identity across requests
Each Express request to `/api/projects/:projectId/*` must resolve the same `ProjectContext` object (not create a new one per request). The `ProjectRegistry` class is the single source of truth. Never instantiate `QueueManager` or `ChatManager` per-request.

### hub.sqlite path resolution
Use `os.homedir()` from Node.js built-ins for portability:
```typescript
import os from 'os'
const HUB_DIR = path.join(os.homedir(), '.specrails')
const HUB_DB_PATH = path.join(HUB_DIR, 'hub.sqlite')
```

### WebSocket fan-out and projectId filtering
The single WebSocket broadcasts all messages for all projects. The client must filter messages to the active project. The `SharedWebSocketProvider` fans out to ALL handlers — it is each handler's responsibility to check `msg.projectId === activeProjectId`. Do not filter at the provider level (hub messages need to reach the HubProvider regardless of active project).

### `config.ts` walk-up logic
The current `getConfig` function walks from the web-manager's CWD up two levels to find the project root (because it's installed at `specrails/web-manager/`). In hub mode, `project.path` IS the project root. Pass `project.path` as `cwd` and the `commandsDir` resolve to `path.join(project.path, '.claude', 'commands', 'sr')` directly. The walk-up logic can be removed from the hub code path.

### Hook URL in command frontmatter
Existing projects have hooks configured with URL `http://127.0.0.1:4200/hooks/events`. In the hub, the hook URL must be `http://127.0.0.1:4200/api/projects/:projectId/hooks/events`. The hub router at `POST /hooks/events` should return a 410 with a message pointing to the new URL. Automatic patching of frontmatter files is deferred to the migration tooling task.

### Port conflicts
The hub runs on 4200. If an existing per-project web-manager is already running on 4200, `srm hub start` must fail cleanly with: `[srm] error: port 4200 is in use. Stop the existing web-manager or use --port <n>`.

### Test strategy
The test suite in `server/*.test.ts` uses `better-sqlite3` with `:memory:` databases. Tests for hub-level functionality should follow the same pattern: pass `':memory:'` to `initHubDb` and inject the result into the `ProjectRegistry`. This preserves test speed (no filesystem I/O in tests).
