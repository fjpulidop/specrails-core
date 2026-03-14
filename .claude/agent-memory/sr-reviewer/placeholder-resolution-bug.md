---
name: placeholder-resolution-bug
description: Broken placeholder substitution in .claude/agents/ resolved copies — setup-time placeholders replaced with incorrect literal text instead of being preserved
type: feedback
---

When new agent templates are created with `/setup`-time placeholders (e.g., `{{FRONTEND_STACK}}`, `{{BACKEND_STACK}}`), the `.claude/agents/` resolved copies must retain the `{{PLACEHOLDER}}` syntax verbatim. The `/setup` command fills them in against a real target repo at install time.

In the specialized-layer-reviewers change (2026-03-14), both `frontend-reviewer.md` and `backend-reviewer.md` in `.claude/agents/` had their stack placeholders incorrectly replaced with "detected from codebase" instead of keeping the original `{{FRONTEND_STACK}}` / `{{BACKEND_STACK}}` tokens.

**Why:** The CI placeholder check (`grep -r '{{[A-Z_]*}}' .claude/agents/`) normally catches *unexpected* placeholders that were never resolved. But for these new agents, the placeholders are *intentional* (resolved at `/setup` time). The failure mode is the opposite: placeholders being replaced with wrong literal text rather than being left in place.

**How to apply:** When reviewing new agent templates that define `/setup`-time placeholders, verify the resolved copies in `.claude/agents/` preserve those exact `{{PLACEHOLDER}}` tokens. Check the `specializing in` or other identity-sentence lines specifically — these are the most common place for placeholder substitution to go wrong.
