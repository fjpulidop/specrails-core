---
change: automated-test-writer-agent
type: delta-spec
---

# Delta Spec: Automated Test Writer Agent — Standalone Command & Manager Integration

This document specifies the exact changes to existing specs and the new specs introduced by this change.

---

## Spec 1: `/specrails:test` Command (NEW)

**File:** `openspec/specs/test-command.md` (to be created)

### Description

The `/specrails:test` command is a standalone invocation of the `sr-test-writer` agent. It accepts an optional argument — a comma-separated list of file paths — and runs the test writer against those files. If no argument is provided, it defaults to `git diff --name-only HEAD` to determine recently changed files.

### Input

```
/specrails:test [<file-path>, <file-path>, ...]
```

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | No | All files changed in `git diff --name-only HEAD` |
| `<file-path>` | No | Comma-separated list of specific files to test |

### Behavior

1. **Argument parsing**: If `$ARGUMENTS` is non-empty, split on commas/spaces to produce `IMPLEMENTED_FILES_LIST`. If empty, run `git diff --name-only HEAD` and use the result.
2. **Framework detection**: Delegate entirely to `sr-test-writer` agent.
3. **Pattern learning**: Delegate entirely to `sr-test-writer` agent.
4. **Test generation**: Delegate entirely to `sr-test-writer` agent.
5. **Output**: Forward the `## Test Writer Results` block from the agent directly to the user.

### Exit behavior

The command is non-blocking in the manager (no pipeline phases that wait on each other). Status is reflected through the three phases defined in the frontmatter:
- `detect`: sr-test-writer begins framework detection
- `write`: sr-test-writer is generating test files
- `report`: sr-test-writer has emitted `TEST_WRITER_STATUS: DONE/SKIPPED/FAILED`

### Edge cases

| Situation | Behavior |
|-----------|----------|
| No test framework detected | Agent outputs `TEST_WRITER_STATUS: SKIPPED`. Command reports "No test framework detected." |
| All files in skip list | Agent outputs `TEST_WRITER_STATUS: SKIPPED`. Command reports skip reason. |
| File path doesn't exist | Agent writes best-effort test with `# UNTESTABLE:` comment |
| `git diff` returns empty | Command outputs "No changed files detected. Pass file paths explicitly." and exits. |

---

## Spec 2: Update to `implement.md` spec — Phase 3c already documented

**File:** `openspec/specs/implement.md`

No changes required. The implement.md spec does not enumerate individual phases — it describes flags and behavior matrix. Phase 3c (test writer) is already present in the `.claude/commands/specrails/implement.md` command file from the prior archived change.

---

## Spec 3: `sr-test-writer` Agent (EXISTING — no changes)

The agent spec is the agent prompt file itself at `templates/agents/sr-test-writer.md`. No changes are required to this file. The standalone `/specrails:test` command delegates to it unchanged.

---

## Spec 4: Manager UI — TestRunnerWidget behavior

**This is a new behavioral spec, not a file spec.**

The `TestRunnerWidget` renders as follows:

### State: No prior test-writer runs

```
[FlaskConical icon]  No test runs yet
                     Run /specrails:test to generate tests for this project
[Run Tests button]
```

### State: Last run completed

```
[FlaskConical icon]  Last test run
                     completed · 4 minutes ago · $0.0123
[Run Again button]
```

### State: Last run failed

```
[FlaskConical icon]  Last test run
                     failed · 2 hours ago
[Run Again button]
```

### State: Test run currently active

```
[FlaskConical icon]  Test run in progress...
                     [pulsing dot animation]
```

The widget reads from the `jobs` prop (already fetched by `DashboardPage`). It filters for `job.command.includes('/specrails:test')` and takes the most recent result.

---

## Spec 5: Manager UI — TestWizard behavior

The `TestWizard` is a modal dialog with these states:

### Idle state (modal open)

```
Title: Run Test Writer
Description: Generate tests for specific files, or leave empty to test all recently changed files.

[Text input: placeholder "src/module.ts, src/utils.ts (optional)"]

[Cancel]  [Run Tests →]
```

### Submitting state

```
[Run Tests →] button shows spinner, disabled
```

### Success state (auto-close after 1s)

```
Title: Queued!
Description: Test writer job has been added to the queue.
```

### Error state

```
Title: Run Test Writer
[Error message shown inline below the input]
[Cancel]  [Run Tests →]
```

---

## No Spec Changes to install.sh

The installer requires no changes. Template files are copied via `cp -r "$SCRIPT_DIR/templates/"*` which is path-agnostic. Adding `templates/commands/test.md` is automatically included.
