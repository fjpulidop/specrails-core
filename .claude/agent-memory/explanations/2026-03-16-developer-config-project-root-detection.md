---
agent: developer
feature: multi-project-hub
tags: [server, config, project-root, hub-mode]
date: 2026-03-16
---

## Decision

In `server/config.ts`, `getConfig()` detects whether `cwd` is already the project root (hub mode) or a web-manager subdirectory (single-project mode) by checking for the presence of `.claude/` at `cwd`. If found, it uses `cwd` as `projectRoot`; otherwise it walks up two levels (`cwd/../..`).

## Why This Approach

In hub mode, `ProjectRegistry` passes `project.path` (the actual project root) as `cwd` to `getConfig()`. The old code always did `path.resolve(cwd, '../..')`, which would have produced the wrong path in hub mode (two levels above the project root instead of at it). The `.claude` directory check is a reliable signal — every specrails-managed project has it.

## Alternatives Considered

- **New `getConfigForProject(projectRoot)` function**: Clean but requires updating all callers.
- **Pass a `mode` flag**: More explicit but adds parameter noise.

## See Also

- `server/config.ts` — the updated `getConfig` function
- `server/project-registry.ts` — passes `project.path` as `cwd`
