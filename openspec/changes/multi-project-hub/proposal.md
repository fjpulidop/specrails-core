# Proposal: Web Manager Multi-Project Hub

## Summary

The web-manager is currently a per-project tool: it is installed into each repo at `specrails/web-manager/`, stores its data in that repo's `data/jobs.sqlite`, and speaks only about that one project. This proposal pivots the web-manager to a **global central hub** — a single, always-running Node.js process installed via `npm install -g @specrails/web-manager` that manages all specrails-enabled projects from one browser interface.

## Motivation

As developers use specrails across multiple repos, the per-project model creates fragmentation:
- Users must start a separate web-manager process for each project they want to monitor
- No way to see job history or analytics across projects from a single view
- The "install into each repo" model imposes template maintenance overhead (copy large node_modules, keep versions in sync)
- A globally-installed tool can stay running in the background and integrate with the OS launcher (menubar, startup items) in the future

The multi-project hub resolves all of this: one command to start (`srm hub`), one browser tab to open, all projects visible simultaneously in a tabbed interface.

## Scope

**In scope (Phase 1 MVP):**
- Global npm package `@specrails/web-manager` with `srm` CLI entry point
- `~/.specrails/hub.sqlite` as the project registry (stores project list + metadata)
- Per-project SQLite databases at `~/.specrails/projects/<slug>/jobs.sqlite`
- Tab-based browser UI showing one tab per registered project
- Add-project flow: user provides a path to a specrails-enabled repo
- Per-project views: Home (dashboard + command grid), Analytics, Conversations
- CWD-based project resolution in `srm` CLI (when hub is running, `srm implement #42` in a project directory routes to that project's job queue)
- Welcome screen (zero projects state)
- Global settings page (hub-level configuration)
- Migration path for existing per-project installs

**Out of scope (deferred to follow-up issues):**
- Split-view onboarding wizard with interactive chat (the issue's "split-view" UI)
- macOS menubar / tray integration
- Multi-user / network-accessible hub (localhost-only for now)
- Project-level custom port assignment (all projects share the hub process)
- Jira integration updates (existing Jira behavior preserved, not extended)
- Real-time cross-project aggregate analytics (cross-project dashboard)

## Risk Assessment

**HIGH:**
- This is a complete architectural pivot. The server's single-project model (one DB, one queue manager, one config) must be multiplexed across N projects. Wrong abstractions here will be costly to undo.
- The `srm` CLI currently targets a fixed port. CWD-based project routing requires a new protocol between CLI and hub server.

**MEDIUM:**
- Data migration from `specrails/web-manager/data/jobs.sqlite` to per-project hub databases must be non-destructive. Existing users should not lose job history.
- The global npm package `@specrails/web-manager` is a new name/scope. Package name conflicts must be resolved before publishing.

**LOW:**
- React client changes are largely additive (add tab bar, add project selector). Existing page components remain intact under a new routing structure.
- WebSocket protocol gains a `projectId` field on all messages — backwards-compatible with srm CLI (old CLI just ignores unknown fields).

## Non-Goals

- Windows support (hub requires bash for project discovery; same constraint as install.sh)
- Authentication or access control (the hub is a localhost-only developer tool)
- Replacing existing per-project installs immediately (migration is opt-in)
