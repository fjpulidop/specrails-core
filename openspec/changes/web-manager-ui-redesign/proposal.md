## Why

The web-manager frontend is a terminal-style dump of inline-styled React components with a free-text command input, a monospace log wall consuming 80% of the screen, and non-interactive job rows. Users must memorize command syntax, cannot explore logs on demand, and get no contextual guidance. The result is unusable for anyone who isn't the developer who built it. A complete UI/UX redesign is needed to transform it from a developer debugging tool into a polished workflow management app that anyone can use without training.

## What Changes

- **Replace inline styles with Tailwind CSS + shadcn/ui + Radix UI** for a modern, consistent design system aligned with specrails.dev
- **Add React Router** for multi-view navigation (Dashboard, Job Detail, Settings)
- **Add Lucide React** for consistent iconography
- **Replace free-text command input with command cards** auto-detected from `.claude/commands/sr/*.md`, each with contextual tooltips
- **Add guided wizards for Implement and Batch Implement** with two paths: "From Issues" (fetches from GitHub/Jira) and "Free Form" (step-by-step feature description)
- **Add Job Detail view** with formatted logs (syntax-colored by event type), pipeline progress visualization, and job actions (cancel/kill)
- **Add Settings view** with auto-detection of issue tracker (GitHub/Jira), queue configuration, and display preferences
- **Add navbar** with navigation, branding, and external links (specrails.dev, docs)
- **Add status bar** with connection state and cost summary
- **Add contextual UX patterns**: tooltips on all interactive elements, empty states with guidance, toast notifications for actions, breadcrumb navigation
- **New server endpoints**: `GET /api/config` (auto-detected project config), `GET /api/issues` (fetch issues from tracker), `GET /api/jobs/:id/logs` (historical logs from SQLite)
- **Use Anthropic's frontend-design plugin** during implementation for high-quality aesthetic output
- **Relocate web-manager installation path** from `<project>/.claude/web-manager/` to `<project>/specrails/web-manager/` — the web-manager is a specrails product, not a Claude artifact; update install.sh, update.sh, and all path references accordingly

## Capabilities

### New Capabilities
- `web-manager-dashboard`: Main dashboard view with active job card, command grid, recent jobs list, and stats
- `web-manager-command-wizards`: Guided modal wizards for Implement (single feature) and Batch Implement (multiple features) with From Issues and Free Form paths
- `web-manager-job-detail`: Job detail view with pipeline progress, formatted log viewer with filtering, and job actions
- `web-manager-settings`: Settings view with auto-detected issue tracker config, queue settings, and display preferences
- `web-manager-design-system`: Tailwind + shadcn/ui + React Router + Lucide integration replacing all inline styles

### Modified Capabilities
<!-- No existing spec-level requirements are changing — this is a frontend-only redesign -->

## Impact

- **Client code**: Complete rewrite of all components in `templates/web-manager/client/`
- **Client dependencies**: New packages — tailwindcss, shadcn/ui, @radix-ui/*, react-router-dom, lucide-react, sonner (toasts)
- **Server code**: 3 new endpoints in `templates/web-manager/server/index.ts` (`/api/config`, `/api/issues`, `/api/jobs/:id/logs`)
- **Server logic**: New config detection module (reads git remote, checks gh/jira CLI availability, reads `.claude/commands/sr/`)
- **Installation path**: Web-manager moves from `.claude/web-manager/` to `specrails/web-manager/` — affects `install.sh`, `update.sh`, server's `resolveProjectName()`, and any hardcoded `.claude/web-manager` references
- **No breaking changes**: All existing WebSocket and REST APIs remain unchanged; new endpoints are additive
