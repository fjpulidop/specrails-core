# Spec Delta: web-manager-analytics

This delta updates the `web-manager-analytics` spec to reflect the per-project routing in the hub.

---

## Changed: Route and API endpoint

**Previous:** Analytics at `/analytics`, fetches `GET /api/analytics`.
**Updated:** Analytics at `/projects/:projectId/analytics`, fetches `GET /api/projects/:projectId/analytics`.

#### Scenario: Navigate to per-project analytics
- **WHEN** user clicks the "Analytics" link in the ProjectNavbar
- **THEN** the browser SHALL navigate to `/projects/:projectId/analytics` and render the analytics page for that project's job data

#### Scenario: Switching projects reloads analytics
- **WHEN** user switches to a different project tab while on the analytics page
- **THEN** the analytics page SHALL re-fetch data for the new project from `GET /api/projects/:newProjectId/analytics`

---

## Unchanged requirements

All `web-manager-analytics` requirements remain in effect:
- Period selector (7d, 30d, 90d, all, custom)
- KPI cards with trend indicators
- Cost Over Time line chart
- Jobs by Status donut chart
- Duration Distribution histogram
- Token Efficiency horizontal bar chart
- Command Performance table
- Daily Throughput stacked bar chart
- Cost per Command treemap
- Bonus Metrics section
- Analytics API validation (invalid period → 400, missing dates → 400)

The only change is that all analytics data is scoped to the active project. Cross-project aggregate analytics are deferred to a future issue.
