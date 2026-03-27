# Spec: `/specrails:test` Command

## Overview

The `/specrails:test` command is a standalone invocation of the `sr-test-writer` agent. It accepts an optional argument — a comma-separated list of file paths — and runs the test writer against those files. If no argument is provided, it defaults to `git diff --name-only HEAD` to determine recently changed files.

## Input

```
/specrails:test [<file-path>, <file-path>, ...]
```

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | No | All files changed in `git diff --name-only HEAD` |
| `<file-path>` | No | Comma-separated list of specific files to test |

## Behavior

1. **Argument parsing**: If `$ARGUMENTS` is non-empty, split on commas/spaces to produce `IMPLEMENTED_FILES_LIST`. If empty, run `git diff --name-only HEAD` and use the result.
2. **Framework detection**: Delegate entirely to `sr-test-writer` agent.
3. **Pattern learning**: Delegate entirely to `sr-test-writer` agent.
4. **Test generation**: Delegate entirely to `sr-test-writer` agent.
5. **Output**: Forward the `## Test Writer Results` block from the agent directly to the user.

## Phases (YAML frontmatter)

```yaml
phases:
  - key: detect
    label: Detect
    description: "Detects test framework and reads existing test patterns"
  - key: write
    label: Write Tests
    description: "Generates test files targeting >80% coverage"
  - key: report
    label: Report
    description: "Outputs test writer results summary"
```

## Exit Behavior

The command is non-blocking in the manager. Status is reflected through the three phases:
- `detect`: sr-test-writer begins framework detection
- `write`: sr-test-writer is generating test files
- `report`: sr-test-writer has emitted `TEST_WRITER_STATUS: DONE/SKIPPED/FAILED`

## Edge Cases

| Situation | Behavior |
|-----------|----------|
| No test framework detected | Agent outputs `TEST_WRITER_STATUS: SKIPPED`. Command reports "No test framework detected." |
| All files in skip list | Agent outputs `TEST_WRITER_STATUS: SKIPPED`. Command reports skip reason. |
| File path doesn't exist | Agent writes best-effort test with `# UNTESTABLE:` comment |
| `git diff` returns empty | Command outputs "No changed files detected. Pass file paths explicitly." and exits. |

## Manager UI

### TestRunnerWidget states

**No prior runs:**
```
[FlaskConical icon]  No test runs yet
                     Run /specrails:test to generate tests for this project
[Run Tests button → opens TestWizard]
```

**Running:**
```
[FlaskConical icon, pulsing]  Test run in progress...
[Running badge with pulse dot]
```

**Last run completed or failed:**
```
[FlaskConical icon]  Last test run
                     [status badge]  ·  [relative time]  ·  [$cost if available]
[Run Again button → opens TestWizard]
```

### TestWizard states

**Idle (modal open):**
```
Title: Run Test Writer
Description: Generate tests for specific files, or leave empty to test all recently changed files.
[Text input: placeholder "src/module.ts, src/utils.ts (optional)"]
[Cancel]  [Run Tests]
```

**Submitting:** Run Tests button shows spinner, is disabled.

**Success (auto-close after 800ms):** "Queued!" message shown.

**Error:** Error message displayed inline below the input.

## Files

- `templates/commands/test.md` — canonical command template (no placeholder substitution needed)
- `.claude/commands/specrails/test.md` — specrails self-hosted copy (identical to template)
- `templates/agents/sr-test-writer.md` — the agent template invoked by this command
