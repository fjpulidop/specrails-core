---
paths:
  - "templates/agents/**"
  - "templates/codex-skills/rails/**"
---

# Role template conventions

- Core ships exactly three roles: `sr-architect`, `sr-developer`, `sr-reviewer`. Adding a role is a product decision, not a template edit.
- Frontmatter: `name`, `description`, `model`, `color`. Codex rails use `name`, `description`, `license`, `compatibility`.
- Keep each role short and aligned with the runtime role definitions in `src/agent-runtime/prompts.ts`.
- Invoke OpenSpec only through `Skill("opsx:<id>", "<args>")`; the installer translates it per provider.
- Never commit, push or open pull requests from a role: the host owns delivery.
- Codex rails mirror the agent bodies; edit both together.
