# Spec Delta: web-manager-dashboard

This delta updates the `web-manager-dashboard` spec to reflect the multi-project hub architecture. The dashboard now renders within a per-project context; all assertions below are scoped to the active project.

---

## Changed: Root URL

**Previous:** The root URL (`/`) renders the Dashboard.
**Updated:** The Dashboard renders at `/projects/:projectId/`. The root URL (`/`) redirects to `/projects/<first-project-id>/`.

#### Scenario: User opens hub with one project registered
- **WHEN** user navigates to `localhost:4200/`
- **THEN** the browser SHALL redirect to `/projects/<projectId>/` and display the Dashboard for the first registered project

---

## Changed: Navbar context

**Previous:** Navbar contains "Home" and "Analytics" links in the center.
**Updated:** The per-project navbar (ProjectNavbar) contains "Home", "Analytics", and "Conversations" links scoped to the current project. The tab bar above it provides cross-project navigation.

#### Scenario: Per-project nav links
- **WHEN** user is viewing a project dashboard
- **THEN** the ProjectNavbar SHALL display links to `/projects/:projectId/`, `/projects/:projectId/analytics`, and `/projects/:projectId/conversations`

---

## Unchanged requirements

All other `web-manager-dashboard` requirements remain in effect:
- Active job card with command, elapsed timer, cost, phase progress, View Logs and Cancel Job buttons
- Command grid populated from `GET /api/projects/:projectId/config` (route namespace updated)
- Wizard modals for Implement and Batch Implement
- Recent jobs list showing up to 10 jobs, sorted most-recent-first
- Status bar showing connection status and aggregate stats
- Empty states for no active job and no job history

The only change is that all API calls use `/api/projects/:projectId/` prefix instead of `/api/`.
