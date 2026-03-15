# Proposal: CLI Wrapper (srm) for Job Spawning

## Problem

Users launch specrails commands directly from the terminal (`claude /sr:implement #42`), bypassing the web-manager entirely. The web-manager never learns about those jobs: no phase tracking, no log capture, no job history. The result is a split world where the dashboard is only useful if every command is manually routed through the browser UI.

## Proposed Solution

Introduce a lightweight Node.js CLI tool called `srm` (specrails manager) that acts as a terminal-native bridge to the web-manager. When the web-manager is running, `srm` routes every command through it and streams logs back to the terminal via WebSocket. When the web-manager is not running, `srm` falls back to invoking `claude` directly with structured output, so the user still gets a cost/token summary.

This makes `srm` the single entry point for launching specrails commands — both in headless and dashboard-augmented workflows.

## User Experience

```
# Route a slash command through the web-manager (or fallback)
srm implement #42

# Pass a raw prompt
srm "summarise the last 5 commits"

# Check web-manager status
srm --status

# List recent jobs (requires web-manager + SQLite persistence from #57)
srm --jobs
```

When the web-manager is running, the terminal shows a live streamed log followed by a summary line:

```
[srm] routing via web-manager (http://127.0.0.1:4200)
... live log lines ...
[srm] done  duration: 4m32s  cost: $0.08  tokens: 12 400  exit: 0
```

When falling back:

```
[srm] web-manager not detected — running directly
... live log lines ...
[srm] done  duration: 4m32s  cost: $0.08  tokens: 12 400  exit: 0
```

## Non-Goals

- `srm` does not start or stop the web-manager.
- `srm` does not replace `claude` for general-purpose use — it is specrails-aware only.
- `srm` does not implement multi-job concurrency; the single-spawn constraint is enforced by the server.
- Job history persistence (SQLite) is out of scope here; `srm --jobs` depends on #57.

## Dependencies

- #57 (SQLite persistence) must land before `srm --jobs` returns useful data. The endpoint and flag are implemented now; they are gated on the server-side feature being available.

## Distribution

`srm` lives in `templates/web-manager/cli/` alongside the existing server and client. It is declared as a `bin` entry in the web-manager `package.json`. It ships with the web-manager installation — no separate npm package for the initial release.
