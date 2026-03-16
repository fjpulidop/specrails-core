# Tasks: Web Manager Multi-Project Hub

## Phase 1 MVP Scope

These tasks deliver the core multi-project hub: global install, project registry, tab-based UI, and CWD-aware CLI. Advanced features (split-view onboarding wizard, migration tooling, cross-project analytics) are deferred.

The tasks are ordered by dependency. Each task must complete before the tasks that depend on it.

---

## Layer: [core] — Hub data layer and project registry

### Task 1 [core] — Create hub database module

**Description:** Create `server/hub-db.ts` implementing the hub-level SQLite operations. This is the project registry layer, completely separate from per-project `db.ts`.

**Create:**
- `templates/web-manager/server/hub-db.ts`

**Schema to implement:**
```sql
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  db_path      TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE hub_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Functions to export:**
- `initHubDb(dbPath: string): DbInstance`
- `listProjects(db): ProjectRow[]`
- `getProject(db, id): ProjectRow | undefined`
- `getProjectByPath(db, path): ProjectRow | undefined`
- `addProject(db, opts: { name, path, dbPath }): ProjectRow`
- `removeProject(db, id): void`
- `touchProject(db, id): void` (update last_seen_at)
- `getHubSetting(db, key): string | null`
- `setHubSetting(db, key, value): void`

**Acceptance criteria:**
- `initHubDb('~/.specrails/hub.sqlite')` creates the file and runs migrations
- All CRUD functions work against the schema
- `ProjectRow` type exported from `server/types.ts`

---

### Task 2 [core] — Create ProjectContext manager

**Description:** Create `server/project-registry.ts` that manages the lifecycle of per-project resources: opens/closes per-project SQLite databases, instantiates QueueManager and ChatManager per project, and exposes a typed registry for the router layer.

**Create:**
- `templates/web-manager/server/project-registry.ts`

**Interface to implement:**
```typescript
interface ProjectContext {
  project: ProjectRow
  db: DbInstance          // per-project jobs.sqlite
  queueManager: QueueManager
  chatManager: ChatManager
}

class ProjectRegistry {
  constructor(hubDb: DbInstance, broadcast: BroadcastFn)
  loadAll(): void                                   // called at startup
  addProject(row: ProjectRow): ProjectContext
  removeProject(id: string): void
  getContext(id: string): ProjectContext | undefined
  getContextByPath(projectPath: string): ProjectContext | undefined
  listContexts(): ProjectContext[]
}
```

**Acceptance criteria:**
- Registry holds ProjectContext per registered project
- Adding a project creates a jobs.sqlite in `~/.specrails/projects/<slug>/jobs.sqlite`
- Removing a project closes DB connections but does NOT delete the DB file
- `broadcast` function passed to each QueueManager/ChatManager includes `projectId` in all messages

---

### Task 3 [core] — Extend broadcast to include projectId

**Description:** Modify `server/queue-manager.ts` and `server/chat-manager.ts` to accept a `projectId` constructor parameter and include it in all broadcast messages.

**Modify:**
- `templates/web-manager/server/queue-manager.ts`
- `templates/web-manager/server/chat-manager.ts`
- `templates/web-manager/server/types.ts`

**Changes:**
- `WsMessage` union type: add `projectId: string` field to all project-scoped message types
- `QueueManager` constructor: add `projectId: string` parameter
- `ChatManager` constructor: add `projectId: string` parameter
- All `broadcast()` calls include `projectId`

**Acceptance criteria:**
- TypeScript compiles without errors
- All `type WsMessage` variants that are project-scoped carry `projectId`
- Hub-level message variants (`hub.project_added`, `hub.project_removed`) added to the union without `projectId`

---

## Layer: [server] — Express routes

### Task 4 [server] — Create hub router (`/api/hub/*`)

**Description:** Create `server/hub-router.ts` implementing the hub-level REST routes. This handles project registration/deregistration and hub health.

**Create:**
- `templates/web-manager/server/hub-router.ts`

**Routes to implement:**
```
GET  /api/hub/state              → { version, projects: count, uptime }
GET  /api/hub/projects           → { projects: ProjectRow[] }
POST /api/hub/projects           → register project; body: { path: string, name?: string }
DELETE /api/hub/projects/:id     → unregister project (404 if not found)
GET  /api/hub/projects/:id       → single project metadata
GET  /api/hub/resolve?path=<p>   → find project by CWD path match; 404 if not found
GET  /api/hub/settings           → { settings: Record<string, string> }
PUT  /api/hub/settings           → body: Record<string, string>; merges into hub_settings
```

**POST /api/hub/projects logic:**
1. Validate that `path` exists on the filesystem and contains `.claude/commands/sr/` (confirming specrails install)
2. Derive `name` from git root basename (run `git -C <path> rev-parse --show-toplevel`)
3. Generate `slug` = kebab-case(name), ensure uniqueness with suffix if needed
4. Set `db_path` = `~/.specrails/projects/<slug>/jobs.sqlite`
5. Insert into hub.sqlite, call `registry.addProject(row)`, broadcast `hub.project_added`

**Acceptance criteria:**
- `GET /api/hub/projects` returns array (empty when no projects registered)
- `POST /api/hub/projects` with a valid specrails project path registers it and broadcasts
- `DELETE /api/hub/projects/:id` unregisters and broadcasts `hub.project_removed`
- `GET /api/hub/resolve?path=/abs/path/to/repo` returns matching project or 404

---

### Task 5 [server] — Create project-scoped router (`/api/projects/:projectId/*`)

**Description:** Create `server/project-router.ts` wrapping all existing per-project routes under the `/api/projects/:projectId/` namespace. The router must resolve `ProjectContext` from `req.params.projectId` and return 404 if the project is not registered.

**Create:**
- `templates/web-manager/server/project-router.ts`

**Routes to implement:** All routes currently in `server/index.ts` under `/api/*` and `/hooks/*`, now namespaced. Specifically:
```
GET  /api/projects/:projectId/state
POST /api/projects/:projectId/spawn
GET  /api/projects/:projectId/queue
POST /api/projects/:projectId/queue/pause
POST /api/projects/:projectId/queue/resume
PUT  /api/projects/:projectId/queue/reorder
GET  /api/projects/:projectId/jobs
GET  /api/projects/:projectId/jobs/:id
DELETE /api/projects/:projectId/jobs/:id
DELETE /api/projects/:projectId/jobs
GET  /api/projects/:projectId/stats
GET  /api/projects/:projectId/analytics
GET  /api/projects/:projectId/config
POST /api/projects/:projectId/config
GET  /api/projects/:projectId/issues
GET  /api/projects/:projectId/chat/conversations
POST /api/projects/:projectId/chat/conversations
GET  /api/projects/:projectId/chat/conversations/:convId
DELETE /api/projects/:projectId/chat/conversations/:convId
PATCH /api/projects/:projectId/chat/conversations/:convId
GET  /api/projects/:projectId/chat/conversations/:convId/messages
POST /api/projects/:projectId/chat/conversations/:convId/messages
DELETE /api/projects/:projectId/chat/conversations/:convId/messages/stream
POST /api/projects/:projectId/hooks/events
```

**Middleware:**
```typescript
router.use('/:projectId', (req, res, next) => {
  const ctx = registry.getContext(req.params.projectId)
  if (!ctx) { res.status(404).json({ error: 'Project not registered' }); return }
  req.projectContext = ctx  // typed on Express.Request
  next()
})
```

**Acceptance criteria:**
- All routes from `server/index.ts` ported and functional
- Unknown projectId returns 404
- Hooks POST URL uses the new path (hook callback in command frontmatter must be updated separately)

---

### Task 6 [server] — Rewrite `server/index.ts` as hub entry point

**Description:** Rewrite `server/index.ts` to:
1. Initialize `~/.specrails/hub.sqlite` via `initHubDb`
2. Create `ProjectRegistry` and call `loadAll()`
3. Mount hub router at `/api/hub`
4. Mount project router at `/api/projects`
5. Add compatibility shims at `/api/state` and `/api/spawn`
6. Remove all per-project route definitions from this file (they move to project-router.ts)

**Compatibility shims:**
```
GET /api/state   → { hubMode: true, version, projects: N }
POST /api/spawn  → 400 { error: 'Hub mode active. Use POST /api/projects/:projectId/spawn', upgradeUrl: '/api/hub/projects' }
```

**Hub startup:**
- Read port from `--port` arg or env `SRM_PORT` (default 4200)
- Write PID to `~/.specrails/hub.pid`
- On SIGTERM/SIGINT: close all project DBs, delete PID file, exit cleanly

**Modify:**
- `templates/web-manager/server/index.ts`

**Acceptance criteria:**
- Server starts with `npm start` and serves `GET /api/hub/state`
- Hub PID file written on start, deleted on clean exit
- TypeScript compiles without errors

---

## Layer: [cli] — `srm` CLI extensions

### Task 7 [cli] — Add `srm hub` subcommand group

**Description:** Extend `cli/srm.ts` with a `hub` subcommand group. Parse `srm hub <sub>` and route to hub-specific handlers.

**Modify:**
- `templates/web-manager/cli/srm.ts`

**Subcommands to implement:**

| Invocation | Behaviour |
|---|---|
| `srm hub start [--port <n>]` | Start hub server in background, write PID to `~/.specrails/hub.pid` |
| `srm hub stop` | Read PID file, send SIGTERM, delete PID file |
| `srm hub status` | `GET /api/hub/state`, print summary of projects and busy states |
| `srm hub add <path>` | `POST /api/hub/projects` with `{ path }`, print confirmation |
| `srm hub remove <id-or-path>` | `DELETE /api/hub/projects/:id`, print confirmation |
| `srm hub list` | `GET /api/hub/projects`, print table of registered projects |

**`srm hub start` implementation:**
- Spawn `node <hub-entry>` as a detached child process
- Wait up to 3 seconds for `GET /api/hub/state` to return 200
- Print `[srm] hub started on http://127.0.0.1:<port>`

**Acceptance criteria:**
- `srm hub start` starts the hub and exits with code 0
- `srm hub stop` terminates the hub cleanly
- `srm hub list` prints a table matching `srm --jobs` style

---

### Task 8 [cli] — Update CWD-based project routing in `srm`

**Description:** Modify the command routing logic in `srm` so that when the hub is running, it resolves the current project from CWD before posting to `/api/spawn`.

**Modify:**
- `templates/web-manager/cli/srm.ts`

**New routing logic (replaces `runViaWebManager`):**
1. `GET /api/hub/state` — if 2xx: hub mode active
2. `GET /api/hub/resolve?path=<cwd>` — resolve project
3. If 404: print "no project registered for <cwd>", print `srm hub add <cwd>`, exit 1
4. If 200: use returned `projectId`, POST to `/api/projects/<projectId>/spawn`
5. WebSocket stream: filter messages by both `processId` AND `projectId`

**Legacy detection:** If hub `/api/hub/state` is not reachable but `/api/state` returns 200, srm falls back to the legacy single-project mode (preserves backwards compat with old per-project servers).

**Acceptance criteria:**
- `srm implement #42` in a registered project directory routes to that project
- `srm implement #42` with no project registered prints actionable error
- `srm implement #42` with no hub running falls back to direct claude invocation

---

## Layer: [client] — React UI

### Task 9 [client] — Create HubProvider and project registry state

**Description:** Create a top-level React context that manages the hub connection, project list, and active project selection.

**Create:**
- `templates/web-manager/client/src/hooks/useHub.tsx`

**State managed:**
```typescript
interface HubState {
  projects: ProjectRow[]
  activeProjectId: string | null
  setActiveProject: (id: string) => void
  addProject: (path: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  hubVersion: string | null
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
}
```

**Initialization:**
- On mount: `GET /api/hub/projects` to populate project list
- `GET /api/hub/state` for version info
- Subscribe to WebSocket `hub.project_added` and `hub.project_removed` to keep list in sync
- Default `activeProjectId` = first project in list (or null if empty)

**Acceptance criteria:**
- `useHub()` hook returns current state
- Adding a project via `POST /api/hub/projects` updates the project list without page reload
- `hub.project_removed` WS message removes the tab immediately

---

### Task 10 [client] — Build TabBar component

**Description:** Create the project tab bar that sits above the per-project navbar.

**Create:**
- `templates/web-manager/client/src/components/TabBar.tsx`

**Requirements:**
- One tab per registered project, showing project name and a status indicator (green pulsing dot when a job is active, grey when idle)
- Clicking a tab sets `activeProjectId` and navigates to `/projects/:projectId/`
- "+" icon button at the end of the tabs opens the Add Project dialog
- Active tab has visual highlight (accent background or bottom border)
- Overflow: when many projects, tabs scroll horizontally (no wrapping)
- Hub title ("specrails hub") shown to the left of the tabs as wordmark

**Acceptance criteria:**
- Switching tabs changes the project content area without page reload
- Status dot updates in real-time when a job starts/finishes (via WebSocket)
- Add button opens dialog, dialog close returns to tab bar

---

### Task 11 [client] — Build AddProjectDialog component

**Description:** Create the modal dialog for registering a new project.

**Create:**
- `templates/web-manager/client/src/components/AddProjectDialog.tsx`

**Flow:**
1. Single input: "Project path" (filesystem path, e.g. `/Users/javi/repos/my-app`)
2. Submit → `POST /api/hub/projects`
3. On success: close dialog, new project tab appears (driven by WS `hub.project_added`)
4. On error (invalid path, not a specrails project): show inline error message

**Acceptance criteria:**
- Path input shows placeholder text
- Empty path prevents submission
- Server validation errors are surfaced in the dialog (not as a toast)
- Dialog dismisses on Escape or overlay click

---

### Task 12 [client] — Build WelcomeScreen component

**Description:** Create the zero-state screen shown when no projects are registered.

**Create:**
- `templates/web-manager/client/src/components/WelcomeScreen.tsx`

**Content:**
- Specrails logo/wordmark
- Headline: "Your projects live here"
- Subtext: "Register a specrails-enabled project to get started"
- "Add your first project" button (opens AddProjectDialog)

**Acceptance criteria:**
- Renders when `projects.length === 0`
- "Add your first project" button triggers AddProjectDialog
- After first project added, transitions to normal tab view

---

### Task 13 [client] — Update App.tsx routing for hub structure

**Description:** Rewrite `App.tsx` to implement the hub routing structure with tab bar and per-project sub-navigation.

**Modify:**
- `templates/web-manager/client/src/App.tsx`

**New structure:**
```tsx
<HubProvider>
  <SharedWebSocketProvider url={WS_URL}>
    {projects.length === 0
      ? <WelcomeScreen />
      : (
        <div className="flex flex-col h-screen">
          <TabBar />
          <ProjectRoutes activeProjectId={activeProjectId} />
        </div>
      )
    }
  </SharedWebSocketProvider>
</HubProvider>
```

**`ProjectRoutes` component:**
```tsx
<Routes>
  <Route path="/projects/:projectId" element={<ProjectLayout />}>
    <Route index element={<DashboardPage />} />
    <Route path="jobs/:jobId" element={<JobDetailPage />} />
    <Route path="analytics" element={<AnalyticsPage />} />
    <Route path="conversations" element={<ConversationsPage />} />
  </Route>
  <Route path="/settings" element={<GlobalSettingsPage />} />
  <Route path="*" element={<Navigate to={`/projects/${activeProjectId}`} replace />} />
</Routes>
```

**Acceptance criteria:**
- Root path redirects to `/projects/<first-project-id>/`
- Switching tabs navigates to the new project's route
- All existing page components render within the new routing structure

---

### Task 14 [client] — Create ProjectLayout and ProjectNavbar

**Description:** Create the per-project layout wrapper with the project-scoped sub-navigation (Home, Analytics, Conversations, Settings icon).

**Create:**
- `templates/web-manager/client/src/components/ProjectLayout.tsx`
- `templates/web-manager/client/src/components/ProjectNavbar.tsx`

**ProjectNavbar:**
- Replaces current `Navbar.tsx` within the per-project scope
- Links: Home → `/projects/:projectId/`, Analytics → `/projects/:projectId/analytics`, Conversations → `/projects/:projectId/conversations`
- Settings icon → `/settings` (global settings)
- Project name displayed as subtitle under specrails branding

**Modify:**
- `templates/web-manager/client/src/components/RootLayout.tsx` — embed ProjectNavbar instead of Navbar

**Acceptance criteria:**
- Per-project nav links work with the new URL structure
- Active link highlighting functions correctly for all routes

---

### Task 15 [client] — Update all API calls to use project-scoped paths

**Description:** Update all React hooks and page components to call `/api/projects/:projectId/*` instead of `/api/*`.

**Modify:**
- `templates/web-manager/client/src/hooks/usePipeline.ts`
- `templates/web-manager/client/src/hooks/useChat.ts`
- `templates/web-manager/client/src/pages/DashboardPage.tsx`
- `templates/web-manager/client/src/pages/AnalyticsPage.tsx`
- `templates/web-manager/client/src/pages/JobDetailPage.tsx`
- `templates/web-manager/client/src/pages/SettingsPage.tsx`

**Pattern:** All `fetch('/api/...')` calls must become `fetch(\`/api/projects/${projectId}/...\`)` where `projectId` comes from `useHub()` context or `useParams()`.

**Acceptance criteria:**
- Dashboard loads jobs for the active project only
- Analytics shows data for the active project
- Switching tabs loads the new project's data (not the old project's)

---

### Task 16 [client] — Create ConversationsPage

**Description:** Extract the existing ChatPanel from the sidebar into a full-page ConversationsPage, accessible via the per-project nav.

**Create:**
- `templates/web-manager/client/src/pages/ConversationsPage.tsx`

**Content:** Move `ChatPanel`, `ChatHeader`, `ChatInput`, `MessageList`, `MessageBubble` into a full-page layout with a sidebar for conversation list and a main area for the active conversation. This matches the existing chat panel UX but with more horizontal space.

**Modify:**
- `templates/web-manager/client/src/components/RootLayout.tsx` — remove the embedded ChatPanel (it was a sidebar in the old layout); conversations now live on their own page

**Acceptance criteria:**
- Conversations page renders the chat panel with conversation list on the left
- All existing chat functionality (send message, stream, create/delete conversation) works
- All API calls use `/api/projects/:projectId/chat/...`

---

### Task 17 [client] — Create GlobalSettingsPage

**Description:** Create the hub-level global settings page at `/settings`.

**Create:**
- `templates/web-manager/client/src/pages/GlobalSettingsPage.tsx`

**Content:**
- Hub version info (from `GET /api/hub/state`)
- Data directory path (`~/.specrails/`)
- List of registered projects with path and "Remove" button per project
- Link to per-project settings (for the currently active project)

**Acceptance criteria:**
- `GET /api/hub/settings` response drives the page
- Removing a project from the list calls `DELETE /api/hub/projects/:id` and updates the tab bar

---

## Layer: [client] — WebSocket updates

### Task 18 [client] — Update SharedWebSocketProvider for hub messages

**Description:** Extend `useSharedWebSocket.tsx` to handle `hub.*` message types and fan them out to hub-level handlers separately from project-scoped handlers.

**Modify:**
- `templates/web-manager/client/src/hooks/useSharedWebSocket.tsx`

**Changes:**
- Hub-level messages (`hub.project_added`, `hub.project_removed`, `hub.project_updated`) are dispatched to handlers registered with key prefix `hub:*`
- Project-scoped messages continue to fan-out to all registered handlers (the HubProvider context filters by `projectId`)

**Acceptance criteria:**
- `hub.project_added` message adds a new tab without page reload
- Project-scoped log messages only trigger re-renders for the active project's components

---

## Non-MVP tasks (deferred)

The following tasks from the original issue are explicitly deferred to follow-up issues:
- Split-view onboarding wizard with progress checkpoints and interactive chat
- Automatic migration of existing per-project installs (migrations are manual via `srm hub migrate`)
- Cross-project aggregate analytics dashboard
- macOS menubar / tray integration
- `install.sh` changes to use global hub instead of per-project template copy

---

## Task dependency graph

```
Task 1 (hub-db.ts)
  └── Task 2 (ProjectRegistry)
        └── Task 3 (broadcast + projectId)
              ├── Task 4 (hub router)
              ├── Task 5 (project router)
              └── Task 6 (server/index.ts rewrite)
                    └── Task 7 (srm hub subcommands)
                          └── Task 8 (srm CWD routing)

Task 9 (HubProvider)
  ├── Task 10 (TabBar)
  ├── Task 11 (AddProjectDialog)
  ├── Task 12 (WelcomeScreen)
  └── Task 13 (App.tsx routing)
        ├── Task 14 (ProjectLayout + ProjectNavbar)
        ├── Task 15 (API call updates)
        ├── Task 16 (ConversationsPage)
        └── Task 17 (GlobalSettingsPage)

Task 18 (SharedWebSocket hub messages) — can run in parallel with Task 9+
```

Server-side tasks (1–8) must be complete before client-side tasks (9–18) can be integration-tested end-to-end. Client tasks 9–18 can be built against a stubbed server.
