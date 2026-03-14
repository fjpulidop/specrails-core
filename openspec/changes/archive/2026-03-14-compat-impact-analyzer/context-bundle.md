# Context Bundle: Backwards Compatibility Impact Analyzer

This document contains everything a developer needs to implement this change without reading the full codebase. Read this, then read `design.md` for the technical design.

---

## What This Change Does

Adds two things to specrails:

1. A new `/compat-check` slash command that snapshots the API surface of a project and diffs it against a prior snapshot to detect breaking changes. Generates a migration guide when breaking changes are found.

2. An extension to the architect agent prompt that makes compatibility analysis a mandatory phase of every OpenSpec fast-forward workflow.

---

## Relevant Existing Files

### Templates you need to read before writing anything

| File | Why It Matters |
|------|---------------|
| `templates/commands/health-check.md` | **Primary structural reference.** The `/compat-check` command follows the same phase structure, variable naming, and output formatting conventions. Read this first. |
| `templates/commands/refactor-recommender.md` | Secondary reference for flag parsing patterns and `$ARGUMENTS` handling. |
| `templates/agents/architect.md` | The file you will modify. Read in full — understand where Phase 6 gets inserted. |
| `openspec/specs/implement.md` | Reference for the permanent spec format you'll use in Task 6. |

### Files that define the API surface you're analyzing

| File | Surface Category |
|------|-----------------|
| `install.sh` | Installer CLI flags |
| `templates/commands/*.md` | Command names and argument flags |
| `templates/agents/*.md` | Agent names |
| All `templates/**/*.md` | Template placeholders `{{UPPER_SNAKE_CASE}}` |
| `openspec/config.yaml` | Config schema keys |

### Generated files (do not edit directly — these come from templates)

| File | Generated From |
|------|---------------|
| `.claude/commands/health-check.md` | `templates/commands/health-check.md` |
| `.claude/commands/refactor-recommender.md` | `templates/commands/refactor-recommender.md` |
| `.claude/agents/*.md` | `templates/agents/*.md` |

For Task 4, you create `.claude/commands/compat-check.md` manually (placeholder substitution only: `{{PROJECT_NAME}}` → `specrails`).

---

## Codebase Conventions to Follow

### Command template structure

Every command in `templates/commands/` follows this pattern:

```markdown
---
name: "<Display Name>"
description: "<one-line description>"
category: Workflow
tags: [tag1, tag2]
---

<preamble: what the command does, what $ARGUMENTS accepts>

---

## Phase 0: <Phase Name>

<phase content>

---

## Phase 1: <Phase Name>

<phase content>
```

### Variable naming in command prompts

Variables are set with `UPPER_SNAKE_CASE=value` and referenced with `VARIABLE_NAME`. Boolean variables use `true` / `false` strings. Arrays are described as "list of" in prose.

### Placeholder syntax

All template variables use `{{UPPER_SNAKE_CASE}}`. There is exactly one placeholder needed for this command: `{{PROJECT_NAME}}`. Do not introduce new placeholders.

### File naming

- Command templates: `kebab-case.md` (e.g., `compat-check.md`)
- Snapshot files: `<YYYY-MM-DD>-<git-short-sha>.json`

### Architect agent prompt structure

The current section order in `templates/agents/architect.md`:

1. Core Responsibilities
   - 1. Analyze Spec Changes
   - 2. Design Implementation Approach
   - 3. Organize Tasks
   - 4. Respect the Architecture
   - 5. Key Warnings to Always Consider
2. Output Format
3. Decision-Making Framework
4. Communication Style
5. Quality Assurance
6. Update your agent memory

Phase 6 (Compatibility Check) is inserted as a new numbered item **between item 5 (Key Warnings) and the "Output Format" section**. The "Output Format" section is also updated to add the compatibility output as a required section.

---

## Snapshot Storage Pattern

Follow the health-check pattern exactly:

- Directory: `.claude/compat-snapshots/` (created on first run, not committed)
- Filename: `<YYYY-MM-DD>-<git-short-sha>.json`
- JSON format: see `design.md` for full schema
- If git is unavailable: use `<YYYY-MM-DD>-unknown.json`
- Housekeeping: print a notice if count > 30 (same threshold as health-check history)

The `.gitignore` suggestion message format (copy from health-check):
```
Tip: compat snapshots are local artifacts. Add to .gitignore:
  echo '.claude/compat-snapshots/' >> .gitignore
```

---

## The Four Breaking Change Categories (Quick Reference)

| Category | Name | Severity | Example |
|----------|------|----------|---------|
| 1 | Removal | BREAKING (MAJOR) | CLI flag deleted, placeholder removed |
| 2 | Rename | BREAKING (MAJOR) | Flag renamed, command renamed |
| 3 | Signature Change | BREAKING (MINOR-MAJOR) | Arg format changes, output format changes |
| 4 | Behavioral Change | ADVISORY | Default value changes, phase order changes |

---

## What "API Surface" Means Here

specrails is not a library — it has no exported functions. Its contract is the interface between the system and its users. That interface is:

- The CLI flags users pass to `install.sh`
- The `{{PLACEHOLDER}}` keys that get substituted into target repos (users may build tooling around these)
- The slash command names users invoke (e.g., `/health-check`, `/implement`)
- The argument flags those commands accept (users script these or document them in team wikis)
- The agent names (referenced in workflows and prompts)
- The OpenSpec config keys (users write `openspec/config.yaml` files)

---

## Edge Cases to Handle in the Command

| Scenario | Required Behavior |
|----------|------------------|
| No snapshot exists, mode is `diff` | Print advisory; switch to `snapshot` mode automatically |
| `--propose <dir>` and dir doesn't exist | Print `Error: no change found at openspec/changes/<dir>/`. Stop. |
| `--propose <dir>` but no `design.md` in dir | Print warning; proceed with surface extraction only (no projection) |
| Git unavailable | Use `unknown` for sha in filename; proceed |
| `templates/` directory missing | Print error: "templates/ not found — is this a specrails repo?" Stop. |
| `install.sh` missing | Skip installer_flags category; note it as unavailable in the report |
| Count of snapshots > 30 | Print housekeeping notice with prune command |
| `--dry-run` | Run all phases; skip Phase 5 save; print "not saved — dry-run mode" |

---

## Self-Referential Note

specrails uses its own agent workflow to develop itself. This means `/compat-check` will be used to validate future changes to specrails — including future changes to `/compat-check` itself. Design it to be usable on the specrails repo from day one.

When running `/compat-check` against specrails, the surface categories to expect:
- ~2 installer flags (`--root-dir`, any others)
- ~15-30 template placeholders (varies — count them in `templates/`)
- ~6 command names (health-check, refactor-recommender, implement, batch-implement, product-backlog, update-product-driven-backlog, compat-check after this change)
- ~10 agent names (architect, developer, reviewer, product-manager, etc.)
- ~3 config keys in `openspec/config.yaml` (schema, context, rules)

---

## Testing Approach

No automated test framework exists. Manual verification steps:

1. After Task 2: Run `/compat-check --snapshot` on the specrails repo. Confirm it produces a valid JSON file in `.claude/compat-snapshots/`.
2. Introduce a deliberate breaking change (rename a placeholder in one template). Run `/compat-check --diff`. Confirm it detects the rename as Category 2: Rename (BREAKING). Revert.
3. After Task 3: Run `/opsx:ff` on a new small change. Confirm the architect output includes a "Compatibility:" line (even if just "No contract surface changes detected.").
4. Run `/compat-check --propose compat-impact-analyzer`. Confirm it correctly identifies this change as non-breaking (new additions only).
5. Check that `.claude/compat-snapshots/` is listed in `.gitignore`. Run `git status` after a snapshot is generated to confirm the file is not tracked.

---

## Commit Message Guidance

Use conventional commits:

- Task 1 + 6: `feat: add compat-check spec`
- Task 2: `feat: add /compat-check command template`
- Task 3: `feat: extend architect agent with compatibility check phase`
- Task 4: `chore: generate .claude/commands/compat-check.md for specrails`
- Task 5: `chore: gitignore compat-snapshots directory`

Or combine related tasks into a single commit where logical.
