---
change: smart-failure-recovery
type: feature
status: shipped
github_issue: 17
vpc_fit: 75%
---

# Proposal: Smart Failure Recovery & Retry

## Problem

When an agent fails mid-task in the `/implement` pipeline, the current behavior is blunt: log the failure, report it in Phase 4e, and stop. There is no structured capture of what failed, no attempt to recover, and no institutional learning. The developer must restart from scratch, re-running the full pipeline with zero benefit from the failed attempt.

Three failure modes repeat predictably:

- **Transient failures**: rate-limit errors, network timeouts, tool permission glitches. These have nothing to do with the task content — a simple retry fixes them. Today they are treated identically to real errors.
- **Code errors**: the agent misunderstood a file structure, produced malformed output, or violated a constraint that only becomes apparent at execution time. The agent itself could fix the problem if shown the error alongside the original task. Today that context is discarded.
- **Design errors**: the task spec is ambiguous or contradictory, requiring human or architect input. Today these silently fail like any other error — the developer has no way to signal "I need design clarification."

The result: every failure restarts the clock. For a multi-feature pipeline, a single agent failure can discard hours of parallel work across other features.

## Solution

Add a structured failure recovery layer to the implement pipeline that:

1. **Captures** failure context at the moment of failure: the task being executed, the error message and stack trace (if any), relevant code state (files being modified), and the phase.
2. **Classifies** the failure: transient, code error, or design error — based on heuristics in the error message and context.
3. **Retries intelligently** based on classification:
   - Transient: exponential backoff (wait 15s, 30s, 60s), then retry with the identical prompt.
   - Code error: re-launch the agent with the original prompt plus an injected "Previous attempt failed with: `<error>`. Files at time of failure: `<state>`." prefix.
   - Design error: halt that feature, escalate to the architect agent with the failure context, then re-launch the developer with the architect's response.
4. **Caps retries** at 3 attempts per agent invocation before escalating to the final report.
5. **Persists failure patterns** in agent memory so future runs recognize recurrent failures faster and skip re-learning the classification.

This is consistent with proven patterns in distributed systems: circuit breakers (stop hammering a broken thing), AWS retry strategies (classify and back off), and Sentry-style error aggregation (capture context at the moment of failure, not after).

## Scope

**In scope:**
- Failure capture protocol injected into `templates/commands/implement.md` and `.claude/commands/implement.md` for the developer phase (Phase 3b) and test-writer phase (Phase 3c)
- Three failure type classifiers as a decision table embedded in the failure recovery section
- Retry logic with exponential backoff for transient errors
- Prompt injection protocol for code errors (append failure context to next attempt)
- Escalation path for design errors: re-invoke architect, then re-launch developer with architect response
- Failure pattern memory: `templates/agents/developer.md` and `.claude/agents/developer.md` gain a failure-pattern recording protocol
- Failure context schema: structured format for capturing task, error, phase, and file state
- Phase 4e report update: add `Retries` column and surface retry counts

**Out of scope:**
- Automated retry of the reviewer agent (reviewer failures are already expected to surface issues; they should not be silently retried)
- Automated retry of the architect agent on first run (architect failures in Phase 3a are still non-blocking skips — recovery only applies to Phase 3b developers and Phase 3c test-writers)
- Failure recovery for the orchestrator itself (the main conversation)
- Persistent retry store across pipeline runs (memory stores patterns, not full retry state)
- CI failure retries (Phase 4d already has 2-retry logic for CI; that is out of scope here)

## Non-goals

- Smart failure recovery does NOT replace human judgment. Design-error escalation routes back to the architect and surfaces the issue, but a human still reviews the result before shipping.
- Smart failure recovery does NOT guarantee eventual success. After 3 attempts, the feature is marked FAILED in the report. The developer must intervene.
- Smart failure recovery does NOT instrument or monitor agent performance over time. Memory stores patterns for heuristic improvement only, not dashboards or metrics.

## Acceptance Criteria

1. `templates/commands/implement.md` and `.claude/commands/implement.md` contain a "Failure Recovery" subsection under Phase 3b describing capture, classification, and retry logic.
2. The same subsection exists under Phase 3c (test-writer failure handling is updated from "non-blocking skip" to the full recovery protocol).
3. Developer agent templates (`templates/agents/developer.md` and `.claude/agents/developer.md`) include a failure-pattern recording section.
4. Failure type classification table (transient / code / design) is present in the implement command with heuristics for each type.
5. Retry cap of 3 is enforced in the spec.
6. Design-error escalation path is described: pause developer, invoke architect with failure context, re-launch developer with architect output.
7. Phase 4e report table includes a `Retries` column.
8. A `failure-patterns.md` memory file schema is defined in the developer agent memory section.

## Motivation

VPC fit score: 75%. This feature directly addresses a trust and DX gap: AI-driven pipelines that fail opaquely destroy confidence faster than pipelines that never tried. Structured recovery turns a hard stop into a self-healing step, and the memory layer means the system gets smarter about the same class of failure over time. The effort is medium — all implementation is in Markdown and prompt engineering, no runtime code.
