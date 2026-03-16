# Spec Delta: web-manager-settings

This delta updates the `web-manager-settings` spec to reflect the two-level settings architecture introduced by the hub.

---

## Changed: Settings split into global and per-project

**Previous:** A single Settings view at `/settings` covers all configuration.
**Updated:** Settings is split:
- `/settings` → Global Settings (hub-level): registered projects list, hub version, data directory
- Per-project settings accessible via the gear icon in the ProjectNavbar: issue tracker, label filter, project name

---

### Requirement: Global Settings view

A Global Settings view SHALL be accessible at `/settings` via the gear icon in the tab bar header area.

#### Scenario: Navigate to global settings
- **WHEN** user clicks the gear icon at the hub level (tab bar area)
- **THEN** the browser SHALL navigate to `/settings` showing hub configuration

#### Scenario: Global settings content
- **WHEN** `/settings` renders
- **THEN** it SHALL display: hub version (from `GET /api/hub/state`), data directory path (`~/.specrails/`), and a table of registered projects with Name, Path, and a Remove button per row

#### Scenario: Remove project from global settings
- **WHEN** user clicks Remove next to a project
- **THEN** the hub SHALL call `DELETE /api/hub/projects/:id` and the project SHALL disappear from both the settings table and the tab bar

---

### Requirement: Per-project settings

Per-project settings SHALL be accessible via a gear icon within each project's ProjectNavbar.

#### Scenario: Navigate to per-project settings
- **WHEN** user clicks the gear icon in the ProjectNavbar
- **THEN** a settings panel or page SHALL render showing: issue tracker configuration, label filter, project name override

---

## Unchanged requirements (now per-project scoped)

All existing `web-manager-settings` requirements remain in effect for per-project settings, with these route changes:
- `GET /api/config` → `GET /api/projects/:projectId/config`
- `POST /api/config` → `POST /api/projects/:projectId/config`
- `GET /api/issues` → `GET /api/projects/:projectId/issues`

The issue tracker auto-detection, label filter, and command registry requirements are unchanged in behavior.
