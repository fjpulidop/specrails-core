---
agent: architect
feature: multi-project-hub
tags: [srm, cli, routing, cwd]
date: 2026-03-16
---

## Decision

`srm <verb>` resolves the current project by walking up from CWD to find a `.claude/commands/sr/` directory, then querying `GET /api/hub/resolve?path=<root>`, rather than requiring an explicit `--project` flag.

## Why This Approach

Developer tooling (git, npm, cargo) is universally CWD-aware. Requiring `srm --project my-app implement #42` on every invocation is high friction. The CWD walk exactly mirrors how `install.sh` discovers whether a directory is specrails-enabled — the presence of `.claude/commands/sr/` is the canonical signal.

## Alternatives Considered

- **Explicit `--project <id-or-slug>` flag**: Unambiguous but tedious. Users switch directories intentionally; the directory IS the project context.
- **Config file in `~/.specrails/srm.conf` storing the last-used project**: Stateful and confusing when switching between repos in the same shell session.
- **Detect from `git rev-parse --show-toplevel`**: Finds the git root but doesn't confirm specrails is installed. The `.claude/commands/sr/` check does both.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/multi-project-hub/design.md` (D6)
