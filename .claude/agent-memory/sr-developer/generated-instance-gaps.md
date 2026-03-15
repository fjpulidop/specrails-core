---
name: generated-instance-gaps
description: Known structural differences between template files and their generated instances in .claude/agents/
type: project
---

The generated `.claude/agents/developer.md` is missing the "Read layer-specific CLAUDE.md files" bullet that exists in `templates/agents/developer.md` (the line contains `{{LAYER_CLAUDE_MD_PATHS}}` which was not resolved during generation).

**Why:** During specrails self-install, the installer did not substitute `{{LAYER_CLAUDE_MD_PATHS}}` because no layer CLAUDE.md paths are defined for specrails itself. The line was dropped rather than left with an unresolved placeholder.

**How to apply:** When inserting bullets into Phase 1 of the developer template, always anchor to content present in BOTH files. "Read referenced base specs" exists in both. "Read layer-specific CLAUDE.md files" only exists in the template. "Identify all files that need to be created or modified" exists in both. Use "Read referenced base specs" as the before-anchor and "Identify all files..." as the after-anchor when editing the generated instance.
