# Design: Backwards Compatibility Impact Analyzer

## Architecture Overview

The feature introduces two artifacts:

1. **`templates/commands/compat-check.md`** — a new slash command (template, with `{{PLACEHOLDER}}` substitution)
2. **Architect agent extension** — a new "Phase 6: Compatibility Check" section appended to `templates/agents/architect.md`

A supporting data file:
3. **`.claude/compat-snapshots/`** — local directory (gitignored) that stores surface snapshots as JSON

No new shell scripts. No new dependencies. Everything runs via Claude's reasoning over file content.

---

## Breaking Change Categories

The analyzer recognizes four categories of breaking change, ordered by severity:

### Category 1: Removal (BREAKING — MAJOR)
A previously-existing contract element no longer exists.

Examples:
- A CLI flag accepted by `install.sh` is removed
- A `{{PLACEHOLDER}}` key is removed from a template
- A slash command is renamed or deleted
- A top-level `openspec/config.yaml` key is removed

**Migration path:** Deprecation notice + removal timeline, or backwards-compatible alias.

### Category 2: Rename (BREAKING — MAJOR)
A contract element exists under a new name but the old name is gone.

Examples:
- `--root-dir` flag renamed to `--target-dir`
- `{{PROJECT_NAME}}` placeholder renamed to `{{REPO_NAME}}`
- `/health-check` command renamed to `/codebase-health`

**Migration path:** Add alias for old name; document rename with one-release grace period.

### Category 3: Signature Change (BREAKING — MINOR or MAJOR)
A contract element still exists but its argument format, output format, or required inputs have changed in an incompatible way.

Examples:
- A command that accepted a single string now requires a flag prefix
- A placeholder that expected a comma-separated list now expects a JSON array
- An agent that was invoked via one method signature now requires different context

**Migration path:** Version the interface; provide migration instructions.

### Category 4: Behavioral Change (ADVISORY)
The element still exists with the same signature, but its behavior changes in a way that callers might depend on.

Examples:
- A command phase order changes (phase 2 now runs before phase 1)
- Default values change (e.g., `--concurrency` default changes from 3 to 5)
- Output format of a report section changes

**Migration path:** Changelog entry; no migration required unless caller parses output.

---

## API Surface Schema

The surface snapshot is stored as JSON at `.claude/compat-snapshots/<YYYY-MM-DD>-<git-short-sha>.json`.

```json
{
  "schema_version": "1",
  "captured_at": "<ISO 8601>",
  "git_sha": "<full sha>",
  "git_branch": "<branch>",
  "surfaces": {
    "installer_flags": [
      { "flag": "--root-dir", "source": "install.sh", "line": 30 }
    ],
    "template_placeholders": [
      { "key": "PROJECT_NAME", "files": ["templates/commands/health-check.md", "..."] }
    ],
    "command_names": [
      { "name": "health-check", "source": "templates/commands/health-check.md", "display_name": "Health Check Dashboard" }
    ],
    "command_arguments": [
      { "command": "health-check", "flags": ["--since", "--only", "--save"], "source": "templates/commands/health-check.md" }
    ],
    "agent_names": [
      { "name": "architect", "source": "templates/agents/architect.md" }
    ],
    "config_keys": [
      { "key": "schema", "source": "openspec/config.yaml" },
      { "key": "context", "source": "openspec/config.yaml" },
      { "key": "rules", "source": "openspec/config.yaml" }
    ]
  }
}
```

---

## Detection Heuristics

The analyzer uses Claude's reasoning (not shell parsing) to extract surface information from file content. This is intentional: the files are Markdown with bash snippets embedded — a simple grep would miss context.

### Installer flags
Read `install.sh`. Find all `case "$1" in` blocks. Extract flag strings (lines matching `--<word>)`). Extract any flag descriptions from adjacent comments.

### Template placeholders
Read all files matching `templates/**/*.md`. Extract all `{{UPPER_SNAKE_CASE}}` patterns. Deduplicate. Record which files each key appears in.

### Command names and flags
For each file in `templates/commands/`:
- Extract `name:` from YAML frontmatter
- Find `$ARGUMENTS` parsing sections; extract flag names (lines matching `--<word>`)

### Agent names
For each file in `templates/agents/`:
- Extract `name:` from YAML frontmatter

### Config schema keys
Read `openspec/config.yaml`. Extract top-level YAML keys.

---

## Diff Algorithm

Given a previous snapshot (baseline) and a current or proposed surface (current):

For each surface category:
1. Build a set of identifiers from baseline and current
2. Compute: `removed = baseline - current`, `added = current - baseline`, `common = baseline ∩ current`
3. For renamed items: if a common item's attributes changed (e.g., display name), classify as rename/signature change
4. Classify each change using the four categories above
5. Assign severity: `BREAKING` (Category 1, 2, 3) or `ADVISORY` (Category 4)

---

## Migration Guide Format

When breaking changes are detected, the analyzer appends a Migration Guide to its output:

```markdown
## Migration Guide

**Change type:** Removal / Rename / Signature Change / Behavioral Change
**Severity:** BREAKING / ADVISORY
**Affects:** <who is affected — users of the CLI / template consumers / command users>

### What Changed
<one paragraph describing the before and after>

### Before
```
<concrete example of old usage>
```

### After
```
<concrete example of new usage>
```

### Remediation Options

**Option A — Backwards-compatible alias (recommended)**
<description of how to add an alias or shim that keeps the old interface working>

**Option B — Clean break with changelog**
<description of what to put in CHANGELOG.md and how to communicate the change>

### Version Strategy
<MAJOR bump if removing/renaming; MINOR bump if signature-only change; PATCH for behavioral advisory>
```

---

## `/compat-check` Command Design

The command runs in five phases:

### Phase 0: Argument Parsing

Parse `$ARGUMENTS`:
- `--diff` — compare current surface to most recent snapshot (default if snapshot exists)
- `--snapshot` — capture current surface and save without diffing
- `--since <date>` — diff against snapshot from this date (ISO format)
- `--propose <change-dir>` — diff proposed changes in `openspec/changes/<change-dir>/` against current surface (reads design.md and tasks.md to understand proposed changes)
- `--dry-run` — print analysis without saving snapshot

Set variables: `MODE` (one of: `snapshot`, `diff`, `propose`), `COMPARE_DATE`, `PROPOSE_DIR`, `DRY_RUN`.

Default behavior when no flags given: if snapshots exist, run `diff`; otherwise run `snapshot`.

### Phase 1: Extract Current Surface

Read the codebase and build the surface snapshot object (per schema above). Print extraction progress for each surface category.

### Phase 2: Load Baseline (diff/propose modes only)

Load the appropriate snapshot from `.claude/compat-snapshots/`. If none exists and mode is `diff`, print advisory and switch to `snapshot` mode.

In `--propose` mode: read `openspec/changes/<change-dir>/design.md` and `tasks.md` to understand what the proposed change intends to modify. Use this as a projected "after" surface for diffing.

### Phase 3: Diff and Classify

Apply the diff algorithm. Classify each change. Count by severity.

### Phase 4: Generate Report

Print the compatibility report:

```
## Compatibility Impact Report — {{PROJECT_NAME}}
Date: <ISO date> | Commit: <git_short_sha>

### Surface Snapshot
| Category | Elements Found |
|----------|---------------|
| Installer flags | N |
| Template placeholders | N |
| Command names | N |
| Command argument flags | N |
| Agent names | N |
| Config keys | N |

### Breaking Changes (N found)
<list, or "None detected.">

### Advisory Changes (N found)
<list, or "None detected.">

### Migration Guide
<included when breaking changes > 0, omitted otherwise>

---
Snapshot saved: .claude/compat-snapshots/<filename>  (or "not saved — dry-run mode")
```

### Phase 5: Save Snapshot

Unless `--dry-run`: write snapshot JSON to `.claude/compat-snapshots/<YYYY-MM-DD>-<git-short-sha>.json`.

Print `.gitignore` suggestion if `.claude/compat-snapshots/` is not already listed.

---

## Architect Agent Extension

A new **Phase 6: Compatibility Check** is appended to the architect agent prompt, between "Task Breakdown" and "Quality Assurance":

```markdown
### 6. Run Compatibility Check

After producing the task breakdown and before finalizing output:

1. **Extract the proposed surface changes** from your implementation design: which commands, agents, placeholders, flags, or config keys are being added, removed, renamed, or modified?

2. **Compare against the current surface** by reading:
   - `install.sh` for CLI flags
   - `templates/commands/*.md` for command names and argument flags
   - `templates/agents/*.md` for agent names
   - `templates/**/*.md` for `{{PLACEHOLDER}}` keys
   - `openspec/config.yaml` for config keys

3. **Classify each change** using the four categories:
   - Category 1: Removal (BREAKING)
   - Category 2: Rename (BREAKING)
   - Category 3: Signature Change (BREAKING or MINOR)
   - Category 4: Behavioral Change (ADVISORY)

4. **Append to your output:**
   - If breaking changes found: a "Compatibility Impact" section listing each breaking change and a Migration Guide
   - If advisory only: a brief "Compatibility Notes" section
   - If no changes to the contract surface: a one-line "Compatibility: No contract surface changes detected."

This phase is mandatory. Do not skip it even if the change appears purely internal.
```

---

## File Layout After Implementation

```
templates/
└── commands/
    └── compat-check.md          # NEW: slash command template

.claude/
├── commands/
│   └── compat-check.md          # NEW: generated (post-/setup)
└── compat-snapshots/            # NEW: local artifact directory (gitignored)
    └── <YYYY-MM-DD>-<sha>.json  # surface snapshots

templates/agents/
└── architect.md                 # MODIFIED: Phase 6 appended

openspec/specs/
└── compat-check.md              # NEW: spec document for the command
```

---

## `.gitignore` Additions

The following should be added to `.gitignore` in target repos (and in specrails itself):

```
.claude/compat-snapshots/
```

The analyzer prints a suggestion to add this if it's missing (same pattern as health-check).

---

## Design Decisions and Rationale

### AI reasoning over shell parsing
The surface extraction uses Claude's judgment rather than `grep` or `sed`. Rationale: the files are Markdown-embedded bash with prose context. A regex-only approach would produce noisy false positives (e.g., `{{PLACEHOLDER}}` in code examples vs. actual template placeholders). Claude can distinguish these.

### Snapshots as JSON, stored locally
Same pattern as health-check's `.claude/health-history/`. Rationale: consistent with existing architecture. Local storage avoids git churn from frequent snapshot updates. Users can choose to commit snapshots if they want baseline tracking in VCS.

### Advisory-only (no blocking)
The analyzer reports findings but does not block the workflow. Rationale: specrails is pre-code phase; imposing hard blocks before the system is mature would create friction. The migration guide gives maintainers actionable information; the decision to block is theirs.

### `--propose` mode for pre-implementation checks
Allows running compatibility analysis on an OpenSpec change *before* it is applied. Rationale: the highest value is catching breaking changes during design, not after implementation. The architect integration covers the in-workflow case; `--propose` covers the manual case.
