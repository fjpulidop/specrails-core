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

```bash
# No project dependencies to check yet (pre-code phase)
echo "No project dependencies to check"
```

#### 4. Test runner

```bash
# No test runner configured yet
echo "No test runner configured"
```

### Summary

Print a setup report:

```
## Environment Setup
| Tool | Status | Notes |
|------|--------|-------|
| GitHub CLI | ok/missing | Backlog provider |
| OpenSpec | ok | ... |
| Dependencies | ok | Pre-code phase, no deps |
| Test runner | n/a | Not configured yet |
```

**Pass `TEST_CMD` (or equivalent) and `BACKLOG_AVAILABLE` forward** — all later phases must use these.

---

## Phase 0: Parse input and determine mode

**If the user passed a text description** (e.g. `"add feature X"`):
- **Single-feature mode**. Derive a kebab-case change name.
- Set `SINGLE_MODE = true`. No worktrees, no parallelism.
- **Skip Phase 1 and Phase 2** — go directly to Phase 3a.

**If the user passed issue/ticket references** (e.g. `#85, #71`):
- Fetch each issue:
  ```bash
  gh issue view {number} --json number,title,labels,body
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
- Tags for each task: `[core]`, `[templates]`, `[cli]`

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

#### Choosing the right developer agent

All tasks currently route to the full-stack **developer** agent since the project doesn't have separate backend/frontend layers yet.

#### Launch modes

**If `SINGLE_MODE`**: Launch in the main repo, foreground.
**If multiple features**: Launch in isolated worktrees (`isolation: worktree`, `run_in_background: true`).

Wait for all developers to complete.

## Phase 4: Merge & Review

**This phase is fully autonomous.**

### 4a. Merge worktree changes to main repo

If `SINGLE_MODE`: skip. Otherwise copy feature-specific files, merge shared files manually, clean up worktrees.

### 4b. Launch Reviewer agent

Launch a single **reviewer** agent to validate ALL merged changes. Include:
- Full CI commands
- Cross-feature merge issue checks
- Record learnings to `common-fixes.md`
- Archive completed changes via OpenSpec

### 4c. Ship — Git & backlog updates

This phase uses **automatic** shipping (GIT_AUTO=true) and **read & write** backlog access (BACKLOG_WRITE=true).

#### Git operations

1. Create branch from `main`: `git checkout -b feat/<descriptive-name>`
2. One commit per feature with descriptive messages
3. If the reviewer modified files, create an additional commit: `fix: resolve CI issues (reviewer)`
4. Push with `-u` flag: `git push -u origin <branch-name>`
5. Create PR (if GitHub CLI is available):
   ```bash
   gh pr create --title "feat: <short description>" --body "$(cat <<'EOF'
   ## Summary
   <bullets>

   ## Changes
   <file list>

   ## Test plan
   <checklist>

   ---
   Implemented via `/implement` pipeline (architect → developer → reviewer)
   EOF
   )"
   ```
   If `gh` is not authenticated, print a compare URL for manual PR creation.

#### Backlog updates

- For fully resolved issues: add a comment noting completion and reference the PR:
  ```bash
  gh issue comment {number} --body "Implemented in PR #XX. All acceptance criteria met."
  ```
- For partially resolved issues: add a comment noting progress:
  ```bash
  gh issue comment {number} --body "Partial progress: [description]. Remaining work: [description]."
  ```

### 4d. Monitor CI

Check CI status after pushing. Fix failures (up to 2 retries).

### 4e. Report

```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Tests | CI | Status |
|------|---------|-------------|-----------|-----------|----------|-------|----|--------|
```

Include PR URL, CI status, and backlog updates made.

---

## Error Handling

- If a product-manager fails: skip that area, continue with others
- If an architect fails: skip that area, report the failure
- If a developer fails: report which phase it failed at
- If the reviewer finds unfixable issues: report them, push what works
- Never block the entire pipeline on a single agent failure. Always produce a final report.
