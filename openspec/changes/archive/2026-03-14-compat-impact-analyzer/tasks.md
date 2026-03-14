# Tasks: Backwards Compatibility Impact Analyzer

Tasks are ordered by dependency. Complete them sequentially. Each task is tagged with its layer.

---

## Task 1: Create the spec document [core]

**Title:** Write `openspec/specs/compat-check.md`

**Description:**
Create the normative spec for the `/compat-check` command. This is the source of truth that the command template and architect extension will implement. Write it before any templates so the implementation has a clear contract to follow.

The spec must cover:
- All five phases of the command (argument parsing, surface extraction, baseline loading, diff/classify, report + save)
- The surface snapshot JSON schema (exact field names and types)
- The four breaking change categories with definitions and migration path strategies
- The migration guide Markdown format (exact heading structure)
- All flags with types, defaults, and behavior descriptions
- The `--propose` mode behavior when reading `openspec/changes/<dir>/design.md`
- Edge cases: no prior snapshot exists; git unavailable; `openspec/changes/` dir not found in `--propose` mode

**Files:**
- `openspec/specs/compat-check.md` (CREATE)

**Acceptance criteria:**
- Every flag documented in the design is specified with type and default
- The JSON snapshot schema is complete and matches `design.md`
- The four breaking change categories are defined with at least one concrete example each
- The migration guide format is specified as a normative template
- Edge cases are called out explicitly

**Dependencies:** None

---

## Task 2: Create the `/compat-check` command template [templates]

**Title:** Write `templates/commands/compat-check.md`

**Description:**
Create the slash command template implementing the five-phase design. This is a Markdown file with YAML frontmatter and `{{PLACEHOLDER}}` substitution syntax, following the same conventions as `templates/commands/health-check.md`.

The command must be self-contained: it reads the filesystem directly using Claude's file-reading capabilities and does not invoke external tools beyond `git rev-parse` for the commit SHA.

**Phase structure to implement:**

**Phase 0 — Argument Parsing**
Parse all flags (`--diff`, `--snapshot`, `--since <date>`, `--propose <change-dir>`, `--dry-run`). Set `MODE`, `COMPARE_DATE`, `PROPOSE_DIR`, `DRY_RUN`. Apply the default-mode logic (diff if snapshots exist, snapshot otherwise).

**Phase 1 — Extract Current Surface**
Read and analyze:
- `install.sh` — extract `--flag-name)` patterns from `case` blocks
- `templates/commands/*.md` — extract `name:` from frontmatter, extract `--flag` patterns from `$ARGUMENTS` sections
- `templates/agents/*.md` — extract `name:` from frontmatter
- All `templates/**/*.md` — extract `{{UPPER_SNAKE_CASE}}` patterns, deduplicated, with source file list
- `openspec/config.yaml` — extract top-level YAML keys

Print one progress line per category as extraction completes.

**Phase 2 — Load Baseline**
Check `.claude/compat-snapshots/` for snapshot files. Select by `COMPARE_DATE` or most-recent. In `--propose` mode, additionally read `openspec/changes/<PROPOSE_DIR>/design.md` and `tasks.md` to understand projected changes.

**Phase 3 — Diff and Classify**
Apply the diff algorithm for each surface category. Classify each change into Category 1–4. Produce `BREAKING_CHANGES` list and `ADVISORY_CHANGES` list.

**Phase 4 — Generate Report**
Print the full compatibility report (see design.md for exact format). Include migration guide when `len(BREAKING_CHANGES) > 0`.

**Phase 5 — Save Snapshot**
Unless `DRY_RUN=true`: serialize current surface to JSON and write to `.claude/compat-snapshots/<YYYY-MM-DD>-<git-short-sha>.json`. Print `.gitignore` suggestion if missing.

**Frontmatter:**
```yaml
---
name: "Compatibility Impact Analyzer"
description: "Snapshot the current API surface and detect breaking changes against a prior baseline. Generates a migration guide when breaking changes are found."
category: Workflow
tags: [workflow, compatibility, breaking-changes, migration]
---
```

**Files:**
- `templates/commands/compat-check.md` (CREATE)

**Acceptance criteria:**
- All five phases present and correctly ordered
- Only `{{PROJECT_NAME}}` is used as a placeholder (no new placeholders)
- Frontmatter is valid YAML with required fields: `name`, `description`, `category`, `tags`
- Phase 0 handles all six flags (including `--dry-run`)
- Phase 1 extracts all six surface categories listed in design.md
- The `.gitignore` suggestion is printed when `.claude/compat-snapshots/` is not listed
- The command prints meaningful output even on first run (no snapshot exists)

**Dependencies:** Task 1

---

## Task 3: Extend the architect agent with Phase 6 [templates]

**Title:** Add compatibility check phase to `templates/agents/architect.md`

**Description:**
Append a new "Phase 6: Compatibility Check" responsibility to the architect agent prompt. This must be inserted between the existing task breakdown guidance (Phase 5: Key Warnings) and the "Output Format" section.

The extension defines:
1. How the architect extracts proposed surface changes from its own implementation design
2. Which files to read to understand the current surface (exact list: install.sh, templates/commands/, templates/agents/, templates/**/*.md for placeholders, openspec/config.yaml)
3. The four-category classification system (reproduced concisely)
4. The three conditional output variants:
   - Breaking changes found → "Compatibility Impact" section + Migration Guide
   - Advisory only → "Compatibility Notes" section
   - No contract changes → one-line acknowledgement

The instruction must include: "This phase is mandatory. Do not skip it even if the change appears purely internal."

Also update the "Output Format" section to add `## Compatibility Impact` (or `## Compatibility Notes`) as a required output section after "Task Breakdown".

**Files:**
- `templates/agents/architect.md` (MODIFY)

**Acceptance criteria:**
- New phase is inserted at the correct location (after warnings, before output format)
- Output Format section is updated to include the compatibility section
- The four categories are clearly defined with one example each
- The three output variants are described (breaking / advisory / none)
- The mandatory instruction is present verbatim
- Existing sections are not modified — only new content is added
- The template still renders correctly: no broken placeholder references introduced

**Dependencies:** Task 1

---

## Task 4: Create the generated command in `.claude/commands/` [templates]

**Title:** Generate `.claude/commands/compat-check.md` for specrails self-use

**Description:**
Since specrails uses its own system, the generated `.claude/commands/compat-check.md` needs to be created for the specrails repo itself. The `/setup` command would normally do this, but since this is a manual addition to the specrails source repo, the developer must create it directly by copying the template and substituting `{{PROJECT_NAME}}` with `specrails`.

This is the same pattern used for all other existing commands in `.claude/commands/`.

**Files:**
- `.claude/commands/compat-check.md` (CREATE)

**Acceptance criteria:**
- File is an exact copy of `templates/commands/compat-check.md` with `{{PROJECT_NAME}}` replaced by `specrails`
- No other placeholder substitutions are needed
- File is syntactically identical to the template (same heading levels, same phase structure)

**Dependencies:** Task 2

---

## Task 5: Add `.claude/compat-snapshots/` to `.gitignore` [core]

**Title:** Gitignore the snapshot directory in specrails

**Description:**
Add `.claude/compat-snapshots/` to specrails' own `.gitignore` file so that snapshot files produced when running `/compat-check` against the specrails repo are not accidentally committed.

Also check whether `.claude/health-history/` is present in `.gitignore` (the health-check command produces a similar artifact); if missing, add it at the same time to avoid a future gap.

**Files:**
- `.gitignore` (MODIFY)

**Acceptance criteria:**
- `.claude/compat-snapshots/` appears in `.gitignore`
- `.claude/.dry-run/` appears in `.gitignore` (already present from implement command — verify and leave untouched if present)
- No other changes to `.gitignore`

**Dependencies:** None (independent of all other tasks)

---

## Task 6: Write the new spec to `openspec/specs/compat-check.md` [core]

**Title:** Publish the compat-check spec as a permanent spec

**Description:**
This is distinct from Task 1 (which creates the spec as part of the change directory). Once the implementation is complete and verified, the spec is promoted from `openspec/changes/compat-impact-analyzer/` into `openspec/specs/compat-check.md` as a permanent, versioned spec.

The spec in `openspec/specs/` becomes the source of truth for future changes to the command. Write it in the same style as `openspec/specs/implement.md` — organized by flags, behavior matrix, variable reference, and edge cases.

**Files:**
- `openspec/specs/compat-check.md` (CREATE)

**Acceptance criteria:**
- Flags section covers all six flags with types, defaults, and behavior
- Behavior matrix table present (mode × flags × output)
- Variable reference table lists all variables set during Phase 0
- Edge cases section covers: no snapshot exists; git unavailable; `--propose` dir not found; empty surface category
- Snapshot JSON schema is documented in full

**Dependencies:** Tasks 1, 2 (implementation complete before spec is finalized)

---

## Task Summary

| # | Title | Layer | Files | Depends On |
|---|-------|-------|-------|------------|
| 1 | Write initial spec | [core] | `openspec/specs/compat-check.md` (draft) | — |
| 2 | Create command template | [templates] | `templates/commands/compat-check.md` | 1 |
| 3 | Extend architect agent | [templates] | `templates/agents/architect.md` | 1 |
| 4 | Generate self-use command | [templates] | `.claude/commands/compat-check.md` | 2 |
| 5 | Gitignore snapshots dir | [core] | `.gitignore` | — |
| 6 | Promote spec to permanent | [core] | `openspec/specs/compat-check.md` | 1, 2 |
