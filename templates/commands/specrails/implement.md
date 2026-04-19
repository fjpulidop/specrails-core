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

#### 1. Backlog provider availability

Read `.specrails/backlog-config.json` and extract `BACKLOG_PROVIDER`.

**If `BACKLOG_PROVIDER=local`:**
```bash
[[ -f ".specrails/local-tickets.json" ]] && echo "Local tickets storage: OK" || echo "WARNING: local-tickets.json not found"
```
- Set `LOCAL_TICKETS_AVAILABLE=true/false` based on file existence.
- Set `GH_AVAILABLE=false` (GitHub CLI not needed for local provider).
- Set `BACKLOG_AVAILABLE=true` if local-tickets.json exists.

**Otherwise:**
```bash
gh auth status 2>&1
```
- Set `GH_AVAILABLE=true/false` for later phases.

#### 2. OpenSpec CLI

```bash
which openspec && openspec --version
```

- If missing: try `npm install -g @fission-ai/openspec`
- If install fails: **STOP** — openspec is required.

#### 3. Project dependencies

{{DEPENDENCY_CHECK_COMMANDS}}

#### 4. Test runner

{{TEST_RUNNER_CHECK}}

#### 5. Agent discovery

Scan the agents directory to determine which agents are installed:

```bash
ls {{SPECRAILS_DIR}}/agents/sr-*.md 2>/dev/null | sed 's|.*/||;s|\.md$||' | sort
```

Store the result as `AVAILABLE_AGENTS` (a list of agent IDs). The pipeline adapts dynamically to the installed agents:

| Agent | Role | Required? | Phase(s) affected |
|-------|------|-----------|-------------------|
| sr-architect | Architecture & design | **Core** (always present) | 3a |
| sr-developer | Full-stack implementation | **Core** (always present) | 3b |
| sr-reviewer | Generalist quality gate | **Core** (always present) | 4b |
| sr-merge-resolver | Merge conflict resolution | **Core** (always present) | 4a |
| sr-product-manager | Product exploration | Optional | 1 |
| sr-test-writer | Test generation | Optional | 3c |
| sr-doc-sync | Documentation sync | Optional | 3d |
| sr-frontend-developer | Frontend implementation | Optional | 3b (routing) |
| sr-backend-developer | Backend implementation | Optional | 3b (routing) |
| sr-frontend-reviewer | Frontend review | Optional | 4b |
| sr-backend-reviewer | Backend review | Optional | 4b |
| sr-security-reviewer | Security analysis | Optional | 4b |
| sr-performance-reviewer | Performance analysis | Optional | 4b |

**Gate rules** (applied throughout the pipeline):
- If an optional agent is NOT in `AVAILABLE_AGENTS`, **skip** that phase/sub-step silently and note `"<agent> not installed — skipping"`.
- Core agents are guaranteed to exist. If a core agent is missing, **STOP** and print: `[error] Core agent <name> not found. Run {{COMMAND_PREFIX}}enrich or reinstall.`

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
| Agents | N installed | core: 4/4, optional: M |
```

**Pass `TEST_CMD`, `BACKLOG_AVAILABLE`, and `AVAILABLE_AGENTS` forward** — all later phases must use these.

---

## Phase 0: Parse input and determine mode

### Flag Detection

Before parsing input, scan `$ARGUMENTS` for control flags:

- If `--dry-run` or `--preview` is present in `$ARGUMENTS`:
  - Set `DRY_RUN=true`
  - Strip the flag from the arguments before further parsing
  - Print: `[dry-run] Preview mode active — no git, PR, or backlog operations will run.`
  - Set `CACHE_DIR={{SPECRAILS_DIR}}/.dry-run/<kebab-case-feature-name>` (derive after parsing the remaining input)
  - Note: if a cache already exists at `CACHE_DIR`, print `[dry-run] Overwriting existing cache at CACHE_DIR` before overwriting.

- If `--apply <feature-name>` is present in `$ARGUMENTS`:
  - Set `APPLY_MODE=true`
  - Set `APPLY_TARGET=<feature-name>` (the argument immediately following `--apply`)
  - Set `CACHE_DIR={{SPECRAILS_DIR}}/.dry-run/<feature-name>`
  - Verify `CACHE_DIR` exists. If it does not: print `[apply] Error: no cached dry-run found at CACHE_DIR` and stop.
  - Skip Phases 1–4b. Go directly to Phase 4c (the apply path handles the rest).
  - Strip `--apply` and the feature name before further parsing.

- If `--confidence-override "<reason>"` is present in `$ARGUMENTS`:
  - Set `CONFIDENCE_OVERRIDE_REASON=<reason>` (the quoted string immediately following `--confidence-override`)
  - Strip `--confidence-override` and the reason before further parsing.

If none of these flags is present: `DRY_RUN=false`, `APPLY_MODE=false`, `CONFIDENCE_OVERRIDE_REASON=""`. Pipeline runs as normal.

Note: `CACHE_DIR` for `--dry-run` is finalized after the feature name is derived from the remaining input. All subsequent phases that reference `CACHE_DIR` have access to it.

Initialize conflict-tracking variables:
- `SNAPSHOTS_CAPTURED=false` — set to true in Phase 0 if issue snapshots are successfully written.
- `CONFLICT_OVERRIDES=[]` — list of conflict records where the user chose to continue; appended by Phase 3a.0 and Phase 4c.0.

---

**If the user passed a text description** (e.g. `"add feature X"`):
- **Single-feature mode**. Derive a kebab-case change name.
- Set `SINGLE_MODE = true`. No worktrees, no parallelism.
- **Skip Phase 1 and Phase 2** — go directly to Phase 3a.

**If the user passed issue/ticket references** (e.g. `#85, #71` for GitHub, `#1, #2` for local tickets, or `PROJ-85, PROJ-71` for JIRA):
- Fetch each issue/ticket:
  ```bash
  {{BACKLOG_VIEW_CMD}}
  ```
- Extract area, value, effort, and feature details from each issue body.
- If only 1 issue: set `SINGLE_MODE = true`.
- **Skip Phase 1 and Phase 2** — go directly to confirmation table.

#### Phase 0 snapshot capture

After fetching issue refs, capture a baseline snapshot for conflict detection.

##### If `BACKLOG_PROVIDER=local` and input mode was issue numbers:

For each resolved ticket ID, read `.specrails/local-tickets.json` and extract the ticket object at `tickets["{id}"]`.

Build a snapshot object for each ticket:
- `number`: ticket `id` (integer)
- `title`: ticket `title` string
- `state`: map ticket `status` — `"done"` or `"cancelled"` → `"closed"`, otherwise → `"open"`
- `assignees`: `[ticket.assignee]` if non-null, else `[]`
- `labels`: ticket `labels` array, sorted alphabetically
- `body_sha`: SHA-256 of the ticket `description` string — compute with:
  ```bash
  echo -n "{description}" | sha256sum | cut -d' ' -f1
  ```
  If `sha256sum` is not available, fall back to `openssl dgst -sha256 -r` or `shasum -a 256`.
- `updated_at`: ticket `updated_at` value
- `captured_at`: current local time in ISO 8601 format

Write the following JSON to `{{SPECRAILS_DIR}}/backlog-cache.json` (overwrite fully — this establishes a fresh baseline for this run):

```json
{
  "schema_version": "1",
  "provider": "local",
  "last_updated": "<ISO 8601 timestamp>",
  "written_by": "implement",
  "issues": {
    "<id>": { <snapshot object> },
    ...
  }
}
```

If the write succeeds: set `SNAPSHOTS_CAPTURED=true`.

If the write fails: print `[backlog-cache] Warning: could not write cache. Conflict detection disabled for this run.` and set `SNAPSHOTS_CAPTURED=false`. Do NOT abort the pipeline.

##### If `GH_AVAILABLE=true` and input mode was issue numbers (GitHub/JIRA):

For each resolved issue number, run:

```bash
gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt
```

Build a snapshot object for each issue:
- `number`: integer issue number
- `title`: issue title string
- `state`: `"open"` or `"closed"`
- `assignees`: array of assignee login names, sorted alphabetically
- `labels`: array of label names, sorted alphabetically
- `body_sha`: SHA-256 of the raw body string — compute with:
  ```bash
  echo -n "{body}" | sha256sum | cut -d' ' -f1
  ```
  If `sha256sum` is not available, fall back to `openssl dgst -sha256 -r` or `shasum -a 256`.
- `updated_at`: the `updatedAt` value from the GitHub API response
- `captured_at`: current local time in ISO 8601 format

Write the following JSON to `{{SPECRAILS_DIR}}/backlog-cache.json` (overwrite fully — this establishes a fresh baseline for this run):

```json
{
  "schema_version": "1",
  "provider": "github",
  "last_updated": "<ISO 8601 timestamp>",
  "written_by": "implement",
  "issues": {
    "<number>": { <snapshot object> },
    ...
  }
}
```

If the write succeeds: set `SNAPSHOTS_CAPTURED=true`.

If the write fails (e.g., `{{SPECRAILS_DIR}}/` directory does not exist): print `[backlog-cache] Warning: could not write cache. Conflict detection disabled for this run.` and set `SNAPSHOTS_CAPTURED=false`. Do NOT abort the pipeline.

##### Otherwise (no backlog available or non-issue input):

Set `SNAPSHOTS_CAPTURED=false`. Print: `[conflict-check] Snapshot skipped — backlog unavailable or non-issue input.`

#### Gitignore advisory

If `SNAPSHOTS_CAPTURED=true`, check whether `.gitignore` already covers the cache file:

```bash
grep -q "backlog-cache" .gitignore 2>/dev/null || \
grep -q "\{{SPECRAILS_DIR}}/" .gitignore 2>/dev/null
```

If neither pattern is found, print:

```
[backlog-cache] Suggestion: add '{{SPECRAILS_DIR}}/backlog-cache.json' to .gitignore to avoid committing ephemeral cache state.
```

This advisory is non-blocking and suppressed when `.gitignore` already covers the file.

#### Pipeline state initialization

Set `PIPELINE_STATE_PATH={{SPECRAILS_DIR}}/pipeline-state/<feature-name>.json` (use the same kebab-case feature name derived above).

Create the directory if it does not exist:

```bash
mkdir -p {{SPECRAILS_DIR}}/pipeline-state
```

Write the initial state file:

```json
{
  "schema_version": "1",
  "feature": "<feature-name>",
  "started_at": "<current ISO 8601 timestamp>",
  "updated_at": "<current ISO 8601 timestamp>",
  "phases": {
    "architect": "pending",
    "developer": "pending",
    "test-writer": "<'pending' if sr-test-writer ∈ AVAILABLE_AGENTS, else 'skipped'>",
    "doc-sync": "<'pending' if sr-doc-sync ∈ AVAILABLE_AGENTS, else 'skipped'>",
    "reviewer": "pending",
    "ship": "pending",
    "ci": "pending"
  },
  "last_successful_phase": null,
  "failed_phase": null,
  "error_context": null,
  "openspec_artifacts": "openspec/changes/<feature-name>/",
  "implemented_files": [],
  "input": {
    "issues": [<issue numbers, or null for text-description mode>],
    "flags": {
      "dry_run": <DRY_RUN>,
      "apply_mode": <APPLY_MODE>,
      "single_mode": <SINGLE_MODE>
    }
  }
}
```

If the write fails: print `[pipeline-state] Warning: could not write state file. Smart retry ({{COMMAND_PREFIX}}retry) will not be available for this run.` Set `PIPELINE_STATE_AVAILABLE=false`. Do NOT abort the pipeline.

If the write succeeds: set `PIPELINE_STATE_AVAILABLE=true`.

**State update helper** — used by all subsequent phases to record progress:

When a phase completes or fails, update `PIPELINE_STATE_PATH`:
1. Read the current file.
2. Set `phases.<phase-key>` to `"done"`, `"failed"`, or `"skipped"`.
3. If `"done"`: set `last_successful_phase` to the phase key.
4. If `"failed"`: set `failed_phase` to the phase key; set `error_context` to a one-line description of the failure (agent name, error type, exit code if known).
5. Set `updated_at` to the current ISO 8601 timestamp.
6. Overwrite the file.

If `PIPELINE_STATE_AVAILABLE=false`: skip all state updates silently.

**If the user passed area names**:
- Check for open backlog issues. If found, filter and pick top 3.
- If none, proceed to Phase 1.

---

## Phase 1: Explore (parallel)

**Only runs if Phase 0 found no backlog issues AND user passed area names AND `sr-product-manager` ∈ `AVAILABLE_AGENTS`.**

If `sr-product-manager` is not installed, skip Phase 1 and Phase 2 entirely. Print: `[phase-1] sr-product-manager not installed — skipping exploration. Proceeding with provided input.`

For each area, launch a **sr-product-manager** agent (`subagent_type: sr-product-manager`, `run_in_background: true`).

Wait for all to complete. Read their output.

## Phase 2: Select

**Only runs if Phase 1 ran.**

Pick the single idea with the best impact/effort ratio from each exploration. Present to user and wait for confirmation.

## Phase 3a.0: Pre-architect conflict check

**Guard:** If `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`, print `[conflict-check] Skipped — SNAPSHOTS_CAPTURED=false (or dry-run mode).` and proceed directly to Phase 3a.

Otherwise, re-fetch each issue in scope and diff against the Phase 0 snapshot:

**If `BACKLOG_PROVIDER=local`:** For each ticket ID in `ISSUE_REFS`, read `.specrails/local-tickets.json` and extract the ticket at `tickets["{id}"]`. If the ticket does not exist (deleted): treat as a CRITICAL conflict — field `"state"`, was `<cached state>`, now `"deleted"`. Otherwise, reconstruct a current snapshot using the same mapping as the Phase 0 local snapshot.

**If `BACKLOG_PROVIDER=github`:** For each issue number in `ISSUE_REFS`:

```bash
gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt
```

If the `gh` command returns non-zero (issue deleted or inaccessible): treat as a CRITICAL conflict — field `"state"`, was `<cached state>`, now `"deleted"`.

In both cases, reconstruct a current snapshot (same shape as Phase 0: sort `assignees` and `labels`, compute `body_sha`).

**Short-circuit:** If `current.updatedAt == cached.updated_at`, mark the issue as clean and skip field comparison.

**Field comparison** (only when `updatedAt` differs):

| Field | Conflict if... | Severity |
|-------|----------------|----------|
| `state` | value differs (`open` → `closed`) | CRITICAL |
| `state` | value differs (`closed` → `open`) | WARNING |
| `title` | string differs | WARNING |
| `assignees` | sorted array differs | WARNING |
| `labels` | sorted array differs | INFO |
| `body_sha` | SHA differs | WARNING |

Collect all conflicts across all issues. If none: print `[conflict-check] All issues clean (Phase 3a.0). Proceeding.` and continue to Phase 3a.

**If conflicts exist**, print the following report and await user input:

```
## Backlog Conflict Detected

The following issues changed since Phase 0 snapshot (captured at <captured_at>):

| Issue | Field | Severity | Was | Now |
|-------|-------|----------|-----|-----|
| #N    | state | CRITICAL | open | closed |
| #N    | body  | WARNING  | <sha-prefix> | <sha-prefix> |

How would you like to proceed?
  [A] Abort — stop the pipeline and exit cleanly
  [C] Continue — proceed despite the conflicts (logged)

Enter A or C:
```

For `body_sha` rows in the table, display only the first 8 characters of each SHA as the "Was" and "Now" values.

**Input handling:**
- Accept `A`, `a` (abort) or `C`, `c` (continue).
- Re-prompt on any other input, up to 3 times total.
- After 3 invalid inputs: print `[conflict-abort] Defaulting to abort after 3 invalid inputs.` and abort.

**On abort:** Print `[conflict-abort] Pipeline aborted. Re-run {{COMMAND_PREFIX}}implement after resolving the issues.` and exit. No git state is left behind.

**On continue:** Print `[conflict-override] Continuing. N conflict(s) logged.` Append each conflict to `CONFLICT_OVERRIDES` as `{phase: "3a.0", issue: "#N", field: "<field>", severity: "<severity>", was: "<was>", now: "<now>"}`. Proceed to Phase 3a.

## Phase 3a: Architect (parallel, in main repo)

For each chosen idea, launch an **sr-architect** agent (`subagent_type: sr-architect`, `run_in_background: true`).

Each architect creates OpenSpec artifacts in `openspec/changes/<name>/`.

Each agent's prompt should include:
- Description of the feature
- Context from exploration (if applicable)
- Instructions to create: proposal.md, design.md, delta-spec, tasks.md, context-bundle.md
- Tags for each task: {{LAYER_TAGS}}

### 3a.1 Identify shared file conflicts

**Only runs in multi-feature mode** (more than one feature). Skip entirely if `SINGLE_MODE=true`.

After all architect agents complete, before launching any developer agent:

#### Step 1: Extract file references

For each `openspec/changes/<name>/tasks.md`, extract all paths listed under `**Files:**` entries (both `Create:` and `Modify:` lines). Normalize paths: strip leading `./`.

#### Step 2: Build the shared-file registry

Group file paths across all features. Any path appearing in two or more features' task lists is a **shared file**. Store as `SHARED_FILES` map: `{path: {features: [...], risk: ""}}`.

#### Step 3: Classify risk

For each shared file, classify risk based on file type and which regions each feature modifies (consult each feature's context-bundle.md "Exact Changes" section):

| Risk | Condition |
|------|-----------|
| `low` | Both features only append new named sections not present in the other feature's changes |
| `medium` | Both features modify structurally distinct regions (different `##` sections or different top-level YAML keys) |
| `high` | Both features modify the same region (same `##` section, same YAML key subtree, or any region in shell scripts) |

Shell scripts (`.sh`, `.bash`): always `high`.
Non-existent files that two features both create: always `high`.

#### Step 4: Derive MERGE_ORDER

Sort features so that for any pair sharing a `high`-risk file, one appears before the other. Use topological sort; break ties alphabetically. Set `MERGE_ORDER` = sorted feature list.

#### Step 5: Print pre-flight report

```
## Shared File Analysis

| File | Features | Risk |
|------|----------|------|
| <path> | <feature-a>, <feature-b> | <risk> |

Merge order: <feature-a> → <feature-b> → <feature-c>

High-risk files detected. These files will be merged sequentially.
Developers will still run in parallel — merge order applies at Phase 4a only.
```

If no shared files: print `No shared files detected. All features modify independent files.`

### 3a.2 Pre-validate architect output

Quick-check each architect's artifacts:
1. tasks.md exists and has tasks
2. context-bundle.md exists
3. File references are real (>70% must exist)
4. Layer tags present on tasks

**Pipeline state:** update `architect` → `done`. If any architect agent failed (skipped area): update `architect` → `failed` with error context `"sr-architect failed for: <area-names>"`.

## Phase 3b: Implement

### Pre-flight: Verify Bash permission

Before launching any developer agent, run a trivial Bash command to confirm Bash is allowed.

### Launch developers

**Read reviewer learnings:** Check `{{SPECRAILS_DIR}}/agent-memory/sr-reviewer/common-fixes.md` and include in developer prompts.

#### Dry-Run: Redirect developer writes

**If `DRY_RUN=true`**, include the following in every developer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified files under:
>   {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. For example:
>   Real path:   src/utils/parser.ts
>   Write to:    {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/src/utils/parser.ts
>
> Do NOT write to real file paths. After writing each file, append an entry
> to {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

**If `DRY_RUN=false`**: developer agent instructions are unchanged.

#### Choosing the right developer agent

For each feature, read `openspec/changes/<name>/tasks.md` and classify every task by its layer tags and file references.

**Step 1 — Classify tasks into layers:**

For each task, determine its layer from:
1. **Explicit layer tags** in tasks.md (e.g., `[frontend]`, `[backend]`, `[core]`, `[infra]`, `[docs]`, etc.)
2. **File references** under `**Files:**` entries — apply the same extension/path rules used in Phase 4b:
   - Frontend: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`, or paths under `components/`, `pages/`, `views/`, `ui/`, `client/`, `frontend/`, `app/`, `public/`, `static/`, `assets/`
   - Backend: `.py`, `.go`, `.java`, `.rb`, `.php`, `.rs`, `.cs`, `.sql`, or paths under `server/`, `api/`, `routes/`, `controllers/`, `services/`, `models/`, `db/`, `backend/`, `migrations/`
   - Mixed/other: everything else (shell scripts, config files, markdown, YAML, etc.)

Produce three sets: `FRONTEND_TASKS`, `BACKEND_TASKS`, `OTHER_TASKS`.

**Step 2 — Route tasks to developer agents:**

Evaluate available developer agents in `AVAILABLE_AGENTS` and apply these rules in priority order:

| Condition | Agent(s) selected | Mode |
|-----------|-------------------|------|
| ALL tasks are frontend-only AND `sr-frontend-developer` ∈ `AVAILABLE_AGENTS` | **sr-frontend-developer** | Single agent for all tasks |
| ALL tasks are backend-only AND `sr-backend-developer` ∈ `AVAILABLE_AGENTS` | **sr-backend-developer** | Single agent for all tasks |
| Mix of frontend + backend tasks AND both layer-specific developers available | **sr-frontend-developer** for `FRONTEND_TASKS`, **sr-backend-developer** for `BACKEND_TASKS`, **sr-developer** for `OTHER_TASKS` | Parallel agents per layer |
| Frontend tasks exist AND `sr-frontend-developer` available, but no backend-specific developer | **sr-frontend-developer** for `FRONTEND_TASKS`, **sr-developer** for remaining | Parallel agents |
| Backend tasks exist AND `sr-backend-developer` available, but no frontend-specific developer | **sr-backend-developer** for `BACKEND_TASKS`, **sr-developer** for remaining | Parallel agents |
| No layer-specific developers available (fallback) | **sr-developer** | Single agent for all tasks |

Store the result as `DEVELOPER_ROUTING`: a map of `{agent_id: [task_list]}`.

**Step 3 — Print routing decision:**

```
## Developer Routing

| Agent | Tasks | Reason |
|-------|-------|--------|
| sr-frontend-developer | Task 1, Task 3 | Frontend-only tasks (React components) |
| sr-backend-developer  | Task 2, Task 4 | Backend-only tasks (API endpoints) |
| sr-developer          | Task 5         | Mixed layer (config + infra) |
```

Also store `DEVELOPER_AGENTS_USED` (the set of developer agent IDs actually launched) — Phase 4b will use this for reviewer selection.

#### Launch modes

For each entry in `DEVELOPER_ROUTING`, launch the assigned developer agent using its `subagent_type` (`sr:developer`, `sr:frontend-developer`, or `sr:backend-developer`) with its task subset.

**If `SINGLE_MODE` and only one agent in routing**: Launch in the main repo, foreground.
**If `SINGLE_MODE` but multiple agents in routing**: Launch agents sequentially in the main repo (one at a time, foreground), passing only their assigned tasks.
**If multiple features**: Launch in isolated worktrees (`isolation: worktree`, `run_in_background: true`).

Wait for all developers to complete.

**Pipeline state:** update `developer` → `done`. Also update `implemented_files` in the state file with the complete list of files created or modified by the developer agent(s). If developer failed: update `developer` → `failed` with error context `"<agent-id> failed: <exit code or error description>"`.

## Phase 3c: Write Tests

**Guard:** If `sr-test-writer` ∉ `AVAILABLE_AGENTS`, skip this phase. Print: `[phase-3c] sr-test-writer not installed — skipping test generation.` Update pipeline state: `test-writer` → `skipped`. Proceed to Phase 3d.

Launch a **sr-test-writer** agent (`subagent_type: sr:test-writer`) for each feature immediately after its developer completes.

Construct the agent invocation prompt to include:
- **IMPLEMENTED_FILES_LIST**: the complete list of files the developer created or modified for this feature
- **TASK_DESCRIPTION**: the original task or feature description that drove the implementation

### Launch modes

**If `SINGLE_MODE`**: Launch a single sr-test-writer agent in the foreground (`run_in_background: false`). Wait for it to complete before proceeding to Phase 4.

**If multiple features (worktrees)**: Launch one sr-test-writer agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`). Wait for all sr-test-writer agents to complete before proceeding to Phase 4.

### Dry-run behavior

**If `DRY_RUN=true`**, include in every test-writer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified test files under:
>   {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. After writing each file, append an entry
> to {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/.cache-manifest.json using:
>   {"cached_path": "...", "real_path": "...", "operation": "create"}

### Failure handling

If a test-writer agent fails or times out:
- Record `Tests: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the sr-test-writer failure is non-blocking
- Include in the reviewer agent prompt: "Note: the sr-test-writer failed for this feature. Check for coverage gaps."

**Pipeline state:** update `test-writer` → `done` (or `failed` with error context `"sr-test-writer timed out or errored"`). Failure does not block the pipeline.

## Phase 3d: Doc Sync

**Guard:** If `sr-doc-sync` ∉ `AVAILABLE_AGENTS`, skip this phase. Print: `[phase-3d] sr-doc-sync not installed — skipping doc sync.` Update pipeline state: `doc-sync` → `skipped`. Proceed to Phase 4.

Launch a **sr-doc-sync** agent (`subagent_type: sr:doc-sync`) for each feature after its tests are written.

Construct the agent invocation prompt to include:
- **IMPLEMENTED_FILES_LIST**: the complete list of files the developer created or modified for this feature
- **TASK_DESCRIPTION**: the original task or feature description that drove the implementation

### Launch modes

**If `SINGLE_MODE`**: Launch a single sr-doc-sync agent in the foreground (`run_in_background: false`). Wait for it to complete before proceeding to Phase 4.

**If multiple features (worktrees)**: Launch one sr-doc-sync agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`). Wait for all sr-doc-sync agents to complete before proceeding to Phase 4.

### Dry-run behavior

**If `DRY_RUN=true`**, include in every doc-sync agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified doc files under:
>   {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. After writing each file, append an entry
> to {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/.cache-manifest.json using:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

### Failure handling

If a doc-sync agent fails or times out:
- Record `Docs: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the sr-doc-sync failure is non-blocking
- Include in the reviewer agent prompt: "Note: the sr-doc-sync agent failed for this feature."

**Pipeline state:** update `doc-sync` → `done` (or `failed` with error context `"sr-doc-sync timed out or errored"`). Failure does not block the pipeline.

## Phase 4: Merge & Review

**This phase is fully autonomous.**

### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used). Proceed to Phase 4b.
- If `DRY_RUN=true`: apply the merge algorithm below, writing all outputs to `CACHE_DIR/<file-path>` instead of the main repo working tree. Do NOT clean up worktrees in dry-run mode.
- Otherwise: apply the merge algorithm below, writing outputs to the main repo working tree. Clean up worktrees at the end.

#### Merge Algorithm

Process features in `MERGE_ORDER` sequence. For each feature:

**Step 1: Identify changed files**

```bash
git -C <worktree-path> diff main --name-only
```

Split into `exclusive_files` (only this feature modifies them) and `shared_files_for_this_feature` (also modified by another feature in MERGE_ORDER).

**Step 2: Merge exclusive files**

Copy directly from worktree to target:
```bash
cp <worktree-path>/<file> <target>/<file>
```
Log: `Copied (exclusive): <file>`

**Step 3: Merge shared files**

For each shared file, choose strategy by file type:

**Strategy A — Markdown section-aware merge** (`.md` files):
1. Read base: current content of `<target>/<file>`.
2. Read incoming: `<worktree-path>/<file>`.
3. Parse both into sections using `##` heading boundaries (heading line + all content until next `##` or EOF).
4. Build section maps: `{heading_text: content}` for base and incoming.
5. Merge:
   - Section in base only: keep.
   - Section in incoming only: append to merged output.
   - Section in both, content identical: keep base.
   - Section in both, content differs: insert conflict markers:
     ```
     <<<<<<< <feature-name>
     <incoming section content>
     =======
     <base section content>
     >>>>>>> base
     ```
     Log: `CONFLICT: <file> — section "<heading>" requires manual resolution.`
6. Write merged result to `<target>/<file>`.

**Strategy B — Unified diff sequential apply** (all other file types):
1. Generate incoming diff against original `main`:
   ```bash
   git -C <worktree-path> diff main -- <file>
   ```
2. Apply to current target:
   ```bash
   patch --forward --fuzz=3 <target>/<file> < <diff>
   ```
3. If `patch` succeeds: log `Merged (diff-apply): <file>`.
4. If `patch` fails: insert conflict markers around rejected hunks. Log: `CONFLICT: <file> — N hunks rejected.`

If `patch` is not available (detected in Phase -1): use Strategy A for all file types and print: `[warn] patch not available — using section-aware fallback for all shared files.`

**Step 4: Record outcomes**

Maintain `MERGE_REPORT`:
- `cleanly_merged`: exclusive files + shared files with no conflicts
- `auto_resolved`: shared files merged without conflict markers
- `requires_resolution`: `{file, feature, regions}` for files with conflict markers

**Step 5: Emit initial merge report**

After all features are processed, print the preliminary report:

```
## Phase 4a Merge Report (preliminary)

### Cleanly Merged
- <file> (exclusive to <feature>)

### Auto-Resolved
- <file> (features: <a>, <b> — distinct sections)

### Requires Resolution (N file(s))
- <file> (features: <a>, <b> — conflicting section: "<heading>")
```

**Step 5a: Smart conflict resolution** (skip if `SINGLE_MODE=true` or `DRY_RUN=true` or `sr-merge-resolver` ∉ `AVAILABLE_AGENTS`)

If `sr-merge-resolver` is not installed, print: `[smart-merge] sr-merge-resolver not installed — skipping automatic resolution. Fix conflicts manually.` and skip to Step 5b.

If `MERGE_REPORT.requires_resolution` is non-empty:

```
[smart-merge] N file(s) have conflict markers. Launching sr-merge-resolver…
```

Build `CONTEXT_BUNDLES` from the features in `MERGE_ORDER`:
```
{ "<feature-a>": "openspec/changes/<feature-a>/context-bundle.md", "<feature-b>": "openspec/changes/<feature-b>/context-bundle.md" }
```

Load merge resolver config from `{{SPECRAILS_DIR}}/merge-resolver-config.json` if it exists. Extract `confidence_threshold` (default: 70) and `mode` (default: `auto`).

Construct the `sr-merge-resolver` agent prompt with:
- `CONFLICTED_FILES`: all file paths in `MERGE_REPORT.requires_resolution`
- `CONTEXT_BUNDLES`: the map above
- `CONFIDENCE_THRESHOLD`: from config or default (70)
- `RESOLUTION_MODE`: from config or default (`auto`)
- `REPORT_PATH`: `openspec/changes/<first-feature-in-MERGE_ORDER>/merge-resolution-report.md`

Launch the **sr-merge-resolver** agent (`subagent_type: sr-merge-resolver`, foreground, `run_in_background: false`). Wait for it to complete.

Read `MERGE_RESOLUTION_STATUS` from the agent's output (`CLEAN`, `PARTIAL`, or `UNRESOLVED`).

**Post-resolution: update MERGE_REPORT**

For each file in `MERGE_REPORT.requires_resolution`:
- Re-scan the file for remaining `<<<<<<<` markers.
- If none remain: move the file from `requires_resolution` → `auto_resolved` (with note: `smart-resolver`).
- If markers remain: keep in `requires_resolution`.

**Step 5b: Emit final merge report**

```
## Phase 4a Merge Report

### Cleanly Merged
- <file> (exclusive to <feature>)

### Auto-Resolved
- <file> (features: <a>, <b> — distinct sections)
- <file> (smart-resolver: additive-concat, confidence 92)

### Requires Manual Resolution
- <file> (features: <a>, <b> — low-confidence: see merge-resolution-report.md)
  Search for `<<<<<<< <feature-name>` to locate conflict markers.

Pipeline will continue. Fix remaining conflicts before the reviewer runs CI.
Resolution report: openspec/changes/<feature>/merge-resolution-report.md
```

If `MERGE_REPORT.requires_resolution` is now empty: print `All conflicts resolved by smart resolver.` and omit the "Requires Manual Resolution" section.

**Step 6: Clean up worktrees** (skip if `DRY_RUN=true`)

```bash
git worktree remove <worktree-path> --force
```

Pass `MERGE_REPORT` to the Phase 4b reviewer agent prompt, listing any files in `requires_resolution`. If the smart resolver ran, also pass the path to `merge-resolution-report.md` so the reviewer can inspect resolution decisions for correctness.

### 4b. Layer Dispatch and Review

#### Step 1: Layer Classification

Before launching any reviewer, classify `MODIFIED_FILES_LIST` into layer-specific file sets.

**Frontend files** — a file is frontend if any of these conditions match:
- Extension is one of: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.sass`, `.less`, `.html`, `.htm`
- Extension is `.js` or `.ts` AND path contains one of: `components/`, `pages/`, `views/`, `ui/`, `client/`, `frontend/`, `app/`
- Path starts with: `public/`, `static/`, `assets/`

Set `FRONTEND_FILES` = files matching frontend rules.

**Backend files** — a file is backend if any of these conditions match:
- Extension is one of: `.py`, `.go`, `.java`, `.rb`, `.php`, `.rs`, `.cs`, `.sql`
- Extension is `.js` or `.ts` AND path contains one of: `server/`, `api/`, `routes/`, `controllers/`, `services/`, `models/`, `db/`, `backend/`
- Path is under: `migrations/`, `alembic/`, `db/migrate/`

Set `BACKEND_FILES` = files matching backend rules.

**Overlap rule:** a file may appear in both `FRONTEND_FILES` and `BACKEND_FILES` (e.g., a Next.js API route at `pages/api/`). Both reviewers will scan it independently.

#### Step 2: Determine which reviewers to launch

A layer reviewer is launched when **both** conditions are met:
1. There are files to review for that layer (file classification) **OR** the corresponding layer developer was used in Phase 3b (`DEVELOPER_AGENTS_USED`)
2. The reviewer agent is installed (`∈ AVAILABLE_AGENTS`)

| Reviewer | Launch condition | Skip reason |
|----------|-----------------|-------------|
| sr-frontend-reviewer | (`FRONTEND_FILES` non-empty OR `sr-frontend-developer` ∈ `DEVELOPER_AGENTS_USED`) AND installed | No frontend files + no frontend developer used, or not installed |
| sr-backend-reviewer | (`BACKEND_FILES` non-empty OR `sr-backend-developer` ∈ `DEVELOPER_AGENTS_USED`) AND installed | No backend files + no backend developer used, or not installed |
| sr-security-reviewer | Installed | Not installed |
| sr-performance-reviewer | Installed | Not installed |

If a reviewer is skipped, set its report variable to `"SKIPPED"` and note the reason.

#### Step 3: Launch Layer Reviewers in Parallel

Launch all applicable layer reviewers in parallel (`run_in_background: true`), using the corresponding `subagent_type` for each (`sr:frontend-reviewer`, `sr:backend-reviewer`, `sr:security-reviewer`, `sr:performance-reviewer`):

**sr-frontend-reviewer** (`subagent_type: sr:frontend-reviewer`, if applicable per Step 2):
- Pass `FRONTEND_FILES_LIST`: the list of files in `FRONTEND_FILES`
- Pass `PIPELINE_CONTEXT`: brief description of what was implemented

**sr-backend-reviewer** (`subagent_type: sr:backend-reviewer`, if applicable per Step 2):
- Pass `BACKEND_FILES_LIST`: the list of files in `BACKEND_FILES`
- Pass `PIPELINE_CONTEXT`: brief description of what was implemented

**sr-security-reviewer** (`subagent_type: sr:security-reviewer`, if applicable per Step 2):
- Pass `MODIFIED_FILES_LIST`: the complete list of all files created or modified during this run
- Pass `PIPELINE_CONTEXT`: brief description of what was implemented
- Pass the exemptions config path: `{{SPECRAILS_DIR}}/security-exemptions.yaml`

**sr-performance-reviewer** (`subagent_type: sr:performance-reviewer`, if applicable per Step 2):
- Pass `MODIFIED_FILES_LIST`: the complete list of all files created or modified during this run
- Pass `PIPELINE_CONTEXT`: brief description of what was implemented

Wait for all launched layer reviewers to complete before proceeding to Step 4.

Parse status lines from each completed reviewer:
- `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` or `CLEAN` → set `FRONTEND_STATUS`
- `BACKEND_REVIEW_STATUS: ISSUES_FOUND` or `CLEAN` → set `BACKEND_STATUS`
- `SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN` → set `SECURITY_BLOCKED=true` if `BLOCKED`, otherwise `false`

If a layer reviewer fails or times out: set the relevant report variable to `"ERROR: reviewer did not complete"` and continue.

#### Step 4: Launch Generalist Reviewer

Construct the generalist reviewer's invocation prompt with layer reports injected. Set each variable to the full output of the corresponding reviewer, or to the string `"SKIPPED"` if that reviewer was not launched:

- `FRONTEND_REVIEW_REPORT`: full output of frontend-reviewer (or `"SKIPPED"`)
- `BACKEND_REVIEW_REPORT`: full output of backend-reviewer (or `"SKIPPED"`)
- `SECURITY_REVIEW_REPORT`: full output of security-reviewer

Include in the reviewer prompt:
- Full CI commands
- Cross-feature merge issue checks
- Instruction to record learnings to `common-fixes.md`
- Instruction to archive completed changes via OpenSpec
- The three layer report variables substituted into the `[injected]` slots in the reviewer agent template

Note: if total layer report length is very large, truncate each layer report to its findings tables only (omit skipped-file logs) to stay within prompt limits.

**The security gate (blocking ship on `SECURITY_STATUS: BLOCKED`) is enforced in Phase 4c.** Do not apply it here.

Launch the **sr-reviewer** agent (`subagent_type: sr:reviewer`, foreground, `run_in_background: false`). Wait for it to complete.

**Pipeline state:** update `reviewer` → `done` (or `failed` with error context `"sr-reviewer timed out or did not complete"` if the agent errored out).

**If `DRY_RUN=true`**, add the following to the reviewer agent prompt:

> Note: This is a dry-run review. Developer files are under {{SPECRAILS_DIR}}/.dry-run/\<feature-name\>/.
> Read modified files from there. Write any reviewer fixes back to CACHE_DIR (not real paths).
> CI commands may be run — they read the real repo, but be aware developer changes are not
> yet applied to real paths.

### 4b-conf. Confidence Gate

After the generalist reviewer agent completes, evaluate the confidence score before proceeding to Phase 4c.

**In multi-feature mode (worktrees):** run this gate once per feature immediately after that feature's reviewer completes. Each feature is evaluated independently — a block on one feature does not prevent another feature's gate from running.

#### Step 1 — Read score file

Path: `openspec/changes/<name>/confidence-score.json`

- If the file does not exist:
  - Set `CONFIDENCE_STATUS=MISSING`
  - Print: `[confidence] Warning: confidence-score.json not found. Proceeding without gate.`
  - Continue to Phase 4c.

#### Step 2 — Read config

Path: `{{SPECRAILS_DIR}}/confidence-config.json`

- If the file does not exist:
  - Use built-in defaults (overall: 70; type_correctness: 60; pattern_adherence: 60; test_coverage: 60; security: 75; architectural_alignment: 60).
  - Print:
    ```
    [confidence] No confidence-config.json found. Using built-in defaults.
    [confidence] To customize thresholds, create {{SPECRAILS_DIR}}/confidence-config.json.
    ```
- If `enabled: false` in the config:
  - Print: `[confidence] Gate disabled. Skipping.`
  - Set `CONFIDENCE_STATUS=DISABLED`
  - Continue to Phase 4c.

#### Step 3 — Compare scores

- Check `overall` against `thresholds.overall`.
- Check each of the five aspects against `thresholds.aspects.<aspect>`.
- Collect all breaches as a list: `{aspect, actual_score, threshold, delta}`.

#### Step 4 — Apply on_breach

**If no breaches:**
- Print: `[confidence] All scores meet thresholds. Proceeding.`
- Set `CONFIDENCE_STATUS=PASS`
- Continue to Phase 4c.

**If breaches exist and `on_breach: "block"`:**

1. Check for `--confidence-override`:
   - If `CONFIDENCE_OVERRIDE_REASON` is non-empty and `override_allowed: true` in the config:
     - Print: `[confidence] Override accepted. Reason: <CONFIDENCE_OVERRIDE_REASON>. Proceeding with gate bypassed.`
     - Set `CONFIDENCE_STATUS=OVERRIDE`
     - Continue to Phase 4c.
   - If `CONFIDENCE_OVERRIDE_REASON` is non-empty but `override_allowed: false` in the config:
     - Print: `[confidence] Override is disabled in confidence-config.json.`
     - (Fall through to block below.)
   - If `CONFIDENCE_OVERRIDE_REASON` is empty or override was rejected:
     - Print the Breach Report (see format below).
     - Set `CONFIDENCE_BLOCKED=true`
     - Set `CONFIDENCE_STATUS=BLOCKED`
     - **Halt: do not proceed to Phase 4c.**

**If breaches exist and `on_breach: "warn"`:**
- Print the Breach Report.
- Set `CONFIDENCE_STATUS=WARN`
- Continue to Phase 4c.

#### Breach Report Format

```
## Confidence Gate: BLOCKED

The reviewer's confidence scores do not meet configured thresholds.

| Aspect | Score | Threshold | Delta |
|--------|-------|-----------|-------|
| <aspect> | <actual> | <threshold> | <delta (negative)> |

### Reviewer Notes on Low-Scoring Aspects

**<aspect> (<score>):** <note from confidence-score.json>

### Flags

- <flag-1>
- <flag-2>
(omit this section if flags array is empty)

### Next Steps

1. Address the concerns above and re-run `{{COMMAND_PREFIX}}implement`.
2. Or, if you have reviewed the concerns and accept the risk, re-run with an override:
   `{{COMMAND_PREFIX}}implement #N --confidence-override "reason"`

Pipeline halted. No git operations have been performed.
```

#### Dry-Run Behavior

When `DRY_RUN=true`, the reviewer still writes `confidence-score.json` (it is an OpenSpec artifact, not a git artifact). Phase 4b-conf still evaluates the score. If `CONFIDENCE_BLOCKED=true`, add to `.cache-manifest.json` under `skipped_operations`:
```
"confidence-gate: blocked — Phase 4c skipped"
```

### Phase 4c.0: Pre-ship conflict check

**Guard:** If `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`, print `[conflict-check] Skipped — SNAPSHOTS_CAPTURED=false (or dry-run mode).` and proceed directly to Phase 4c.

This check is independent of Phase 3a.0. Even if the user chose to continue through a conflict at Phase 3a.0, this gate re-checks all in-scope issues against the Phase 0 snapshot. It is the final gate before any code reaches git.

Re-fetch each issue in `ISSUE_REFS` and diff against `{{SPECRAILS_DIR}}/backlog-cache.json` using the same algorithm as Phase 3a.0:

**If `BACKLOG_PROVIDER=local`:** Read `.specrails/local-tickets.json` and extract each ticket by ID.

**If `BACKLOG_PROVIDER=github`:**
```bash
gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt
```

If the cache file is missing or malformed JSON at this point: log `[conflict-check] Warning: cache file missing or unreadable. Skipping diff for this run.` and proceed to Phase 4c (treat as clean).

Apply the same short-circuit (`updatedAt` match → clean), field comparison, and severity classification as Phase 3a.0.

If all issues are clean: print `[conflict-check] All issues clean (Phase 4c.0). Proceeding.` and continue.

If conflicts exist: print the same conflict report format as Phase 3a.0 (with `Phase 4c.0` context) and await `A`/`C` input (same re-prompt and default-abort logic).

**On abort:** Print `[conflict-abort] Pipeline aborted. Re-run {{COMMAND_PREFIX}}implement after resolving the issues.` and exit. No git operations have been performed at this point.

**On continue:** Print `[conflict-override] Continuing. N conflict(s) logged.` Append each conflict to `CONFLICT_OVERRIDES` as `{phase: "4c.0", issue: "#N", field: "<field>", severity: "<severity>", was: "<was>", now: "<now>"}`. Proceed to Phase 4c.

### 4c. Ship — Git & backlog updates

**Security gate:** If `SECURITY_BLOCKED=true`:
1. Print all Critical findings from the security-reviewer output
2. Do NOT create a branch, commit, push, or PR
3. Print: "Pipeline blocked by security findings. Fix the Critical issues listed above and re-run {{COMMAND_PREFIX}}implement."
4. Skip to Phase 4e.

### Dry-Run Gate

**If `DRY_RUN=true`:**
Print: `[dry-run] Skipping all git and backlog operations.`
Record skipped operations to `.cache-manifest.json` under `skipped_operations`:
- `"git: branch creation (feat/<name>)"`
- `"git: commit"`
- `"git: push"`
- `"github: pr creation"` (if `GH_AVAILABLE=true`)
- If `BACKLOG_PROVIDER=local` and `BACKLOG_WRITE=true`:
  - `"local: ticket comment #{id}"` for each ticket in scope
  - `"local: ticket status update #{id}"` for each fully resolved ticket
- If `BACKLOG_PROVIDER=github` and `BACKLOG_WRITE=true`:
  - `"github: issue comment #N"` for each issue in scope
  - `"github: issue close #N (via PR merge)"` for each fully resolved issue

Then skip the rest of Phase 4c and proceed directly to Phase 4e.

**If `APPLY_MODE=true`:**
1. Read `.cache-manifest.json` from `CACHE_DIR`.
2. For each entry in `files`: copy `cached_path` to `real_path`, creating directories as needed.
3. Print: `[apply] Copied N files from {{SPECRAILS_DIR}}/.dry-run/<feature-name>/ to real locations.`
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
- For fully resolved issues/tickets: add a comment noting completion and reference the PR:
  ```bash
  {{BACKLOG_COMMENT_CMD}}
  ```
  - **Local:** Update the ticket status to `"done"` using `{{BACKLOG_UPDATE_CMD}}` and add a comment: `"Implemented in PR #XX. All acceptance criteria met."` via `{{BACKLOG_COMMENT_CMD}}`. Local tickets are closed directly — there is no auto-close-on-merge mechanism.
  - **GitHub:** `gh issue comment {number} --body "Implemented in PR #XX. All acceptance criteria met."` — do NOT close the issue explicitly. Use `Closes #N` in the PR body so GitHub auto-closes on merge.
  - **JIRA:** `jira issue comment {key} --message "Implemented in PR #XX. All acceptance criteria met."`
  - For GitHub/JIRA: ensure the PR body includes `Closes #N` for each fully resolved issue (auto-closes on merge)
- For partially resolved issues/tickets: add a comment noting progress:
  ```bash
  {{BACKLOG_PARTIAL_COMMENT_CMD}}
  ```
  - **Local:** Additionally update the ticket status to `"in_progress"` via `{{BACKLOG_UPDATE_CMD}}` if it is still `"todo"`.

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

**Pipeline state:** update `ship` → `done` if git operations and PR creation succeeded, or `failed` with error context describing which step failed (e.g. `"git push failed: <exit code>"`, `"gh pr create failed"`, `"security gate blocked ship"`). If `DRY_RUN=true`: update `ship` → `skipped`.

### 4d. Monitor CI

**Only if `GIT_AUTO=true` and code was pushed.**

Check CI status after pushing. Fix failures (up to 2 retries).

**Pipeline state:** update `ci` → `done` if CI passed, or `failed` with error context `"CI failed after 2 retries: <summary>"`. If CI was not run (`GIT_AUTO=false` or dry-run): update `ci` → `skipped`.

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
| Developer files | {{SPECRAILS_DIR}}/.dry-run/\<name\>/ (N files) |

### What Would Change

[For each file in `.cache-manifest.json` `files` array:]
- `<real_path>` — [new file / modified] ([approximate line delta if available])

### Confidence

| | |
|-|--|
| Score file | `openspec/changes/<name>/confidence-score.json` |
| Gate result | `<CONFIDENCE_STATUS>` (PASS / WARN / BLOCKED / OVERRIDE / MISSING / DISABLED) |
| Overall score | `<overall score from confidence-score.json, or N/A if MISSING/DISABLED>` |

### Operations Skipped

[List items from `.cache-manifest.json` `skipped_operations` array]

### Next Steps

To apply these changes and ship:
```
{{COMMAND_PREFIX}}implement --apply <feature-name>
```

To discard this dry run:
```
rm -rf {{SPECRAILS_DIR}}/.dry-run/<feature-name>/
```

---

**Otherwise**, show the standard pipeline table:

```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Frontend | Backend | Confidence | Security | CI | Conflicts | Status |
|------|---------|-------------|-----------|-----------|-------|------|----------|----------|---------|------------|----------|----|-----------|--------|
```

Confidence column values:

| Value | Meaning |
|-------|---------|
| `PASS (82)` | All scores met thresholds; overall score shown in parens |
| `WARN (62)` | Scores below threshold but `on_breach=warn`; overall score in parens |
| `BLOCKED (62)` | Gate blocked the pipeline; overall score in parens |
| `OVERRIDE (62)` | Gate bypassed by `--confidence-override`; overall score in parens |
| `MISSING` | `confidence-score.json` not found after reviewer completed |
| `DISABLED` | Gate disabled via `enabled: false` in config |

If `CONFIDENCE_OVERRIDE_REASON` is non-empty, append a `### Confidence Override` section below the table:

```
### Confidence Override

**Reason:** <CONFIDENCE_OVERRIDE_REASON>
```

Column values:
- **Frontend**: `CLEAN`, `ISSUES`, or `SKIPPED` (no frontend files in changeset)
- **Backend**: `CLEAN`, `ISSUES`, or `SKIPPED` (no backend files in changeset)
- **Security**: `CLEAN`, `WARNINGS`, `BLOCKED`, or `SKIPPED`

The `Conflicts` column values:
- `skipped` — `SNAPSHOTS_CAPTURED=false` (non-issue input or GH unavailable)
- `clean` — both conflict checks ran and found no changes
- `overridden (N)` — user chose Continue at one or both gates; N is the total number of conflict records in `CONFLICT_OVERRIDES`

If `MERGE_REPORT.requires_resolution` is non-empty, print an additional section:

```
### Merge Conflicts Requiring Resolution

| File | Features | Conflicting Region | Resolver Status |
|------|----------|--------------------|-----------------|
| <file> | <feature-a>, <feature-b> | <section heading or hunk description> | LOW_CONFIDENCE / SKIPPED |

Fix these conflicts (search for `<<<<<<<` in each file), then commit the resolved files.
To retry smart resolution after addressing context: `{{COMMAND_PREFIX}}merge-resolve --files <file>`
```

If `CONFLICT_OVERRIDES` is non-empty, print:

```
## Conflict Overrides

The following backlog conflicts were detected but overridden by the user:

| Phase | Issue | Field | Severity | Was | Now |
|-------|-------|-------|----------|-----|-----|
| 3a.0  | #42   | state | CRITICAL | open | closed |
```

If `CONFLICT_OVERRIDES` is empty or `SNAPSHOTS_CAPTURED=false`: omit the `## Conflict Overrides` section entirely. Do not print an empty table or a "No conflict overrides" line.

Include the shipping mode in the report:
- If automatic: show PR URL, CI status, backlog updates made
- If manual: show summary of changes, suggested git commands, backlog updates pending

---

## Error Handling

- If a sr-product-manager fails: skip that area, continue with others
- If a sr-architect fails: skip that area, report the failure
- If a sr-developer fails: report which phase it failed at
- If the sr-reviewer finds unfixable issues: report them, push what works
- If Phase 4c (ship) fails: report the failure
- Never block the entire pipeline on a single agent failure. Always produce a final report.
