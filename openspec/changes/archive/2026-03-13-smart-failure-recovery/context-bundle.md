---
change: smart-failure-recovery
type: context-bundle
---

# Context Bundle: Smart Failure Recovery & Retry

This file is a self-contained implementation guide. You do not need to read any other artifact to implement this change. Everything required is here.

---

## What You Are Building

You are adding structured failure recovery to the `/implement` pipeline. When a developer or test-writer agent fails, instead of immediately marking the feature as FAILED, the orchestrator:

1. Captures structured failure context (what failed, why, which files were in progress)
2. Classifies the failure as transient, code, or design
3. Retries intelligently based on type (backoff, context injection, or architect escalation)
4. Records the pattern in agent memory for future classification
5. Reports retry counts in the Phase 4e summary table

This is pure prompt engineering — no new code, no shell scripts, no binaries. All changes are in Markdown files.

---

## Files to Change

| File | Change Type | Description |
|---|---|---|
| `templates/commands/implement.md` | Modify | Add Phase 3b Failure Recovery subsection; replace Phase 3c failure handling; add Retries column to Phase 4e table |
| `.claude/commands/implement.md` | Modify | Same changes, applied to the resolved generated instance |
| `templates/agents/developer.md` | Modify | Add failure-pattern recording protocol section near end of file |
| `.claude/agents/developer.md` | Modify | Same section with `{{MEMORY_PATH}}` resolved to `.claude/agent-memory/developer/` |
| `.claude/agent-memory/developer/failure-patterns.md` | Create | Initial empty failure pattern registry |

**Do NOT modify:**
- Any other agent templates (`reviewer.md`, `architect.md`, `security-reviewer.md`, `test-writer.md`)
- `openspec/specs/implement.md` — this is a reference spec, not a command
- Any files in `openspec/changes/` other than this change set
- `.claude/agent-memory/developer/MEMORY.md` — do not touch the MEMORY.md index

---

## Current State

### `templates/commands/implement.md` — Phase 3b (relevant excerpt)

```markdown
## Phase 3b: Implement

### Pre-flight: Verify Bash permission

Before launching any developer agent, run a trivial Bash command to confirm Bash is allowed.

### Launch developers

**Read reviewer learnings:** Check `.claude/agent-memory/reviewer/common-fixes.md` and include in developer prompts.

[... dry-run, routing, and launch mode sections ...]

Wait for all developers to complete.

## Phase 3c: Write Tests
```

The Phase 3b section ends with "Wait for all developers to complete." — there is **no** failure recovery logic here currently.

### `templates/commands/implement.md` — Phase 3c failure handling (current)

```markdown
### Failure handling

If a test-writer agent fails or times out:
- Record `Tests: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the test-writer failure is non-blocking
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

This is the section to replace entirely.

### `templates/commands/implement.md` — Phase 4e report table (current)

```markdown
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
|------|---------|-------------|-----------|-----------|-------|----------|----------|----|--------|
```

The same line exists verbatim in `.claude/commands/implement.md`.

### `templates/agents/developer.md` — end of file (current)

The file ends with the `## MEMORY.md` section:

```markdown
## Update Your Agent Memory

As you implement OpenSpec changes, update your agent memory with discoveries about codebase patterns, architectural decisions, key file locations, edge cases, and testing patterns.

# Persistent Agent Memory

You have a persistent agent memory directory at `{{MEMORY_PATH}}`. Its contents persist across conversations.
[...]

## MEMORY.md

Your MEMORY.md is currently empty.
```

The failure-pattern recording section goes after the "MEMORY.md" section at the very end of the file.

### `.claude/agents/developer.md` — same as template but with resolved placeholders

`{{MEMORY_PATH}}` is resolved to `.claude/agent-memory/developer/` in this file. All other `{{PLACEHOLDER}}` substitutions are also resolved. Apply the same end-of-file addition with the resolved path.

---

## Exact Changes

### Change 1: Insert Failure Recovery in Phase 3b (`templates/commands/implement.md` and `.claude/commands/implement.md`)

**Location:** After the line `Wait for all developers to complete.` inside `## Phase 3b: Implement`, before the `## Phase 3c: Write Tests` heading.

**Insert this block verbatim:**

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
  error_detail: <full error output, or last 50 lines if long — append "[truncated]" if cut>
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

**Note for `.claude/commands/implement.md`:** apply the identical block. This file is a resolved instance — no `{{PLACEHOLDER}}` strings should be introduced. The failure-patterns.md path is a literal path, not a placeholder, so no substitution is needed.

---

### Change 2: Replace Phase 3c failure handling (`templates/commands/implement.md` and `.claude/commands/implement.md`)

**Location:** Find and replace the entire `### Failure handling` subsection inside `## Phase 3c: Write Tests`.

**Find this exact block:**

```markdown
### Failure handling

If a test-writer agent fails or times out:
- Record `Tests: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the test-writer failure is non-blocking
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

**Replace with:**

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

---

### Change 3: Update Phase 4e table and add Recovery Notes (`templates/commands/implement.md` and `.claude/commands/implement.md`)

**Location:** The Phase 4e report table.

**Find this exact line:**

```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

**Replace with:**

```
| Area | Feature | Change Name | Architect | Developer | Tests | Retries | Reviewer | Security | CI | Status |
```

**Then**, immediately after the table block (after the closing `|------|...` separator line and the example row, before the next `###` or `---`), add:

```markdown
### Recovery Notes

If any feature required recovery (retries or design escalation), list them here:

| Feature | Final Attempt | Failure Type | Resolution | Notes |
|---|---|---|---|---|
| <name> | 3/3 | code | FAILED | <last error summary> |
| <name> | 1/1 | design | Escalated — architect revised task | Succeeded on retry |

Omit this section entirely if no features required recovery.
```

---

### Change 4: Add failure-pattern recording to `templates/agents/developer.md`

**Location:** After the final line of the file (after the `## MEMORY.md` section and its content).

**Append this block at the end of the file:**

```markdown
## Failure Pattern Recording

If this invocation is a recovery retry — that is, the prompt you received contains a "PREVIOUS ATTEMPT FAILED" block — after completing the task, record the failure pattern:

1. Read `{{MEMORY_PATH}}/failure-patterns.md`.
2. Find the row whose `Error Signal` column matches the key phrase from the error in the "PREVIOUS ATTEMPT FAILED" block.
3. If a matching row exists: increment `Observed Count` by 1, update `Last Seen` to today's date (YYYY-MM-DD), and add any new insight to `Notes`.
4. If no matching row exists: append a new row with `Observed Count: 1`, today's date, and a brief note about what caused the error and how it was resolved.
5. Write the updated `failure-patterns.md` back.

This recording step is non-blocking. If writing the file fails for any reason, skip it silently — never let memory writes interrupt or delay the implementation.
```

---

### Change 5: Apply Change 4 to `.claude/agents/developer.md`

**Location:** Same — after the final line of the file.

**Append the identical block, but with `{{MEMORY_PATH}}` replaced by `.claude/agent-memory/developer/`:**

```markdown
## Failure Pattern Recording

If this invocation is a recovery retry — that is, the prompt you received contains a "PREVIOUS ATTEMPT FAILED" block — after completing the task, record the failure pattern:

1. Read `.claude/agent-memory/developer/failure-patterns.md`.
2. Find the row whose `Error Signal` column matches the key phrase from the error in the "PREVIOUS ATTEMPT FAILED" block.
3. If a matching row exists: increment `Observed Count` by 1, update `Last Seen` to today's date (YYYY-MM-DD), and add any new insight to `Notes`.
4. If no matching row exists: append a new row with `Observed Count: 1`, today's date, and a brief note about what caused the error and how it was resolved.
5. Write the updated `failure-patterns.md` back.

This recording step is non-blocking. If writing the file fails for any reason, skip it silently — never let memory writes interrupt or delay the implementation.
```

---

### Change 6: Create `.claude/agent-memory/developer/failure-patterns.md`

**Create this file with this exact content:**

```markdown
# Developer Agent Failure Patterns

Patterns observed during pipeline recovery. Updated after each recovery cycle by the orchestrator.

## Pattern Registry

| Error Signal | Type | Observed Count | Last Seen | Notes |
|---|---|---|---|---|

No patterns recorded yet.
```

---

## Existing Patterns to Follow

- **Section insertion in implement.md:** Always insert after the natural end of a phase's prose (look for "Wait for..." or the last bulleted instruction). Never insert inside an existing subsection.
- **Subsection naming:** Use `###` for subsections within a phase. "Failure Recovery" matches the capitalization style of "Failure handling" in Phase 3c but is renamed for consistency.
- **Phase 4e table edits:** The table header line and separator line must both be updated when adding a column. The separator line uses `|---|` or `|------|` — match the existing style in the file.
- **Agent template sections:** New sections go at the end of the file, after all `##` sections. Use `##` heading level (not `###`) for top-level agent sections.
- **Memory file naming:** kebab-case, matching `common-fixes.md` in the reviewer memory directory.
- **Non-blocking convention:** Memory writes are always non-blocking (see test-writer and reviewer patterns). Mirror the same "skip silently if write fails" language.
- **`run_in_background: false` for blocking agents:** Design-error escalation launches an architect synchronously. This matches how the implement pipeline handles Phase 3a architect agents in single-feature mode.

---

## Conventions Checklist

- [ ] No `{{PLACEHOLDER}}` strings in `.claude/` files (only in `templates/`)
- [ ] `{{MEMORY_PATH}}` resolved to `.claude/agent-memory/developer/` in `.claude/agents/developer.md`
- [ ] Phase 4e table column order: `Developer | Tests | Retries | Reviewer | Security | CI | Status`
- [ ] Failure Recovery subsection uses `###` heading level (not `##`)
- [ ] Sleep values: 15s / 30s / 60s (not 10s / 20s / 40s or any other values)
- [ ] Retry cap is exactly 3 throughout all sections
- [ ] `NOT_TESTABLE` maps to `Tests: SKIPPED (NOT_TESTABLE)` — not FAILED
- [ ] Design escalation architect launch uses `run_in_background: false`
- [ ] All code blocks inside markdown sections use proper fencing (triple-backtick)
- [ ] Existing table separator lines are updated when adding columns

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 4e table column count mismatch between template and generated copy | Medium | Apply Change 3 to both files in the same task; verify both have identical table structure |
| Nested code fences in the injected "PREVIOUS ATTEMPT FAILED" block cause Markdown rendering issues | Low | Use plain text for the injected block (no fencing around the FAILURE_CONTEXT schema inside the Failure Recovery subsection of the command) |
| Design escalation architect agent runs in background accidentally | Low | Explicitly mark `run_in_background: false` in the instruction text |
| `failure-patterns.md` grows unbounded | Low | No mitigation needed now; this is a future concern for a cleanup task |
| Retry backoff sleep delays block other features in multi-feature mode | Low | Retries are per-feature; sleeping one feature's recovery does not affect other features running in parallel worktrees |
