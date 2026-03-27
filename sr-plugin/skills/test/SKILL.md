---
name: test
description: "Generate comprehensive tests for files using sr:test-writer. Pass file paths or leave empty to test all recently changed files. Accepts: file paths, globs, or empty for git-changed files."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---

# Test Generator

Generate comprehensive tests for implementation files using the `sr:test-writer` agent.

**Input:** $ARGUMENTS
- File paths: `/specrails:test src/api/users.ts src/utils/auth.ts`
- Glob: `/specrails:test "src/**/*.ts"`
- Empty: `/specrails:test` — tests all files changed since last commit

---

## Step 1: Determine target files

**If $ARGUMENTS is provided:**
- Parse the arguments as file paths or a glob pattern
- Expand any globs to a list of files
- Validate each file exists

**If $ARGUMENTS is empty:**
```bash
git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only --cached
```
- Use the list of changed files as the target
- Filter out test files (*.test.*, *.spec.*, _test.go, spec/**)
- Filter out non-code files (*.md, *.json, *.yaml, *.lock)

If no files remain after filtering: print "No implementation files to test." and stop.

---

## Step 2: Confirm scope

Print the list of files that will be tested:

```
Generating tests for:
  src/api/users.ts
  src/utils/auth.ts

Launch sr:test-writer? [Y/n]
```

---

## Step 3: Launch sr:test-writer

Launch the **`sr:test-writer`** agent (`subagent_type: sr:test-writer`, foreground).

Provide this context in the prompt:
```
IMPLEMENTED_FILES_LIST:
<list of target files, one per line>

TASK_DESCRIPTION:
Generate comprehensive tests for the files listed above. Target >80% coverage. Follow existing test patterns in this project.
```

Wait for the agent to complete.

---

## Step 4: Report results

Display the TEST_WRITER_STATUS from the agent output and summarize:
- Which test files were written
- Which files were skipped and why
- Any issues encountered
