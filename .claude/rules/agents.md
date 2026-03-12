---
paths:
  - ".claude/agents/**"
  - "templates/agents/**"
---

# Agent Prompt Conventions

- Agent files use YAML frontmatter with: `name`, `description`, `model`, `color`, `memory`
- The `description` field must include examples showing when to launch the agent
- Models: `opus` for deep reasoning (product-manager), `sonnet` for implementation, `haiku` for read-only analysis
- Each agent has a persistent memory directory at `.claude/agent-memory/{agent-name}/`
- Agent prompts should be self-contained — include all context the agent needs without relying on conversation history
- Define clear boundaries: what the agent does AND what it does NOT do
- Include output format specifications so agents produce consistent, parseable output
- Reference persona files by path when product evaluation is needed
