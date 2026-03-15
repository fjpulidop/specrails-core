# Spec: /sr:compat-check Command

The `/sr:compat-check` command snapshots the API surface of a specrails project and diffs it against a prior snapshot to detect breaking changes. Generates a migration guide when breaking changes are found.

---

## Flags

### `--diff`

Compare the current API surface to the most recent snapshot. Default mode when at least one snapshot exists.

| Attribute | Value |
|-----------|-------|
| Type | boolean flag (no argument) |
| Default | active when snapshots exist in `.claude/compat-snapshots/` |
| Effect | Sets `MODE=diff` |

### `--snapshot`

Capture the current API surface and save it as a new baseline without performing a diff.

| Attribute | Value |
|-----------|-------|
| Type | boolean flag (no argument) |
| Default | active when no snapshots exist |
| Effect | Sets `MODE=snapshot` |

### `--since <date>`

Diff against the snapshot from the specified date rather than the most recent one.

| Attribute | Value |
|-----------|-------|
| Type | string (ISO date: YYYY-MM-DD) |
| Default | `""` (use most recent snapshot) |
| Effect | Sets `COMPARE_DATE=<date>` |
| Requires | `--diff` mode (implied if not set) |

### `--propose <change-dir>`

Diff proposed changes described in `openspec/changes/<change-dir>/` against the current surface. Reads `design.md` and `tasks.md` to understand the projected "after" state.

| Attribute | Value |
|-----------|-------|
| Type | string (directory name under `openspec/changes/`) |
| Default | none |
| Effect | Sets `MODE=propose`, `PROPOSE_DIR=<change-dir>` |

### `--dry-run`

Run all phases but skip Phase 5 (snapshot save). Output is printed but not persisted.

| Attribute | Value |
|-----------|-------|
| Type | boolean flag (no argument) |
| Default | false |
| Effect | Sets `DRY_RUN=true` |

---

## Variables Set During Phase 0

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MODE` | string | `"diff"` if snapshots exist, `"snapshot"` otherwise | Active operating mode |
| `COMPARE_DATE` | string | `""` | ISO date of snapshot to use as baseline |
| `PROPOSE_DIR` | string | `""` | Name of the change directory to analyze |
| `DRY_RUN` | boolean | `false` | Whether to skip saving the snapshot |

---

## Behavior Matrix

| Mode | `--since` | `--dry-run` | Baseline loaded | Snapshot saved | Report generated |
|------|-----------|-------------|-----------------|----------------|-----------------|
| `snapshot` | ignored | false | No | Yes | Surface only |
| `snapshot` | ignored | true | No | No | Surface only + "not saved" note |
| `diff` | `""` | false | Most recent | Yes | Full diff |
| `diff` | `<date>` | false | Nearest to date | Yes | Full diff |
| `diff` | any | true | Most recent / by date | No | Full diff + "not saved" note |
| `propose` | ignored | false | Current surface | Yes | Projected diff |
| `propose` | ignored | true | Current surface | No | Projected diff + "not saved" note |

---

## Surface Snapshot JSON Schema

Snapshots are stored at `.claude/compat-snapshots/<YYYY-MM-DD>-<git-short-sha>.json`.

```json
{
  "schema_version": "1",
  "captured_at": "<ISO 8601 datetime>",
  "git_sha": "<full sha or 'unknown'>",
  "git_branch": "<branch name or 'unknown'>",
  "surfaces": {
    "installer_flags": [
      { "flag": "--root-dir", "source": "install.sh", "line": 30 }
    ],
    "template_placeholders": [
      { "key": "PROJECT_NAME", "files": ["templates/commands/health-check.md"] }
    ],
    "command_names": [
      { "name": "health-check", "source": "templates/commands/health-check.md", "display_name": "Health Check Dashboard" }
    ],
    "command_arguments": [
      { "command": "health-check", "flags": ["--since", "--only", "--save"], "source": "templates/commands/health-check.md" }
    ],
    "agent_names": [
      { "name": "sr-architect", "source": "templates/agents/sr-architect.md" }
    ],
    "config_keys": [
      { "key": "schema", "source": "openspec/config.yaml" }
    ]
  }
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Always `"1"` in this version |
| `captured_at` | string | ISO 8601 datetime of capture |
| `git_sha` | string | Full git SHA, or `"unknown"` if git unavailable |
| `git_branch` | string | Current branch name, or `"unknown"` if git unavailable |
| `surfaces.installer_flags` | array | Flags extracted from `install.sh` case blocks |
| `surfaces.installer_flags[].flag` | string | Flag string (e.g., `"--root-dir"`) |
| `surfaces.installer_flags[].source` | string | Always `"install.sh"` |
| `surfaces.installer_flags[].line` | integer | Line number in source file |
| `surfaces.template_placeholders` | array | Deduplicated `{{KEY}}` patterns from all templates |
| `surfaces.template_placeholders[].key` | string | Placeholder key without braces (e.g., `"PROJECT_NAME"`) |
| `surfaces.template_placeholders[].files` | array of strings | All template files containing this key |
| `surfaces.command_names` | array | Command names from frontmatter of `templates/commands/*.md` |
| `surfaces.command_names[].name` | string | Kebab-case command name |
| `surfaces.command_names[].source` | string | Source file path |
| `surfaces.command_names[].display_name` | string | Human-readable name from frontmatter `name:` field |
| `surfaces.command_arguments` | array | Per-command flag lists |
| `surfaces.command_arguments[].command` | string | Command name (matches `command_names[].name`) |
| `surfaces.command_arguments[].flags` | array of strings | All `--flag` names accepted by this command |
| `surfaces.command_arguments[].source` | string | Source file path |
| `surfaces.agent_names` | array | Agent names from frontmatter of `templates/agents/*.md` |
| `surfaces.agent_names[].name` | string | Agent name |
| `surfaces.agent_names[].source` | string | Source file path |
| `surfaces.config_keys` | array | Top-level keys from `openspec/config.yaml` |
| `surfaces.config_keys[].key` | string | Key name |
| `surfaces.config_keys[].source` | string | Always `"openspec/config.yaml"` |

---

## Breaking Change Categories

### Category 1: Removal (BREAKING — MAJOR)

A previously-existing contract element no longer exists.

**Definition:** An element present in the baseline snapshot is absent from the current surface with no replacement under the same name.

**Examples:**
- CLI flag `--root-dir` removed from `install.sh` — users who call the installer with this flag will get an error
- `{{PROJECT_NAME}}` placeholder removed from templates — downstream tooling that depends on this substitution breaks
- `/health-check` command deleted — team wikis and scripts referencing this command break

**Migration path:** Deprecation notice + removal timeline, or backwards-compatible alias.

### Category 2: Rename (BREAKING — MAJOR)

A contract element exists under a new name but the old name is gone.

**Definition:** An element disappears from the baseline and a new element appears in the current surface that performs the same function under a different name.

**Examples:**
- `--root-dir` flag renamed to `--target-dir` — all existing install scripts must be updated
- `{{PROJECT_NAME}}` renamed to `{{REPO_NAME}}` — all template consumers break
- `/health-check` renamed to `/codebase-health` — all invocations and documentation must change

**Migration path:** Add alias for old name; document rename with one-release grace period.

### Category 3: Signature Change (BREAKING — MINOR or MAJOR)

A contract element still exists but its argument format, output format, or required inputs have changed in an incompatible way.

**Definition:** The element is present in both baseline and current, but its inputs or outputs differ in a way that breaks existing callers.

**Examples:**
- A command that accepted a bare string now requires a `--flag` prefix
- A placeholder that expected a comma-separated list now expects JSON
- An agent now requires additional mandatory context that wasn't needed before

**Migration path:** Version the interface; provide migration instructions.

### Category 4: Behavioral Change (ADVISORY)

The element still exists with the same signature, but its behavior changes in a way that callers might depend on.

**Definition:** Name and signature are unchanged but semantics, defaults, output format, or phase ordering differ.

**Examples:**
- A command phase order changes (phase 2 now runs before phase 1)
- `--concurrency` default changes from 3 to 5
- Output report section format changes (callers parsing the output may break)

**Migration path:** Changelog entry; no migration required unless caller parses output.

---

## Migration Guide Format

When breaking changes are detected, the analyzer appends one Migration Guide block per breaking change:

```markdown
## Migration Guide

**Change type:** Removal | Rename | Signature Change | Behavioral Change
**Severity:** BREAKING | ADVISORY
**Affects:** <who is affected>

### What Changed
<one paragraph describing before and after>

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
<description of alias/shim approach>

**Option B — Clean break with changelog**
<what to put in CHANGELOG.md and how to communicate>

### Version Strategy
<MAJOR bump if removing/renaming; MINOR bump if signature-only change; PATCH for behavioral advisory>
```

---

## Phase Descriptions

### Phase 0: Argument Parsing

Parse `$ARGUMENTS` for all flags. Set `MODE`, `COMPARE_DATE`, `PROPOSE_DIR`, `DRY_RUN`. Apply default-mode logic: if snapshots exist in `.claude/compat-snapshots/`, default to `diff`; otherwise default to `snapshot`.

### Phase 1: Extract Current Surface

Read the codebase and build a surface snapshot object per the schema above. Surface categories to extract:

1. **installer_flags** — read `install.sh`, find `case "$1" in` blocks, extract `--flag)` patterns
2. **template_placeholders** — read all `templates/**/*.md`, extract `{{UPPER_SNAKE_CASE}}` patterns, deduplicate, record source files
3. **command_names** — read `templates/commands/*.md`, extract `name:` from YAML frontmatter
4. **command_arguments** — read `templates/commands/*.md`, extract `--flag` patterns from `$ARGUMENTS` sections
5. **agent_names** — read `templates/agents/*.md`, extract `name:` from YAML frontmatter
6. **config_keys** — read `openspec/config.yaml`, extract top-level keys

Print one progress line per category as extraction completes.

### Phase 2: Load Baseline (diff/propose modes)

Check `.claude/compat-snapshots/` for existing snapshot files. Select by `COMPARE_DATE` (nearest without exceeding) or most-recent. In `propose` mode, additionally read `openspec/changes/<PROPOSE_DIR>/design.md` and `tasks.md` to understand projected changes.

### Phase 3: Diff and Classify

For each surface category, compute: `removed = baseline - current`, `added = current - baseline`. Classify each change into Category 1–4. Produce `BREAKING_CHANGES` and `ADVISORY_CHANGES` lists.

### Phase 4: Generate Report

Print the compatibility report including the Migration Guide when `len(BREAKING_CHANGES) > 0`.

### Phase 5: Save Snapshot

Unless `DRY_RUN=true`: serialize the current surface to JSON and write to `.claude/compat-snapshots/<YYYY-MM-DD>-<git-short-sha>.json`. Print `.gitignore` suggestion if the directory is not listed.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No snapshot exists, mode is `diff` | Print advisory; automatically switch to `snapshot` mode |
| `--propose <dir>` and dir doesn't exist | Print `Error: no change found at openspec/changes/<dir>/`. Stop. |
| `--propose <dir>` but no `design.md` in dir | Print warning; proceed with surface extraction only (no projection) |
| Git unavailable | Use `"unknown"` for sha in filename; proceed normally |
| `templates/` directory missing | Print `Error: templates/ not found — is this a specrails repo?`. Stop. |
| `install.sh` missing | Skip `installer_flags` category; note as unavailable in report |
| Snapshot count > 30 | Print housekeeping notice with prune command |
| `--dry-run` | Run all phases; skip Phase 5 save; print "not saved — dry-run mode" |
| Empty surface category | Include category in snapshot with empty array; note in report |

---

## Snapshot Storage

- **Directory:** `.claude/compat-snapshots/` (created on first run, not committed to git)
- **Filename:** `<YYYY-MM-DD>-<git-short-sha>.json`
- **Git unavailable:** Use `<YYYY-MM-DD>-unknown.json`
- **Housekeeping threshold:** Print notice when count exceeds 30 (same as health-check)
- **gitignore entry:** `.claude/compat-snapshots/`

---

### Requirement: Command namespace
The `/compat-check` command SHALL be invoked as `/sr:compat-check`. The command file SHALL be located at `.claude/commands/sr/compat-check.md`.

#### Scenario: Command invocation
- **WHEN** user types `/sr:compat-check`
- **THEN** the compatibility check runs identically to the former `/compat-check`

### Requirement: Agent name surface extraction
The surface extraction for `agent_names` SHALL read from `templates/agents/sr-*.md` and extract `sr-` prefixed names from frontmatter.

#### Scenario: Agent names in snapshot
- **WHEN** Phase 1 extracts agent names
- **THEN** the snapshot contains entries like `{ "name": "sr-architect", "source": "templates/agents/sr-architect.md" }`

### Requirement: Command name surface extraction
The surface extraction for `command_names` SHALL read from `templates/commands/sr/*.md` and extract command names.

#### Scenario: Command names in snapshot
- **WHEN** Phase 1 extracts command names
- **THEN** the snapshot contains entries like `{ "name": "sr:implement", "source": "templates/commands/sr/implement.md" }`
