---
agent: developer
feature: automated-test-writer-agent
tags: [bash-tests, generated-instances, memory-path, placeholder-substitution]
date: 2026-03-17
---

## Decision

The `test_generated_instance_has_memory_path` assertion checks for `.claude/agent-memory/` (without the `sr-test-writer` suffix) because the generated instance uses `test-writer/` as the subdirectory, not `sr-test-writer/`.

## Why This Approach

The `{{MEMORY_PATH}}` placeholder in agent templates is substituted during `/setup` by stripping the `sr-` prefix from the agent name. This is consistent across all agents: `sr-developer` → `developer/`, `sr-architect` → `architect/`, `sr-test-writer` → `test-writer/`. The test asserts that substitution happened (the `{{MEMORY_PATH}}` token is gone and a real path exists) without coupling to the exact subdirectory name.

## Alternatives Considered

Asserting `.claude/agent-memory/test-writer` was considered but rejected: if the setup wizard's naming convention changes, the test would break unnecessarily. Asserting only `.claude/agent-memory/` tests the correct invariant (substitution happened) without over-specifying the path.

## See Also

- `.claude/agent-memory/developer/generated-instance-gaps.md` — documents known template-vs-instance differences
