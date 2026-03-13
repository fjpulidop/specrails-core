---
change: auto-doc-sync-agent
type: design
---

# Technical Design: Auto-Doc Sync Agent

## Architecture Overview

The doc-sync agent is a Claude Code agent — a Markdown prompt file with YAML frontmatter, identical in structure to `test-writer.md` and `reviewer.md`. No new runtime dependencies are required.

The agent runs as a new **Phase 3d** in the implement pipeline, inserted between Phase 3c (Write Tests) and Phase 4 (Merge & Review).

```
Current pipeline:
  Phase 3c: Test Writer  →  Phase 4: Merge & Review

After this change:
  Phase 3c: Test Writer  →  Phase 3d: Doc Sync  →  Phase 4: Merge & Review
```

The doc-sync agent receives the list of implemented files, detects the project's existing documentation conventions, and generates only the documentation types the project already uses. It never modifies implementation or test files.

---

## Documentation Type Detection

The agent scans the repository for documentation artifacts before generating anything. Detection is performed by reading standard files and directory structures. The agent will only generate a given documentation type if evidence of that type is already present.

### Detection Matrix

| Documentation Type | Detection Signal | Generation Action |
|-------------------|-----------------|-------------------|
| Inline docstrings | Existing docstrings in same-language files (JSDoc `/** */`, Python `"""`, Go `// FuncName ...`, etc.) | Add docstrings to all exported symbols in modified files that currently lack them |
| CHANGELOG.md | File exists at repo root or `docs/CHANGELOG.md` | Prepend a new entry following the existing format |
| README feature list | `## Features`, `## What's New`, or `## Capabilities` section present in README.md | Append new feature entry under the matching section |
| Migration guide | `MIGRATION.md`, `docs/migration/` directory, or `### Breaking Changes` section in CHANGELOG | Generate migration content if any public API, schema, or CLI interface changed |

If none of these signals are detected: the agent outputs `DOC_SYNC_STATUS: SKIPPED` with reason "no existing documentation conventions detected" and stops without writing any files.

### Style Learning Protocol

Before generating any documentation, the agent reads existing documentation to learn style:

1. **Docstring style**: Read up to 3 files of the same language as the modified files. Extract the docstring format (JSDoc vs TSDoc, NumPy vs Google style, plain prose, etc.), parameter annotation style, and return value description format.
2. **Changelog format**: Read the first 40 lines of `CHANGELOG.md` to detect the format. Common formats: Keep a Changelog (`### Added`, `### Changed`, `### Fixed`, `### Breaking Changes`); date-keyed entries; conventional commit groupings (`feat:`, `fix:`).
3. **README structure**: Read the `## Features` section (or equivalent) to detect entry format: bullet points, sub-headings, badge rows, code snippets, etc.
4. **Migration guide format**: Read the most recent migration entry to detect structure (numbered steps, before/after code blocks, explicit version ranges, etc.).

The agent applies the detected style exactly. It never introduces a new style.

---

## Agent Prompt Structure

### File: `templates/agents/doc-sync.md`

YAML frontmatter:

```yaml
---
name: doc-sync
description: "..."
model: sonnet
color: yellow
memory: project
---
```

**Color assignment: `yellow`**

Existing color assignments at time of this change:
- `green` — architect
- `purple` — developer, backend-developer
- `red` — reviewer
- `orange` — security-reviewer
- `cyan` — test-writer, product-analyst
- `blue` — product-manager, frontend-developer

`yellow` is unassigned and visually unambiguous in terminal output. It also has conventional association with documentation (yellow highlighting, sticky notes). Do not change this to a color already in use.

### Placeholders

| Placeholder | Description | Resolved to (specrails) |
|-------------|-------------|-------------------------|
| `{{TECH_EXPERTISE}}` | Documentation formats relevant to the target stack | specrails' own language and tooling list |
| `{{LAYER_CLAUDE_MD_PATHS}}` | Layer-specific CLAUDE.md paths | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | Agent memory directory | `.claude/agent-memory/doc-sync/` |

`IMPLEMENTED_FILES_LIST` and `TASK_DESCRIPTION` appear in the prompt body as runtime-injected instructional references — they are NOT static `{{...}}` substitution targets.

### Prompt Sections (ordered)

1. **Identity**: "You are a documentation specialist. Your only job is to generate and update documentation — you never modify implementation or test files."
2. **Mission**: Extend the project's existing documentation to cover newly implemented code, strictly within the project's current documentation conventions.
3. **What you receive**: `IMPLEMENTED_FILES_LIST`, `TASK_DESCRIPTION`, layer CLAUDE.md paths (`{{LAYER_CLAUDE_MD_PATHS}}`).
4. **Documentation detection protocol**: Detection matrix above — what to look for and where.
5. **Style learning protocol**: How to read existing docs before generating anything.
6. **Generation mandate**: Per detected type — what to generate and how.
7. **Generation rules**: Never modify implementation files; never invent a new documentation convention; only touch files from `IMPLEMENTED_FILES_LIST` when adding docstrings; use `TASK_DESCRIPTION` for changelog and README entry prose.
8. **Breaking change detection**: How to identify breaking changes and when to trigger migration guide or `### Breaking Changes` entry generation.
9. **Output format**: Status line, list of files written/modified, summary per documentation type.
10. **Memory protocol**: Using `{{MEMORY_PATH}}`.

---

## Breaking Change Detection

The agent examines each file in `IMPLEMENTED_FILES_LIST` for signals that a public interface changed:

- **Function/method signature change**: Parameter added, removed, renamed, or type-changed in an exported function.
- **Removed export**: A symbol that previously existed in the file is no longer exported.
- **Schema modification**: A database schema, GraphQL type, or OpenAPI spec changed in a way that removes or renames a field.
- **CLI interface change**: A command, flag, or subcommand was removed or renamed.

If any breaking change signal is detected AND a migration guide convention exists in the repo: generate a migration guide section. If no migration guide convention exists: add a `### Breaking Changes` subsection to the changelog entry instead.

This detection is best-effort. The agent reads the current state of files in `IMPLEMENTED_FILES_LIST` and infers change type from the task description and the code. It is not expected to perform full static analysis or read git history.

---

## Pipeline Integration

### Phase 3d: Doc Sync

The new phase is inserted in `templates/commands/implement.md` after Phase 3c (Write Tests) and before Phase 4 (Merge & Review).

#### Positioning

```
## Phase 3c: Write Tests
[...existing content unchanged...]

## Phase 3d: Doc Sync     ← NEW

## Phase 4: Merge & Review
[...existing content unchanged...]
```

The exact insertion point in `templates/commands/implement.md` is immediately after the Phase 3c failure handling block (after the line "- Include in the reviewer agent prompt: 'Note: the test-writer failed for this feature. Check for coverage gaps.'") and before the `## Phase 4: Merge & Review` heading.

#### Phase 3d Behavior

**Single-feature mode (`SINGLE_MODE=true`):**
- After the test-writer agent completes in Phase 3c, launch a single `doc-sync` agent in the foreground (`run_in_background: false`).
- Pass to the agent:
  - `IMPLEMENTED_FILES_LIST`: the list of files the developer created or modified
  - `TASK_DESCRIPTION`: the original task description / feature spec
- Wait for the doc-sync agent to complete before proceeding to Phase 4.

**Multi-feature mode (worktrees):**
- After all test-writer agents complete (Phase 3c), launch one `doc-sync` agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`).
- Each agent receives the `IMPLEMENTED_FILES_LIST` for its own feature only.
- Wait for all doc-sync agents to complete before proceeding to Phase 4.

**Dry-run mode (`DRY_RUN=true`):**
Apply the same dry-run redirect as other agents:

> IMPORTANT: This is a dry-run. Write all new or modified documentation files under `.claude/.dry-run/<feature-name>/`. Mirror the real destination path within this directory. After writing each file, append an entry to `.claude/.dry-run/<feature-name>/.cache-manifest.json` using: `{"cached_path": "...", "real_path": "...", "operation": "create|modify"}`.

**If doc-sync fails or times out:**
- Log the failure in the Phase 4e report under the `Docs` column as `FAILED`.
- Do NOT block Phase 4 (merge and review). Proceed without doc updates.
- Include in the reviewer agent prompt: "Note: the doc-sync agent failed for this feature. Documentation may be incomplete."

#### Report Table Update

The Phase 4e report table gains a `Docs` column positioned between `Tests` and `Reviewer`, reflecting execution order:

**Before:**
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

**After:**
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Security | CI | Status |
```

`Docs` column values:
- `ok` — one or more documentation files written or updated
- `SKIPPED` — no documentation conventions detected, agent exited cleanly
- `FAILED` — agent failed or timed out

---

## File Changes Summary

### New Files

| File | Description |
|------|-------------|
| `templates/agents/doc-sync.md` | Canonical doc-sync agent template with `{{PLACEHOLDER}}` syntax |
| `.claude/agents/doc-sync.md` | Generated specrails instance with placeholders resolved |
| `.claude/agent-memory/doc-sync/MEMORY.md` | Initial empty memory file |

### Modified Files

| File | Change |
|------|--------|
| `templates/commands/implement.md` | Insert Phase 3d after Phase 3c; add `Docs` column to Phase 4e table |
| `.claude/commands/implement.md` | Same changes applied to generated copy |

---

## Design Decisions and Rationale

### Detection-first, never prescriptive

The agent must detect before it generates. Imposing documentation conventions on a project that has none creates noise and merge conflicts. If a project does not have a CHANGELOG, the doc-sync agent should not create one — that is a product decision, not a pipeline decision. The agent's value is in reducing the maintenance cost of documentation systems that already exist, not in bootstrapping new ones.

### Non-blocking on failure

Documentation failures should never block a ship. If the agent detects nothing, it exits cleanly with `SKIPPED`. If it encounters a runtime error, the pipeline continues and the reviewer notes the gap. The implementation is correct and tested; missing docs are a trailing concern.

### One agent per feature in multi-feature mode

Each doc-sync agent is scoped to its own worktree and its own feature's files, mirroring the test-writer pattern exactly. A single agent over all features would require reasoning about inter-feature documentation interactions before the merge step — premature and error-prone.

### Agent does not read git history

The agent reads files from `IMPLEMENTED_FILES_LIST` as they currently exist in the worktree. It infers what changed from the task description and the current code state. It does not need `git diff` or `git log`. This keeps the agent simpler and avoids dependency on git availability in the worktree context.

### Phase 3d position: after test-writer, before reviewer

Documentation should be generated after implementation is finalized (post-developer) and after test files are in place (post-test-writer, so the agent can observe whether tests exist alongside the code). The reviewer needs documentation in place to verify completeness. Placing doc-sync before the reviewer satisfies all three constraints.

### CHANGELOG conflict in multi-feature merges

CHANGELOG.md is a shared file in almost every multi-feature scenario. It will appear in the Phase 4a shared file registry as `medium` or `high` risk depending on whether both features add entries at the same position. The existing merge algorithm (Phase 4a Strategy A, section-aware merge) handles this: both entries will appear in the merged file, with conflict markers only if entries land in the exact same section. This is an existing mechanism — no special handling is required in the doc-sync agent or this change.

### `yellow` color

All semantically natural colors are already assigned. Yellow is unambiguous in terminal contexts, conventionally associated with documentation work, and not used by any existing agent.

---

## Edge Cases

- **No existing docs at all**: Agent detects no documentation signals, outputs `DOC_SYNC_STATUS: SKIPPED`. No files are written. Reviewer notes this in the report.
- **CHANGELOG.md exists but format is unrecognized**: Agent reads first 40 lines, cannot determine format, outputs `DOC_SYNC_STATUS: PARTIAL` with note "CHANGELOG format not recognized — skipped changelog entry", and continues with other doc types (README, docstrings).
- **Docstrings partially present**: Some exported functions have docstrings, others don't. Agent adds docstrings only to the undocumented ones in files within `IMPLEMENTED_FILES_LIST`. It does not modify existing docstrings.
- **README has no `## Features` section**: Agent does not add one. It only appends to sections that already exist.
- **Breaking change with no migration convention**: Agent adds `### Breaking Changes` to the changelog entry instead of creating a new `MIGRATION.md` file.
- **Dry-run + doc-sync**: Documentation files land in the dry-run cache alongside developer and test files. The `.cache-manifest.json` receives entries for doc files with `"operation": "create"` or `"modify"` as appropriate.
- **specrails repo self-reference**: When doc-sync runs against specrails itself, it will detect `CHANGELOG.md` (if one exists), look for docstrings in shell scripts (none conventionally), and potentially update the README. This is expected behavior — no special casing needed.
