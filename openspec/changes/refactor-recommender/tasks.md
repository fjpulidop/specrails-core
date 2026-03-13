---
change: refactor-recommender
type: tasks
---

# Tasks: Refactor Priority Recommender

All tasks are sequential. This change touches only one new file (the command template) and has no dependencies on other in-flight changes.

---

## 1. Create the Command Template

**[templates]**

**Task 1.1** — Create `templates/commands/refactor-recommender.md`

**Description:** Write the full slash command template. This is the primary deliverable. The file must include:
- YAML frontmatter block (name, description, category, tags)
- `$ARGUMENTS` handling section (path scoping and `--dry-run` flag detection)
- Phase 0: Environment pre-flight (check `gh auth status`)
- Phase 1: Scope determination (parse paths from `$ARGUMENTS`, apply default exclusions)
- Phase 2: Six-category analysis (one subsection per category, sequential)
- Phase 3: Score and rank findings (composite formula, sort, dedup check)
- Phase 4: Create GitHub Issues (label creation, duplicate prevention, issue body template)
- Phase 5: Output ranked summary table
- Dry-run mode throughout (wherever issues would be created, gate on the flag)

**Files:**
- Create: `templates/commands/refactor-recommender.md`

**Placeholders to include:**
- `{{PROJECT_NAME}}` — used in the command description header and issue footer
- `{{BACKLOG_PROVIDER_NAME}}` — used in the pre-flight section when reporting provider status

**Acceptance criteria:**
- File exists at `templates/commands/refactor-recommender.md`
- YAML frontmatter is valid and includes `name`, `description`, `category`, `tags`
- All six analysis categories are present as distinct subsections
- Scoring formula `impact * 2 + (6 - effort)` is documented inline
- `--dry-run` flag is handled: when set, no `gh issue create` commands run
- `$ARGUMENTS` path scoping is documented: when paths are provided, analysis is restricted; default exclusions (`node_modules/`, `.git/`, `.claude/`, `vendor/`) are listed
- Issue body template matches the format in design.md
- `gh label create "refactor-opportunity" --color "B60205" --force` is called before any issue creation
- Duplicate prevention logic is present (fetch existing issues with label, check dedup key)
- `{{PROJECT_NAME}}` and `{{BACKLOG_PROVIDER_NAME}}` are the only `{{...}}` placeholders
- `grep '{{[A-Z_]*}}' templates/commands/refactor-recommender.md` returns only those two placeholders

---

## 2. Install into specrails .claude/commands/

**[templates]**

**Task 2.1** — Copy command to `.claude/commands/refactor-recommender.md` with placeholders resolved

**Description:** The specrails repo self-hosts its own workflow system. After creating the template, produce the resolved copy that specrails itself uses. Replace `{{PROJECT_NAME}}` with `specrails` and `{{BACKLOG_PROVIDER_NAME}}` with `GitHub Issues`.

**Files:**
- Create: `.claude/commands/refactor-recommender.md`

**Acceptance criteria:**
- File exists at `.claude/commands/refactor-recommender.md`
- `grep '{{[A-Z_]*}}' .claude/commands/refactor-recommender.md` returns no output (no unresolved placeholders)
- Content is identical to the template except for the two placeholder substitutions

**Dependencies:** Task 1.1 must be complete.

---

## 3. Verify install.sh Coverage

**[templates]**

**Task 3.1** — Confirm no install.sh changes are needed

**Description:** Verify that `install.sh` already handles the new template file. The installer copies `templates/` to `.claude/setup-templates/` at line 319:
```bash
cp -r "$SCRIPT_DIR/templates/"* "$REPO_ROOT/.claude/setup-templates/"
```
This includes `templates/commands/refactor-recommender.md` automatically. No code change is required — only verification.

Additionally confirm that `/setup` installs all files from `.claude/setup-templates/commands/` into `.claude/commands/` with placeholder substitution. No change needed there either.

**Files:**
- Verify (no modification): `install.sh`
- Verify (no modification): `commands/setup.md`

**Acceptance criteria:**
- Read `install.sh` and confirm the wildcard copy covers the new file
- Read `commands/setup.md` and confirm the command installation phase substitutes `{{PROJECT_NAME}}` and `{{BACKLOG_PROVIDER_NAME}}`
- If either check reveals a gap, create a follow-up task to fix it before closing this task
- Document the verification result as a comment in this file (no file changes needed if all checks pass)

**Dependencies:** Task 1.1 must be complete.

---

## 4. Verification

**[templates]**

**Task 4.1** — Manual end-to-end verification on the specrails repo itself

**Description:** Run the command on the specrails codebase to validate it produces meaningful output. specrails is a good test target: it has shell scripts (outdated-pattern candidates), large Markdown command files (large-file candidates), and several functions in `install.sh` that may exceed thresholds.

**Verification steps:**
1. Run `/refactor-recommender --dry-run` from within the specrails repo
2. Confirm output shows findings in at least 3 of the 6 categories
3. Confirm each finding has: category, file, current snippet, proposed snippet, rationale, impact score, effort score, composite score
4. Confirm the ranked summary table is produced
5. Confirm no GitHub Issues are created (dry-run mode)
6. Run `/refactor-recommender install.sh` to verify path scoping restricts analysis to one file
7. Optionally run without `--dry-run` to create one real issue and verify label and body format

**Files:**
- No files modified during verification

**Acceptance criteria:**
- Steps 1-6 pass without errors
- If step 2 fails (fewer than 3 categories produce findings), adjust detection thresholds in the template and re-run
- If path scoping in step 6 analyzes files outside `install.sh`, fix the scope parsing logic

**Dependencies:** Tasks 1.1 and 2.1 must be complete.
