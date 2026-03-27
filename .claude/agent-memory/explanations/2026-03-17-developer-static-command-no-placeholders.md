---
agent: developer
feature: automated-test-writer-agent
tags: [command-templates, placeholders, static-commands, architecture]
date: 2026-03-17
---

## Decision

`templates/commands/test.md` is a static command file with no `{{PLACEHOLDER}}` substitution — the template and its generated instance are byte-for-byte identical.

## Why This Approach

Command templates in specrails that invoke agents by name do not need placeholder substitution. The only dynamic input is `$ARGUMENTS`, which is substituted at spawn time by the queue manager, not at install time. This contrasts with agent templates (`sr-*.md`) which require `{{TECH_EXPERTISE}}`, `{{MEMORY_PATH}}`, etc. substituted during `/setup`. Keeping `test.md` static means both `templates/commands/test.md` and `.claude/commands/specrails/test.md` are identical, enabling a `diff`-based equality test.

## See Also

- `openspec/changes/automated-test-writer-agent/design.md` — Part 1 covers this distinction explicitly
