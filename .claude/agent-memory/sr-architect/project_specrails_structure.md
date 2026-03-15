---
name: specrails repo structure
description: Key files, directories, and the self-hosting pattern in specrails
type: project
---

specrails is self-hosting: it uses its own agent workflow to develop itself.

**Critical duality:** Two files are always kept in sync:
- `templates/commands/implement.md` — source template with `{{PLACEHOLDER}}` tokens
- `.claude/commands/implement.md` — generated/active command with placeholders resolved

Changes to the implement command MUST update both files in the same commit.

**Key directories:**
- `templates/` — source templates (agents, commands, rules, personas, settings)
- `.claude/` — generated output for specrails itself (agents, commands, rules, skills, agent-memory)
- `openspec/specs/` — spec source of truth (currently sparse — implement.md did not exist as of 2026-03-13)
- `openspec/changes/` — pending changes; `openspec/changes/archive/` for completed ones

**Existing orchestrator variables (Phase 4c):**
- `GIT_AUTO` (boolean) — controls automatic git shipping
- `BACKLOG_WRITE` (boolean) — controls backlog issue commenting
- `GH_AVAILABLE` (boolean) — set in Phase -1, controls whether gh CLI ops are attempted

New flags follow the same inline-variable pattern (no `{{PLACEHOLDER}}` needed).

**Why:** specrails is pre-code phase — no CI, no test framework. Manual verification is the only QA path.
