# Tasks: Local Agent Dry-Run / Preview Mode

Tasks are ordered sequentially. Each task depends on the one before it.

---

## T1 — Add .gitignore entry for dry-run cache [core]

**Description:**
Create or update `.gitignore` at the repo root to exclude `.claude/.dry-run/`. This must happen before any dry-run runs so cached artifacts are never accidentally staged.

**Files involved:**
- `.gitignore` (create if absent)

**Acceptance criteria:**
- `.gitignore` contains the line `.claude/.dry-run/`
- `git status` does not show `.claude/.dry-run/` contents as untracked after a dry-run cache is created

**Dependencies:** none

---

## T2 — Add Flag Detection to Phase 0 in the template [templates]

**Description:**
Insert a "Flag Detection" subsection at the top of Phase 0 in `templates/commands/implement.md`. This subsection must:

1. Detect `--dry-run` or `--preview` in `$ARGUMENTS`, set `DRY_RUN=true`, strip the flag, print a notice.
2. Detect `--apply <feature-name>` in `$ARGUMENTS`, set `APPLY_MODE=true`, set `APPLY_TARGET` and `CACHE_DIR`, verify cache exists, then jump directly to Phase 4c (apply path). Stop with an error if cache is missing.
3. Default both flags to false when absent.

The subsection goes above the existing "If the user passed a text description..." block.

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 0 has a "Flag Detection" subsection as its first content block
- Variables `DRY_RUN`, `APPLY_MODE`, `APPLY_TARGET`, `CACHE_DIR` are defined
- The prose clearly states: strip flags before further input parsing
- `--apply` path verifies cache existence before proceeding
- No `{{PLACEHOLDER}}` syntax used (inline variable names, consistent with GIT_AUTO pattern)

**Dependencies:** none

---

## T3 — Add dry-run cache redirect to Phase 3b developer prompt [templates]

**Description:**
In `templates/commands/implement.md`, add a conditional block in Phase 3b under "Launch developers". When `DRY_RUN=true`, the developer agent prompt must include instructions to:
- Write all new/modified files under `CACHE_DIR` mirroring real paths
- Append each file entry to `.cache-manifest.json` in CACHE_DIR

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 3b has a conditional block gated on `DRY_RUN=true`
- Developer prompt text includes: write destination, path mirroring rule, manifest update instruction
- Condition is clearly separated from the existing developer launch prose

**Dependencies:** T2

---

## T4 — Add dry-run merge redirect to Phase 4a [templates]

**Description:**
In `templates/commands/implement.md`, add a conditional at the start of Phase 4a. When `DRY_RUN=true`, worktree merge output goes to `CACHE_DIR` rather than the main repo working tree.

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4a has an explicit conditional: `If SINGLE_MODE: skip. If DRY_RUN=true: merge to CACHE_DIR. Otherwise: merge to main repo.`
- Existing merge logic is unchanged for non-dry-run paths

**Dependencies:** T2

---

## T5 — Add dry-run reviewer path hint to Phase 4b [templates]

**Description:**
In `templates/commands/implement.md`, add a conditional block in Phase 4b. When `DRY_RUN=true`, the reviewer agent prompt must include instructions to:
- Read developer-produced files from `CACHE_DIR`
- Write any fixes back to `CACHE_DIR` (not real paths)
- Understand CI commands read the real repo (no developer changes applied yet)

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4b has a conditional block gated on `DRY_RUN=true`
- Reviewer prompt text covers: read path, write path, CI caveat
- Normal reviewer path is unchanged

**Dependencies:** T2

---

## T6 — Add Dry-Run Gate to Phase 4c [templates]

**Description:**
In `templates/commands/implement.md`, insert a "Dry-Run Gate" block at the very top of Phase 4c, before the existing `GIT_AUTO` conditional. This block handles two cases:

1. `DRY_RUN=true`: Print "[dry-run] Skipping all git and backlog operations." then jump to Phase 4e.
2. `APPLY_MODE=true`: Read `.cache-manifest.json`, copy each file from `cached_path` to `real_path`, print "[apply] Copied N files.", then fall through to the existing Phase 4c logic (GIT_AUTO branch). On successful completion, delete CACHE_DIR.

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4c opens with the Dry-Run Gate block, clearly labeled
- `DRY_RUN=true` path: no git commands run, no backlog commands run, exits to Phase 4e
- `APPLY_MODE=true` path: reads manifest, copies files, proceeds to existing Phase 4c, deletes cache on success
- Existing `GIT_AUTO` and `BACKLOG_WRITE` logic is untouched and only reached when neither flag is set (or in apply mode after copy)

**Dependencies:** T2, T3, T4, T5

---

## T7 — Add Preview Report to Phase 4e [templates]

**Description:**
In `templates/commands/implement.md`, add a conditional block at the top of Phase 4e. When `DRY_RUN=true`, display the Preview Report instead of (or before) the standard pipeline table. The Preview Report includes:

- Artifacts Generated table (OpenSpec files + developer files)
- What Would Change: per-file summary from `.cache-manifest.json` (new file / modified, line delta)
- Operations Skipped: from `skipped_operations` in `.cache-manifest.json`
- Next Steps: how to apply (`/implement --apply <name>`) or discard (`rm -rf .claude/.dry-run/<name>/`)

**Files involved:**
- `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4e has a conditional block gated on `DRY_RUN=true`
- All four sections of the Preview Report are present and formatted as Markdown
- `--apply` command in Next Steps uses the correct feature name variable
- Standard report table is still shown for non-dry-run runs

**Dependencies:** T6

---

## T8 — Mirror all changes to `.claude/commands/implement.md` [commands]

**Description:**
Apply every change from T2–T7 to `.claude/commands/implement.md`. This is the active command in the specrails repo. It must be identical to the template after placeholder substitution — and since this repo has no placeholder variables left unresolved, the template and generated command should match in structure.

**Files involved:**
- `.claude/commands/implement.md`

**Acceptance criteria:**
- `.claude/commands/implement.md` contains Flag Detection (Phase 0), cache redirect (Phase 3b), merge redirect (Phase 4a), reviewer path hint (Phase 4b), Dry-Run Gate (Phase 4c), and Preview Report (Phase 4e)
- The structure and prose are consistent with the template
- No `{{PLACEHOLDER}}` tokens remain in the generated command

**Dependencies:** T2, T3, T4, T5, T6, T7

---

## T9 — Create `openspec/specs/implement.md` [core]

**Description:**
Create the missing spec file `openspec/specs/implement.md` documenting the `/implement` command's flags, cache structure, and behavior matrix as described in `delta-spec.md`.

**Files involved:**
- `openspec/specs/implement.md` (new file)

**Acceptance criteria:**
- File exists at `openspec/specs/implement.md`
- Documents `--dry-run`, `--preview`, `--apply` flags
- Includes the behavior matrix table
- Describes cache directory structure and `.cache-manifest.json` schema

**Dependencies:** T7

---

## T10 — Manual verification [core]

**Description:**
After all code tasks complete, manually verify dry-run behavior using a test invocation.

**Verification steps:**
1. Run `/implement --dry-run "test dry-run feature"` in a test context
2. Confirm no git operations fire (check `git log` and `git status`)
3. Confirm `.claude/.dry-run/test-dry-run-feature/` is created with expected files
4. Confirm preview report appears in Phase 4e output
5. Run `/implement --apply test-dry-run-feature`
6. Confirm files are copied to real locations
7. Confirm `.claude/.dry-run/test-dry-run-feature/` is deleted after successful apply
8. Confirm `.claude/.dry-run/` does not appear in `git status` (gitignore working)

**Files involved:** none (verification only)

**Acceptance criteria:**
- All 8 verification steps pass without errors

**Dependencies:** T1, T8, T9
