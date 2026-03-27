---
change: automated-test-writer-agent
type: design
---

# Technical Design: Automated Test Writer Agent — Standalone Command & Manager Integration

## Overview

This design covers two repos:
- **specrails** (`/Users/javi/repos/specrails`) — the installer/template repo
- **specrails-manager** (`/Users/javi/repos/specrails-manager`) — the web UI manager

The central new artifact is `templates/commands/test.md` — a command template that invokes the `sr-test-writer` agent standalone. Everything else (manager UI, tests) derives from this artifact existing.

---

## Part 1: specrails — `/specrails:test` Command Template

### File: `templates/commands/test.md`

This is the canonical template. It is copied verbatim into target repos by `install.sh` (via `cp -r "$SCRIPT_DIR/templates/"*`) and then remains as-is (it has no `{{PLACEHOLDER}}` strings because command templates in specrails are static — they do not get placeholder substitution at install time; the setup wizard only substitutes agent files).

**Wait — this requires a design decision.** Reviewing the codebase: `templates/commands/` files like `implement.md`, `batch-implement.md`, `health-check.md` all use `{{PLACEHOLDER}}` syntax that gets resolved during `/setup`. The `install.sh` copies everything to `.claude/setup-templates/`, then `/setup` applies substitutions and writes to `.claude/commands/specrails/`. Looking at the pattern more carefully:

- `install.sh`: `cp -r "$SCRIPT_DIR/templates/"* "$REPO_ROOT/.claude/setup-templates/"`
- `/setup` command then reads from `.claude/setup-templates/` and substitutes placeholders into `.claude/commands/specrails/`

However, examining `implement.md` in `templates/commands/implement.md` — it does NOT exist in that path (read attempt returned "File does not exist"). The `.claude/commands/specrails/implement.md` is the final resolved version. The templates are for the setup wizard to generate from; the `.claude/` directory contains the live copies.

For `test.md`, the command template needs zero runtime substitution — its only dynamic input is `$ARGUMENTS` which is substituted by queue-manager at spawn time. Therefore:

- `templates/commands/test.md` — template with `{{TECH_EXPERTISE}}` and `{{MEMORY_PATH}}` if referencing the agent inline. But this command file is an *orchestrator command*, not an agent file. It references the `sr-test-writer` *agent* by name. The only placeholder needed is none — the command simply invokes the agent.

**Conclusion**: `templates/commands/test.md` is a static command file (like `health-check.md`, `why.md`) with no placeholders. It has YAML frontmatter defining phases, then a prompt body that instructs the orchestrator to invoke `sr-test-writer`.

### YAML Frontmatter for `test.md`

```yaml
---
name: "Test Writer"
description: "Generate comprehensive tests for files using sr-test-writer. Pass file paths or leave empty for all changed files."
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
```

The `phases` array is consumed by `config.ts::parseFrontmatter` → passed to `QueueManager._phasesForCommand` → rendered in `PipelineProgress.tsx`. These three phases reflect what the sr-test-writer agent actually does (framework detection → test writing → output report), giving the manager meaningful progress tracking.

### Command Body

The body instructs the orchestrator (the main Claude Code session) to:
1. Parse `$ARGUMENTS` — either file paths or "all changed files"
2. Construct the `IMPLEMENTED_FILES_LIST` and `TASK_DESCRIPTION` for the agent
3. Launch `sr-test-writer` as a sub-agent
4. Forward the agent's output back to the user

The body also handles the case where `$ARGUMENTS` is empty: default to `git diff --name-only HEAD` to get changed files.

### File: `.claude/commands/specrails/test.md`

This is the specrails-self-hosted version. It is identical to `templates/commands/test.md` because test.md has no placeholders. Both files are maintained in sync.

---

## Part 2: specrails-manager — Command Discovery (No Code Changes Required)

The manager's `config.ts::scanCommands()` already scans all `.md` files in `.claude/commands/specrails/`. When `test.md` is installed into a target repo's `.claude/commands/specrails/`, it is automatically discovered, its frontmatter is parsed, and it appears in the dashboard command grid. No changes to `config.ts` are required.

---

## Part 3: specrails-manager — CommandGrid Visual Treatment

### File: `client/src/components/CommandGrid.tsx`

Add a `test` entry to `COMMAND_META` so the command card has a dedicated icon and color instead of falling back to `FALLBACK_META`.

```typescript
import { FlaskConical } from 'lucide-react'

// In COMMAND_META:
test: {
  icon: FlaskConical,
  color: 'text-dracula-cyan',
  glow: 'hover:glow-cyan hover:border-dracula-cyan/40',
},
```

`FlaskConical` is already in the lucide-react package (no new dependency). Cyan matches the `sr-test-writer` agent's `color: cyan` frontmatter, creating visual consistency.

The `test` command does NOT need a wizard (no issue picker, no branch selection). It accepts an optional file argument. The UX design is: clicking "Test Writer" opens a `TestWizard` — a small modal that accepts an optional comma-separated file path list. If the user submits with empty input, the command is spawned as `/specrails:test` (no arguments, meaning "all changed files"). If the user enters paths, it spawns `/specrails:test src/foo.ts,src/bar.ts`.

Add `test` to `WIZARD_COMMANDS`:
```typescript
const WIZARD_COMMANDS = new Set(['implement', 'batch-implement', 'test'])
```

### File: `client/src/components/TestWizard.tsx` (NEW)

A lightweight wizard modal (reusing the `Dialog` pattern from `ImplementWizard.tsx`) with:
- Title: "Run Test Writer"
- Description: "Generate tests for specific files, or leave empty to test all recently changed files."
- A text input: placeholder "src/module.ts, src/utils.ts (optional)"
- Two buttons: "Cancel" and "Run Tests"
- On submit: calls `spawnCommand('test')` with the paths as argument string, or without arguments if empty
- Shows a spinner + "Queued!" confirmation state

The wizard is small — approximately 80 lines of TSX. It follows the exact same structure as `ImplementWizard.tsx`.

### File: `client/src/pages/DashboardPage.tsx`

Add:
1. Import `TestWizard`
2. Add `wizardOpen === 'test'` handler (same pattern as `implement` and `batch-implement`)
3. Add a "Tests" section below "Recent Jobs" containing `TestRunnerWidget`

---

## Part 4: specrails-manager — TestRunnerWidget

### File: `client/src/components/TestRunnerWidget.tsx` (NEW)

This widget shows the last test-writer job result for the active project. It fetches from the existing `/jobs?limit=1&command=/specrails:test` endpoint (the `listJobs` endpoint in `project-router.ts` already supports filtering by command prefix through the `status` query param — but it does NOT support command filtering yet).

**Design decision**: Rather than adding a new API endpoint (which would touch `project-router.ts` and need tests), the widget fetches the last 20 jobs and filters client-side for `command.includes('/specrails:test')`. This is pragmatic for v1: the job list is small per project, the filter is trivial, and it avoids server-side changes. If job volume grows, a `?command=` filter can be added later.

**Widget content:**
- If no test-writer jobs exist: "No test runs yet" + a "Run Tests" button (calls `onLaunch`)
- If last job exists:
  - Status badge (completed/failed/running)
  - Command string (truncated)
  - "N turns ago" / time elapsed
  - Cost if available
  - A "Run Again" button
- If a test-writer job is currently running: show a pulsing "Running..." indicator

**Props:**
```typescript
interface TestRunnerWidgetProps {
  jobs: JobSummary[]  // passed from DashboardPage (already fetched)
  onLaunch: () => void
}
```

By accepting the already-fetched `jobs` array, the widget avoids a redundant fetch.

---

## Part 5: specrails-manager — DashboardPage Integration

The dashboard layout after this change:

```
Commands
  [Discovery section]
  [Delivery section]
  [Others section — collapsible]

Tests
  [TestRunnerWidget]

Recent Jobs
  [RecentJobs]
```

The "Tests" section appears between "Commands" and "Recent Jobs". It has the same header style as the other sections (uppercase, muted, small).

The `TestWizard` is rendered at the bottom of the page alongside `ImplementWizard` and `BatchImplementWizard`, controlled by the shared `wizardOpen` state.

---

## Part 6: Tests

### `tests/test-test-writer-template.sh` (specrails)

Bash test script following the exact structure of `tests/test-install.sh`:
- Sources `test-helpers.sh`
- Tests that `templates/agents/sr-test-writer.md` exists
- Tests that the frontmatter contains `name: sr-test-writer`
- Tests that all three required placeholders are present: `{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`
- Tests that the framework detection table is present (contains "vitest", "pytest", "go.mod")
- Tests that `TEST_WRITER_STATUS:` appears in the output format section
- Tests that `.claude/agents/sr-test-writer.md` exists (the generated instance)
- Tests that `.claude/agents/sr-test-writer.md` has NO unresolved `{{PLACEHOLDER}}` strings

### `tests/test-test-command.sh` (specrails)

Bash test script:
- Tests that `templates/commands/test.md` exists
- Tests that frontmatter contains `name:` and `description:` keys
- Tests that frontmatter contains a `phases:` array with at least one entry
- Tests that `.claude/commands/specrails/test.md` exists
- Tests that both files have identical content (template has no placeholders, so they must match)
- Tests that frontmatter is valid YAML (no parse errors — uses `python3 -c "import yaml; yaml.safe_load(open('file').read())"` if available, otherwise skips)

### `tests/run-all.sh` — update

Add the two new test scripts to the existing `run-all.sh` runner.

### `server/test-writer.test.ts` (specrails-manager)

Vitest test file following the exact structure of `config.test.ts`:

```typescript
describe('test command discovery', () => {
  it('discovers test.md when present in commands dir')
  it('parses test command frontmatter: name, description, phases')
  it('parses test command phases array correctly')
  it('test command phases include detect, write, report keys')
})
```

These tests use `vi.spyOn(fs, ...)` mocks (same pattern as `config.test.ts`) to simulate a `.claude/commands/specrails/test.md` file with the expected frontmatter and verify that `scanCommands` (exported from `config.ts`) returns the correct `CommandInfo` object with phases populated.

Note: `scanCommands` is currently not exported from `config.ts`. It must be exported as part of this change so it can be tested in isolation, without going through the full `getConfig` call.

---

## Part 7: `tests/run-all.sh` Update

The existing `run-all.sh` sources each test file. Add calls for the two new test scripts.

---

## Data Flow Summary

```
User clicks "Test Writer" in dashboard
  → TestWizard opens
  → User enters optional file paths
  → TestWizard calls POST /projects/:id/spawn { command: "/specrails:test src/foo.ts" }
  → project-router.ts → QueueManager.enqueue("/specrails:test src/foo.ts")
  → QueueManager._resolveCommand reads .claude/commands/specrails/test.md
  → strips frontmatter, substitutes $ARGUMENTS = "src/foo.ts"
  → spawns claude CLI with the resolved prompt
  → sr-test-writer agent runs (framework detect → pattern learn → write tests)
  → job events stream via WebSocket to client
  → PipelineProgress shows: Detect → Write Tests → Report
  → On completion: TestRunnerWidget shows last run summary
```

---

## Compatibility

All changes are additive. No existing command, agent, placeholder, or config key is modified. The only behavioral change is that `scanCommands` becomes a named export — but it was already an internal function, so no callers are broken.

---

## Open Questions / Resolved Ambiguities

**Q: Should `test` command open a wizard or spawn directly?**
Resolved: Wizard. The command is more useful with an optional file path argument. A direct spawn with no arguments is confusing ("what will it test?"). The wizard makes the optional-argument pattern explicit. The wizard is small and consistent with existing patterns.

**Q: Should `TestRunnerWidget` use a dedicated API endpoint or client-side filter?**
Resolved: Client-side filter over the already-fetched jobs array. Avoids server-side complexity for v1. Documented for future optimization.

**Q: Should `scanCommands` remain private or be exported?**
Resolved: Export it. It is already a pure function and is exactly what test-writer.test.ts needs to test in isolation. Exporting it follows the principle of making testable units accessible.
