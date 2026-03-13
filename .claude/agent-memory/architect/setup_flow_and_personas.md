---
name: setup flow and persona system
description: How /setup works phase by phase, how personas are generated, and the template-to-output mapping for personas
type: project
---

## /setup phase structure

- Phase 1: Codebase analysis + display findings (1.4 is the confirmation step)
- Phase 2: User persona discovery (2.1 ask, 2.2 research, 2.3 generate VPC personas, 2.4 present)
- Phase 3: Configuration (agents, backlog provider, git workflow, commands)
- Phase 4: Generate files (4.1 agents, 4.2 personas, 4.3 commands, 4.4 rules, 4.5 CLAUDE.md, 4.6 settings, 4.7 memory)
- Phase 5: Cleanup (5.1 rm scaffolding, 5.2 verify, 5.3 summary)

## Persona system

Three pre-authored personas ship with specrails:
- `the-lead-dev.md` — "Alex"
- `the-product-founder.md` — "Sara"
- `the-maintainer.md` — "Kai"

Location: `.claude/agents/personas/` (specrails's own setup)
Template source: `templates/personas/` (what gets copied to target repos)

**The maintainer persona is NOT parameterized** — it ships verbatim, not via {{PLACEHOLDER}} substitution. It is copied as-is to `.claude/agents/personas/the-maintainer.md` in target repos.

User-generated personas use `templates/personas/persona.md` as a template.

## product-manager agent and personas

The product-manager template (`templates/agents/product-manager.md`) uses:
- `{{PERSONA_FILE_LIST}}` — list of persona file paths (user-generated)
- `{{MAINTAINER_PERSONA_LINE}}` — added by formalize-oss-maintainer feature; conditional on IS_OSS
- `{{PERSONA_COUNT}}` — total count including Maintainer when IS_OSS=true

The agent reads ALL files in `.claude/agents/personas/` dynamically, so presence of a file is sufficient for it to include the persona in VPC scoring.

## install.sh → /setup handoff

install.sh writes detection results to `.claude/setup-templates/` (temporary scaffolding directory).
/setup reads those files during Phase 1-4.
Phase 5.1 cleans up all of setup-templates with `rm -rf`.

The `.oss-detection.json` file follows this pattern.
