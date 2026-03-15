## 0. Relocate Web-Manager Installation Path

- [x] 0.1 Update `templates/web-manager/server/index.ts` `resolveProjectName()`: change parent directory walk from `.claude/web-manager` assumption to `specrails/web-manager` (grandparent check from `specrails` instead of `.claude`)
- [x] 0.2 Update `install.sh`: change all web-manager installation paths from `$REPO_ROOT/.claude/web-manager/` to `$REPO_ROOT/specrails/web-manager/`, ensure `specrails/` directory is created
- [x] 0.3 Update `update.sh`: change web-manager update paths from `.claude/web-manager/` to `specrails/web-manager/`
- [x] 0.4 Update `templates/web-manager/README.md`: reflect new installation location
- [x] 0.5 Grep for any remaining `.claude/web-manager` references in templates, commands, or agent prompts and update them to `specrails/web-manager`
- [x] 0.6 Update existing server tests (`index.test.ts`, `queue-manager.test.ts`, `db.test.ts`) to pass with the new path logic; run `npx vitest run` and fix any failures

## 1. Client Stack Setup

- [x] 1.1 Install client dependencies: tailwindcss, @tailwindcss/vite, shadcn/ui (via npx shadcn@latest init), react-router-dom, lucide-react, sonner
- [x] 1.2 Configure Tailwind CSS with Vite plugin, create tailwind config with dark theme as default, add base styles to globals.css
- [x] 1.3 Initialize shadcn/ui with `npx shadcn@latest init` — configure components directory, CSS variables, and base theme (dark)
- [x] 1.4 Install required shadcn components: button, card, dialog, tooltip, badge, input, select, toast (via sonner), separator
- [x] 1.5 Set up React Router in main.tsx with routes: `/` (Dashboard), `/jobs/:id` (JobDetail), `/settings` (Settings), `*` (NotFound redirect)
- [x] 1.6 Create root layout component with Navbar, `<Outlet />`, and StatusBar — wrap with `TooltipProvider` and `Toaster`

## 2. Server: Config and Issues Endpoints

- [x] 2.1 Create `server/config.ts` module: scan `.claude/commands/sr/*.md` for command registry (parse YAML frontmatter for name, description), detect `gh` CLI availability and auth status via `gh auth status`, detect `jira` CLI availability, extract repo name from git remote origin
- [x] 2.2 Add `GET /api/config` endpoint in `server/index.ts` returning: `{ issueTracker: { github: {...}, jira: {...}, active, labelFilter }, commands: [...], project: { name, repo } }`
- [x] 2.3 Add `POST /api/config` endpoint for persisting settings changes (label filter, active tracker) to SQLite `queue_state` table
- [x] 2.4 Add `GET /api/issues` endpoint: proxy to `gh issue list` or `jira issue list` based on active tracker config, accept `?search=` and `?label=` query params, return structured JSON array of `{ number, title, labels, body }`
- [x] 2.5 Add tests for config detection module (`config.test.ts`): mock `execSync` for CLI detection, mock filesystem for command scanning, verify config response structure
- [x] 2.6 Add tests for `/api/config` and `/api/issues` endpoints in `index.test.ts`: mock config module, verify response shapes, verify error handling when no tracker configured (503)
- [x] 2.7 Run `npx vitest run` — all existing and new server tests MUST pass

## 3. Navbar and Layout

- [x] 3.1 Build `Navbar` component: specrails wordmark/logo (left), nav links — Dashboard, Settings gear icon (center/right), external link to specrails.dev (right, opens new tab), active view highlighting via React Router `NavLink`
- [x] 3.2 Build `StatusBar` component: connection status dot (green/red) with label, today's stats (jobs, cost), all-time stats — fetched from existing `/api/stats` endpoint
- [x] 3.3 Build `RootLayout` component wrapping Navbar + `<Outlet />` + StatusBar with full-height flex layout

## 4. Dashboard View

- [x] 4.1 Build `ActiveJobCard` component: shows current running job with command name, elapsed timer (live-updating), cost, pipeline phase indicators (Architect → Developer → Reviewer → Ship), "View Logs" button (navigates to `/jobs/:id`), "Cancel Job" button; shows empty state when no job running
- [x] 4.2 Build `CommandGrid` component: fetches commands from `GET /api/config`, renders grid of shadcn Cards with Lucide icon, name, short description; each card has a shadcn Tooltip with extended description on hover
- [x] 4.3 Implement command card click handlers: simple commands (Health Check, Backlog, etc.) immediately call `POST /api/spawn` and show toast; Implement and Batch Implement open their respective wizard modals
- [x] 4.4 Build `RecentJobs` component: fetches from `GET /api/jobs?limit=10`, renders list with status badge (colored via shadcn Badge), command, relative time, cost, and "View" link (React Router Link to `/jobs/:id`); shows empty state when no jobs
- [x] 4.5 Compose `DashboardPage` combining ActiveJobCard + CommandGrid + RecentJobs with proper spacing and section layout

## 5. Command Wizards

- [x] 5.1 Build `ImplementWizard` modal: shadcn Dialog with two-card path selection (From Issues / Free Form), step state managed with useReducer
- [x] 5.2 Build `IssuePickerStep` component for "From Issues" path: fetches from `GET /api/issues`, renders searchable list with checkboxes, label filter dropdown, issue number + title + labels; single-select for Implement, multi-select for Batch; shows empty state and "no tracker configured" state with Settings link
- [x] 5.3 Build `FreeFormStep` component for "Free Form" single feature: title input + description textarea, validation (title required), submit button with loading state
- [x] 5.4 Build `BatchFreeFormStep` component for "Free Form" multiple features: number selector, dynamic form groups (title + description per feature), add/remove feature buttons, submit with count
- [x] 5.5 Build `BatchImplementWizard` modal: same structure as ImplementWizard but with multi-select defaults and batch-implement command generation
- [x] 5.6 Wire wizard submissions: construct correct command strings (`/sr:implement #42`, `/sr:batch-implement #1 #2 #3`, etc.), call `POST /api/spawn`, show toast, close modal

## 6. Job Detail View

- [x] 6.1 Build `JobDetailPage`: fetches job from `GET /api/jobs/:id`, displays command, status badge, start time, duration (live-updating if running), cost; shows "Job not found" for invalid IDs with Dashboard link
- [x] 6.2 Build `PipelineProgress` component: horizontal 4-phase visualization (Architect → Developer → Reviewer → Ship) with status icons (checkmark/pulse/empty/error), phase name, duration per phase; each phase has tooltip explaining its role
- [x] 6.3 Build `LogViewer` component: renders formatted log lines from events array; syntax coloring by event type — phase headers bold with `▸`, tool calls in cyan with `[ToolName]`, assistant text in primary color, stderr in orange/red; timestamps in muted color
- [x] 6.4 Add log viewer features: search/filter input, auto-scroll with "Jump to bottom" button when user scrolls up, line count indicator
- [x] 6.5 Implement historical + live log merging: on mount, fetch events from `GET /api/jobs/:id`, then subscribe to WebSocket `log` messages for that jobId, merge into single ordered list (fixes #68)
- [x] 6.6 Add job action buttons: "Cancel Job" (destructive variant, calls `DELETE /api/jobs/:id`, toast feedback) visible only for running jobs; tooltip on button explaining SIGTERM behavior

## 7. Settings View

- [x] 7.1 Build `SettingsPage` with sections: Issue Tracker, Queue, Display
- [x] 7.2 Build Issue Tracker section: show detected status (GitHub ✓ / Jira ✓ / None), repo name, auth status, radio selector for active tracker, label filter input; show setup instructions when tracker not authenticated
- [x] 7.3 Build Queue section: placeholder for future queue config (inactivity timeout, auto-pause on failure)
- [x] 7.4 Build Display section: placeholder for future display preferences (log line limit)
- [x] 7.5 Wire settings persistence via `POST /api/config`

## 8. Contextual UX Polish

- [x] 8.1 Add tooltips to all command cards with extended descriptions from command frontmatter
- [x] 8.2 Add tooltips to pipeline phase indicators explaining each phase's role
- [x] 8.3 Add tooltips to all action buttons (Cancel, Kill, View, etc.)
- [x] 8.4 Add tooltips to status badges explaining what each status means
- [x] 8.5 Implement toast notifications for all actions: job queued, job canceled, job completed/failed, API errors
- [x] 8.6 Implement all empty states: no active job, no job history, no issues found, no tracker configured
- [x] 8.7 Add breadcrumb navigation in Job Detail: "Dashboard › Job #abc123"

## 9. Integration, Tests, and Cleanup

- [x] 9.1 Remove all old components: CommandInput.tsx, AgentActivity.tsx, SearchBox.tsx, LogStream.tsx (replaced by new components)
- [x] 9.2 Update usePipeline hook to support both Dashboard (summary) and JobDetail (full events) modes
- [x] 9.3 Update useWebSocket hook to filter messages by jobId when in Job Detail view
- [x] 9.4 Update ALL existing server tests to work with new components and endpoints — `db.test.ts`, `queue-manager.test.ts`, `index.test.ts`, `hooks.test.ts`
- [x] 9.5 Run `npx vitest run` from the web-manager root — ALL tests MUST pass (0 failures)
- [x] 9.6 Run `npm run build` (TypeScript compilation + Vite build) — MUST succeed with 0 errors
- [x] 9.7 If any test fails, fix the root cause and re-run until all pass — do NOT skip or disable tests
- [ ] 9.8 Manual smoke test: launch web-manager, verify Dashboard renders, queue a job, verify logs appear in Job Detail, verify Settings loads config
