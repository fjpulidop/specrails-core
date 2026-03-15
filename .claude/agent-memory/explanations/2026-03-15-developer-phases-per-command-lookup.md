---
agent: developer
feature: dynamic-pipeline-phases
tags: [queue-manager, command-lookup, slug-parsing, setActivePhases]
date: 2026-03-15
---

## Decision

`QueueManager` stores the commands list in a `_commands` field (set via constructor or `setCommands`) and uses a `_phasesForCommand` helper to extract the slug from a job command string before looking up its phases.

## Why This Approach

The command stored on a job is the raw invocation string, e.g. `/sr:implement #5`. To look up the matching `CommandInfo`, we need to extract the slug `implement`. The helper strips the `/sr:` prefix via `split(':').pop()` and falls back to stripping a leading `/` for bare command strings. This handles both the namespaced form used by the web UI and unqualified forms.

When `_phasesForCommand` returns a non-empty array, `_startJob` calls `setActivePhases` instead of `resetPhases`. When phases are empty (command not found or command declares no phases), it falls back to `resetPhases` to preserve the existing default-4-phases behavior.

## Alternatives Considered

- **Call `getConfig()` inside `_startJob`**: Would add a filesystem read on every job start and create a tight coupling to the config layer. Rejected in favor of dependency injection via constructor/setter.
- **Pass phases directly on the Job object**: Would require changing the job enqueue API and the DB schema. Out of scope for this change.
