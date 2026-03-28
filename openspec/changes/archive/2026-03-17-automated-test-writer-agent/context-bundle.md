---
change: automated-test-writer-agent
type: context-bundle
---

# Context Bundle: Automated Test Writer Agent — Standalone Command & Manager Integration

This document is a complete, self-contained context package for the sr-developer agent implementing this change. Read this document before touching any file.

---

## What You Are Building

You are implementing a standalone `/specrails:test` command that lets users invoke the existing `sr-test-writer` agent independently, and adding manager UI support for it. The agent template already exists — you are not creating a new agent. You are creating the command orchestrator and the manager UI.

**Repos involved:**
- `/Users/javi/repos/specrails` — command template files, agent template, bash tests
- `/Users/javi/repos/specrails-manager` — TypeScript server and React client

---

## Architecture Context

### How specrails commands work

1. `install.sh` copies `templates/` to `.claude/setup-templates/` in the target repo
2. `/setup` runs and writes adapted versions to `.claude/commands/specrails/`
3. `templates/commands/test.md` — this is the SOURCE. It has no `{{PLACEHOLDER}}` strings.
4. `.claude/commands/specrails/test.md` — this is the LIVE COPY for specrails itself.
5. Both files are identical (no substitution needed for command files that reference agents by name).

### How the manager discovers commands

`server/config.ts::scanCommands(commandsDir)` reads all `.md` files in `.claude/commands/specrails/`, parses YAML frontmatter, and returns `CommandInfo[]`. The `phases` array in frontmatter is used by `PipelineProgress.tsx` in `JobDetailPage.tsx`.

When `test.md` exists with a `phases` array, the manager automatically shows 3 phase indicators when a `/specrails:test` job is running.

### How the manager spawns commands

`CommandGrid.tsx` calls `POST /spawn { command: "/specrails:test" }` → `project-router.ts` → `QueueManager.enqueue` → `_resolveCommand` reads `.claude/commands/specrails/test.md`, strips frontmatter, substitutes `$ARGUMENTS`, passes to `claude` CLI.

The `sr-test-writer` agent is invoked BY the `/specrails:test` command body. The command runs in the main Claude Code session (the orchestrator). The orchestrator then spawns the `sr-test-writer` sub-agent.

---

## Files to Read Before Implementing

### In specrails:
- `/Users/javi/repos/specrails/templates/agents/sr-test-writer.md` — the agent you are orchestrating (understand its inputs and output format)
- `/Users/javi/repos/specrails/.claude/commands/specrails/implement.md` — lines 1-60 — see how a command references an agent
- `/Users/javi/repos/specrails/tests/test-helpers.sh` — the test harness you must use
- `/Users/javi/repos/specrails/tests/test-install.sh` — exact pattern your tests must follow

### In specrails-manager:
- `/Users/javi/repos/specrails-manager/server/config.ts` — `scanCommands` function (lines 164-198), `parseFrontmatter` (lines 81-158)
- `/Users/javi/repos/specrails-manager/server/config.test.ts` — exact test pattern to follow
- `/Users/javi/repos/specrails-manager/client/src/components/CommandGrid.tsx` — add `test` to `COMMAND_META` and `WIZARD_COMMANDS`
- `/Users/javi/repos/specrails-manager/client/src/components/ImplementWizard.tsx` — the wizard pattern to follow
- `/Users/javi/repos/specrails-manager/client/src/pages/DashboardPage.tsx` — where to integrate new sections
- `/Users/javi/repos/specrails-manager/client/src/components/RecentJobs.tsx` — see how `JobSummary` is rendered (use same Badge variants)
- `/Users/javi/repos/specrails-manager/client/src/types.ts` — `JobSummary`, `CommandInfo`, `PhaseDefinition` types

---

## Critical Facts

### sr-test-writer agent inputs

The agent expects these in its invocation prompt:
- `IMPLEMENTED_FILES_LIST` — the list of files to write tests for
- `TASK_DESCRIPTION` — what the implementation was about

Your command body must construct and pass these to the agent.

### sr-test-writer agent output

The agent always ends with:
```
TEST_WRITER_STATUS: DONE|SKIPPED|FAILED
```

Your command body should forward the `## Test Writer Results` block to the user.

### `phases` frontmatter parsing

`parseFrontmatter` in `config.ts` handles nested YAML arrays. The `phases` array format that is parsed correctly:
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

Each item must start with `  - key:` (two spaces, dash, space). Continuation properties must start with `    ` (four spaces). This is critical — malformed indentation causes phases to be silently dropped.

### `scanCommands` export

`config.ts` line 164: `function scanCommands(...)` — add `export` keyword. No other changes to `config.ts`.

### TestWizard spawn API call

The `/spawn` endpoint is at `${getApiBase()}/spawn` (not project-scoped in single-project mode). In hub mode it is at `${getApiBase()}/projects/${projectId}/spawn`. Use the `getApiBase()` helper from `../lib/api` — it handles the routing automatically (same as `ImplementWizard.tsx`).

Check `ImplementWizard.tsx` to see the exact `fetch` call pattern.

### `glass-card` CSS class

Used in `CommandGrid.tsx` for command cards. Use it in `TestRunnerWidget.tsx` outer container for visual consistency. It is a Tailwind utility class defined in the project's CSS.

### `formatDistanceToNow`

Import from `date-fns`:
```typescript
import { formatDistanceToNow } from 'date-fns'
```

`date-fns` is already a dependency — do not add it again.

### No new npm dependencies

Do not install any new packages. All required UI primitives (`Dialog`, `Button`, `Input`, `Badge`) are already present in `client/src/components/ui/`.

---

## Exact File Paths (absolute)

### Files to CREATE:
- `/Users/javi/repos/specrails/templates/commands/test.md`
- `/Users/javi/repos/specrails/.claude/commands/specrails/test.md`
- `/Users/javi/repos/specrails/tests/test-test-writer-template.sh`
- `/Users/javi/repos/specrails/tests/test-test-command.sh`
- `/Users/javi/repos/specrails-manager/server/test-writer.test.ts`
- `/Users/javi/repos/specrails-manager/client/src/components/TestWizard.tsx`
- `/Users/javi/repos/specrails-manager/client/src/components/TestRunnerWidget.tsx`

### Files to MODIFY:
- `/Users/javi/repos/specrails/tests/run-all.sh` — add 2 new test script lines
- `/Users/javi/repos/specrails-manager/server/config.ts` — add `export` to `scanCommands`
- `/Users/javi/repos/specrails-manager/client/src/components/CommandGrid.tsx` — add `test` to COMMAND_META and WIZARD_COMMANDS, import FlaskConical
- `/Users/javi/repos/specrails-manager/client/src/pages/DashboardPage.tsx` — add TestWizard, TestRunnerWidget, "Tests" section

### Files NOT to modify:
- `templates/agents/sr-test-writer.md` — agent already exists, do not change
- `.claude/agents/sr-test-writer.md` — already exists, do not change
- `install.sh` — no changes needed (templates are copied wholesale)
- `server/project-router.ts` — no server-side API changes needed
- `server/queue-manager.ts` — no changes needed

---

## Test Framework Details

### specrails bash tests

The test runner uses `run_test "name" function`. Each function must return 0 on success and non-zero on failure. Use `assert_*` helpers from `test-helpers.sh`. The `setup_test_env` creates a temp dir; `teardown_test_env` cleans it up — both called automatically by `run_test`.

For tests that read files from the specrails repo itself (not the temp dir), use `$SPECRAILS_DIR` (set in `test-helpers.sh` as the parent of the `tests/` directory).

Scripts must be executable: `chmod +x tests/test-test-writer-template.sh tests/test-test-command.sh`

### specrails-manager Vitest tests

```bash
cd /Users/javi/repos/specrails-manager
npx vitest run server/test-writer.test.ts
```

Test file location follows existing convention: co-located with source file (`server/test-writer.test.ts` next to `server/config.ts`).

All mocks use `vi.spyOn(fs, 'existsSync')`, etc. Do NOT use real filesystem. Do NOT call real CLI commands. Follow `config.test.ts` pattern exactly.

---

## Verification Commands

Run these after implementation to verify correctness:

```bash
# specrails: check for broken placeholders in new command files
grep -r '{{[A-Z_]*}}' /Users/javi/repos/specrails/templates/commands/test.md
grep -r '{{[A-Z_]*}}' /Users/javi/repos/specrails/.claude/commands/specrails/test.md

# specrails: verify files are identical
diff /Users/javi/repos/specrails/templates/commands/test.md \
     /Users/javi/repos/specrails/.claude/commands/specrails/test.md

# specrails: run all bash tests
cd /Users/javi/repos/specrails && bash tests/run-all.sh

# specrails-manager: TypeScript check
cd /Users/javi/repos/specrails-manager && npx tsc --noEmit

# specrails-manager: run all server tests
cd /Users/javi/repos/specrails-manager && npx vitest run

# specrails-manager: run just the new test file
cd /Users/javi/repos/specrails-manager && npx vitest run server/test-writer.test.ts
```

---

## Known Gotchas

1. **`FlaskConical` icon**: Verify it exists in the installed version of lucide-react before using. Run: `node -e "const l = require('lucide-react'); console.log('FlaskConical' in l)"` in the manager directory.

2. **YAML frontmatter indentation**: The `parseFrontmatter` parser is strict about indentation. `phases` items must use exactly `  - key:` (2 spaces + dash + space). Properties of each item must use exactly `    label:` (4 spaces). Test by checking `scanCommands` returns 3 phases in `test-writer.test.ts`.

3. **Identical files**: `templates/commands/test.md` and `.claude/commands/specrails/test.md` must be byte-for-byte identical. The test in `D2` diffs them. If you introduce any difference (even a trailing newline), the test fails.

4. **`getApiBase()` in wizard**: Do not hardcode `/spawn`. Use `${getApiBase()}/spawn` exactly as `ImplementWizard.tsx` does.

5. **`run-all.sh` uses `bash`**: Each test script is run as a subshell via `bash "$SCRIPT_DIR/test-foo.sh" || TOTAL_EXIT=1`. Do NOT use `source`. Each script calls `print_summary` and `exit "$TESTS_FAILED"` at the end, and `run-all.sh` sets `TOTAL_EXIT=1` if any script exits non-zero.

6. **TestRunnerWidget receives `jobs` from DashboardPage**: Do NOT add a separate fetch inside `TestRunnerWidget`. The prop is `jobs: JobSummary[]`, not a loading hook. The filtering (`j.command.includes('/specrails:test')`) happens inside the widget.
