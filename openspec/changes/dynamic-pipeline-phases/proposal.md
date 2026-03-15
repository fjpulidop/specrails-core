## Why

The web-manager has two usability problems: (1) logs from Claude CLI execution are not reliably visible — the server extracts "display text" from raw JSON events and broadcasts only that via WebSocket, losing structured event data for live viewers; historical events loaded from SQLite do render, but live streaming produces only flattened `log`-type rows that miss assistant messages, tool calls, and result summaries. (2) The pipeline progress bar is hardcoded to the `architect → developer → reviewer → ship` workflow, which only applies to `/sr:implement`. Every other command (product-backlog, health-check, refactor-recommender, etc.) shows four idle phases that never transition, which is confusing and misleading.

## What Changes

- **Command metadata**: Each command defines its own pipeline phases via frontmatter in its `.md` file (e.g., `phases: [analyst]` for product-backlog, `phases: [architect, developer, reviewer, ship]` for implement). Commands with no phases get no pipeline bar.
- **Server config endpoint**: `GET /api/config` returns phase definitions per command. The hooks system accepts any phase name declared by the active command, not just the hardcoded four.
- **Dynamic pipeline UI**: `PipelineProgress` renders whatever phases the current command declares — from zero (no bar) to N phases with labels and descriptions.
- **Log streaming fix**: The server broadcasts raw structured events via WebSocket (not just extracted display text), so the client's `LogViewer` can parse `assistant`, `tool_use`, and `result` events in real time — matching what historical log viewing already shows.
- **WebSocket URL**: Derive the WebSocket URL from the current page origin instead of hardcoding `ws://localhost:4200`.

## Capabilities

### New Capabilities
- `command-phase-registry`: Frontmatter-based phase declaration per command, server-side phase registry, and dynamic phase validation in hooks

### Modified Capabilities
- `web-manager-dashboard`: Active job card renders dynamic phases from the running command's definition instead of hardcoded 4-phase pipeline
- `web-manager-job-detail`: Pipeline progress component accepts dynamic phase list; log viewer receives structured events in real time (not flattened text); WebSocket URL derived from origin

## Impact

- **Server**: `hooks.ts` phase validation becomes dynamic (per-job, not global). `queue-manager.ts` broadcasts raw events alongside display text. `config.ts` parses `phases` frontmatter from command files.
- **Client**: `PipelineProgress.tsx` becomes data-driven. `usePipeline.ts` phase types become dynamic. `JobDetailPage.tsx` WebSocket URL derived from `window.location`. `LogViewer.tsx` unchanged (already handles all event types).
- **Command files**: All 8 command `.md` files in `.claude/commands/sr/` get a `phases` frontmatter field.
- **Breaking**: Hook consumers posting to `POST /hooks/events` must use phase names matching the active command's declared phases (currently only implement/batch-implement use hooks, so low risk).
