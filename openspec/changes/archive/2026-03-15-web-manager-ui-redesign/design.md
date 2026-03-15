## Context

The web-manager client (`templates/web-manager/client/`) is a React 18 app with zero UI libraries — all styling is inline `React.CSSProperties` objects. It renders a single grid layout with a sidebar (pipeline phases, job queue, free-text input) and a main area (raw log dump + job history table). There is no routing, no design system, no contextual help, and no way to drill into individual jobs.

The parent project `specrails-web` already uses **Tailwind CSS + shadcn/ui + Radix UI + Lucide + React Router v6**, providing a proven stack and visual language to align with.

The server (`templates/web-manager/server/`) exposes Express REST endpoints and a WebSocket for real-time updates. It persists jobs and events to SQLite via `better-sqlite3`. Current endpoints: `POST /api/spawn`, `DELETE /api/jobs/:id`, `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/stats`, `GET /api/queue/*`, and the `/hooks` router.

## Goals / Non-Goals

**Goals:**
- Complete client rewrite with Tailwind + shadcn/ui + React Router producing a polished, intuitive app
- Three navigable views: Dashboard (home), Job Detail, Settings
- Command cards auto-discovered from `.claude/commands/sr/*.md` with contextual tooltips
- Guided modal wizards for Implement and Batch Implement (From Issues / Free Form paths)
- Formatted, on-demand log viewer in Job Detail with syntax coloring by event type
- Settings view with auto-detected issue tracker (GitHub/Jira) and queue configuration
- Contextual UX throughout: tooltips, empty states, toasts, breadcrumbs
- Use Anthropic's `frontend-design` plugin during implementation for high aesthetic quality
- New server endpoints for config detection and issue fetching

**Non-Goals:**
- Mobile/responsive design (this is a desktop developer tool)
- Light theme (dark-only, matching specrails brand; can be added later)
- Authentication or multi-user support
- Real-time collaborative editing of settings
- Replacing the WebSocket protocol or existing REST API contracts
- Jira OAuth flow (relies on pre-configured `jira` CLI)

## Decisions

### 1. Client stack: Tailwind + shadcn/ui + React Router + Lucide

**Choice**: Adopt the same stack as specrails-web (the landing site).

**Alternatives considered**:
- Keep inline styles → rejected; root cause of the aesthetic problems
- Material UI / Ant Design → rejected; heavier, opinionated, doesn't match specrails brand
- CSS Modules → rejected; less ecosystem, no component library alignment

**Rationale**: Consistency with specrails-web, excellent Radix accessibility primitives, Tailwind utility-first matches the "template" nature of specrails (easy to customize per-project), shadcn components are copy-paste (no version lock-in).

### 2. Navigation: React Router with 3 views (no sidebar layout)

**Choice**: Full-page view switching via React Router (`/`, `/jobs/:id`, `/settings`) with a persistent navbar and status bar.

**Alternatives considered**:
- Keep single-page grid with modals for everything → rejected; jobs detail with logs needs full screen space
- Sidebar navigation (like current) → rejected; wastes horizontal space on a monitoring tool
- Tab-based layout → rejected; doesn't support deep-linking to specific jobs

**Rationale**: Deep-linking to `/jobs/:id` enables sharing URLs. Full-page job detail gives maximum space for logs. Dashboard as home provides at-a-glance status without clutter.

### 3. Command discovery: server-side scan of `.claude/commands/sr/`

**Choice**: New `GET /api/config` endpoint reads `.claude/commands/sr/*.md`, extracts frontmatter (name, description), and returns a command registry. Client renders cards from this data.

**Alternatives considered**:
- Hardcode command list in client → rejected; breaks when user adds/removes commands
- Client-side fetch of markdown files → rejected; client doesn't have filesystem access

**Rationale**: Commands are project-specific (installed by specrails setup). Server can read the filesystem, parse YAML frontmatter, and serve a structured list. Cards auto-update when commands change.

### 4. Issue fetching: server-side proxy via `gh` / `jira` CLI

**Choice**: New `GET /api/issues` endpoint shells out to `gh issue list` or `jira issue list` and returns structured JSON. The endpoint accepts query params for label filter and search text.

**Alternatives considered**:
- Direct GitHub API from client → rejected; requires auth token exposure to browser
- GitHub App / OAuth flow → rejected; overkill for a local dev tool
- Import issues from a file → rejected; stale immediately

**Rationale**: The server already runs with the user's shell environment where `gh` and `jira` CLIs are authenticated. Proxying through the server avoids credential exposure and leverages existing CLI auth.

### 5. Log formatting: client-side parsing of stream-json events

**Choice**: Job Detail view fetches historical events from `GET /api/jobs/:id` (already returns `events` array) and subscribes to WebSocket for live events. Client parses each event's `event_type` and `payload` to render formatted, colored log lines.

**Alternatives considered**:
- Server-side log formatting → rejected; formatting is a view concern
- Separate log endpoint → not needed; existing `/api/jobs/:id` already returns events from SQLite

**Rationale**: Events are already persisted in SQLite with `event_type` (assistant, tool_use, tool_result, log, result). The client can use this to apply different formatting: phase headers in bold, tool calls in a distinct color, assistant text as primary, errors in red. This also fixes issue #68 (historical logs from SQLite).

### 6. Wizard modals: shadcn Dialog + multi-step state machine

**Choice**: Implement and Batch Implement commands open a shadcn `Dialog` containing a step-based wizard. State managed with `useReducer` for step transitions.

**Alternatives considered**:
- Full-page wizard views → rejected; loses dashboard context
- Drawer (slide-in panel) → acceptable but modals feel more focused for a 2-3 step flow
- Single form with conditional sections → rejected; confusing for the "From Issues" vs "Free Form" fork

**Rationale**: Modals keep the user anchored to the dashboard. The wizard has at most 3 steps (choose path → configure → confirm), which fits well in a dialog without feeling cramped.

### 7. Tooltip system: shadcn Tooltip with consistent content structure

**Choice**: Every command card, action button, status badge, and pipeline phase gets a shadcn `Tooltip` with a consistent format: title line + 1-2 sentence explanation.

**Rationale**: shadcn Tooltip wraps Radix Tooltip with proper accessibility (keyboard focus, screen reader). Consistent structure means tooltips feel like a coherent help system rather than random hints.

### 8. Toast notifications: sonner library

**Choice**: Use `sonner` for toast notifications (job queued, job canceled, errors).

**Alternatives considered**:
- shadcn Toast (Radix-based) → works but sonner has better defaults, stacking, and animations
- Custom implementation → rejected; unnecessary

**Rationale**: Sonner is lightweight (~3KB), beautifully animated, and commonly paired with shadcn.

## Risks / Trade-offs

- **[Large rewrite scope]** → Mitigated by keeping all server WebSocket/REST contracts unchanged. Client is a clean-room rewrite; server gets additive endpoints only.
- **[CLI dependency for issues]** → If `gh` or `jira` is not authenticated, the "From Issues" path shows an error with setup instructions. The "Free Form" path always works.
- **[Command frontmatter parsing]** → Some command files may lack YAML frontmatter. Server falls back to filename-derived name and empty description.
- **[Log volume in Job Detail]** → Large jobs can produce thousands of events. Mitigated by virtualized scrolling (only render visible rows) and server-side pagination of events.
- **[Plugin availability]** → The `frontend-design` plugin must be loaded during implementation via `claude --plugin-dir`. This is a developer workflow concern, not a runtime dependency.

### 9. Installation path: `specrails/web-manager/` instead of `.claude/web-manager/`

**Choice**: Move the web-manager installation target from `<project>/.claude/web-manager/` to `<project>/specrails/web-manager/`.

**Alternatives considered**:
- Keep in `.claude/web-manager/` → rejected; `.claude/` is Claude Code's namespace for agents, commands, rules, and settings. The web-manager is a specrails product, not a Claude artifact.
- Top-level `.specrails/web-manager/` → acceptable but `specrails/` without the dot is more visible and honest about being a project dependency.

**Rationale**: Clean separation of concerns. `.claude/` contains Claude Code configuration (agents, commands, rules, skills, settings). `specrails/` contains specrails runtime components (web-manager, future tools). The server's `resolveProjectName()` currently walks up from `.claude/web-manager/` — this needs updating to walk up from `specrails/web-manager/`. The `install.sh` and `update.sh` scripts also need path updates.

## Open Questions

- None — all major decisions resolved during explore phase.
