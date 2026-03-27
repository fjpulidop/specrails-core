---
name: pattern_static_command_templates
description: When to design a command template as static (no placeholders) vs requiring {{PLACEHOLDER}} substitution by install.sh
type: project
---

# Static vs Placeholder Command Templates

## Rule

A command template in `templates/commands/` should be **static** (zero `{{PLACEHOLDER}}` tokens) when:
1. It operates on a fixed, well-known directory path that never varies across target repos (e.g., `.claude/agent-memory/explanations/`)
2. It reads/searches data at runtime using LLM-native tools (Glob, Read) rather than template-time substitution
3. It has no project-specific configuration (tech stack, CI commands, layer names)

A command template should use `{{PLACEHOLDER}}` when:
1. It references tech-stack-specific commands (e.g., `{{CI_COMMANDS_FULL}}`, `{{DEPENDENCY_CHECK_COMMANDS}}`)
2. It references project-specific paths or names that vary per target repo
3. It contains layer or routing logic that depends on project structure (`{{LAYER_TAGS}}`, `{{DEVELOPER_ROUTING_RULES}}`)

## Examples

- `templates/commands/why.md` — static (searches a fixed memory directory)
- `templates/commands/compat-check.md` — static (reads baseline snapshot, no project-specific paths)
- `templates/commands/implement.md` — heavily templated (CI commands, backlog provider, routing rules)

## Why

**Why:** Using `{{PLACEHOLDER}}` in a static command creates unnecessary coupling to install.sh and makes the command harder to read and test. Static commands can be read and understood without substitution context.

**How to apply:** Before adding any `{{PLACEHOLDER}}` to a new command template, ask: "Does this value vary between target repos?" If no, hardcode it or make the LLM discover it at runtime.
