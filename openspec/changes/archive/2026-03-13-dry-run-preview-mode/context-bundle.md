# Context Bundle: Local Agent Dry-Run / Preview Mode

Everything a developer needs to implement this feature without reading additional files.

---

## What You Are Building

A `--dry-run` flag (alias `--preview`) for the `/implement` command. When active:

- All agents (architect, developer, reviewer) run as normal
- Developer file output is redirected to `.claude/.dry-run/<feature-name>/` instead of real paths
- Phase 4c (git branch, commit, push, PR creation, backlog issue comments) is entirely skipped
- A preview report shows diffs and skipped operations at the end
- A companion `--apply <feature-name>` flag copies cached files to real locations and then runs Phase 4c

The entire feature is implemented as prose changes to two Markdown command files. There is no new code, no new agents, no new tools.

---

## Files to Change

| File | Change type | Notes |
|------|-------------|-------|
| `templates/commands/implement.md` | Modify | Source template — authoritative |
| `.claude/commands/implement.md` | Modify | Active generated command — must match template |
| `openspec/specs/implement.md` | Create | New spec file for the implement command |
| `.gitignore` | Create or modify | Add `.claude/.dry-run/` |

---

## Current Structure of `implement.md`

The command has these phases in order:

```
Phase -1  Environment Setup
Phase 0   Parse input and determine mode
Phase 1   Explore (parallel, product-manager agents)
Phase 2   Select
Phase 3a  Architect (parallel)
  3a.1  Identify shared file conflicts
  3a.2  Pre-validate architect output
Phase 3b  Implement (developer agents)
  Pre-flight: Verify Bash permission
  Launch developers
Phase 4   Merge & Review
  4a. Merge worktree changes to main repo
  4b. Launch Reviewer agent
  4c. Ship — Git & backlog updates
    [GIT_AUTO=true section]
    [GIT_AUTO=false section]
    [Backlog updates section]
  4d. Monitor CI
  4e. Report
Error Handling
```

The template version (`templates/commands/implement.md`) has `{{PLACEHOLDER}}` tokens for stack-specific values. The generated version (`.claude/commands/implement.md`) has these resolved.

Key existing variables in Phase 4c: `GIT_AUTO` (boolean), `BACKLOG_WRITE` (boolean), `GH_AVAILABLE` (boolean set in Phase -1).

---

## Where Each Task Inserts Content

### Phase 0 — Insert at the very top, before "If the user passed a text description..."

```markdown
### Flag Detection

Before parsing input, scan $ARGUMENTS for control flags:

- If `--dry-run` or `--preview` is present in $ARGUMENTS:
  - Set `DRY_RUN=true`
  - Strip the flag from the arguments before further parsing
  - Print: `[dry-run] Preview mode active — no git, PR, or backlog operations will run.`
  - Set `CACHE_DIR=.claude/.dry-run/<kebab-case-feature-name>` (derive after parsing the remaining input)

- If `--apply <feature-name>` is present in $ARGUMENTS:
  - Set `APPLY_MODE=true`
  - Set `APPLY_TARGET=<feature-name>` (the argument immediately following --apply)
  - Set `CACHE_DIR=.claude/.dry-run/<feature-name>`
  - Verify CACHE_DIR exists. If it does not: print `[apply] Error: no cached dry-run found at CACHE_DIR` and stop.
  - Skip Phases 1–4b. Go directly to Phase 4c (the apply path handles the rest).
  - Strip --apply and the feature name before further parsing.

If neither flag is present: `DRY_RUN=false`, `APPLY_MODE=false`. Pipeline runs as normal.

Note: `CACHE_DIR` for `--dry-run` is finalized after the feature name is derived from the remaining input. All subsequent phases that reference CACHE_DIR have access to it.
```

### Phase 3b — After "Read reviewer learnings", before "Choosing the right developer agent"

```markdown
#### Dry-Run: Redirect developer writes

**If `DRY_RUN=true`**, include the following in every developer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified files under:
>   .claude/.dry-run/<feature-name>/
>
> Mirror the real destination path within this directory. For example:
>   Real path:   src/utils/parser.ts
>   Write to:    .claude/.dry-run/<feature-name>/src/utils/parser.ts
>
> Do NOT write to real file paths. After writing each file, append an entry
> to .claude/.dry-run/<feature-name>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

**If `DRY_RUN=false`**: developer agent instructions are unchanged.
```

### Phase 4a — Replace the opening line with a three-way conditional

**Current:**
```
If `SINGLE_MODE`: skip. Otherwise copy feature-specific files...
```

**Replace with:**
```
- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo. Apply the same merge logic (copy feature-specific files, handle shared files) but destination is `CACHE_DIR/<file-path>`.
- Otherwise: merge to main repo working tree as normal.
```

### Phase 4b — After the existing reviewer agent description, add a conditional block

```markdown
**If `DRY_RUN=true`**, add to the reviewer agent prompt:

> Note: This is a dry-run review. Developer files are under .claude/.dry-run/<feature-name>/.
> Read modified files from there. Write any reviewer fixes back to CACHE_DIR (not real paths).
> CI commands may be run — they read the real repo, but be aware developer changes are not
> yet applied to real paths.
```

### Phase 4c — Insert "Dry-Run Gate" as the FIRST block, before "If GIT_AUTO=true..."

```markdown
### Dry-Run Gate

**If `DRY_RUN=true`:**
Print: `[dry-run] Skipping all git and backlog operations.`
Record skipped operations to `.cache-manifest.json`:
- "git: branch creation (feat/<name>)"
- "git: commit"
- "git: push"
- "github: pr creation" (if GH_AVAILABLE=true)
- "github: issue comment #N" for each issue in scope (if BACKLOG_WRITE=true)
Then skip the rest of Phase 4c and proceed directly to Phase 4e.

**If `APPLY_MODE=true`:**
1. Read `.cache-manifest.json` from `CACHE_DIR`.
2. For each entry in `files`: copy `cached_path` to `real_path`, creating directories as needed.
3. Print: `[apply] Copied N files from .claude/.dry-run/<feature-name>/ to real locations.`
4. Then proceed with Phase 4c normally (GIT_AUTO logic, backlog updates) using the real files.
5. On successful completion of Phase 4c: delete `CACHE_DIR` and print `[apply] Cache cleaned up.`
   If Phase 4c fails: preserve `CACHE_DIR` for re-run.

**Otherwise:** proceed as normal.
```

### Phase 4e — Insert "Dry-Run Preview Report" as a conditional block BEFORE the standard table

```markdown
**If `DRY_RUN=true`**, show this report instead of the standard pipeline table:

---
## Dry-Run Preview Report

### Artifacts Generated
| Type | Location |
|------|----------|
| OpenSpec proposal | openspec/changes/<name>/proposal.md |
| OpenSpec design | openspec/changes/<name>/design.md |
| OpenSpec tasks | openspec/changes/<name>/tasks.md |
| OpenSpec context-bundle | openspec/changes/<name>/context-bundle.md |
| Developer files | .claude/.dry-run/<name>/ (N files) |

### What Would Change
[For each file in .cache-manifest.json `files` array:]
- `<real_path>` — [new file / modified] ([approximate line delta if available])

### Operations Skipped
[List items from .cache-manifest.json `skipped_operations` array]

### Next Steps
To apply these changes and ship:
  /implement --apply <feature-name>

To discard this dry run:
  rm -rf .claude/.dry-run/<feature-name>/
---
```

---

## Cache Manifest Schema

File: `.claude/.dry-run/<feature-name>/.cache-manifest.json`

```json
{
  "feature": "dry-run-preview-mode",
  "created_at": "2026-03-13T00:00:00Z",
  "dry_run": true,
  "files": [
    {
      "cached_path": ".claude/.dry-run/dry-run-preview-mode/templates/commands/implement.md",
      "real_path": "templates/commands/implement.md",
      "operation": "modify"
    }
  ],
  "openspec_changes": "dry-run-preview-mode",
  "skipped_operations": [
    "git: branch creation (feat/dry-run-preview-mode)",
    "git: commit",
    "git: push",
    "github: pr creation",
    "github: issue comment #18"
  ]
}
```

---

## Existing Patterns to Follow

The new dry-run logic follows the same conditional-flag pattern already in Phase 4c:

```
#### If `GIT_AUTO=true` (automatic shipping)
...

#### If `GIT_AUTO=false` (manual shipping)
...
```

The dry-run gate sits above these. When `DRY_RUN=false` and `APPLY_MODE=false`, the `GIT_AUTO` logic runs exactly as before — no behavior change.

---

## Conventions Checklist

- No `{{PLACEHOLDER}}` tokens for dry-run logic — use inline variable names (`DRY_RUN`, `CACHE_DIR`) matching the `GIT_AUTO` / `BACKLOG_WRITE` pattern
- All headings use `###` (third level) to match surrounding Phase 4c structure
- Variable names: `UPPER_SNAKE_CASE`
- File paths: kebab-case directories, no uppercase
- The template and generated command must be updated in the same commit
- After editing, run: `grep -r '{{[A-Z_]*}}' .claude/commands/` to verify no broken placeholders

---

## Risks

1. **Developer agent path discipline**: Dry-run correctness depends entirely on the developer agent following the cache path instruction. If the agent writes to real paths, the dry-run silently fails. Mitigation: make the instruction prominent and explicit in the prompt; include the prohibition ("Do NOT write to real file paths") explicitly.

2. **Reviewer CI gap**: In dry-run mode, CI runs against the real repo (developer changes not applied). CI results may not reflect what the final code would produce. Mitigation: the reviewer prompt explicitly notes this caveat. The user is informed in the preview report.

3. **Stale cache on re-run**: If `--dry-run` is run twice with the same feature name, the second run overwrites the first. Mitigation: print a warning ("[dry-run] Overwriting existing cache at CACHE_DIR") before overwriting.

4. **`CACHE_DIR` finalization timing**: `CACHE_DIR` requires the feature name, which is derived from input parsing. The flag detection section must note that `CACHE_DIR` is finalized after the feature name is known. Phases 3a onward can reference it without issue.
