---
change: smart-failure-recovery
type: delta-spec
---

# Delta Spec: Smart Failure Recovery & Retry

This document captures the normative behavioral changes introduced by this change set. Statements use SHALL (required), SHOULD (recommended), and MAY (optional).

---

## 1. Failure Capture

### 1.1 Capture on developer agent failure

When a developer agent (Phase 3b) fails, the orchestrator SHALL immediately construct a `FAILURE_CONTEXT` block before attempting any recovery. The block MUST include:

- `phase`: the pipeline phase identifier (`3b` or `3c`)
- `feature`: the kebab-case change name
- `attempt`: the current attempt number (integer, starting at 1)
- `error_summary`: a one-line description of the error, extracted from the agent's last output
- `error_detail`: the full error output, or the last 50 lines if the output exceeds 50 lines
- `files_in_progress`: the list of files the agent was creating or modifying, sourced from the feature's `tasks.md`
- `last_action`: a description of what the agent was doing when it failed, inferred from its last output
- `task_description`: the task or feature description originally passed to the agent

### 1.2 Capture on test-writer agent failure

The same `FAILURE_CONTEXT` block SHALL be constructed when a test-writer agent (Phase 3c) fails. Phase value SHALL be `3c`.

---

## 2. Failure Classification

### 2.1 Classification is mandatory

For every failure in Phase 3b or Phase 3c, the orchestrator SHALL classify the failure into one of three types before selecting a retry branch:

| Type | Primary Signals |
|---|---|
| `transient` | Rate limit, timeout, HTTP 429/503, network error, tool permission denied, context window exceeded (first occurrence only) |
| `code` | File not found, syntax error, type error, malformed output, partial/incomplete output, assertion failure, test failure |
| `design` | Agent self-reports ambiguity or contradiction; no pattern match on transient or code; repeated code errors on attempt 2 or later |

### 2.2 Classification precedence

The classifier SHALL check signals in this order: `transient` first, `code` second, `design` as the default. If no signal matches, the failure MUST be classified as `design`.

### 2.3 Known pattern priority

If the orchestrator has read a `failure-patterns.md` file from developer agent memory, recognized patterns in that file SHALL take precedence over the generic signal table.

---

## 3. Retry Behavior

### 3.1 Maximum attempts

The orchestrator SHALL NOT attempt more than 3 total invocations of a developer or test-writer agent for a given feature before escalating to a final FAILED status. Each attempt counts toward this limit regardless of failure type.

### 3.2 Transient retry

When failure type is `transient` and attempt count is less than 3, the orchestrator SHALL:

1. Wait before retrying, using exponential backoff: 15 seconds on attempt 1, 30 seconds on attempt 2, 60 seconds on attempt 3.
2. Re-launch the agent with the identical prompt as the original invocation.

### 3.3 Code error retry

When failure type is `code` and attempt count is less than 3, the orchestrator SHALL:

1. Re-launch the agent with an augmented prompt that prepends the `FAILURE_CONTEXT` block and instructs the agent not to repeat the failed approach.
2. The original task description MUST be preserved in full following the injected context.

### 3.4 Design error escalation

When failure type is `design`, the orchestrator SHALL:

1. Pause the developer for the affected feature.
2. Launch an architect agent with the `FAILURE_CONTEXT` block and a request for either a `REVISED_TASK` or a `NOT_IMPLEMENTABLE` response.
3. On `REVISED_TASK`: re-launch the developer with the revised task description. The attempt counter SHALL reset to 1 for this new cycle.
4. On `NOT_IMPLEMENTABLE`: mark the feature as FAILED with the architect's note. Continue the pipeline for other features.

### 3.5 Repeated code error escalation

If a developer fails with a `code` error on attempt 2 or later, the orchestrator SHOULD reclassify the failure as `design` and escalate, rather than retrying with the same injected-context approach.

---

## 4. Test-Writer Failure Handling

### 4.1 Upgrade from non-blocking skip

Phase 3c failure handling SHALL be upgraded from the existing "non-blocking skip" behavior to the full three-branch recovery protocol defined in Section 3.

### 4.2 Design escalation for test-writer

When a test-writer design-error escalation reaches the architect, the architect SHALL respond with either `REVISED_TASK` (refactoring guidance) or `NOT_TESTABLE`. A `NOT_TESTABLE` response SHALL mark the test as skipped (not FAILED) in the Phase 4e report, with the architect's note included.

---

## 5. Failure Pattern Memory

### 5.1 Failure pattern file

The developer agent memory directory SHALL contain a `failure-patterns.md` file with a pattern registry table. The file MAY be empty on initialization.

### 5.2 Recording

After each recovery cycle completes (whether successful or final failure), the orchestrator or developer agent SHALL append or update the relevant row in `failure-patterns.md`.

### 5.3 Reading

At the start of Phase 3b, the orchestrator SHALL read `.claude/agent-memory/developer/failure-patterns.md` and supply its contents to the failure classifier as a supplement to the generic signal table.

---

## 6. Phase 4e Report

### 6.1 Retries column

The Phase 4e pipeline report table SHALL include a `Retries` column. The column SHALL display the total number of retry attempts made for each feature's developer and test-writer agents (e.g., `0`, `1/3`, `2/3`). A value of `0` indicates no retries were needed.

### 6.2 FAILED status with recovery note

If a feature reaches FAILED status after exhausting retries or receiving a `NOT_IMPLEMENTABLE` from the architect, the Status column SHALL display `FAILED` and the report SHALL include a "Recovery Notes" subsection listing the failure type, final attempt count, and the architect's note (if design escalation occurred).

---

## 7. Constraints

- Recovery logic SHALL apply only to Phase 3b (developer) and Phase 3c (test-writer). It SHALL NOT apply to Phase 3a (architect), Phase 4b (reviewer), or Phase 4b-sec (security-reviewer).
- Recovery logic SHALL be bypassed when `DRY_RUN=true` for transient failures (no external dependencies in dry-run). Code and design error recovery SHALL still run in dry-run mode.
- The architect agent launched during design escalation SHALL use `run_in_background: false` — recovery is a blocking operation for that feature.
- The retry backoff sleep SHALL be implemented as a Bash `sleep` command issued by the orchestrator between agent launches.
