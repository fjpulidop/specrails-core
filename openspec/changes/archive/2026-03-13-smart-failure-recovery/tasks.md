---
change: smart-failure-recovery
type: tasks
---

# Tasks: Smart Failure Recovery & Retry

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Add Failure Recovery subsection to Phase 3b in `templates/commands/implement.md` [templates]

**Description:** Insert a structured "Failure Recovery" subsection at the end of the `## Phase 3b: Implement` section in `templates/commands/implement.md`. This subsection defines the failure capture schema, classification decision table, and three retry branches (transient, code, design). It also specifies that the orchestrator reads `failure-patterns.md` from developer memory before classification.

**Files:**
- Modify: `templates/commands/implement.md`

**Specific change:** After the line "Wait for all developers to complete." in Phase 3b, insert the following subsection:

```markdown
### Failure Recovery

If a developer agent fails at any point during Phase 3b, do NOT immediately mark it FAILED. Instead:

#### Step 1: Construct FAILURE_CONTEXT

Assemble the following block from the agent's last output and the known task context:

```
FAILURE_CONTEXT:
  phase: 3b
  feature: <change-name>
  attempt: <current attempt number>
  error_summary: <one-line error description from agent output>
  error_detail: <full error output, or last 50 lines if long — note "[truncated]" if cut>
  files_in_progress: <file list from this feature's tasks.md>
  last_action: <inferred from agent's last output>
  task_description: <the task description originally passed to the agent>
```

#### Step 2: Classify the failure

Check for signals in this order:

| Type | Signals |
|---|---|
| `transient` | "rate limit", "timeout", "429", "503", "network error", "connection refused", "tool permission denied", "exceeded context window" (first occurrence only) |
| `code` | "file not found", "syntax error", "type error", "no such file", "permission denied" (filesystem), "malformed output", partial/incomplete response, "assertion failed", "test failed" |
| `design` | Agent self-reports ambiguity or contradiction; no transient or code signal matches; OR failure type is `code` on attempt 2 or later |

Default: if no signal matches, classify as `design`.

**If `.claude/agent-memory/developer/failure-patterns.md` exists:** read it before classifying. Patterns listed there take priority over the table above.

#### Step 3: Execute the retry branch

**If `transient` and attempt < 3:**
1. Print: `[recovery] Transient failure on <feature> (attempt N). Waiting Xs before retry.`
   - Backoff: attempt 1 → 15s, attempt 2 → 30s, attempt 3 → 60s
2. Run: `sleep <seconds>`
3. Re-launch the developer agent with the identical prompt.

**If `code` and attempt < 3:**
1. Print: `[recovery] Code error on <feature> (attempt N). Retrying with failure context.`
2. Prepend the following to the original task prompt:
   ```
   PREVIOUS ATTEMPT FAILED (Attempt N):

   Error: <error_summary>
   Detail: <error_detail>
   Files in progress: <files_in_progress>
   Last action: <last_action>

   Do not repeat the same approach that caused the error. Fix the issue and complete the task.

   Original task follows:
   ---
   ```
3. Re-launch the developer agent with the augmented prompt.

**If `design` (or attempt = 3 with repeated failures):**
1. Print: `[recovery] Design error or repeated failures on <feature>. Escalating to architect.`
2. Pause the developer for this feature.
3. Launch an **architect** agent (foreground, `run_in_background: false`) with:
   ```
   FAILURE ESCALATION — feature: <name>

   <FAILURE_CONTEXT block>

   Please diagnose the root cause and respond with one of:
   - REVISED_TASK: <revised task description resolving the ambiguity or contradiction>
   - NOT_IMPLEMENTABLE: <reason this task cannot be implemented as specified>
   ```
4. If architect responds `REVISED_TASK`: re-launch the developer with the revised task. Reset attempt counter to 1.
5. If architect responds `NOT_IMPLEMENTABLE`: mark feature FAILED. Record reason in Phase 4e report. Continue pipeline for other features.

#### Step 4: Record the failure pattern

After the recovery cycle completes (success or final FAILED), append or update `.claude/agent-memory/developer/failure-patterns.md`:

```
| <error signal> | <type> | <count> | <YYYY-MM-DD> | <brief note> |
```
```

**Acceptance criteria:**
- "Failure Recovery" subsection exists inside `## Phase 3b: Implement`, after "Wait for all developers to complete."
- Subsection contains all four steps: capture, classify, retry branch, record pattern
- Decision table covers all three failure types with example signals
- Backoff values are 15s / 30s / 60s
- Design escalation launches architect with `run_in_background: false`
- Pattern recording step references `.claude/agent-memory/developer/failure-patterns.md`
- All existing Phase 3b content is preserved unchanged
- No `{{PLACEHOLDER}}` strings are broken

**Dependencies:** None (can start immediately)

---

## Task 2 — Upgrade Phase 3c failure handling in `templates/commands/implement.md` [templates]

**Description:** The existing Phase 3c "Failure handling" subsection uses a simple non-blocking skip. Replace it with the full three-branch recovery protocol, adapted for test-writer failures. Specifically: design-error escalation for test-writers routes to the architect asking about refactoring for testability, and a `NOT_TESTABLE` response marks the test as skipped (not FAILED).

**Files:**
- Modify: `templates/commands/implement.md`

**Specific change:** Find the existing `### Failure handling` subsection inside `## Phase 3c: Write Tests`:

```
### Failure handling

If a test-writer agent fails or times out:
- Record `Tests: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the test-writer failure is non-blocking
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

Replace with:

```markdown
### Failure Recovery

If a test-writer agent fails, construct a `FAILURE_CONTEXT` block (same schema as Phase 3b, with `phase: 3c`), then classify and retry using the same three-branch protocol as Phase 3b, with one difference for design escalation:

**Design error escalation for test-writer:**
When escalating to the architect, use this prompt instead:

```
FAILURE ESCALATION (test-writer) — feature: <name>

<FAILURE_CONTEXT block>

The test-writer could not generate tests for the above files. Please respond with one of:
- REVISED_TASK: <refactoring guidance to make the implementation more testable>
- NOT_TESTABLE: <reason the implementation cannot be tested as written>
```

- On `REVISED_TASK`: pass the guidance to the developer as a follow-up task, then re-launch the test-writer.
- On `NOT_TESTABLE`: record `Tests: SKIPPED (NOT_TESTABLE)` in the Phase 4e report with the architect's note. Continue to Phase 4 — this is non-blocking.

For all other failure types, the same retry limits (max 3 attempts) apply. Final FAILED status after 3 failed attempts records `Tests: FAILED` in the report.
```

**Acceptance criteria:**
- Old simple-skip "Failure handling" subsection is fully replaced
- New subsection is titled "Failure Recovery" for consistency with Phase 3b
- Design escalation message is specific to test-writers (asks about testability, not general revision)
- `NOT_TESTABLE` outcome maps to `Tests: SKIPPED (NOT_TESTABLE)`, not `Tests: FAILED`
- Retry cap of 3 still applies
- All existing Phase 3c content outside this subsection is preserved unchanged

**Dependencies:** Task 1 (establishes the recovery pattern; Task 2 references it)

---

## Task 3 — Add Retries column to Phase 4e report table in `templates/commands/implement.md` [templates]

**Description:** The Phase 4e report table currently has these columns: `Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status`. Add a `Retries` column between `Tests` and `Reviewer`. Also add a "Recovery Notes" subsection to Phase 4e that surfaces failure details when any feature was FAILED or required design escalation.

**Files:**
- Modify: `templates/commands/implement.md`

**Specific change:**

Find the Phase 4e report table line:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

Replace with:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Retries | Reviewer | Security | CI | Status |
```

Then, after the table block, add:

```markdown
### Recovery Notes

If any feature was marked FAILED or required design escalation, list them here:

| Feature | Final Attempt | Failure Type | Resolution | Notes |
|---|---|---|---|---|
| <name> | 3/3 | code | FAILED | <last error summary> |
| <name> | 1/1 | design | Escalated — architect revised task | Succeeded on retry |

Omit this section if no features required recovery.
```

**Acceptance criteria:**
- `Retries` column exists between `Tests` and `Reviewer` in the Phase 4e table
- "Recovery Notes" subsection exists after the table
- Recovery Notes table has columns: Feature, Final Attempt, Failure Type, Resolution, Notes
- "Omit this section if no features required recovery" instruction is present
- Existing table format and surrounding content are preserved

**Dependencies:** Task 1 (establishes retry concept)

---

## Task 4 — Create `failure-patterns.md` memory file for developer agent [core]

**Description:** Create `.claude/agent-memory/developer/failure-patterns.md` — the initial (empty) failure pattern registry. This file is read by the orchestrator at the start of Phase 3b to supplement the generic classifier, and written to after each recovery cycle.

**Files:**
- Create: `.claude/agent-memory/developer/failure-patterns.md`

**Content:**
```markdown
# Developer Agent Failure Patterns

Patterns observed during pipeline recovery. Updated after each recovery cycle by the orchestrator.

## Pattern Registry

| Error Signal | Type | Observed Count | Last Seen | Notes |
|---|---|---|---|---|

No patterns recorded yet.
```

**Acceptance criteria:**
- File exists at `.claude/agent-memory/developer/failure-patterns.md`
- Contains the Pattern Registry table header with correct columns
- Contains "No patterns recorded yet." placeholder
- No other content

**Dependencies:** None (can run in parallel with all other tasks)

---

## Task 5 — Add failure-pattern recording protocol to `templates/agents/developer.md` [templates]

**Description:** The developer agent template needs a section that instructs the agent to record failure patterns to memory after each recovery cycle. This is analogous to the reviewer's "record learnings to common-fixes.md" instruction.

**Files:**
- Modify: `templates/agents/developer.md`

**Specific change:** Read the existing `templates/agents/developer.md`. Locate the memory protocol section (likely near the end, referencing `{{MEMORY_PATH}}`). After that section, add:

```markdown
## Failure Pattern Recording

If this agent invocation was a recovery retry (i.e., the prompt contains a "PREVIOUS ATTEMPT FAILED" block), after completing the task:

1. Read `{{MEMORY_PATH}}/failure-patterns.md`.
2. Find the row matching the error signal from the failed attempt.
3. If a row exists: increment the `Observed Count`, update `Last Seen` to today's date, and add any new insight to `Notes`.
4. If no row exists: append a new row with `Observed Count: 1`, today's date, and a brief note about what fixed the issue.
5. Write the updated file back.

This is non-blocking: if writing fails, continue. Never let memory writes interrupt implementation.
```

**Acceptance criteria:**
- "Failure Pattern Recording" section exists in `templates/agents/developer.md`
- Section references `{{MEMORY_PATH}}/failure-patterns.md`
- Section instructs: read → find/insert row → update count and date → write back
- "Non-blocking" caveat is present
- Section is positioned after the main memory protocol section
- Existing template content is preserved; no placeholders are broken

**Dependencies:** Task 4 (establishes the target file)

---

## Task 6 — Apply Task 5 changes to `.claude/agents/developer.md` [templates]

**Description:** Apply the same failure-pattern recording protocol from Task 5 to `.claude/agents/developer.md` (the specrails-adapted generated instance). In this file, `{{MEMORY_PATH}}` is already resolved to `.claude/agent-memory/developer/`. Use the resolved path directly.

**Files:**
- Modify: `.claude/agents/developer.md`

**Specific change:** Same section as Task 5, with `{{MEMORY_PATH}}` replaced by `.claude/agent-memory/developer/`.

**Acceptance criteria:**
- "Failure Pattern Recording" section exists in `.claude/agents/developer.md`
- References `.claude/agent-memory/developer/failure-patterns.md` (not `{{MEMORY_PATH}}`)
- Section content matches Task 5 exactly except for the resolved path
- No unresolved `{{PLACEHOLDER}}` strings remain in the file

**Dependencies:** Task 5 (content pattern established by template edit)

---

## Task 7 — Apply Tasks 1, 2, 3 changes to `.claude/commands/implement.md` [core]

**Description:** Apply all three template-level changes (Tasks 1, 2, 3) to `.claude/commands/implement.md`, the specrails-adapted generated instance. The generated copy has resolved placeholders; apply the same logical sections in their resolved form.

**Files:**
- Modify: `.claude/commands/implement.md`

**Specific changes:**
- Same "Failure Recovery" subsection insertion in Phase 3b (Task 1)
- Same Phase 3c "Failure Recovery" replacement (Task 2)
- Same Phase 4e table update with `Retries` column and "Recovery Notes" subsection (Task 3)

**Acceptance criteria:**
- All three changes from Tasks 1, 2, 3 are present in `.claude/commands/implement.md`
- No template placeholders (`{{...}}`) are introduced — this is a fully resolved instance
- Phase 3b failure recovery references `.claude/agent-memory/developer/failure-patterns.md` directly (not a placeholder)
- Phase 4e table columns match the template: `Developer | Tests | Retries | Reviewer | Security | CI | Status`
- All existing content outside modified sections is preserved unchanged

**Dependencies:** Tasks 1, 2, 3 (content patterns established by template edits)

---

## Task 8 — Verify no broken placeholders [core]

**Description:** After Tasks 5 and 6 are complete, run the placeholder integrity check on both generated files to ensure no unresolved `{{PLACEHOLDER}}` strings were introduced.

**Files:** Read-only verification

**Commands:**
```bash
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/agents/developer.md 2>/dev/null || echo "OK: developer agent"
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/commands/implement.md 2>/dev/null || echo "OK: implement command"
```

Expected output for each: no matches (or the "OK:" echo).

**Acceptance criteria:**
- Both commands return no matches
- If any match is found: fix the unresolved placeholder in the relevant file before closing this task

**Dependencies:** Tasks 6, 7

---

## Execution Order

```
Task 4 (create failure-patterns.md)   — independent, start immediately

Task 1 (Phase 3b recovery)  ──┐
Task 2 (Phase 3c upgrade)   ──┤──> Task 7 (apply to .claude/commands/implement.md)  ──> Task 8 (verify)
Task 3 (Phase 4e Retries)   ──┘

Task 5 (developer template)  ──> Task 6 (developer generated)  ──> Task 8 (verify)
```

Tasks 1, 2, 3, 4, and 5 can all start in parallel. Task 6 depends on Task 5. Task 7 depends on Tasks 1, 2, and 3. Task 8 depends on Tasks 6 and 7.

### Minimum critical path

Task 1 → Task 7 → Task 8

### Parallel fast path

Run Tasks 1, 2, 3, 4, 5 simultaneously. Then run Tasks 6 and 7 simultaneously. Then Task 8.
