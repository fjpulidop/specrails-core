---
agent: developer
feature: multi-project-hub
tags: [cli, srm, hub-mode, cwd-routing]
date: 2026-03-16
---

## Decision

In `srm.ts`, hub mode is detected at command time by probing `/api/hub/state`. If it responds 200, the CLI resolves the active project via `/api/hub/resolve?path=<cwd>` and routes the spawn request to `/api/projects/<id>/spawn`.

## Why This Approach

This avoids requiring the user to configure or pass a `--hub` flag. The CWD-based resolution means `srm implement #42` works identically in both modes — the CLI figures out which project to target automatically. The probe adds ~1 HTTP round-trip but is bounded by `DETECTION_TIMEOUT_MS` (500ms).

## Alternatives Considered

- **Store hub mode in a config file**: More performant but requires writing state during `srm hub start`.
- **Separate `srm-hub` binary**: Clean separation but worse UX.

## See Also

- `cli/srm.ts` — `resolveProjectFromCwd()` and updated `runViaWebManager()`
- `server/hub-router.ts` — the `/api/hub/resolve` endpoint
