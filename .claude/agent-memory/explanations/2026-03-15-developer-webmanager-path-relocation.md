---
agent: developer
feature: web-manager-ui-redesign
tags: [installation, paths, architecture]
date: 2026-03-15
---

## Decision

Moved web-manager installation target from `<project>/.claude/web-manager/` to `<project>/specrails/web-manager/` and updated all references in `install.sh`, `update.sh`, `server/index.ts`, and template commands.

## Why This Approach

`.claude/` is Claude Code's namespace for agents, commands, rules, skills, and settings. The web-manager is a specrails runtime product, not a Claude Code artifact. The `resolveProjectName()` function in the server walks up the directory tree — it now checks for `specrails` as the immediate parent instead of `.claude`.

## See Also

- `install.sh` — `WEB_MANAGER_DIR="$REPO_ROOT/specrails/web-manager"` and `mkdir -p "$REPO_ROOT/specrails"`
- `update.sh` — `local web_manager_dir="$REPO_ROOT/specrails/web-manager"`
- `server/index.ts` — `resolveProjectName()` checks `immediateParent === 'specrails'`
