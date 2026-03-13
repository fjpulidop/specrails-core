---
name: openspec_artifact_conventions
description: Conventions for OpenSpec change artifacts — frontmatter schemas, cross-file consistency rules, and patterns discovered across multiple change sets
type: project
---

# OpenSpec Artifact Conventions

## Frontmatter Schema (all 5 artifact types)

Each artifact has a YAML frontmatter block:

```yaml
---
change: <kebab-case-change-name>      # same across all 5 files
type: feature | design | delta-spec | tasks | context-bundle
status: proposed                      # proposal.md only
github_issue: <number>               # proposal.md only
vpc_fit: <percent>%                  # proposal.md only
---
```

## The 5 Required Artifacts

| File | Type value | Purpose |
|------|-----------|---------|
| `proposal.md` | `feature` | Problem, solution, scope, acceptance criteria, motivation |
| `design.md` | `design` | Technical architecture, file changes, design decisions, edge cases |
| `delta-spec.md` | `delta-spec` | Spec-level statements ("SHALL", "MUST") — what the system does after the change |
| `tasks.md` | `tasks` | Ordered atomic tasks with layer tags, files, acceptance criteria, dependencies |
| `context-bundle.md` | `context-bundle` | Self-contained developer briefing — no other file needed |

## Cross-file Consistency Rules

1. **Report table**: The Phase 4e report table in `templates/commands/implement.md` is the single source of truth for pipeline status columns. When designing a new phase, verify the current table column order before specifying "before/after" — columns may have been added by prior changes.

2. **Agent colors**: Maintain a registry of assigned colors to avoid collision:
   - `green` — architect
   - `purple` — developer (and layer variants)
   - `red` — reviewer
   - `orange` — security-reviewer
   - `cyan` — test-writer (assigned 2026-03-13)

3. **Placeholder naming**: Use `{{UPPER_SNAKE_CASE}}` only for static substitutions by install.sh. Runtime-injected values (like `IMPLEMENTED_FILES_LIST`) appear in the prompt body as plain text references, never as `{{...}}`.

4. **Always-on vs. flagged agents**: The pattern is always-on with graceful degradation (SKIPPED status) rather than opt-out flags. See security-reviewer and test-writer as examples.

5. **Non-blocking failure pattern**: New agents should be non-blocking by default. If an agent fails, the pipeline logs FAILED in the report column and continues. Only security Critical findings block Phase 4c.

## Additive Provider/Mode Pattern

When a feature adds a new provider or mode alongside an existing one (e.g., adding JIRA to GitHub Issues in the backlog pipeline), the pattern is:
- Both branches remain as full prose in the generated command (no template erasure)
- Runtime config selects which branch executes
- New section header mirrors the existing one's style (e.g., `### If provider=github` alongside `### If provider=jira`)
- This is the same pattern as `GIT_AUTO=true/false` in Phase 4c of `implement.md`

## Context Bundle Conventions

- Opens with "What You Are Building" (concise summary)
- "Files to Change" table: path, change type, notes; includes "Do NOT modify" list
- "Current State" section describes relevant file sections exactly as they exist NOW
- "Exact Changes" section: verbatim prose to insert with precise location anchors ("after X block, before Y block")
- Closes with: Existing Patterns to Follow, relevant API/tool reference, Conventions Checklist, Risks table

## Phase Numbering in implement.md

Current phase map as of 2026-03-13:
- Phase -1: Environment Setup
- Phase 0: Parse input and determine mode
- Phase 1: Explore (parallel)
- Phase 2: Select
- Phase 3a: Architect
- Phase 3b: Implement (developer)
- Phase 3c: Write Tests (test-writer) — added by automated-test-writer change
- Phase 4: Merge & Review
  - 4a: Merge worktrees
  - 4b: Reviewer
  - 4b-sec: Security Reviewer
  - 4c: Ship
  - 4d: Monitor CI
  - 4e: Report

**Why:** Always check the current implement.md before assigning a new phase number — phases have been inserted between existing ones (3b → 3c) and between sub-phases (4b → 4b-sec).
