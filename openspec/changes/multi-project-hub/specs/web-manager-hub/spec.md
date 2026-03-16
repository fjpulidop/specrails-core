# Spec: Web Manager Multi-Project Hub

This spec governs the hub-level capabilities of the web-manager. It supplements and partially supersedes `web-manager-dashboard`, `web-manager-settings`, and `web-manager-analytics` specs where those assume a single-project model.

---

### Requirement: Hub is installed globally via npm

The web-manager SHALL be installable as a global npm package.

#### Scenario: Global install
- **WHEN** user runs `npm install -g @specrails/web-manager`
- **THEN** the `srm` binary SHALL be available on PATH

#### Scenario: Start hub
- **WHEN** user runs `srm hub start`
- **THEN** the hub server SHALL start on port 4200 (default), write its PID to `~/.specrails/hub.pid`, and print `[srm] hub started on http://127.0.0.1:4200`

#### Scenario: Stop hub
- **WHEN** user runs `srm hub stop`
- **THEN** the hub server SHALL receive SIGTERM, clean up DB connections, delete the PID file, and exit

---

### Requirement: Hub registry persists projects in `~/.specrails/hub.sqlite`

The hub SHALL maintain a SQLite database at `~/.specrails/hub.sqlite` containing the project registry.

#### Scenario: Registry created on first start
- **WHEN** the hub starts for the first time
- **THEN** `~/.specrails/hub.sqlite` SHALL be created with the `projects` and `hub_settings` tables

#### Scenario: Projects persist across hub restarts
- **WHEN** user stops and restarts the hub
- **THEN** all previously registered projects SHALL be present in the project list

---

### Requirement: Projects are registered via CLI or UI

Users SHALL be able to register specrails-enabled project directories with the hub.

#### Scenario: CLI registration
- **WHEN** user runs `srm hub add /abs/path/to/project`
- **THEN** the hub SHALL validate that `.claude/commands/sr/` exists at that path, register the project, and print the project name and ID

#### Scenario: Invalid path rejected
- **WHEN** user runs `srm hub add /path/without/specrails`
- **THEN** the hub SHALL print `[srm] error: not a specrails-enabled project (missing .claude/commands/sr/)` and exit 1

#### Scenario: UI registration
- **WHEN** user clicks "+" in the tab bar and submits a valid path
- **THEN** `POST /api/hub/projects` SHALL register the project and broadcast `hub.project_added`

---

### Requirement: Per-project data stored in `~/.specrails/projects/<slug>/jobs.sqlite`

Each registered project SHALL have an isolated SQLite database for its jobs, events, and conversations.

#### Scenario: Database created on first registration
- **WHEN** a project is registered for the first time
- **THEN** `~/.specrails/projects/<slug>/jobs.sqlite` SHALL be created and initialized with the current schema

#### Scenario: Slug uniqueness
- **WHEN** two projects have the same name (e.g. both named "my-app")
- **THEN** the second project's slug SHALL have a numeric suffix (e.g. "my-app-2")

---

### Requirement: Hub UI shows browser-style project tabs

The web-manager UI SHALL display one tab per registered project at the top of the application.

#### Scenario: Tab bar renders
- **WHEN** at least one project is registered
- **THEN** the tab bar SHALL show one tab per project with the project name and a status indicator

#### Scenario: Status indicator reflects job state
- **WHEN** a job is running in a project
- **THEN** that project's tab SHALL show a green pulsing dot
- **WHEN** no job is running
- **THEN** the dot SHALL be grey

#### Scenario: Switching tabs
- **WHEN** user clicks a project tab
- **THEN** the content area SHALL render that project's dashboard without a page reload
- **AND** the URL SHALL update to `/projects/:projectId/`

#### Scenario: Add project tab button
- **WHEN** user clicks the "+" icon in the tab bar
- **THEN** the Add Project dialog SHALL open

---

### Requirement: Welcome screen for first-time users

When no projects are registered, the UI SHALL show a welcome screen.

#### Scenario: Zero projects state
- **WHEN** the hub is running and `GET /api/hub/projects` returns an empty array
- **THEN** the UI SHALL display the welcome screen with an "Add your first project" button

#### Scenario: Welcome screen dismissed on first project add
- **WHEN** user adds their first project via the welcome screen
- **THEN** the UI SHALL transition to the tab view with the new project selected

---

### Requirement: CWD-based project routing in `srm`

When the hub is running, `srm <verb>` SHALL route to the project matching the current working directory.

#### Scenario: Command routed to active project
- **WHEN** user runs `srm implement #42` from within a registered project directory
- **THEN** the command SHALL be queued in that project's job queue via `POST /api/projects/:projectId/spawn`

#### Scenario: Unregistered project
- **WHEN** user runs `srm implement #42` from a directory not matching any registered project
- **THEN** `srm` SHALL print `[srm] no project registered for <cwd>` and `[srm] run: srm hub add <cwd>` and exit 1

#### Scenario: Hub not running — direct fallback preserved
- **WHEN** `srm <verb>` is invoked and the hub is not reachable
- **THEN** `srm` SHALL fall back to spawning claude directly, exactly as before

---

### Requirement: Hub API exposes project management endpoints

#### Scenario: List projects
- **WHEN** client calls `GET /api/hub/projects`
- **THEN** the server SHALL return `{ projects: ProjectRow[] }` with all registered projects

#### Scenario: Hub health
- **WHEN** client calls `GET /api/hub/state`
- **THEN** the server SHALL return `{ version: string, projects: number, uptime: number }`

#### Scenario: Resolve project by path
- **WHEN** client calls `GET /api/hub/resolve?path=/abs/path`
- **THEN** the server SHALL return `{ project: ProjectRow }` if found, or 404

---

### Requirement: All per-project API routes are namespaced by project ID

All routes that operate on project-specific data SHALL be under `/api/projects/:projectId/`.

#### Scenario: Project-scoped spawn
- **WHEN** client calls `POST /api/projects/:projectId/spawn` with `{ command: string }`
- **THEN** the job SHALL be queued in that project's QueueManager and return `{ jobId, position }`

#### Scenario: Unknown project ID
- **WHEN** client calls any `/api/projects/:projectId/*` route with an unregistered project ID
- **THEN** the server SHALL return HTTP 404 with `{ error: "Project not registered" }`

---

### Requirement: Compatibility shims for old `srm` CLI

The hub SHALL expose compatibility routes at the old paths to surface clear upgrade messages.

#### Scenario: Old srm hits `/api/state`
- **WHEN** client calls `GET /api/state`
- **THEN** the server SHALL return HTTP 200 with `{ hubMode: true, version: string, projects: number }`

#### Scenario: Old srm hits `/api/spawn`
- **WHEN** client calls `POST /api/spawn`
- **THEN** the server SHALL return HTTP 400 with `{ error: "Hub mode active. Use POST /api/projects/:projectId/spawn", upgradeUrl: "/api/hub/projects" }`
