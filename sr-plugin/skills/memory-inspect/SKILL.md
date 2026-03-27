---
name: memory-inspect
description: "Inspect and manage agent memory directories. Lists all sr-* agent memory stores, shows per-agent stats (file count, size, last modified), displays recent entries, and detects stale or orphaned files."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---

Inspect agent memory directories under `.claude/agent-memory/sr-*/` for **this project** (read name from CLAUDE.md or package.json). Show per-agent stats, recent entries, and actionable recommendations.

**Input:** `$ARGUMENTS` — optional:
- `<agent-name>` — inspect a specific agent's memory (e.g. `sr-developer`, `sr-reviewer`)
- `--stale <days>` — flag files not modified in more than N days as stale (default: 30)
- `--prune` — delete stale files after confirmation (prints the list first, then asks)

---

## Phase 0: Argument Parsing

Parse `$ARGUMENTS` to set runtime variables.

**Variables to set:**

- `AGENT_FILTER` — string or empty string. Default: `""` (inspect all agents).
- `STALE_DAYS` — integer. Default: `30`.
- `PRUNE_MODE` — boolean. Default: `false`.

**Parsing rules:**

1. Scan `$ARGUMENTS` for `--stale <N>`. If found, set `STALE_DAYS=<N>`. Validate that `<N>` is a positive integer; if not, print `Error: --stale requires a positive integer (e.g. --stale 14)` and stop. Strip from arguments.
2. Scan for `--prune`. If found, set `PRUNE_MODE=true`. Strip from arguments.
3. Remaining non-flag text (if any) is treated as `AGENT_FILTER`. Strip leading/trailing whitespace.

**Print active configuration:**

```
Scanning: <all agents | agent: AGENT_FILTER> | Stale threshold: STALE_DAYS days | Prune: yes/no
```

---

## Phase 1: Discover Memory Directories

Glob all directories matching `.claude/agent-memory/sr-*/`.

If no directories are found:
```
No agent memory directories found under .claude/agent-memory/.

Agent memory is written by sr-* agents during the /specrails:implement pipeline.
Run /specrails:implement on a feature to generate your first memory entries.
```
Then stop.

If `AGENT_FILTER` is set, filter to only the directory `.claude/agent-memory/<AGENT_FILTER>/`. If that directory does not exist:
```
No memory directory found for agent: <AGENT_FILTER>

Available agents:
  <list of discovered sr-* directory names>
```
Then stop.

Set `AGENT_DIRS` = list of matching directories (full paths), sorted alphabetically.

---

## Phase 2: Collect Per-Agent Stats

For each directory in `AGENT_DIRS`, collect:

- `AGENT_NAME` — directory name (e.g. `sr-developer`)
- `FILE_COUNT` — total number of files (recursive, all types)
- `TOTAL_SIZE` — total size in bytes; display as human-readable (KB, MB)
- `LAST_MODIFIED` — ISO date of the most recently modified file
- `OLDEST_MODIFIED` — ISO date of the least recently modified file
- `STALE_FILES` — list of files not modified in more than `STALE_DAYS` days (full paths)
- `STALE_COUNT` — count of stale files

Use the current date to compute stale age. A file is stale if `(today - last_modified) > STALE_DAYS`.

Print a summary table after collecting all stats:

```
## Agent Memory Overview

| Agent | Files | Size | Last Modified | Stale (>STALE_DAYS days) |
|-------|-------|------|---------------|--------------------------|
| sr-developer   | N | N KB | YYYY-MM-DD | N files |
| sr-reviewer    | N | N KB | YYYY-MM-DD | N files |
| ...            | ... | ... | ...        | ...     |

Total: N agents | N files | N KB
```

---

## Phase 3: Display Recent Entries

For each agent in `AGENT_DIRS`, show the 5 most recently modified files.

Print per agent:

```
### <agent-name>

Recent entries (5 most recent):

| File | Size | Last Modified |
|------|------|---------------|
| common-fixes.md | 2.1 KB | 2026-03-18 |
| ...             | ...    | ...         |
```

If the agent directory has fewer than 5 files, show all of them.

If `AGENT_FILTER` is set (single-agent mode), show the full content of each file up to 50 lines. For files exceeding 50 lines, print the first 50 lines followed by:
```
... (N more lines — view full file at <relative-path>)
```

---

## Phase 4: Orphan Detection

An **orphaned** memory directory is one whose agent name does not correspond to a known sr-agent persona.

Known sr-agent names (check for exact match):
`sr-architect`, `sr-developer`, `sr-test-writer`, `sr-reviewer`, `sr-frontend-reviewer`, `sr-backend-reviewer`, `sr-security-reviewer`, `sr-doc-sync`, `sr-product-manager`

For each directory in `AGENT_DIRS`, check whether its `AGENT_NAME` is in the known list. Collect non-matching directories as `ORPHANED_DIRS`.

If `ORPHANED_DIRS` is non-empty, print:

```
### Orphaned Memory Directories

The following directories do not match any known sr-agent name and may be leftover from renamed or removed agents:

| Directory | Files | Size | Recommendation |
|-----------|-------|------|----------------|
| sr-old-agent | N | N KB | Review and delete if no longer needed |
```

If `ORPHANED_DIRS` is empty: skip this section entirely.

---

## Phase 5: Stale File Report

Collect all stale files across all agents (from Phase 2 `STALE_FILES` lists).

If no stale files exist:
```
No stale files found (threshold: STALE_DAYS days). Memory is up to date.
```
Skip the rest of Phase 5.

Otherwise, print:

```
### Stale Files (not modified in >STALE_DAYS days)

| Agent | File | Size | Last Modified | Age (days) |
|-------|------|------|---------------|------------|
| sr-developer | common-fixes.md | 1.2 KB | 2026-01-10 | 69 |
| ...          | ...             | ...    | ...        | ...        |

N stale files total (N KB).
```

---

## Phase 6: Prune (if --prune)

Skip this phase if `PRUNE_MODE=false`.

If `PRUNE_MODE=true` and there are no stale files and no orphaned directories:
```
Nothing to prune. All memory files are within the STALE_DAYS-day threshold.
```
Then stop.

Otherwise, print the full list of files and directories that will be deleted:

```
## Files to Delete

The following N files will be permanently deleted:

Stale files:
  - .claude/agent-memory/sr-developer/common-fixes.md (69 days old)
  - ...

Orphaned directories:
  - .claude/agent-memory/sr-old-agent/ (N files, N KB)

Proceed? [y/N]:
```

Wait for user input.

- If the user enters `y` or `Y`:
  - Delete each stale file individually.
  - Delete each orphaned directory recursively.
  - Print a confirmation for each deletion: `Deleted: <path>`
  - Print a summary:
    ```
    Pruned N files (N KB freed).
    ```
- If the user enters anything else (or presses Enter):
  - Print: `Prune cancelled. No files were deleted.`
  - Stop.

---

## Phase 7: Recommendations

Print a final recommendations section based on findings:

```
## Recommendations

<one or more of the following, based on findings>
```

**Recommendation rules (print only applicable ones):**

1. **Prune stale data** — if `STALE_COUNT > 0` across any agent and `PRUNE_MODE=false`:
   ```
   - N stale files detected. Run `/specrails:memory-inspect --prune` to remove them and free N KB.
   ```

2. **Investigate large memory** — if any single agent's `TOTAL_SIZE > 1 MB`:
   ```
   - <agent-name> memory exceeds 1 MB (TOTAL_SIZE). Consider reviewing large files:
     <list files over 100 KB>
   ```

3. **Orphaned directories** — if `ORPHANED_DIRS` is non-empty:
   ```
   - N orphaned director(y|ies) found. Review and delete manually if no longer needed.
   ```

4. **Empty memory directories** — if any agent directory has `FILE_COUNT = 0`:
   ```
   - <agent-name> memory directory is empty. It may be safe to delete:
     rm -rf .claude/agent-memory/<agent-name>/
   ```

5. **Gitignore advisory** — check whether `.claude/agent-memory` appears in `.gitignore`. If not:
   ```
   - Agent memory is local runtime state. Add to .gitignore:
       echo '.claude/agent-memory/' >> .gitignore
   ```

If no recommendations apply, print:
```
All agent memory looks healthy. No action required.
```
