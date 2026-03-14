---
name: agent_memory_extension_pattern
description: Design pattern for extending agent behavior via shared memory directories — write path (reviewer→store) and read path (store→developer)
type: project
---

# Agent Memory Extension Pattern

When a feature needs one agent to share learned knowledge with another agent across sessions, use the "shared memory store" pattern:

## Structure

```
.claude/agent-memory/<domain>/
├── README.md          # Schema documentation (human + agent readable)
└── <records>          # One file per record (JSON for structured, .md for narrative)
```

## Write path

The producing agent (e.g., reviewer) writes to the store at the end of its workflow, after its primary output. The write step is non-blocking — it never delays or gates the agent's primary deliverable.

## Read path

The consuming agent (e.g., developer) reads from the store at the start of its workflow, during context-gathering. The read step is explicitly graceful: "If the directory does not exist or is empty, proceed normally."

## Key design decisions

- **One file per record** (not append-to-single-file): avoids write contention in multi-feature mode where multiple agent instances run concurrently
- **JSON for structured extraction, Markdown for narrative**: use JSON when the consumer needs to match on specific fields; use .md when the content is for human scanning
- **Filename encodes recency**: use `<YYYY-MM-DD>-<slug>` prefix so records sort naturally by date
- **Idempotency in the producer**: scan for existing records with same class before writing — avoids duplicates over long-running repos
- **One record per failure class per session** (not per instance): keeps the store lean and scannable

## Example: agent-failure-learning change

- Store: `.claude/agent-memory/failures/`
- Producer: reviewer writes JSON after review report
- Consumer: developer reads during Phase 1 (Understand)
- Schema fields: `agent`, `timestamp`, `feature`, `error_type`, `root_cause`, `file_pattern`, `prevention_rule`, `severity`
- Matching: consumer matches `file_pattern` globs against its own expected file set using contextual judgment (not strict glob expansion)

## Template touch points

When implementing this pattern, the only files that change are:
1. Agent templates (`templates/agents/<producer>.md` and `templates/agents/<consumer>.md`)
2. Their generated instances (`.claude/agents/<producer>.md` and `.claude/agents/<consumer>.md`)
3. The new store README (`.claude/agent-memory/<domain>/README.md`)

No `install.sh` changes, no `implement.md` pipeline changes, no new phase numbers.
