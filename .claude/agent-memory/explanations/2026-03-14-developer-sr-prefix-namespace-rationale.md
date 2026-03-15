---
agent: developer
feature: sr-prefix-namespace
tags: [namespace, agents, commands, migration]
date: 2026-03-14
---

## Decision

All specrails agents and workflow commands were renamed to use the `sr-` prefix (e.g., `architect` → `sr-architect`, `/implement` → `/sr:implement`) and moved into a `sr/` command subdirectory.

## Why This Approach

Claude Code routes agent launches by matching `subagent_type:` to an agent's `name:` field. Without a namespace prefix, a user's own `developer.md` agent in their repo would silently shadow specrails' `developer.md`, breaking the pipeline in ways that are hard to diagnose. The `sr-` prefix makes specrails agents unambiguously distinct from any user-defined agents.

The `sr/` subdirectory for commands (`.claude/commands/sr/`) is what gives Claude Code the `/sr:implement` slash syntax — the namespace comes from the directory name, not the file name.

## Alternatives Considered

- Per-agent prefixing (e.g. `specrails-developer`) — rejected as too verbose and ugly in command names
- No prefix at all — rejected because collision risk grows as users add their own agents

## See Also

- `openspec/changes/sr-prefix-namespace/` for the full change spec
- `update.sh:do_migrate_sr_prefix()` for the migration path from legacy installations
