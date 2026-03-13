# Implementation Pipeline

Full OpenSpec lifecycle with specialized agents: architect designs, developer implements, reviewer validates and archives. Handles 1 to N features — adapts automatically (sequential for 1, parallel with worktrees for N).

**MANDATORY: Always follow this pipeline exactly as written. NEVER skip, shortcut, or "optimize away" any phase — even if the task seems simple enough to do directly. The orchestrator MUST launch the architect, developer, and reviewer agents as specified. Do NOT implement changes yourself in the main conversation; delegate to the agents defined in each phase. No exceptions.**

**Input:** $ARGUMENTS — accepts three modes:

1. **Issue numbers** (recommended): `#85, #71, #63` — implement these specific GitHub Issues directly. Skips exploration and selection.
2. **Text description** (single feature): `"add price history chart"` — implement a single feature from a description. Skips exploration and selection.
3. **Area names** (fallback): `Analytics, UI, Testing` — explores areas and picks the best items. Only use if no backlog issues exist.

**IMPORTANT:** Before running, ensure Read/Write/Bash/Glob/Grep permissions are set to "allow" — background agents cannot request permissions interactively.

---

## Phase -1: Environment Setup (cloud pre-flight)

**This phase runs BEFORE anything else.** Detect if we're in a cloud/remote environment and ensure all required tools are available.

### Detection

Check the environment variable `CLAUDE_CODE_ENTRYPOINT`. If it contains `remote_mobile` or `remote_web`, OR if `CLAUDE_CODE_REMOTE` is `true`, we're in a **cloud environment**.

### Checks to run (sequential, fail-fast)

#### 1. GitHub CLI authentication

```bash
gh auth status 2>&1
```

- Set `GH_AVAILABLE=true/false` for later phases.

#### 2. OpenSpec CLI

```bash
which openspec && openspec --version
```

- If missing: try `npm install -g @openspec/cli`
- If install fails: **STOP** — openspec is required.

#### 3. Project dependencies

{{DEPENDENCY_CHECK_COMMANDS}}

#### 4. Test runner

{{TEST_RUNNER_CHECK}}

### Summary

Print a setup report:

```
## Environment Setup
| Tool | Status | Notes |
|------|--------|-------|
| Backlog provider | ok/missing | {{BACKLOG_PROVIDER_NAME}} |
| OpenSpec | ok | ... |
| Dependencies | ok | ... |
| Test runner | ok | ... |
```

**Pass `TEST_CMD` (or equivalent) and `BACKLOG_AVAILABLE` forward** — all later phases must use these.

---

## Phase 0: Parse input and determine mode

### Flag Detection

Before parsing input, scan `$ARGUMENTS` for control flags:

- If `--dry-run` or `--preview` is present in `$ARGUMENTS`:
  - Set `DRY_RUN=true`
  - Strip the flag from the arguments before further parsing
  - Print: `[dry-run] Preview mode active — no git, PR, or backlog operations will run.`
  - Set `CACHE_DIR=.claude/.dry-run/<kebab-case-feature-name>` (derive after parsing the remaining input)
  - Note: if a cache already exists at `CACHE_DIR`, print `[dry-run] Overwriting existing cache at CACHE_DIR` before overwriting.

- If `--apply <feature-name>` is present in `$ARGUMENTS`:
  - Set `APPLY_MODE=true`
  - Set `APPLY_TARGET=<feature-name>` (the argument immediately following `--apply`)
  - Set `CACHE_DIR=.claude/.dry-run/<feature-name>`
  - Verify `CACHE_DIR` exists. If it does not: print `[apply] Error: no cached dry-run found at CACHE_DIR` and stop.
  - Skip Phases 1–4b. Go directly to Phase 4c (the apply path handles the rest).
  - Strip `--apply` and the feature name before further parsing.

If neither flag is present: `DRY_RUN=false`, `APPLY_MODE=false`. Pipeline runs as normal.

Note: `CACHE_DIR` for `--dry-run` is finalized after the feature name is derived from the remaining input. All subsequent phases that reference `CACHE_DIR` have access to it.

---

**If the user passed a text description** (e.g. `"add feature X"`):
- **Single-feature mode**. Derive a kebab-case change name.
- Set `SINGLE_MODE = true`. No worktrees, no parallelism.
- **Skip Phase 1 and Phase 2** — go directly to Phase 3a.

**If the user passed issue/ticket references** (e.g. `#85, #71` for GitHub or `PROJ-85, PROJ-71` for JIRA):
- Fetch each issue/ticket:
  ```bash
  {{BACKLOG_VIEW_CMD}}
  ```
- Extract area, value, effort, and feature details from each issue body.
- If only 1 issue: set `SINGLE_MODE = true`.
- **Skip Phase 1 and Phase 2** — go directly to confirmation table.

**If the user passed area names**:
- Check for open backlog issues. If found, filter and pick top 3.
- If none, proceed to Phase 1.

---

## Phase 1: Explore (parallel)

**Only runs if Phase 0 found no backlog issues AND user passed area names.**

For each area, launch a **product-manager** agent (`subagent_type: product-manager`, `run_in_background: true`).

Wait for all to complete. Read their output.

## Phase 2: Select

**Only runs if Phase 1 ran.**

Pick the single idea with the best impact/effort ratio from each exploration. Present to user and wait for confirmation.

## Phase 3a: Architect (parallel, in main repo)

For each chosen idea, launch an **architect** agent (`subagent_type: architect`, `run_in_background: true`).

Each architect creates OpenSpec artifacts in `openspec/changes/<name>/`.

Each agent's prompt should include:
- Description of the feature
- Context from exploration (if applicable)
- Instructions to create: proposal.md, design.md, delta-spec, tasks.md, context-bundle.md
- Tags for each task: {{LAYER_TAGS}}

### 3a.1 Identify shared file conflicts

Before launching developers, scan all tasks.md files to identify **shared files** that multiple features will modify.

### 3a.2 Pre-validate architect output

Quick-check each architect's artifacts:
1. tasks.md exists and has tasks
2. context-bundle.md exists
3. File references are real (>70% must exist)
4. Layer tags present on tasks

## Phase 3b: Implement

### Pre-flight: Verify Bash permission

Before launching any developer agent, run a trivial Bash command to confirm Bash is allowed.

### Launch developers

**Read reviewer learnings:** Check `.claude/agent-memory/reviewer/common-fixes.md` and include in developer prompts.

#### Dry-Run: Redirect developer writes

**If `DRY_RUN=true`**, include the following in every developer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified files under:
>   .claude/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. For example:
>   Real path:   src/utils/parser.ts
>   Write to:    .claude/.dry-run/\<feature-name\>/src/utils/parser.ts
>
> Do NOT write to real file paths. After writing each file, append an entry
> to .claude/.dry-run/\<feature-name\>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

**If `DRY_RUN=false`**: developer agent instructions are unchanged.

#### Choosing the right developer agent

For each feature, analyze the tasks' layer tags:

{{DEVELOPER_ROUTING_RULES}}

#### Launch modes

**If `SINGLE_MODE`**: Launch in the main repo, foreground.
**If multiple features**: Launch in isolated worktrees (`isolation: worktree`, `run_in_background: true`).

Wait for all developers to complete.

## Phase 4: Merge & Review

**This phase is fully autonomous.**

### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo. Apply the same merge logic (copy feature-specific files, handle shared files) but destination is `CACHE_DIR/<file-path>`.
- Otherwise: merge to main repo working tree as normal (copy feature-specific files, merge shared files manually, clean up worktrees).

### 4b. Launch Reviewer agent

Launch a single **reviewer** agent to validate ALL merged changes. Include:
- Full CI commands
- Cross-feature merge issue checks
- Record learnings to `common-fixes.md`
- Archive completed changes via OpenSpec

**If `DRY_RUN=true`**, add the following to the reviewer agent prompt:

> Note: This is a dry-run review. Developer files are under .claude/.dry-run/\<feature-name\>/.
> Read modified files from there. Write any reviewer fixes back to CACHE_DIR (not real paths).
> CI commands may be run — they read the real repo, but be aware developer changes are not
> yet applied to real paths.

### 4b-sec. Launch Security Reviewer agent

After the reviewer agent completes, launch a **security-reviewer** agent (`subagent_type: security-reviewer`).

Construct the agent invocation prompt to include:
- **MODIFIED_FILES_LIST**: the complete list of files created or modified during this implementation run
- **PIPELINE_CONTEXT**: brief description — feature names and change names implemented
- The exemptions config path: `.claude/security-exemptions.yaml`

Wait for the security-reviewer to complete. Parse the final line of its output:
- `SECURITY_STATUS: BLOCKED` → set `SECURITY_BLOCKED=true`
- `SECURITY_STATUS: WARNINGS` → set `SECURITY_BLOCKED=false`, capture warning summary
- `SECURITY_STATUS: CLEAN` → set `SECURITY_BLOCKED=false`

### 4c. Ship — Git & backlog updates

**Security gate:** If `SECURITY_BLOCKED=true`:
1. Print all Critical findings from the security-reviewer output
2. Do NOT create a branch, commit, push, or PR
3. Print: "Pipeline blocked by security findings. Fix the Critical issues listed above and re-run /implement."
4. Skip to Phase 4e.

### Dry-Run Gate

**If `DRY_RUN=true`:**
Print: `[dry-run] Skipping all git and backlog operations.`
Record skipped operations to `.cache-manifest.json` under `skipped_operations`:
- `"git: branch creation (feat/<name>)"`
- `"git: commit"`
- `"git: push"`
- `"github: pr creation"` (if `GH_AVAILABLE=true`)
- `"github: issue comment #N"` for each issue in scope (if `BACKLOG_WRITE=true`)

Then skip the rest of Phase 4c and proceed directly to Phase 4e.

**If `APPLY_MODE=true`:**
1. Read `.cache-manifest.json` from `CACHE_DIR`.
2. For each entry in `files`: copy `cached_path` to `real_path`, creating directories as needed.
3. Print: `[apply] Copied N files from .claude/.dry-run/<feature-name>/ to real locations.`
4. Then proceed with Phase 4c normally (GIT_AUTO logic, backlog updates) using the real files.
5. On successful completion of Phase 4c: delete `CACHE_DIR` and print `[apply] Cache cleaned up.`
   If Phase 4c fails: preserve `CACHE_DIR` for re-run.

**Otherwise:** proceed as normal.

---

This phase respects the `GIT_AUTO` and `BACKLOG_WRITE` settings from configuration.

#### If `GIT_AUTO=true` (automatic shipping)

1. Create branch from `main`: `git checkout -b feat/<descriptive-name>`
2. One commit per feature with descriptive messages
3. If the reviewer modified files, create an additional commit: `fix: resolve CI issues (reviewer)`
4. Push with `-u` flag: `git push -u origin <branch-name>`
5. Create PR (if GitHub CLI is available):
   ```bash
   {{PR_CREATE_CMD}}
   ```
   If `gh` is not authenticated, print a compare URL for manual PR creation.

#### If `GIT_AUTO=false` (manual shipping)

Do NOT create branches, commits, or push. Instead display a summary:

```
## Changes Ready for Review

All implementation is complete and CI checks pass.

### Files Changed
- [list all modified/created files per feature]

### Suggested Next Steps
1. Review the changes: `git diff`
2. Create a branch: `git checkout -b feat/<name>`
3. Stage and commit: `git add <files> && git commit -m "feat: ..."`
4. Push and create PR manually
```

#### Backlog updates (both modes)

**If `BACKLOG_WRITE=true`:**
- For fully resolved issues/tickets: add a comment noting completion and reference the PR (if created):
  ```bash
  {{BACKLOG_COMMENT_CMD}}
  ```
  - GitHub: `gh issue comment {number} --body "Implemented in PR #XX. All acceptance criteria met."`
  - JIRA: `jira issue comment {key} --message "Implemented in PR #XX. All acceptance criteria met."` or REST API equivalent
- For partially resolved issues/tickets: add a comment noting progress:
  ```bash
  {{BACKLOG_PARTIAL_COMMENT_CMD}}
  ```

**If `BACKLOG_WRITE=false`:**
- Do NOT create, modify, or comment on any issues/tickets.
- Instead, display what the user should update manually:
  ```
  ## Backlog Updates (manual)

  The following tickets should be updated:
  | Ticket | Status | Suggested Action |
  |--------|--------|-----------------|
  | #85 / PROJ-85 | Fully implemented | Close / move to Done |
  | #71 / PROJ-71 | Partial progress | Comment: "X completed, Y remaining" |
  ```

### 4d. Monitor CI

**Only if `GIT_AUTO=true` and code was pushed.**

Check CI status after pushing. Fix failures (up to 2 retries).

If `GIT_AUTO=false`: skip — the user will push and monitor CI themselves.

### 4e. Report

**If `DRY_RUN=true`**, show this report instead of the standard pipeline table:

---

## Dry-Run Preview Report

### Artifacts Generated

| Type | Location |
|------|----------|
| OpenSpec proposal | openspec/changes/\<name\>/proposal.md |
| OpenSpec design | openspec/changes/\<name\>/design.md |
| OpenSpec tasks | openspec/changes/\<name\>/tasks.md |
| OpenSpec context-bundle | openspec/changes/\<name\>/context-bundle.md |
| Developer files | .claude/.dry-run/\<name\>/ (N files) |

### What Would Change

[For each file in `.cache-manifest.json` `files` array:]
- `<real_path>` — [new file / modified] ([approximate line delta if available])

### Operations Skipped

[List items from `.cache-manifest.json` `skipped_operations` array]

### Next Steps

To apply these changes and ship:
```
/implement --apply <feature-name>
```

To discard this dry run:
```
rm -rf .claude/.dry-run/<feature-name>/
```

---

**Otherwise**, show the standard pipeline table:

```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
|------|---------|-------------|-----------|-----------|----------|----------|-------|----|--------|
```

Include the shipping mode in the report:
- If automatic: show PR URL, CI status, backlog updates made
- If manual: show summary of changes, suggested git commands, backlog updates pending

---

## Error Handling

- If a product-manager fails: skip that area, continue with others
- If an architect fails: skip that area, report the failure
- If a developer fails: report which phase it failed at
- If the reviewer finds unfixable issues: report them, push what works
- Never block the entire pipeline on a single agent failure. Always produce a final report.
