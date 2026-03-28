---
change: automated-test-writer-agent
type: tasks
---

# Tasks: Automated Test Writer Agent — Standalone Command & Manager Integration

Tasks are ordered by dependency. Execute tasks within the same group in parallel where possible.

---

## Group A — specrails: Core Command Files

These tasks are independent and can run in parallel.

---

### Task A1 — Create `templates/commands/test.md` [specrails]

**Description:** Create the canonical `/specrails:test` command template. This is a static command file (no `{{PLACEHOLDER}}` substitution needed — it references `sr-test-writer` by agent name). The file is copied verbatim into target repos by `install.sh`.

**File to create:** `/Users/javi/repos/specrails/templates/commands/test.md`

**Required frontmatter:**
```yaml
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
```

**Required body sections (in order):**

1. `# Test Writer` — h1 title
2. Brief description of the command's purpose (1-2 sentences)
3. `**Input:** $ARGUMENTS` — describe the two modes: explicit file paths (comma/space separated), or empty (defaults to changed files)
4. `## Step 1: Resolve Files to Test` — bash block showing: if `$ARGUMENTS` is empty, run `git diff --name-only HEAD`; if git diff is also empty, output a message and stop; otherwise use `$ARGUMENTS` split into a list
5. `## Step 2: Invoke sr-test-writer` — instructions to launch the `sr-test-writer` agent with:
   - `IMPLEMENTED_FILES_LIST:` the resolved file list from Step 1
   - `TASK_DESCRIPTION:` "Standalone test generation run via /specrails:test"
   - Note: run in foreground (`run_in_background: false`), wait for completion
6. `## Step 3: Forward Results` — output the full `## Test Writer Results` block from the agent response directly to the user
7. `## Edge Cases` — what to do when: no files found, all files skipped, test framework not detected

**Acceptance criteria:**
- File exists at the specified path
- YAML frontmatter is valid (no parse errors)
- `phases` array contains exactly 3 items with keys: `detect`, `write`, `report`
- Body references `sr-test-writer` by name (the Claude Code agent name)
- Body describes argument handling: empty = changed files, non-empty = explicit paths
- No `{{PLACEHOLDER}}` strings appear anywhere in the file
- File uses kebab-case naming (`test.md`)

**Dependencies:** None

---

### Task A2 — Create `.claude/commands/specrails/test.md` [specrails]

**Description:** Create the specrails-self-hosted version of the `/specrails:test` command. Since `test.md` has no placeholders, this file is identical to `templates/commands/test.md`.

**File to create:** `/Users/javi/repos/specrails/.claude/commands/specrails/test.md`

**Content:** Copy the exact content from `templates/commands/test.md` (same file, no substitutions applied).

**Acceptance criteria:**
- File exists at the specified path
- Content is byte-for-byte identical to `templates/commands/test.md`
- YAML frontmatter is valid
- No `{{PLACEHOLDER}}` strings appear anywhere

**Dependencies:** Task A1 (must have the template content first)

---

## Group B — specrails-manager: Server-Side

### Task B1 — Export `scanCommands` from `config.ts` [manager-server]

**Description:** The `scanCommands` function in `server/config.ts` is currently an internal (non-exported) function. Export it so it can be unit-tested in isolation in `server/test-writer.test.ts`.

**File to modify:** `/Users/javi/repos/specrails-manager/server/config.ts`

**Change:** Add `export` keyword to the `scanCommands` function declaration.

Before:
```typescript
function scanCommands(commandsDir: string): CommandInfo[] {
```

After:
```typescript
export function scanCommands(commandsDir: string): CommandInfo[] {
```

**Acceptance criteria:**
- `scanCommands` is exported from `config.ts`
- All existing callers within `config.ts` (`getConfig` function) continue to work
- TypeScript compilation passes (`tsc --noEmit`)
- Existing tests in `config.test.ts` continue to pass

**Dependencies:** None

---

## Group C — specrails-manager: Client-Side

These tasks depend on each other in the order listed.

---

### Task C1 — Add `test` entry to `COMMAND_META` in `CommandGrid.tsx` [manager-client]

**Description:** Add a dedicated icon and color mapping for the `test` command slug so it renders with `FlaskConical` icon in cyan, instead of falling back to the generic `Play` icon.

**File to modify:** `/Users/javi/repos/specrails-manager/client/src/components/CommandGrid.tsx`

**Changes:**

1. Add `FlaskConical` to the lucide-react import:
```typescript
import {
  Rocket,
  Layers,
  ClipboardList,
  ChevronRight,
  Sparkles,
  Wrench,
  HeartPulse,
  Shield,
  HelpCircle,
  Play,
  ArrowRight,
  FlaskConical,  // ADD THIS
} from 'lucide-react'
```

2. Add `test` entry to `COMMAND_META`:
```typescript
test: {
  icon: FlaskConical,
  color: 'text-dracula-cyan',
  glow: 'hover:glow-cyan hover:border-dracula-cyan/40',
},
```

3. Add `test` to `WIZARD_COMMANDS`:
```typescript
const WIZARD_COMMANDS = new Set(['implement', 'batch-implement', 'test'])
```

**Acceptance criteria:**
- `FlaskConical` is imported from `lucide-react` (it exists in the installed version — verify with `grep -r "FlaskConical" node_modules/lucide-react/dist/ | head -1`)
- `COMMAND_META['test']` exists with `icon: FlaskConical`, `color: 'text-dracula-cyan'`
- `WIZARD_COMMANDS` includes `'test'`
- TypeScript compilation passes
- No existing command card behavior is changed

**Dependencies:** None (can run in parallel with other Group C tasks)

---

### Task C2 — Create `TestWizard.tsx` component [manager-client]

**Description:** Create a new wizard modal for the `/specrails:test` command. Users can optionally enter file paths; submitting with empty input runs the command against all changed files.

**File to create:** `/Users/javi/repos/specrails-manager/client/src/components/TestWizard.tsx`

**Reference pattern:** Follow `ImplementWizard.tsx` for Dialog structure, loading state, and error handling. The test wizard is simpler — no issue picker, no multi-step flow.

**Component interface:**
```typescript
interface TestWizardProps {
  open: boolean
  onClose: () => void
}
```

**Required UI states:**
1. **Idle**: Dialog open, text input for optional file paths, "Cancel" and "Run Tests" buttons
2. **Submitting**: "Run Tests" button shows a spinner and is disabled; input is disabled
3. **Success**: Brief "Queued!" message shown, dialog auto-closes after 800ms
4. **Error**: Error message displayed inline below the input field

**Spawn behavior:**
```typescript
// Empty input → spawn without arguments
const command = paths.trim() ? `/specrails:test ${paths.trim()}` : '/specrails:test'
// POST to /spawn with { command }
```

**Dialog text:**
- Title: "Run Test Writer"
- Description: "Generate tests for specific files, or leave empty to test all recently changed files."
- Input placeholder: "src/module.ts, src/utils.ts (optional)"
- Input label: "File Paths" (visually hidden, for accessibility)
- Submit button: "Run Tests"
- Success title: "Queued!"
- Success description: "Test writer job added to the queue."

**Acceptance criteria:**
- Component is exported as named export: `export function TestWizard(...)`
- Dialog closes on cancel, on success (after 800ms), and on backdrop click
- Empty input spawns `/specrails:test` (no trailing space or arguments)
- Non-empty input spawns `/specrails:test <trimmed input>`
- Spinner shown during submit
- Error from API shown inline
- TypeScript compilation passes
- No new npm dependencies required (uses existing `Dialog`, `Button`, `Input` from `components/ui/`)

**Dependencies:** Task C1 (needs `WIZARD_COMMANDS` to include `'test'` before wiring)

---

### Task C3 — Create `TestRunnerWidget.tsx` component [manager-client]

**Description:** Create a widget that shows the last test-writer job for the current project and provides a quick-launch button.

**File to create:** `/Users/javi/repos/specrails-manager/client/src/components/TestRunnerWidget.tsx`

**Component interface:**
```typescript
interface TestRunnerWidgetProps {
  jobs: JobSummary[]   // all recent jobs, already fetched by DashboardPage
  onLaunch: () => void // opens TestWizard
}
```

**Internal logic:**
```typescript
// Filter for test-writer jobs, take most recent
const testJobs = jobs.filter(j => j.command.includes('/specrails:test'))
const lastTestJob = testJobs[0] ?? null
const isRunning = lastTestJob?.status === 'running'
```

**Required render states:**

State 1 — No prior runs (`lastTestJob === null`):
```
[FlaskConical icon, text-dracula-cyan]  No test runs yet
                                         Run /specrails:test to generate tests for this project.
[Run Tests button → calls onLaunch]
```

State 2 — Running (`isRunning === true`):
```
[FlaskConical icon, text-dracula-cyan, pulsing]  Test run in progress...
[grey "Running" badge with pulse dot]
```

State 3 — Last run completed or failed:
```
[FlaskConical icon]  Last test run
                     [status badge]  ·  [relative time]  ·  [$cost if available]
[Run Again button → calls onLaunch]
```

**Styling requirements:**
- Use the `glass-card` CSS class for the outer container (matches existing dashboard cards)
- Status badge uses the same `<Badge>` component variant pattern as `RecentJobs.tsx`
- Time displayed via `formatDistanceToNow` from `date-fns` (already a dependency)

**Acceptance criteria:**
- Component exported as `export function TestRunnerWidget(...)`
- All three render states are implemented
- `onLaunch` is called when "Run Tests" or "Run Again" is clicked
- No fetch calls inside the component (reads from props only)
- TypeScript compilation passes
- `jobs` prop typed as `JobSummary[]` from `../types`

**Dependencies:** None (pure display component, no side effects)

---

### Task C4 — Update `DashboardPage.tsx` [manager-client]

**Description:** Wire `TestWizard` and `TestRunnerWidget` into the dashboard. Add a "Tests" section between "Commands" and "Recent Jobs".

**File to modify:** `/Users/javi/repos/specrails-manager/client/src/pages/DashboardPage.tsx`

**Changes:**

1. Add imports:
```typescript
import { TestWizard } from '../components/TestWizard'
import { TestRunnerWidget } from '../components/TestRunnerWidget'
```

2. Add `wizardOpen === 'test'` handler (no new state needed — `wizardOpen` is already `string | null`):

3. Add "Tests" section in JSX between the Commands section and Recent Jobs section:
```tsx
<section>
  <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
    Tests
  </h2>
  <TestRunnerWidget
    jobs={jobs}
    onLaunch={() => setWizardOpen('test')}
  />
</section>
```

4. Add `TestWizard` component at the bottom (alongside `ImplementWizard` and `BatchImplementWizard`):
```tsx
<TestWizard
  open={wizardOpen === 'test'}
  onClose={() => setWizardOpen(null)}
/>
```

**Resulting JSX structure:**
```
<div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
  <section> {/* Commands */} </section>
  <section> {/* Tests — NEW */} </section>
  <section> {/* Recent Jobs */} </section>
  <ImplementWizard ... />
  <BatchImplementWizard ... />
  <TestWizard ... />  {/* NEW */}
</div>
```

**Acceptance criteria:**
- "Tests" section renders between "Commands" and "Recent Jobs"
- `TestRunnerWidget` receives the `jobs` array that is already fetched
- `TestWizard` opens when `wizardOpen === 'test'`
- `TestWizard` closes on `setWizardOpen(null)`
- No new fetch calls added
- TypeScript compilation passes
- Page layout is not broken

**Dependencies:** Task C2 (`TestWizard`), Task C3 (`TestRunnerWidget`)

---

## Group D — Tests

### Task D1 — Create `tests/test-test-writer-template.sh` [tests] [specrails]

**Description:** Bash test script that validates the sr-test-writer agent template and its generated instance in specrails.

**File to create:** `/Users/javi/repos/specrails/tests/test-test-writer-template.sh`

**Structure:** Follow `tests/test-install.sh` exactly — source `test-helpers.sh`, use `run_test` wrapper, call `print_summary` at end.

**Required test functions:**

```bash
test_template_exists()
# assert_file_exists "$SPECRAILS_DIR/templates/agents/sr-test-writer.md"

test_template_has_name_frontmatter()
# assert_contains "$(cat templates/agents/sr-test-writer.md)" "name: sr-test-writer"

test_template_has_tech_expertise_placeholder()
# assert_contains "$(cat templates/agents/sr-test-writer.md)" "{{TECH_EXPERTISE}}"

test_template_has_layer_paths_placeholder()
# assert_contains "$(cat templates/agents/sr-test-writer.md)" "{{LAYER_CLAUDE_MD_PATHS}}"

test_template_has_memory_path_placeholder()
# assert_contains "$(cat templates/agents/sr-test-writer.md)" "{{MEMORY_PATH}}"

test_template_has_framework_detection_table()
# assert_contains "$(cat ...)" "vitest"
# assert_contains "$(cat ...)" "pytest"
# assert_contains "$(cat ...)" "go.mod"

test_template_has_test_writer_status_line()
# assert_contains "$(cat ...)" "TEST_WRITER_STATUS:"

test_generated_instance_exists()
# assert_file_exists "$SPECRAILS_DIR/.claude/agents/sr-test-writer.md"

test_generated_instance_no_broken_placeholders()
# Run: grep -c '{{[A-Z_]*}}' .claude/agents/sr-test-writer.md
# assert_eq "0" "$count"

test_generated_instance_has_memory_path()
# assert_contains "$(cat .claude/agents/sr-test-writer.md)" ".claude/agent-memory/sr-test-writer"
```

**File header:**
```bash
#!/bin/bash
# Tests for sr-test-writer agent template and generated instance
set -euo pipefail
```

**Acceptance criteria:**
- All test functions are defined and called via `run_test`
- Script is executable (`chmod +x`)
- Script sources `test-helpers.sh` from the same directory
- `print_summary "sr-test-writer template tests"` is called at the end
- Script ends with `exit "$TESTS_FAILED"` (exit code = number of failures)
- Running the script standalone (`bash tests/test-test-writer-template.sh`) exits 0 when all pass

**Dependencies:** None (reads existing files)

---

### Task D2 — Create `tests/test-test-command.sh` [tests] [specrails]

**Description:** Bash test script that validates the `/specrails:test` command template and its installed copy.

**File to create:** `/Users/javi/repos/specrails/tests/test-test-command.sh`

**Structure:** Follow `tests/test-install.sh` exactly.

**Required test functions:**

```bash
test_template_command_exists()
# assert_file_exists "$SPECRAILS_DIR/templates/commands/test.md"

test_template_has_name_key()
# assert_contains "$(cat templates/commands/test.md)" 'name:'

test_template_has_description_key()
# assert_contains "$(cat templates/commands/test.md)" 'description:'

test_template_has_phases_key()
# assert_contains "$(cat templates/commands/test.md)" 'phases:'

test_template_has_detect_phase()
# assert_contains "$(cat templates/commands/test.md)" 'key: detect'

test_template_has_write_phase()
# assert_contains "$(cat templates/commands/test.md)" 'key: write'

test_template_has_report_phase()
# assert_contains "$(cat templates/commands/test.md)" 'key: report'

test_template_references_sr_test_writer()
# assert_contains "$(cat templates/commands/test.md)" "sr-test-writer"

test_template_no_broken_placeholders()
# grep -c '{{[A-Z_]*}}' templates/commands/test.md → assert_eq "0"

test_installed_command_exists()
# assert_file_exists "$SPECRAILS_DIR/.claude/commands/specrails/test.md"

test_installed_matches_template()
# diff templates/commands/test.md .claude/commands/specrails/test.md
# assert_eq "0" "$?" "installed command should be identical to template"
```

**Acceptance criteria:**
- All test functions defined and called via `run_test`
- Script is executable
- Sources `test-helpers.sh`
- `print_summary "test command template tests"` at end
- Script ends with `exit "$TESTS_FAILED"`
- Running the script standalone exits 0 when all pass

**Dependencies:** Tasks A1, A2 (files must exist to test them)

---

### Task D3 — Create `server/test-writer.test.ts` [tests] [manager-server]

**Description:** Vitest test file for test-writer command discovery and `scanCommands` behavior.

**File to create:** `/Users/javi/repos/specrails-manager/server/test-writer.test.ts`

**Structure:** Follow `config.test.ts` exactly — same import patterns, `vi.mock`, `vi.spyOn` approach, `beforeEach`/`afterEach` hooks.

**Required test groups:**

```typescript
describe('scanCommands — test command', () => {
  // setup: mock fs.existsSync to return true, fs.readdirSync to return ['test.md'],
  //        fs.readFileSync to return the expected test.md frontmatter content

  it('discovers test.md and returns correct id, slug, name')
  it('parses description from frontmatter')
  it('parses phases array: 3 phases with keys detect, write, report')
  it('phase labels are: Detect, Write Tests, Report')
  it('phase descriptions are non-empty strings')
  it('returns empty phases array when frontmatter has no phases key')
  it('handles missing test.md gracefully (empty commands dir)')
  it('handles malformed frontmatter gracefully (falls back to filename-derived name)')
})
```

**Mock content to use for `fs.readFileSync`:**
```typescript
const TEST_COMMAND_FRONTMATTER = `---
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
`
```

**Import:**
```typescript
import { scanCommands } from './config'
```

Note: This import only works after Task B1 exports `scanCommands`.

**Acceptance criteria:**
- All 8 test cases are implemented
- Uses `vi.spyOn(fs, ...)` pattern, not real filesystem access
- `beforeEach` resets all mocks
- `afterEach` restores all spies
- All tests pass (`npx vitest run server/test-writer.test.ts`)
- TypeScript compilation passes

**Dependencies:** Task B1 (needs `scanCommands` exported)

---

### Task D4 — Update `tests/run-all.sh` [tests] [specrails]

**Description:** Add the two new test scripts to the test runner so they are included in CI (when CI is added) and in manual `./tests/run-all.sh` runs.

**File to modify:** `/Users/javi/repos/specrails/tests/run-all.sh`

**Change:** Add two lines calling the new test scripts, after the existing test script invocations:

```bash
bash "$SCRIPT_DIR/test-test-writer-template.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-test-command.sh" || TOTAL_EXIT=1
```

**Acceptance criteria:**
- Both new scripts are invoked by `run-all.sh`
- `./tests/run-all.sh` runs all tests without error (exit 0 when all pass)
- The ordering is: existing tests first, then the two new scripts (non-breaking append)

**Dependencies:** Tasks D1, D2

---

## Execution Order

```
Group A (parallel):
  A1 (templates/commands/test.md)
  A2 depends on A1

Group B (independent):
  B1 (export scanCommands) — independent

Group C (sequential within group):
  C1 (COMMAND_META) — independent
  C2 (TestWizard) — can start after C1
  C3 (TestRunnerWidget) — independent
  C4 (DashboardPage) — depends on C2, C3

Group D (tests — depend on their targets):
  D1 — independent (reads existing files, no new deps)
  D2 — depends on A1, A2
  D3 — depends on B1
  D4 — depends on D1, D2
```

### Minimum critical path

```
A1 → A2 → D2 → D4
B1 → D3
C1 → C2 → C4
C3 → C4
```

### Recommended parallel execution plan

**Batch 1 (all independent):** A1, B1, C1, C3, D1

**Batch 2 (depends on Batch 1):** A2, C2, D3

**Batch 3 (depends on Batch 2):** C4, D2

**Batch 4 (final verification):** D4 (run-all.sh)

---

## Verification Checklist

After all tasks are complete, verify:

- [ ] `templates/commands/test.md` exists and has valid frontmatter with 3 phases
- [ ] `.claude/commands/specrails/test.md` exists and matches the template
- [ ] `scanCommands` is exported from `server/config.ts`
- [ ] `TestWizard.tsx` opens when Test Writer card is clicked in manager
- [ ] `TestRunnerWidget.tsx` shows correct state for no-runs, running, completed
- [ ] `DashboardPage.tsx` has "Tests" section between "Commands" and "Recent Jobs"
- [ ] `tests/test-test-writer-template.sh` passes all assertions
- [ ] `tests/test-test-command.sh` passes all assertions
- [ ] `server/test-writer.test.ts` passes all 8 test cases
- [ ] `./tests/run-all.sh` exits 0
- [ ] `npx vitest run` exits 0 in specrails-manager
- [ ] TypeScript compilation passes in specrails-manager (`tsc --noEmit`)
- [ ] No broken `{{PLACEHOLDER}}` strings in any new file
