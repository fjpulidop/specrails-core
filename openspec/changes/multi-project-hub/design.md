# Design: Web Manager Multi-Project Hub

## Context

The current web-manager is a per-project Express server located at `templates/web-manager/`. It runs as `specrails/web-manager/` in each target repo and stores jobs in `data/jobs.sqlite` relative to its CWD. The `srm` CLI bridges the terminal to this server via HTTP + WebSocket, defaulting to port 4200.

The hub transforms this into a single global process that manages multiple projects simultaneously, identified by their filesystem path, with a browser UI that uses browser-style project tabs.

---

## D1: Deployment model — global npm package

**Decision:** Ship as `@specrails/web-manager` on npm with global install (`npm install -g @specrails/web-manager`). The `srm` CLI becomes the sole entry point for both the hub server and project-scoped commands.

**Entry points exposed via `bin` in package.json:**
```json
{
  "bin": {
    "srm": "./cli/dist/srm.js"
  }
}
```

`srm hub start` starts the hub server.
`srm hub stop` sends SIGTERM to a PID recorded in `~/.specrails/hub.pid`.
`srm <verb> [args]` routes a project command (resolves project from CWD).

**Why global over per-project:** The core value proposition is cross-project visibility. Per-project installs cannot share state. Global install also eliminates the `templates/web-manager/` copy step from `install.sh`, reducing template bloat.

**Retained:** The direct-fallback path in `srm` (spawn claude directly when hub is not reachable) is preserved unchanged.

---

## D2: Hub registry — `~/.specrails/hub.sqlite`

**Decision:** A single SQLite file at `~/.specrails/hub.sqlite` acts as the project registry. It stores the list of registered projects and their metadata.

### Schema

```sql
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,          -- UUID v4
  slug         TEXT NOT NULL UNIQUE,      -- kebab-case derived from project name
  name         TEXT NOT NULL,             -- display name (from git root basename or user-provided)
  path         TEXT NOT NULL UNIQUE,      -- absolute filesystem path to project root
  db_path      TEXT NOT NULL,             -- absolute path to per-project jobs.sqlite
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE hub_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Why SQLite over JSON config:** The registry will be queried and mutated by both the hub server and potentially CLI subcommands. SQLite gives ACID guarantees for concurrent reads, simple upserts, and indexed lookups by path and slug. A JSON file would require read-parse-modify-write with file locking.

---

## D3: Per-project data isolation

**Decision:** Each registered project gets its own SQLite database at `~/.specrails/projects/<slug>/jobs.sqlite`. The hub server opens these databases lazily on first access and holds them in a `Map<projectId, DbInstance>`.

**Why not a single multi-tenant DB:** The existing `db.ts` schema is designed around a single project. Merging all projects into one DB would require adding a `project_id` column to every table, migrating existing per-project DBs into it, and rewriting all queries. A per-project DB approach lets us reuse `db.ts` unchanged, simply opening a different file per project.

**Migration:** When a user registers a project that has an existing `specrails/web-manager/data/jobs.sqlite`, the hub offers to copy it to `~/.specrails/projects/<slug>/jobs.sqlite` as a one-time migration. The original file is left in place (non-destructive).

---

## D4: Project-scoped HTTP routes

**Decision:** All existing API routes gain a `/projects/:projectId` prefix. The root server routes become:

```
GET  /api/hub/projects              — list registered projects
POST /api/hub/projects              — register a new project
DELETE /api/hub/projects/:id        — unregister a project
GET  /api/hub/projects/:id          — get project metadata
GET  /api/hub/state                 — hub health/version (replaces /api/state)
GET  /api/hub/settings              — global settings
PUT  /api/hub/settings              — update global settings

GET  /api/projects/:projectId/state
POST /api/projects/:projectId/spawn
GET  /api/projects/:projectId/jobs
GET  /api/projects/:projectId/jobs/:id
DELETE /api/projects/:projectId/jobs/:id
DELETE /api/projects/:projectId/jobs
GET  /api/projects/:projectId/queue
POST /api/projects/:projectId/queue/pause
POST /api/projects/:projectId/queue/resume
PUT  /api/projects/:projectId/queue/reorder
GET  /api/projects/:projectId/analytics
GET  /api/projects/:projectId/stats
GET  /api/projects/:projectId/config
POST /api/projects/:projectId/config
GET  /api/projects/:projectId/issues
POST /api/projects/:projectId/hooks/events   (hook callback URL)
GET  /api/projects/:projectId/chat/conversations
POST /api/projects/:projectId/chat/conversations
... (all existing chat routes under /api/projects/:projectId/)
```

**Backwards compatibility for `srm`:** The old `srm` CLI targets `/api/state` and `/api/spawn`. The hub exposes thin compatibility shims at `/api/state` and `/api/spawn` that resolve the project by examining the `X-Project-Id` header or a `projectId` body field (set by the new srm). Old srm CLI (no header) receives a 400 with a "upgrade srm" message.

**Why prefix over subdomain:** Simpler. No DNS. No cross-origin issues. The existing CORS configuration stays.

---

## D5: WebSocket protocol extension

**Decision:** The shared WebSocket adds a `projectId` field to all project-scoped messages. Hub-level messages (project added, project removed) have `type: 'hub.*'`.

### Message types

```typescript
// Existing message types extended with projectId
type WsMessage =
  | { type: 'init'; projectId: string; projectName: string; ... }
  | { type: 'log'; projectId: string; processId: string; source: 'stdout'|'stderr'; line: string }
  | { type: 'phase'; projectId: string; phase: string; state: string }
  | { type: 'queue_update'; projectId: string; jobs: QueuedJob[]; activeJobId: string | null }
  // Hub-level messages
  | { type: 'hub.project_added'; project: ProjectRow }
  | { type: 'hub.project_removed'; projectId: string }
  | { type: 'hub.project_updated'; project: ProjectRow }
```

**`srm` CLI filtering:** The `srm` CLI already filters log messages by `processId`. Adding `projectId` as an additional filter is backwards-compatible — old srm ignores the field, new srm uses it.

---

## D6: CWD-based project routing in `srm`

**Decision:** When `srm <verb>` is invoked and the hub is running, `srm` sends `GET /api/hub/resolve?path=<cwd>` to find the matching project, then routes the command to `/api/projects/<projectId>/spawn`. If no project is registered for the CWD, `srm` prints a prompt to register the project.

```
[srm] no project registered for /Users/javi/repos/my-app
[srm] run: srm hub add /Users/javi/repos/my-app
```

**Why CWD resolution over explicit `--project` flag:** Most developer tooling is CWD-aware. Requiring an explicit flag would be friction every time. CWD resolution matches the mental model: "I'm in this repo, run this command."

**Resolution algorithm:**
1. Start from CWD
2. Walk up until a `.claude/commands/sr/` directory is found (confirming this is a specrails-enabled repo)
3. GET `/api/hub/resolve?path=<found-root>`
4. Server looks up `projects.path = found-root` in hub.sqlite

---

## D7: Per-project server instances vs. a single multiplexed server

**Decision:** A single Express server process handles all projects. Per-project resources (QueueManager, ChatManager, DbInstance) are instantiated per project and stored in a `ProjectContext` map.

```typescript
interface ProjectContext {
  project: ProjectRow
  db: DbInstance
  queueManager: QueueManager
  chatManager: ChatManager
}

const projects = new Map<string, ProjectContext>()
```

**Why not separate processes per project:** Multiple processes would require port management, process supervision, inter-process communication for the UI, and would not share the WebSocket fan-out. A single-process approach is simpler, easier to debug, and sufficient for the single-user use case.

**Trade-off:** If one project's queue crashes, it could affect other projects. Mitigation: wrap per-project request handlers in try/catch that catches and logs errors without crashing the process.

---

## D8: React client — tab-based navigation

**Decision:** The top-level navigation switches from a simple navbar to a two-layer layout:

- **Tab bar:** One tab per registered project, plus a "+" button to add a project. Tabs show project name and a status indicator (green dot = busy, grey = idle).
- **Per-project sub-navigation:** Within each project tab, the existing Home / Analytics / Conversations links (replaces the "Chat" panel which becomes a full page).

### Component tree (new)

```
<HubProvider>                     ← hub-level WS, project registry state
  <TabBar />                      ← project tabs + add button
  <ProjectContext.Provider>        ← active project context (projectId, etc.)
    <ProjectLayout>                ← wraps RootLayout equivalent
      <ProjectNavbar />            ← Home | Analytics | Conversations | Settings icon
      <Routes>
        /projects/:projectId/              → DashboardPage
        /projects/:projectId/jobs/:jobId   → JobDetailPage
        /projects/:projectId/analytics     → AnalyticsPage
        /projects/:projectId/conversations → ConversationsPage (was chat panel)
        /settings                          → GlobalSettingsPage
      </Routes>
      <StatusBar />
    </ProjectLayout>
  </ProjectContext.Provider>
</HubProvider>
```

**Welcome screen:** When `projects.length === 0`, the app renders `<WelcomeScreen />` instead of the tab bar + project content. The welcome screen has a single "Add your first project" button that opens the add-project dialog.

**Add project dialog:** A simple modal with one input (filesystem path). On submit, calls `POST /api/hub/projects`. On success, a new tab appears and the dialog closes.

---

## D9: Settings — global vs. per-project

**Decision:** Settings is split into two levels:
- **Global settings** (`/settings`): Hub version, data directory, theme. Accessible via the gear icon in the tab bar header area.
- **Per-project settings** (visible in each project's sub-navigation as a gear icon): Issue tracker, label filter, project name override. These write to the per-project DB via `POST /api/projects/:projectId/config`.

The existing `SettingsPage` becomes the per-project settings. A new `GlobalSettingsPage` is added for hub-level config.

---

## D10: `srm hub` CLI subcommands

**Decision:** Extend `srm` with a `hub` subcommand group:

```
srm hub start [--port <n>]    Start the hub server (default port 4200)
srm hub stop                  Stop the running hub server
srm hub status                Print hub status and registered projects
srm hub add <path>            Register a project (optionally migrate existing DB)
srm hub remove <path|slug>    Unregister a project (does NOT delete data)
srm hub list                  List registered projects
```

Existing `srm <verb>` still works. The detection probe `GET /api/state` is replaced by `GET /api/hub/state` (the hub also exposes `/api/state` as a shim returning `{ version, projects: count, hubMode: true }`).

---

## D11: Migration strategy from per-project installs

**Decision:** The hub provides a `srm hub migrate <project-path>` command that:
1. Locates `<project-path>/specrails/web-manager/data/jobs.sqlite`
2. Copies it to `~/.specrails/projects/<slug>/jobs.sqlite`
3. Registers the project in `hub.sqlite`
4. Prints a message: "Project registered. The original database at `<path>` has not been modified."

The per-project web-manager installation in `specrails/web-manager/` is NOT removed by migration. Users can continue using the old per-project server if they prefer. Migration is opt-in.

`install.sh` is NOT changed in this phase. The global npm package is a separate installation from the per-project template.

---

## D12: Data directory — `~/.specrails/`

**Decision:** All hub data lives in `~/.specrails/`:
```
~/.specrails/
├── hub.sqlite              ← project registry
├── hub.pid                 ← PID of running hub process (if any)
└── projects/
    ├── my-app/
    │   └── jobs.sqlite
    ├── specrails/
    │   └── jobs.sqlite
    └── ...
```

**Why `~/.specrails/` over `~/.config/specrails/` or XDG:** Simpler. The XDG spec is Linux-specific and less familiar to macOS developers. `~/.specrails/` mirrors the pattern of `~/.claude/`, `~/.npm/` etc. and is discoverable.

---

## Compatibility Impact

### Category 1: Removal (BREAKING)
- `GET /api/state` — removed as primary endpoint; replaced by `GET /api/hub/state`. A shim is provided at `/api/state` returning 200 with `{ hubMode: true }` to prevent srm CLI errors, but the response shape changes.
- `POST /api/spawn` — removed as a top-level route. Old `srm` CLI versions that POST to `/api/spawn` will receive 400 from the shim. **Migration guide:** Upgrade `srm` globally (`npm install -g @specrails/web-manager`) to get the new CWD-aware routing.

### Category 2: Rename (BREAKING)
- All `/api/jobs/*` routes renamed to `/api/projects/:projectId/jobs/*`
- All `/api/chat/*` routes renamed to `/api/projects/:projectId/chat/*`
- All `/api/analytics` route renamed to `/api/projects/:projectId/analytics`
- **Migration guide:** Old `srm --jobs` flag relies on `GET /api/jobs`. The new `srm --jobs` resolves project from CWD and calls the namespaced route. Update `srm` to the new version.

### Category 4: Behavioral Change (ADVISORY)
- WebSocket `init` message now includes `projectId` field
- WebSocket `log` messages now include `projectId` field
- `srm --status` output format changes to show all registered projects
- Hook callback URL changes from `POST /hooks/events` to `POST /api/projects/:projectId/hooks/events`

### Hook URL migration for existing projects
Existing projects that installed hooks via `install.sh` have their hook URL hardcoded in `.claude/commands/sr/*.md` frontmatter. These must be updated to the new namespaced URL. A `srm hub migrate` step should patch these files automatically.
