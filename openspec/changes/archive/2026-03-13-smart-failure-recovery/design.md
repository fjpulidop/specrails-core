---
change: smart-failure-recovery
type: design
---

# Design: Smart Failure Recovery & Retry

## Architecture Overview

This change is pure orchestration: all logic lives in Markdown prompts and prompt-engineering conventions. There is no runtime code, no new binary, no shell script. The "recovery engine" is the orchestrator (main conversation) reading a structured failure context and deciding which retry branch to follow.

The design has four components:

1. **Failure Capture Block** — a structured output format emitted by the developer agent when it fails, read by the orchestrator.
2. **Failure Classifier** — a decision table in the implement command that maps error message patterns to failure types.
3. **Retry Branches** — three prose-defined branches (transient / code / design) that describe what the orchestrator does next.
4. **Failure Pattern Memory** — a `failure-patterns.md` file in the developer agent memory that accumulates heuristics for classification.

---

## Component 1: Failure Capture Block

When a developer or test-writer agent fails, the orchestrator currently has only the agent's unstructured output. To enable structured recovery, we define a **failure capture schema** that the orchestrator populates immediately on agent failure, before attempting any retry.

### Schema

```
FAILURE_CONTEXT:
  phase: <3b | 3c>
  feature: <change-name>
  attempt: <1 | 2 | 3>
  error_summary: <one-line description of the error>
  error_detail: <full error output or last N lines if long>
  files_in_progress: <list of files the agent was creating or modifying>
  last_action: <description of what the agent was doing when it failed>
  task_description: <the task or feature description passed to the agent>
```

The orchestrator constructs this block from:
- The agent's last output (parse for error signals)
- The task description it passed to the agent
- The file list from the feature's `tasks.md` (files that were "in progress")

### Design Decision: Orchestrator-assembled, not agent-emitted

An alternative design would have the agent emit a structured failure block itself before failing. This was rejected because: (a) agents don't always produce controlled output when failing — they may simply stop or produce partial output; (b) it would require adding complex "on failure" logic to every agent template. The orchestrator-assembled approach is simpler and more robust: the orchestrator already knows the task, knows the files, and can parse the agent's last output.

---

## Component 2: Failure Classifier

The orchestrator classifies failures using a decision table embedded in the implement command, applied immediately after constructing the `FAILURE_CONTEXT`. Classification is applied once per failure; the result gates which retry branch runs.

### Decision Table

| Failure Type | Heuristic Signals | Action |
|---|---|---|
| `transient` | "rate limit", "timeout", "429", "503", "network error", "connection refused", "tool permission denied", "exceeded context" (first occurrence) | Exponential backoff retry |
| `code` | "unexpected token", "file not found", "no such file", "permission denied" (file system), "syntax error", "undefined variable", "type error", "assertion failed", "test failed", partial/incomplete output | Re-launch with failure context injected |
| `design` | "ambiguous", "contradictory", "unclear requirement", "which approach", "cannot determine", "conflicting instructions", "spec gap" (agent self-reports), OR: code error on attempt 2 or 3 (escalate after repeated code errors) | Escalate to architect |

Classification is order-sensitive: check `transient` first, then `code`, then default to `design` if no pattern matches. The intent is: when in doubt, treat as a design error (escalate) rather than silently loop.

### Design Decision: Heuristic strings, not semantic parsing

Full semantic parsing of agent output would require running another agent, adding latency and cost. Heuristic string matching on the error summary covers the common cases (rate limits and syntax errors are identifiable from their messages). Edge cases that don't match fall through to `design` and escalate — this is the correct conservative default for a developer tool where a human is always available.

---

## Component 3: Retry Branches

### Branch A: Transient Retry

**When:** `failure_type = transient` AND `attempt <= 3`

**Steps:**
1. Print: `[recovery] Transient failure detected on attempt N. Retrying in Xs...`
   - Backoff: attempt 1→15s, attempt 2→30s, attempt 3→60s
2. Re-launch the agent with the **identical prompt** as the original invocation.
3. If the retry succeeds: continue the pipeline normally.
4. If the retry fails again: classify the new failure. If still transient and attempt < 3: repeat. If attempt = 3: mark as FAILED and move to Phase 4e report.

**Design Decision: Sleep is orchestrator-side**
The orchestrator is a Claude conversation — it can issue Bash sleep commands between agent launches. The sleep duration is embedded in the instruction text as a literal wait: `Run: sleep 15 && echo "Retrying..."`. This is deterministic and requires no new infrastructure.

### Branch B: Code Error Retry

**When:** `failure_type = code` AND `attempt <= 3`

**Steps:**
1. Print: `[recovery] Code error detected on attempt N. Re-launching with failure context.`
2. Construct the retry prompt:
   ```
   PREVIOUS ATTEMPT FAILED (Attempt N):

   Error: <error_summary>
   Detail: <error_detail>
   Files in progress at time of failure: <files_in_progress>
   Last action: <last_action>

   Please fix the issue described above and complete the task. Do not repeat the same approach that caused the error.

   Original task follows:
   ---
   <original task description>
   ```
3. Re-launch the agent with the augmented prompt.
4. If the retry succeeds: continue the pipeline normally.
5. If attempt = 3 and still failing: escalate to architect (same as Branch C).

### Branch C: Design Error Escalation

**When:** `failure_type = design` OR attempt = 3 with repeated failures

**Steps:**
1. Print: `[recovery] Design error or repeated failures on feature <name>. Escalating to architect.`
2. Pause the developer for this feature. Do not mark it FAILED yet.
3. Launch an **architect** agent with the following prompt:
   ```
   FAILURE ESCALATION: Developer agent failed on feature <name>.

   Failure context:
   <FAILURE_CONTEXT block>

   Please review the failure, diagnose the root cause, and produce either:
   (a) A revised task description that resolves the ambiguity or contradiction, OR
   (b) A note explaining why the task as specified is not implementable.

   Output format: respond with either "REVISED_TASK: ..." or "NOT_IMPLEMENTABLE: ..."
   ```
4. If architect responds with `REVISED_TASK`:
   - Re-launch the developer with the revised task. This is attempt 1 of a fresh retry cycle (max 3 more attempts).
5. If architect responds with `NOT_IMPLEMENTABLE`:
   - Mark feature as FAILED in the Phase 4e report with reason: `Design escalation: <architect's note>`.
   - Continue the pipeline for other features.

**Design Decision: Architect re-invocation, not human interrupt**
The design error path could pause the pipeline and ask the human. We chose architect re-invocation first because: (a) the architect has the full spec context; (b) it keeps the pipeline autonomous; (c) the human still sees the outcome in the Phase 4e report and can intervene if needed. A human interrupt would require interactive input, which is incompatible with background agent execution.

---

## Component 4: Failure Pattern Memory

### File: `.claude/agent-memory/developer/failure-patterns.md`

The developer agent records each failure classification to this file after each recovery attempt. The orchestrator reads this file when constructing the failure classifier — recorded patterns take priority over the generic heuristic table.

### Schema

```markdown
# Failure Patterns

## Pattern Registry

| Error Signal | Type | Observed Count | Last Seen | Notes |
|---|---|---|---|---|
| "exceeded context window" | transient | 3 | 2026-03-01 | Retry with smaller file list |
| "cannot parse delta-spec.md" | code | 2 | 2026-02-28 | File has non-standard frontmatter |
```

### Update Protocol

After each recovery cycle completes (success or final failure), the developer agent appends or increments the relevant row. The orchestrator reads this file at the start of Phase 3b and passes it to the failure classifier as a "known patterns" supplement.

### Design Decision: Separate memory file, not inline in MEMORY.md

Failure patterns are structured tabular data that grow over time. Embedding them in `MEMORY.md` would exceed the 200-line truncation limit quickly. A separate file keeps `MEMORY.md` as an index and `failure-patterns.md` as the data store. This mirrors the existing `reviewer/common-fixes.md` pattern.

---

## Affected Files

| File | Change Type | Description |
|---|---|---|
| `templates/commands/implement.md` | Modify | Add Failure Recovery subsection to Phase 3b and update Phase 3c failure handling; add Retries column to Phase 4e table |
| `.claude/commands/implement.md` | Modify | Same changes, applied to generated instance |
| `templates/agents/developer.md` | Modify | Add failure-pattern recording protocol section |
| `.claude/agents/developer.md` | Modify | Same changes, applied to generated instance |
| `.claude/agent-memory/developer/failure-patterns.md` | Create | Initial (empty) failure pattern registry |

---

## Edge Cases

### Retry counter resets on design escalation
When a design error escalation produces a `REVISED_TASK`, the retry counter resets to 1. This is intentional: the architect has clarified the spec, so the developer gets a fresh 3-attempt budget.

### Concurrent failures in multi-feature mode
In multi-feature mode, multiple developers run in parallel in worktrees. Each developer's failure recovery runs independently — the retry logic is per-feature, not global. Design escalations from different features queue independently to the architect (one at a time, in the order failures are detected).

### Failure during retry
If a developer fails during a Branch B (code error) retry and the new failure classifies as `transient`, the retry type changes for the next attempt. The attempt counter continues from where it was.

### Context window overflow on Branch B
If the original task description is long and the failure context would exceed reasonable prompt size, truncate `error_detail` to the last 50 lines. Note the truncation in the injected block: `[truncated to last 50 lines]`.

### test-writer failures
Phase 3c test-writer failures currently use a simple non-blocking skip. This change upgrades test-writer to the same three-branch recovery. However, design-error escalation for a test-writer means the test is genuinely hard to write — not a spec ambiguity. In this case, the escalation message to the architect is: "Test writer could not generate tests for `<files>`. Reason: `<error>`. Should this implementation be refactored for testability?" The architect responds with either a note to the developer or `NOT_TESTABLE`, which marks the test as skipped in the report.
