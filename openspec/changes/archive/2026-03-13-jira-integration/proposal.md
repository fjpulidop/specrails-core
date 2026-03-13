# Proposal: JIRA Integration — Project Labels and Epic Grouping in Backlog Pipeline

## Problem

The backlog pipeline today is GitHub Issues–only. When a team's source of truth for product work is JIRA, the current pipeline creates a friction gap: feature ideas discovered via `/update-product-driven-backlog` land in GitHub Issues, where the team does not work. The team must manually copy each ticket into JIRA, reorganize by project, and attach it to the correct epic — labor that should be automated.

Two specific pain points surface in JIRA-first teams:

1. **No project label on generated tickets.** JIRA uses project labels (e.g., `PROJECT-specrails`) to identify which product area a ticket belongs to. Without this, tickets are orphaned from their project context and require manual triaging.

2. **No epic grouping.** JIRA's hierarchy distinguishes epics (large capability areas) from stories (individual features). The VPC discovery process naturally surfaces area-level groupings (`area:core`, `area:agents`, `area:commands`) that map directly onto epics. Without this mapping, every generated ticket appears as a flat, ungrouped story, and the team must manually reorganize the backlog.

## Solution

Extend the `/setup` wizard and the `/update-product-driven-backlog` command to be JIRA-aware.

**In `/setup` (Phase 3.2 — Backlog Provider):**
When the user selects JIRA, prompt for a **project label** — a string applied to every generated ticket to identify the project (e.g., `PROJECT-specrails`). Store this in `.claude/backlog-config.json` alongside the existing JIRA configuration.

**In `/update-product-driven-backlog` (Backlog Sync phase):**
When `provider: jira` is configured, group discovered feature ideas by `area:*` label before creating tickets. For each unique area:
1. Look up whether a JIRA epic for that area already exists in the project.
2. If not, create an epic with the area name as its title.
3. Create each Story ticket linked to its corresponding epic and tagged with the configured project label.

GitHub Issues mode is unchanged. The JIRA path is activated only when `provider: jira` is set in `.claude/backlog-config.json`.

## Non-Goals

- This does not change the product discovery logic (VPC scoring, persona analysis). Only the sync path changes.
- This does not add sprint assignment, priority mapping, or custom field population beyond project label and epic linkage.
- This does not introduce a JIRA-specific area mapping system. Areas are derived from the same `area:*` labels already used for GitHub Issues.
- This does not modify the `/product-backlog` read command (that is a separate concern).
- This does not change any behavior when `provider: github` or `provider: none` is configured.

## Scope

Four files change:

1. `commands/setup.md` — the `/setup` command active in this specrails repo
2. `templates/commands/setup.md` — the source template installed into target repos (does not yet exist; setup lives only in `commands/setup.md` for now — see design.md)
3. `.claude/commands/update-product-driven-backlog.md` — the active command in this repo
4. `templates/commands/update-product-driven-backlog.md` — the source template for target repos

Additionally, the `backlog-config.json` schema is extended (documented, not a code file).

## Acceptance Criteria

- `/setup` prompts for a project label when JIRA is selected; label is stored in `.claude/backlog-config.json`
- Every ticket created in JIRA includes the configured project label
- `/update-product-driven-backlog` reads `backlog-config.json` to detect JIRA mode
- Feature ideas are grouped by area before JIRA creation
- A JIRA epic is created per area if none exists with that name
- Each Story is linked to its area's epic via `Epic Link` field or parent relationship
- GitHub Issues mode produces identical output to before this change
- All new JIRA operations are skipped when `BACKLOG_WRITE=false`
