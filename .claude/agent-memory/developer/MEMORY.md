# Developer Agent Memory

## Key architecture facts

- Agent files live in `.claude/agents/sr-*.md` — all use `sr-` prefix to avoid collisions with user-defined agents in target repos
- Workflow command files live in `.claude/commands/sr/*.md` — the `sr/` subdir enables `/sr:command` syntax in Claude Code
- Template agents are in `templates/agents/sr-*.md`; template commands are in `templates/commands/sr/*.md`
- `update.sh` runs `do_migrate_sr_prefix()` before `do_core/do_agents` for `all`, `commands`, `agents`, `core` components

## Patterns

- Agent `name:` frontmatter field must match the file's stem exactly (e.g. `sr-architect.md` → `name: sr-architect`)
- `subagent_type:` in command files must match the `name:` field of the target agent
- Memory dirs are at `.claude/agent-memory/sr-<agent>/` (e.g. `sr-reviewer/common-fixes.md`)

## Detailed notes

- [sr-prefix-namespace explanation](../../agent-memory/explanations/) — see dated files for rationale
