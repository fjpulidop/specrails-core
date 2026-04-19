---
name: "OpenSpec Change Diff Visualizer"
description: "Show a before/after diff of OpenSpec spec changes for a given change. Highlights additions, removals, and behavioral modifications across acceptance criteria, flows, and constraints. Supports markdown and JSON output."
category: Workflow
tags: [openspec, diff, specs, visualization, changes]
---

Visualize spec changes for **{{PROJECT_NAME}}**: compare the current specs against a named OpenSpec change to show exactly what behavioral requirements are being added, modified, or removed.

**Input:** $ARGUMENTS — accepts:
- `<change-name>` — the kebab-case name of the change to diff (required). If omitted, interactive selection is offered.
- `--format json` — emit structured JSON instead of markdown (default: markdown).
- `--summary-only` — skip inline line-level diff; show only the file-level and behavioral summary.

---

## Phase 0: Argument Parsing

Parse `$ARGUMENTS` to set runtime variables.

**Variables to set:**

- `CHANGE_NAME` — string. Required. If not provided, prompt the user.
- `FORMAT` — `"markdown"` or `"json"`. Default: `"markdown"`.
- `SUMMARY_ONLY` — boolean. Default: `false`.

**Parsing rules:**

1. Scan `$ARGUMENTS` for `--format <value>`. If found and value is `json`, set `FORMAT="json"`. Any other value: print `Error: unknown format "<value>". Valid: markdown, json` and stop. Strip from arguments.
2. Scan for `--summary-only`. If found, set `SUMMARY_ONLY=true`. Strip from arguments.
3. Treat the remaining token (if any) as `CHANGE_NAME`. Strip leading/trailing whitespace.
4. If `CHANGE_NAME` is empty after parsing:
   - Run:
     ```bash
     openspec list --json
     ```
   - If the result shows available changes, use the **AskUserQuestion tool** (open-ended, show the list) to ask which change to diff.
   - If no changes exist, print:
     ```
     Error: no active changes found. Run /opsx:new or /opsx:ff to create one first.
     ```
     Stop.

**Print active configuration:**

```
Diffing change: <CHANGE_NAME>
Format: <markdown|json>
Summary only: <yes|no>
```

---

## Phase 1: Locate the Change

Find the change directory and enumerate its spec artifacts.

### Step 1a: Resolve the change path

Check these locations in order:

1. `openspec/changes/<CHANGE_NAME>/` — active change.
2. `openspec/changes/archive/` — glob for directories matching `*<CHANGE_NAME>` or exact `<CHANGE_NAME>`. Take the most recent match (latest date prefix).

If neither location yields a directory, print:

```
Error: change "<CHANGE_NAME>" not found.
Searched:
  - openspec/changes/<CHANGE_NAME>/
  - openspec/changes/archive/*<CHANGE_NAME>*/

Run `openspec list` to see available changes.
```

Stop.

Set `CHANGE_DIR` to the resolved path.

**Print:** `Found change at: <CHANGE_DIR>`

### Step 1b: Enumerate spec artifacts in the change

Collect spec content from the change directory using this priority:

1. **Delta-spec file** — `<CHANGE_DIR>/delta-spec.md`. If present, read it. Set `HAS_DELTA_SPEC=true`.
2. **Inline specs subdirectory** — `<CHANGE_DIR>/specs/`. If present, glob `**/*.md` within it. Each file is an individual spec. Set `HAS_SPEC_DIR=true`.
3. **Proposal file** — `<CHANGE_DIR>/proposal.md`. Always read if present. Used for context but not as a primary diff source. Set `HAS_PROPOSAL=true`.

At least one of `HAS_DELTA_SPEC` or `HAS_SPEC_DIR` must be true to proceed.

If neither exists:
```
Warning: no spec artifacts found in <CHANGE_DIR>.
  Expected: delta-spec.md or specs/*.md

The change may not have reached the spec authoring phase yet.
Run /opsx:continue to create specs first.
```
Stop.

Store the collected spec content:
- `DELTA_SPEC` — string content of delta-spec.md (or `""` if absent).
- `CHANGE_SPECS` — array of `{ path, content }` objects from the specs/ subdirectory (or `[]` if absent).
- `PROPOSAL` — string content of proposal.md (or `""` if absent).

**Print:** `Spec artifacts: <delta-spec.md present|absent>, <N spec files in specs/>, proposal <present|absent>`

---

## Phase 2: Load Baseline Specs

Find the current baseline specs to compare against.

### Step 2a: Discover baseline spec files

Glob for markdown files in `openspec/specs/` (recursively: `openspec/specs/**/*.md`).

Store as `BASELINE_SPECS` — array of `{ path, content }` objects.

If `openspec/specs/` does not exist or contains no files:
```
Note: no baseline specs found in openspec/specs/.
Diff will show all change specs as net-new additions (no removals or modifications).
```
Set `BASELINE_SPECS=[]`.

**Print:** `Baseline: <N> spec file(s) found in openspec/specs/`

### Step 2b: Match change specs to baseline specs

For each entry in `CHANGE_SPECS` (from the change's specs/ subdirectory), attempt to find its counterpart in `BASELINE_SPECS`.

**Matching rule:** A change spec at `<CHANGE_DIR>/specs/<spec-name>/spec.md` matches a baseline spec at `openspec/specs/<spec-name>/spec.md` or `openspec/specs/<spec-name>.md`. Match on the spec name segment only.

Build `SPEC_PAIRS` — array of:
```
{
  specName: string,
  changePath: string | null,       // path in change (null if baseline-only)
  baselinePath: string | null,     // path in baseline (null if change-only)
  changeContent: string | null,
  baselineContent: string | null,
  matchType: "new" | "modified" | "deleted" | "unchanged"
}
```

**Match type rules:**
- `changePath` present, `baselinePath` absent → `"new"`.
- `changePath` absent, `baselinePath` present (and baseline spec is referenced/affected by delta-spec) → `"deleted"`.
- Both present and content differs → `"modified"`.
- Both present and content identical → `"unchanged"`.

For the delta-spec flow (when `HAS_DELTA_SPEC=true` and `HAS_SPEC_DIR=false`):
- The delta-spec itself is the primary artifact. There is no per-file pairing.
- Set `SPEC_PAIRS=[]` and use the delta-spec content directly in Phase 3.

---

## Phase 3: Compute the Diff

Produce a structured diff comparing baseline vs. change specs.

### Step 3a: Delta-spec analysis (when HAS_DELTA_SPEC=true)

Parse the delta-spec sections to extract behavioral elements:

**Acceptance criteria / SHALL statements:**
- Glob for lines matching the pattern: `^\*\*\d+\.\d+\*\*` (numbered normative statements like `**1.1**`).
- Collect all `{ id, text }` pairs into `DELTA_STATEMENTS`.

**Surface impact table:**
- Find the `## Surface Impact` section (or `### Surface Impact of This Change`).
- Parse all table rows into `SURFACE_CHANGES`: `[ { category, element, change, severity } ]`.

**REST/API contract changes:**
- Find any section with "REST API", "API Contract", or "Endpoints" in the heading.
- Extract endpoint definitions: method + path + response shape changes.
- Store as `API_CHANGES`.

**Since there is no true baseline for a delta-spec** (it defines net-new behavior), classify every `DELTA_STATEMENTS` entry as a `"new"` addition. If the "Surface Impact" table includes rows with change type "Removal" or "BREAKING", classify those as `"modified"` or `"deleted"` accordingly.

Build `DIFF_RESULT`:
```
{
  addedStatements: [{ id, text }],
  modifiedStatements: [{ id, text, changeDescription }],
  removedStatements: [{ id, text }],
  surfaceChanges: [{ category, element, change, severity }],
  apiChanges: [{ method, path, description }],
  specPairs: []
}
```

### Step 3b: Spec-file-pair analysis (when HAS_SPEC_DIR=true)

For each `SPEC_PAIR` in `SPEC_PAIRS` where `matchType !== "unchanged"`:

**Line-level diff:**

Compare `baselineContent` and `changeContent` line by line:

1. Split each content string into lines.
2. Identify added lines (present in change, absent in baseline) and removed lines (present in baseline, absent in change).
3. For each changed block, compute a ±3-line context window.
4. Mark heading lines (starting with `#`) separately — heading changes indicate structural reorganization.
5. Mark lines containing normative language (`SHALL`, `MUST`, `SHOULD`, `MAY`, `SHALL NOT`, `MUST NOT`) as behavioral.

Produce `{ specName, matchType, addedLines, removedLines, behavioralChanges, headingChanges }`.

**Behavioral change classification:**

- Line added + contains `SHALL`/`MUST` → new requirement.
- Line removed + contains `SHALL`/`MUST` → removed requirement.
- Line modified (matched by proximity) + normative keyword → modified requirement.
- Other additions/removals → structural/non-normative.

Build `DIFF_RESULT` from all `SPEC_PAIRS`.

### Step 3c: Compute summary statistics

```
ADDED_COUNT    = count(addedStatements) + count(added spec files)
MODIFIED_COUNT = count(modifiedStatements) + count(modified spec files)
REMOVED_COUNT  = count(removedStatements) + count(deleted spec files)
TOTAL_CHANGES  = ADDED_COUNT + MODIFIED_COUNT + REMOVED_COUNT
```

---

## Phase 4: Render Output

### If FORMAT = "json"

Emit a single JSON object:

```json
{
  "schema_version": "1",
  "project": "{{PROJECT_NAME}}",
  "change": "<CHANGE_NAME>",
  "generated_at": "<ISO 8601 timestamp>",
  "source": "<delta-spec | spec-files>",
  "summary": {
    "total_changes": <N>,
    "added": <N>,
    "modified": <N>,
    "removed": <N>
  },
  "added_statements": [
    { "id": "1.1", "text": "..." }
  ],
  "modified_statements": [
    { "id": "2.3", "text": "...", "change_description": "..." }
  ],
  "removed_statements": [
    { "id": "3.1", "text": "..." }
  ],
  "surface_changes": [
    { "category": "...", "element": "...", "change": "...", "severity": "..." }
  ],
  "api_changes": [
    { "method": "POST", "path": "/api/spawn", "description": "..." }
  ],
  "spec_pairs": [
    {
      "spec_name": "...",
      "match_type": "new|modified|deleted",
      "added_lines": ["..."],
      "removed_lines": ["..."],
      "behavioral_changes": ["..."],
      "heading_changes": ["..."]
    }
  ]
}
```

Stop after emitting JSON.

### If FORMAT = "markdown"

Render the full diff report:

```
## OpenSpec Change Diff — <CHANGE_NAME>
Project: {{PROJECT_NAME}} | Generated: <YYYY-MM-DD HH:MM>

### Summary

| Metric | Count |
|--------|-------|
| ➕ Added requirements | <N> |
| ✏️  Modified requirements | <N> |
| ➖ Removed requirements | <N> |
| **Total changes** | **<N>** |
```

**If TOTAL_CHANGES = 0:**
```
✅ No behavioral differences detected between the change specs and the baseline.
```
Stop.

---

Then render sections:

#### Added Requirements

```
### ➕ Added Requirements (<N>)

<for each added statement:>
> **<id>** <text>

<if none:>
_No new requirements._
```

#### Modified Requirements

```
### ✏️  Modified Requirements (<N>)

<for each modified statement or spec pair with matchType="modified":>
#### <spec-name or section heading>

\`\`\`diff
- <removed line>
+ <added line>
\`\`\`

**Change:** <change_description or inferred summary>

<if SUMMARY_ONLY=true: skip inline diff blocks, show only change description>
```

#### Removed Requirements

```
### ➖ Removed Requirements (<N>)

<for each removed statement:>
> ~~**<id>** <text>~~

<if none:>
_No requirements removed._
```

#### Surface Impact (when HAS_DELTA_SPEC=true and SURFACE_CHANGES is non-empty)

```
### 🗺️  Surface Impact

| # | Category | Element | Change | Severity |
|---|----------|---------|--------|----------|
<rows from SURFACE_CHANGES>
```

#### API Contract Changes (when API_CHANGES is non-empty)

```
### 🔌 API Contract Changes

<for each API_CHANGES entry:>
- **<METHOD> <path>** — <description>
```

#### New Spec Files (when added spec files exist)

```
### 📄 New Spec Files

<for each specPair where matchType="new":>
- `<changePath>` — new spec, no baseline counterpart
```

#### Deleted Spec Files (when deleted spec files exist)

```
### 🗑️  Deleted Spec Files

<for each specPair where matchType="deleted":>
- `<baselinePath>` — removed by this change
```

---

Close the report:

```
---
_Generated by `{{COMMAND_PREFIX}}opsx-diff` in {{PROJECT_NAME}}_
_Change source: <CHANGE_DIR>_

**Next steps:**
- Run `/opsx:apply <CHANGE_NAME>` to implement these changes.
- Run `/opsx:archive <CHANGE_NAME>` after implementation to merge specs into baseline.
```

---

## Phase 5: Save Snapshot (optional)

After rendering, write a diff snapshot to `{{SPECRAILS_DIR}}/opsx-diff-history/`:

1. Filename: `<CHANGE_NAME>-<YYYY-MM-DD>.json`
2. Directory: `{{SPECRAILS_DIR}}/opsx-diff-history/` (create if absent, idempotent).
3. Content: the JSON object from Phase 4 (regardless of FORMAT setting).

Print: `Snapshot saved: {{SPECRAILS_DIR}}/opsx-diff-history/<CHANGE_NAME>-<YYYY-MM-DD>.json`

If the write fails: print `Warning: could not write diff snapshot. Continuing.` Do not abort.

**Housekeeping:** If `{{SPECRAILS_DIR}}/opsx-diff-history/` has more than 50 `.json` files, print:
```
Note: {{SPECRAILS_DIR}}/opsx-diff-history/ has <N> snapshots. Prune old ones with:
  ls -t {{SPECRAILS_DIR}}/opsx-diff-history/ | tail -n +51 | xargs -I{} rm {{SPECRAILS_DIR}}/opsx-diff-history/{}
```
