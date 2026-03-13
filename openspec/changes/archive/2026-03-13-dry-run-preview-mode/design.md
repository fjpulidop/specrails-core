# Technical Design: Local Agent Dry-Run / Preview Mode

## Overview

The dry-run feature is a pure orchestration-layer concern. No agent prompt changes. No new agents. No new tools. The entire implementation is confined to the `/implement` command's Markdown prose — specifically, two new parsing rules in Phase 0 and a conditional gate in Phase 4c.

The cache mechanism is a directory convention, not a database or state file. Simplicity is the guiding principle.

---

## Architecture

```
/implement --dry-run #18
     |
     v
Phase 0: Parse flags
  - Detect --dry-run or --preview
  - Set DRY_RUN=true
  - Set CACHE_DIR=.claude/.dry-run/<feature-name>
     |
     v
Phase -1, 1, 2, 3a, 3b: Run normally
  BUT: developer agent writes to CACHE_DIR instead of real locations
     |
     v
Phase 4a: Merge to CACHE_DIR (not main repo)
     |
     v
Phase 4b: Reviewer reads from CACHE_DIR
     |
     v
Phase 4c: SKIPPED (no git, no PR, no backlog updates)
     |
     v
Phase 4e: Preview report (diffs, artifact list, skipped ops)
     |
     v
User runs: /implement --apply <feature-name>
     |
     v
Phase 0 (apply): Detect --apply, locate CACHE_DIR
     |
     v
Apply: Copy files from CACHE_DIR to real locations
     |
     v
Phase 4c: Run normally (branch, commit, push, PR, backlog)
```

---

## File Changes

### 1. `templates/commands/implement.md` (template source)

This is the authoritative source. All changes described below apply here first.

### 2. `.claude/commands/implement.md` (active generated command)

Receives identical changes. Since specrails is self-hosting, this IS the running command.

---

## Detailed Changes Per Phase

### Phase 0: Parse input and determine mode

**Add at the top of Phase 0**, before existing input parsing logic:

```
### Flag Detection

Before parsing input, scan $ARGUMENTS for control flags:

- If `--dry-run` or `--preview` is present in $ARGUMENTS:
  - Set `DRY_RUN=true`
  - Strip the flag from the arguments before further parsing
  - Print: `[dry-run] Preview mode active — no git, PR, or backlog operations will run.`

- If `--apply` is present in $ARGUMENTS followed by a feature name:
  - Set `APPLY_MODE=true`
  - Set `APPLY_TARGET=<feature-name>` (the argument after --apply)
  - Set `CACHE_DIR=.claude/.dry-run/<feature-name>`
  - Verify CACHE_DIR exists. If not: print error and stop.
  - Skip all phases except 4c. Go directly to the Apply step (see Phase 4c).
  - Strip the flag and feature name before further parsing.

If neither flag is present: `DRY_RUN=false`, `APPLY_MODE=false`. Pipeline runs as normal.
```

**Cache directory naming convention:**

`CACHE_DIR = .claude/.dry-run/<kebab-case-feature-name>/`

The feature name is derived the same way as the change name — from the issue title or text description, kebab-cased. Examples:
- Issue #18 "Local Agent Dry-Run / Preview Mode" → `.claude/.dry-run/dry-run-preview-mode/`
- Text "add price history chart" → `.claude/.dry-run/add-price-history-chart/`

**Cache directory structure:**

```
.claude/.dry-run/<feature-name>/
  openspec/changes/<feature-name>/    # Architect artifacts (proposal, design, tasks, etc.)
  <real-file-paths-mirrored>/         # Developer file changes, mirrored from repo root
  .cache-manifest.json                # List of files changed, their real destinations, timestamp
  .preview-report.md                  # Generated at end of Phase 4e
```

The `.cache-manifest.json` format:

```json
{
  "feature": "<feature-name>",
  "created_at": "<ISO timestamp>",
  "dry_run": true,
  "files": [
    {
      "cached_path": ".claude/.dry-run/<feature-name>/path/to/file",
      "real_path": "path/to/file",
      "operation": "create|modify"
    }
  ],
  "openspec_changes": "<feature-name>",
  "skipped_operations": [
    "git: branch creation (feat/<name>)",
    "git: commit",
    "git: push",
    "github: pr creation",
    "github: issue comment #18"
  ]
}
```

### Phase 3a: Architect

**No change to agent invocation.** The architect always writes to `openspec/changes/<name>/`. This is fine — OpenSpec artifacts are not git-committed by the pipeline; they live in the working tree. In dry-run mode they still go to `openspec/changes/<name>/` as normal.

Rationale: OpenSpec changes are not side effects that reach remotes. They are local design artifacts. Moving them to the cache would break the reviewer's ability to read them by standard path. Keeping them in `openspec/changes/<name>/` is the simpler, correct choice.

**Note the architect output is NOT cached separately** — it remains at its normal location. Only developer-produced file changes (code, tests, docs written to the repo) are redirected to CACHE_DIR.

### Phase 3b: Implement — developer agent instructions

**When `DRY_RUN=true`**, add to the developer agent prompt:

```
IMPORTANT: This is a dry-run. Write all new or modified files under:
  .claude/.dry-run/<feature-name>/

Mirror the real destination path within this directory. For example:
  Real path:   src/utils/parser.ts
  Write to:    .claude/.dry-run/<feature-name>/src/utils/parser.ts

Do NOT write to real file paths. After writing each file, append an entry
to .claude/.dry-run/<feature-name>/.cache-manifest.json.
```

**When `DRY_RUN=false`**: developer agent instructions are unchanged.

### Phase 4a: Merge worktree changes

**When `DRY_RUN=true`**: Merge worktree outputs into `CACHE_DIR` instead of the main repo working tree. The merge logic is identical; only the destination changes.

**When `DRY_RUN=false`**: unchanged.

### Phase 4b: Reviewer agent

**When `DRY_RUN=true`**: The reviewer reads files from `CACHE_DIR` when it needs to inspect developer output. The reviewer's prompt must include:

```
Note: This is a dry-run review. Developer files are under .claude/.dry-run/<feature-name>/.
Read modified files from there. Do NOT write fixes to real paths — write them to CACHE_DIR.
CI commands may be run (they read the real repo), but understand that developer changes
are in the cache and not yet applied.
```

**When `DRY_RUN=false`**: unchanged.

### Phase 4c: Ship — CORE CHANGE

**Add at the top of Phase 4c:**

```
### Dry-Run Gate

IF `DRY_RUN=true`:
  SKIP this entire phase (4c).
  Do not create branches.
  Do not commit.
  Do not push.
  Do not create PRs.
  Do not comment on issues.
  Proceed directly to Phase 4e (Report).

IF `APPLY_MODE=true`:
  Read .cache-manifest.json from CACHE_DIR.
  For each file in the manifest:
    Copy from cached_path to real_path (create directories as needed).
  Print: "[apply] Copied N files from cache to real locations."
  Then run Phase 4c normally (branch, commit, push, PR, backlog updates).
  After shipping, delete CACHE_DIR.
```

### Phase 4e: Report

**When `DRY_RUN=true`**, replace or augment the standard report table with a **Preview Report**:

```
## Dry-Run Preview Report

### Artifacts Generated
| Type | Location |
|------|----------|
| OpenSpec proposal | openspec/changes/<name>/proposal.md |
| OpenSpec design | openspec/changes/<name>/design.md |
| OpenSpec tasks | openspec/changes/<name>/tasks.md |
| OpenSpec context-bundle | openspec/changes/<name>/context-bundle.md |
| Developer files | .claude/.dry-run/<name>/ (N files) |

### What Would Change (diff preview)
[For each file in .cache-manifest.json, show a summary: new file / modified (N lines +/- M)]

### Operations Skipped
[List from .cache-manifest.json skipped_operations field]

### Next Steps
To apply these changes and ship:
  /implement --apply <feature-name>

To discard this dry run:
  rm -rf .claude/.dry-run/<feature-name>/
```

**When `DRY_RUN=false`**: report is unchanged.

---

## Cache Lifecycle

| Event | Action |
|-------|--------|
| `--dry-run` completes | Cache persists at `.claude/.dry-run/<name>/` |
| `--apply <name>` completes successfully | Cache is deleted |
| `--apply <name>` fails mid-way | Cache is preserved (re-runnable) |
| Manual discard | `rm -rf .claude/.dry-run/<name>/` |
| Multiple dry runs, same name | New run overwrites the cache (with a warning) |

The `.claude/.dry-run/` directory should be added to `.gitignore` so cached previews are not accidentally committed.

---

## Integration Points

| Component | Interaction |
|-----------|-------------|
| Phase 0 | New flag parsing, DRY_RUN/APPLY_MODE vars set |
| Phase 3b developer prompt | Redirected write path when DRY_RUN=true |
| Phase 4a merge | Destination changes to CACHE_DIR when DRY_RUN=true |
| Phase 4b reviewer prompt | Read path hint when DRY_RUN=true |
| Phase 4c | Conditional skip gate (DRY_RUN) or apply-from-cache entry point (APPLY_MODE) |
| Phase 4e | Extended preview report when DRY_RUN=true |
| `.gitignore` | `.claude/.dry-run/` added |

---

## Key Design Decisions

**Why not a separate `/dry-run` command?**
A flag on `/implement` is discoverable, consistent with how `GIT_AUTO` and `BACKLOG_WRITE` already parameterize behavior, and requires no new command scaffolding.

**Why mirror file paths in the cache rather than a flat list?**
Mirrored paths make the apply step trivial (just copy by path) and make diffs readable without any path translation.

**Why keep OpenSpec artifacts at their real location even in dry-run?**
OpenSpec changes are local design files, not pushed to remote. Moving them to the cache adds complexity for no safety benefit. The reviewer and subsequent phases read them from standard paths.

**Why a JSON manifest rather than a directory scan on apply?**
The manifest captures intent (create vs. modify) and the list of skipped operations for the report. A directory scan would lose this metadata.

**Why delete the cache on successful `--apply`?**
Prevents stale caches from confusing future runs. If apply fails, the cache is preserved so the user can re-run `--apply` safely.
