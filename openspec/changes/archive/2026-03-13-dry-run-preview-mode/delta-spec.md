# Delta Spec: Local Agent Dry-Run / Preview Mode

This document describes the exact changes to existing specs and conventions introduced by this feature. It is not a full spec rewrite — only deltas are recorded.

---

## 1. `openspec/specs/implement.md` (does not yet exist — create)

The implement command does not currently have a spec file in `openspec/specs/`. Create it and capture the dry-run behavior as part of the baseline spec.

**File to create:** `openspec/specs/implement.md`

**Content to add:**

```markdown
# Spec: /implement Command

## Flags

### --dry-run / --preview

When passed, the pipeline runs fully (all agents execute) but no external side effects fire:
- No git branch creation, commits, pushes
- No PR creation
- No GitHub/backlog issue comments

Generated artifacts are cached at `.claude/.dry-run/<feature-name>/`.

The pipeline ends with a preview report showing what would have changed and what operations were skipped.

### --apply <feature-name>

Reads cached artifacts from `.claude/.dry-run/<feature-name>/`, copies them to their real destinations, then executes Phase 4c (git + backlog operations) normally.

Deletes the cache on successful completion.

## Cache Directory

Location: `.claude/.dry-run/<feature-name>/`

Structure:
- Mirrors real file paths under the cache root
- `.cache-manifest.json` — manifest of cached files, their real paths, and skipped operations
- `.preview-report.md` — the rendered preview report from Phase 4e

The `.claude/.dry-run/` directory is gitignored.

## Behavior Matrix

| Flag | Agents run | Files written | Git ops | Backlog ops | Cache |
|------|-----------|---------------|---------|-------------|-------|
| (none) | yes | real paths | yes | yes | no |
| --dry-run | yes | cache | no | no | created |
| --apply | no | real paths (from cache) | yes | yes | deleted on success |
```

---

## 2. `templates/commands/implement.md` — Phase 0 additions

**Section:** Phase 0: Parse input and determine mode

**Delta:** Add a "Flag Detection" subsection at the top of Phase 0, before all existing input parsing. See `design.md` for the exact prose to insert.

**Variables introduced:**
- `DRY_RUN` (boolean, default false)
- `APPLY_MODE` (boolean, default false)
- `APPLY_TARGET` (string, the feature name following --apply)
- `CACHE_DIR` (string path, set when DRY_RUN or APPLY_MODE is true)

---

## 3. `templates/commands/implement.md` — Phase 3b additions

**Section:** Phase 3b: Implement — developer agent prompt

**Delta:** When `DRY_RUN=true`, add instruction block to developer agent prompt redirecting writes to `CACHE_DIR`. See `design.md` for exact text.

---

## 4. `templates/commands/implement.md` — Phase 4a additions

**Section:** Phase 4a: Merge worktree changes to main repo

**Delta:** Add conditional: when `DRY_RUN=true`, merge worktree outputs to `CACHE_DIR` instead of main repo working tree.

---

## 5. `templates/commands/implement.md` — Phase 4b additions

**Section:** Phase 4b: Launch Reviewer agent

**Delta:** When `DRY_RUN=true`, add instruction block to reviewer agent prompt directing it to read developer files from `CACHE_DIR`.

---

## 6. `templates/commands/implement.md` — Phase 4c dry-run gate

**Section:** Phase 4c: Ship — Git & backlog updates

**Delta:** Add a "Dry-Run Gate" block at the very top of Phase 4c, before all existing content. This block:
1. When `DRY_RUN=true`: skips Phase 4c entirely and jumps to Phase 4e.
2. When `APPLY_MODE=true`: runs the apply-from-cache logic, then proceeds with Phase 4c as normal.

---

## 7. `templates/commands/implement.md` — Phase 4e preview report

**Section:** Phase 4e: Report

**Delta:** When `DRY_RUN=true`, show the Preview Report format instead of the standard pipeline report table. See `design.md` for the exact format.

---

## 8. `.claude/commands/implement.md` — identical changes

The generated command receives the same changes as the template. Both files must be updated in the same commit.

---

## 9. `.gitignore`

**Delta:** Add `.claude/.dry-run/` to the project `.gitignore`.

If no `.gitignore` exists yet, create one with this entry.

---

## Conventions Unchanged

- `{{PLACEHOLDER}}` syntax is not used for dry-run logic — the new sections are plain prose/markdown with inline variable names (`DRY_RUN`, `CACHE_DIR`), consistent with how `GIT_AUTO` and `BACKLOG_WRITE` are handled in Phase 4c today.
- All new prose follows existing heading levels and formatting conventions.
- No new template placeholders are introduced.
