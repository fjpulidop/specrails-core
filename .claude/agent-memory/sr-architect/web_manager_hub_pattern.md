---
name: web_manager_hub_pattern
description: Multi-project hub architecture: global npm install, ProjectRegistry, hub.sqlite, per-project sqlite, tab UI
type: project
---

## Hub architecture (multi-project-hub change, 2026-03-16)

The web-manager pivoted from per-project install to a global npm package (`@specrails/web-manager`).

**Key patterns:**
- Single Express process, N projects in-memory via `ProjectRegistry` (Map<projectId, ProjectContext>)
- `~/.specrails/hub.sqlite` = project registry (projects table + hub_settings table)
- `~/.specrails/projects/<slug>/jobs.sqlite` = per-project data (reuses `db.ts` unchanged)
- All API routes namespaced: `/api/hub/*` for hub-level, `/api/projects/:projectId/*` for project-level
- WS messages gain `projectId` field; client filters by active project
- `srm hub start/stop/add/remove/list` subcommand group
- CWD-based routing: walk up from CWD until `.claude/commands/sr/` found, then `GET /api/hub/resolve?path=<root>`
- Compatibility shims: `GET /api/state` returns `{ hubMode: true }`, `POST /api/spawn` returns 400 with upgrade message
- Hub data dir: `~/.specrails/` (use `os.homedir()` for portability)
- PID file: `~/.specrails/hub.pid` for `srm hub stop`

**`config.ts` change:** In hub mode, pass `project.path` directly as `cwd` — no `../..` walk needed since `project.path` IS the project root.

**Why:** Cross-project visibility, eliminate per-project template bloat, single running process.
