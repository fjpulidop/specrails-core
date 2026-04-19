---
name: "Smart Failure Recovery"
description: "Resume a failed {{COMMAND_PREFIX}}implement pipeline from the last successful phase without restarting from scratch."
category: Workflow
tags: [workflow, recovery, retry, resilience]
phases:
  - key: load
    label: Load State
    description: "Read pipeline state from disk and identify the resume point"
  - key: resume
    label: Resume
    description: "Execute remaining phases starting from the failed phase"
  - key: report
    label: Report
    description: "Print a final status report with outcomes and next steps"
---

Resume a failed `{{COMMAND_PREFIX}}implement` run for **{{PROJECT_NAME}}**. Reads pipeline state written by the implement pipeline to identify which phases completed and which failed, then re-executes only the remaining phases.

**MANDATORY: Follow this pipeline exactly. Do NOT skip phases or re-run phases that already succeeded. Read all context from the pipeline state file — do not rely on memory. Do not re-implement anything yourself; delegate to the same agents used by `{{COMMAND_PREFIX}}implement`.**

**Input:** $ARGUMENTS — accepted forms:

1. `<feature-name>` — kebab-case feature name matching a `{{SPECRAILS_DIR}}/pipeline-state/<feature-name>.json` file
2. `--list` — list all available pipeline state files and their current status, then exit
3. `<feature-name> --from <phase>` — force resume from a specific phase (overrides auto-detection)
4. `<feature-name> --dry-run` — override to resume in dry-run mode (no git/PR operations)

---

## Phase 0: Parse Input

Scan `$ARGUMENTS` for flags:

- `--list`: if present, set `LIST_ONLY=true`.
- `--from <phase>`: if present, set `RESUME_FROM_OVERRIDE=<phase>`. Valid values: `architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci`.
- `--dry-run`: if present, set `DRY_RUN_OVERRIDE=true`.

Extract the first positional argument (not starting with `--`) as `FEATURE_NAME`.

**If `--list`:** scan `{{SPECRAILS_DIR}}/pipeline-state/*.json`. For each file found, parse and print:

```
## Available Pipeline States

| Feature | Last Successful Phase | Failed Phase | Updated At |
|---------|----------------------|--------------|------------|
| <name>  | <phase or —>         | <phase or —> | <ISO time> |
```

If no files found: print `No pipeline state files found. Run {{COMMAND_PREFIX}}implement first.`

Exit after printing — do not proceed.

**If no positional argument and no `--list`:** print the following usage and exit:

```
Usage: {{COMMAND_PREFIX}}retry <feature-name> [--from <phase>] [--dry-run]
       {{COMMAND_PREFIX}}retry --list

Phases: architect | developer | test-writer | doc-sync | reviewer | ship | ci
```

---

## Phase 1: Load Pipeline State

Read: `{{SPECRAILS_DIR}}/pipeline-state/<FEATURE_NAME>.json`

If the file does not exist:

```
[retry] Error: no pipeline state found for "<FEATURE_NAME>".

Run {{COMMAND_PREFIX}}retry --list to see available states, or start a new run:
  {{COMMAND_PREFIX}}implement <your input>
```

Exit.

Parse the state file and set the following variables:

- `LAST_SUCCESSFUL_PHASE` ← `last_successful_phase` (may be `null`)
- `FAILED_PHASE` ← `failed_phase` (may be `null`)
- `ERROR_CONTEXT` ← `error_context` (may be `null`)
- `OPENSPEC_ARTIFACTS` ← `openspec_artifacts` (e.g. `openspec/changes/<name>/`)
- `IMPLEMENTED_FILES` ← `implemented_files` (array, may be empty)
- `ORIGINAL_ISSUES` ← `input.issues` (array of issue numbers, may be `null`)
- `ORIGINAL_INPUT_FLAGS` ← `input.flags` object
- `SINGLE_MODE` ← `input.flags.single_mode` (default `true`)
- `DRY_RUN` ← if `DRY_RUN_OVERRIDE=true` then `true`, else `input.flags.dry_run` (default `false`)
- `PHASE_STATUSES` ← `phases` map (`architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci` → `"done"`, `"failed"`, `"skipped"`, or `"pending"`)

**Validation:**

- If all phases are `"pending"`: the pipeline never reached any execution. Print:
  ```
  [retry] Warning: all phases are pending — the pipeline may not have started.
  Recommend running {{COMMAND_PREFIX}}implement instead.
  ```
  Prompt: `Proceed anyway? [y/N]`. If `n` or no response: exit.

---

## Phase 2: Status Report

Print the pipeline status:

```
## Pipeline State: <FEATURE_NAME>

| Phase        | Status  | Notes                              |
|--------------|---------|-------------------------------------|
| architect    | done    |                                     |
| developer    | done    |                                     |
| test-writer  | FAILED  | <ERROR_CONTEXT or "no details">     |
| doc-sync     | pending |                                     |
| reviewer     | pending |                                     |
| ship         | pending |                                     |
| ci           | pending |                                     |

Last successful phase : <LAST_SUCCESSFUL_PHASE or "none">
Failed phase          : <FAILED_PHASE or "—">
Error context         : <ERROR_CONTEXT or "no details recorded">
OpenSpec artifacts    : <OPENSPEC_ARTIFACTS>
Implemented files     : <count> file(s) tracked
Original input        : <issues list or "text description">
```

---

## Phase 3: Determine Resume Point

**Phase execution order (canonical):**

```
architect → developer → test-writer → doc-sync → reviewer → ship → ci
```

**If `RESUME_FROM_OVERRIDE` is set:** use it as `RESUME_PHASE`. Validate it is one of the canonical values; if not, print an error and exit.

**Otherwise, auto-detect:**

1. If `FAILED_PHASE` is set: `RESUME_PHASE = FAILED_PHASE`.
2. Else if `LAST_SUCCESSFUL_PHASE` is set: `RESUME_PHASE` = the next phase after `LAST_SUCCESSFUL_PHASE` in canonical order.
3. Else: `RESUME_PHASE = architect` (no phases completed).

Print the resume plan:

```
## Resume Plan

Resuming from phase: <RESUME_PHASE>

Phases to skip (already done):
  ✓ <phase>   (done)
  ✓ <phase>   (done)

Phases to execute:
  ► <RESUME_PHASE>    (resuming here)
  · <next-phase>
  · <next-phase>
  ...
```

Prompt the user:

```
Proceed? [Y/n]
```

If `n` or no response: exit without changes.

---

## Phase 4: Execute Remaining Phases

Execute phases in canonical order starting from `RESUME_PHASE`. For each phase:

- If its status in `PHASE_STATUSES` is `"done"` AND it precedes `RESUME_PHASE` in canonical order: **skip** — do not re-run.
- If it equals `RESUME_PHASE` or comes after: **run** it.

After each phase completes (or fails), update `{{SPECRAILS_DIR}}/pipeline-state/<FEATURE_NAME>.json`:
1. Read the current file.
2. Set `phases.<phase-key>` to `"done"` or `"failed"`.
3. If `"done"`: update `last_successful_phase`.
4. If `"failed"`: update `failed_phase` and `error_context`.
5. Update `updated_at` to current ISO 8601 timestamp.
6. Overwrite the file.

---

### 4a. Phase: architect

**Only runs if `RESUME_PHASE=architect`.**

Verify that `ORIGINAL_ISSUES` is non-empty or a text description is recoverable. If neither is available: print an error and stop — the original input is required to re-run the architect.

Launch **sr-architect** agent(s) exactly as described in Phase 3a of the implement pipeline. Pass:
- Original issue numbers from `ORIGINAL_ISSUES` (or text description if stored in state)
- Same OpenSpec output directory: `OPENSPEC_ARTIFACTS`

Wait for all architects to complete.

**Pipeline state update:** `architect` → `done` or `failed`.

---

### 4b. Phase: developer

**Runs if `RESUME_PHASE` is `architect` or `developer`.**

Before launching, verify architect artifacts exist:

```bash
ls <OPENSPEC_ARTIFACTS>tasks.md <OPENSPEC_ARTIFACTS>context-bundle.md
```

If missing and `RESUME_PHASE=developer`: print:

```
[retry] Error: architect artifacts not found at <OPENSPEC_ARTIFACTS>.
Retry from the architect phase: {{COMMAND_PREFIX}}retry <FEATURE_NAME> --from architect
```

Stop.

Launch **sr-developer** agent(s) exactly as described in Phase 3b of the implement pipeline.

- If `SINGLE_MODE=true`: launch in main repo, foreground.
- If `SINGLE_MODE=false`: launch in isolated worktrees, background.
- If `DRY_RUN=true`: use the dry-run redirect instructions from Phase 3b.

Wait for all developers to complete. Collect the list of files created or modified.

**Pipeline state update:** `developer` → `done` (also update `implemented_files` in state with the collected file list) or `failed`.

---

### 4c. Phase: test-writer

**Runs if `RESUME_PHASE` is `architect`, `developer`, or `test-writer`.**

If `IMPLEMENTED_FILES` is empty: warn but continue — the sr-test-writer will discover files from git diff.

Launch **sr-test-writer** agent(s) exactly as in Phase 3c of the implement pipeline. Pass:
- `IMPLEMENTED_FILES_LIST`: the `implemented_files` array from state
- `TASK_DESCRIPTION`: derived from `ORIGINAL_ISSUES` or architect artifacts

Wait for completion. Failure is **non-blocking** — record `FAILED` and continue to next phase.

**Pipeline state update:** `test-writer` → `done` or `failed`.

---

### 4d. Phase: doc-sync

**Runs if `RESUME_PHASE` is any phase up to and including `doc-sync`.**

Launch **sr-doc-sync** agent(s) exactly as in Phase 3d of the implement pipeline. Pass:
- `IMPLEMENTED_FILES_LIST`: the `implemented_files` array from state
- `TASK_DESCRIPTION`: derived from `ORIGINAL_ISSUES` or architect artifacts

Wait for completion. Failure is **non-blocking** — record `FAILED` and continue.

**Pipeline state update:** `doc-sync` → `done` or `failed`.

---

### 4e. Phase: reviewer

**Runs if `RESUME_PHASE` is any phase up to and including `reviewer`.**

Launch layer reviewers and the generalist sr-reviewer exactly as in Phase 4b of the implement pipeline. Pass:
- `MODIFIED_FILES_LIST`: the `implemented_files` array from state
- `PIPELINE_CONTEXT`: brief description from original input and issue titles
- Layer reports from sr-frontend-reviewer, sr-backend-reviewer, sr-security-reviewer

Wait for all to complete. Parse `SECURITY_BLOCKED`, `FRONTEND_STATUS`, `BACKEND_STATUS`.

**Run the Confidence Gate (Phase 4b-conf)** exactly as defined in the implement pipeline.

**Pipeline state update:** `reviewer` → `done` or `failed`.

---

### 4f. Phase: ship

**Runs if `RESUME_PHASE` is `ship` or `ci`.**

If `DRY_RUN=true`: skip git operations. Record skipped operations, print dry-run summary, proceed to Phase 5.

Otherwise, run Phase 4c (ship) of the implement pipeline exactly as defined:
- Security gate check (`SECURITY_BLOCKED`)
- Conflict pre-check (Phase 4c.0)
- Git branch creation, commit, push, PR creation
- Backlog updates

**Pipeline state update:** `ship` → `done` or `failed`.

---

### 4g. Phase: ci

**Runs if ship succeeded and code was pushed.**

Run Phase 4d (CI monitoring) of the implement pipeline exactly as defined. Check CI status, fix failures (up to 2 retries).

**Pipeline state update:** `ci` → `done` or `failed`.

---

## Phase 5: Report

Print the final report:

```
## Retry Complete: <FEATURE_NAME>

Resumed from: <RESUME_PHASE>
Phases executed this run: <comma-separated list>

| Phase        | Status  |
|--------------|---------|
| architect    | done    |
| developer    | done    |
| test-writer  | done    |
| doc-sync     | done    |
| reviewer     | done    |
| ship         | done    |
| ci           | done    |
```

Include PR URL if ship ran successfully.

**If any phase failed**, add:

```
## Failures

| Phase       | Error Context          |
|-------------|------------------------|
| <phase>     | <error_context>        |

Next steps:
- To retry from the failed phase: {{COMMAND_PREFIX}}retry <FEATURE_NAME> --from <failed-phase>
- To see all pipeline states: {{COMMAND_PREFIX}}retry --list
- To restart from scratch: {{COMMAND_PREFIX}}implement <original-input>
```

---

## Error Handling

| Phase | Blocking? | On failure |
|-------|-----------|------------|
| architect | **Yes** | Stop — cannot proceed without OpenSpec artifacts |
| developer | **Yes** | Stop — cannot proceed without implemented files |
| test-writer | No | Record FAILED, continue to doc-sync |
| doc-sync | No | Record FAILED, continue to reviewer |
| reviewer | No | Report findings, continue to ship |
| ship | **Yes** | Stop — report failure with git/PR context |
| ci | **Yes** | Stop — report failure with CI log and fix suggestions |
