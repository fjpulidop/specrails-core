---
name: "Test Writer"
description: "Generate comprehensive tests for files using sr-test-writer. Pass file paths or leave empty to test all recently changed files."
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
---

# Test Writer

Invoke the `sr-test-writer` agent to generate comprehensive tests for recently changed or explicitly specified files.

**Input:** `$ARGUMENTS` — two modes:
- **Explicit paths** (comma or space separated): `src/module.ts src/utils.ts` — write tests for these specific files only.
- **Empty** (no arguments): defaults to `git diff --name-only HEAD` to discover all files changed since the last commit.

## Step 1: Resolve Files to Test

```bash
if [ -z "$ARGUMENTS" ]; then
  RESOLVED_FILES="$(git diff --name-only HEAD)"
  if [ -z "$RESOLVED_FILES" ]; then
    echo "No changed files found. Pass explicit file paths or make changes before running /specrails:test."
    exit 0
  fi
else
  # Split $ARGUMENTS on commas and spaces into a newline-separated list
  RESOLVED_FILES="$(echo "$ARGUMENTS" | tr ',' '\n' | tr ' ' '\n' | sed '/^$/d')"
fi
```

The resolved file list (`RESOLVED_FILES`) is passed to `sr-test-writer` as `IMPLEMENTED_FILES_LIST`.

## Step 2: Invoke sr-test-writer

Launch the `sr-test-writer` agent with the following inputs:

- `IMPLEMENTED_FILES_LIST:` the resolved file list from Step 1 (one file per line)
- `TASK_DESCRIPTION:` "Standalone test generation run via /specrails:test"

Run the agent in the foreground (`run_in_background: false`) and wait for completion before proceeding to Step 3.

## Step 3: Forward Results

Output the full `## Test Writer Results` block from the agent response directly to the user, including the `TEST_WRITER_STATUS:` line.

## Edge Cases

- **No files found** (empty git diff, no arguments): print a message explaining that no changed files were detected, suggest passing explicit paths, and stop without invoking the agent.
- **All files skipped**: the `sr-test-writer` agent will output `TEST_WRITER_STATUS: SKIPPED` — forward this result as-is.
- **Test framework not detected**: the agent outputs `TEST_WRITER_STATUS: SKIPPED` with reason "no test framework detected" — forward this result and suggest the user ensure a `package.json`, `pyproject.toml`, `go.mod`, or equivalent manifest exists at the project root.
