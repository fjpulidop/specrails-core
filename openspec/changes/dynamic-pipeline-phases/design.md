## Context

The web-manager currently hardcodes a 4-phase pipeline (`architect → developer → reviewer → ship`) in both server and client. This only applies to `/sr:implement` and `/sr:batch-implement`. All other commands (product-backlog, health-check, etc.) show four idle phases that never transition.

Additionally, live log streaming is lossy: the server's `extractDisplayText()` converts structured JSON events to plain text before broadcasting via WebSocket. The client's `LogViewer` already handles `assistant`, `tool_use`, `result`, etc. event types — but only sees them when loading historical events from the API. Live WebSocket messages arrive as flat `log`-type rows, losing structure.

## Goals / Non-Goals

**Goals:**
- Each command declares its own pipeline phases via frontmatter metadata
- Server validates hook events against the active command's phases, not a global list
- Pipeline UI renders dynamically based on the command's declared phases (0 to N)
- Live WebSocket streaming sends structured events so LogViewer can render them identically to historical events
- WebSocket URL derived from page origin instead of hardcoded `ws://localhost:4200`

**Non-Goals:**
- Redesigning the LogViewer component (it already handles all event types correctly)
- Changing the hook HTTP protocol (`POST /hooks/events` stays the same)
- Per-phase timing/duration tracking (existing behavior preserved)
- Custom phase icons per command (reuse existing icon set)

## Decisions

### D1: Phase declaration via command frontmatter

Commands declare phases in their `.md` frontmatter:
```yaml
---
name: "Product Backlog"
description: "..."
phases:
  - key: analyst
    label: Analyst
    description: Reads and prioritizes the product backlog
---
```

Commands without a `phases` field get no pipeline bar. The `implement.md` and `batch-implement.md` files lack YAML frontmatter (they use prose headers), so they will be updated to include frontmatter with their 4-phase definition.

**Why over a separate registry file**: Phases are metadata about the command. Keeping them co-located with the command definition means adding a new command automatically includes its pipeline definition. No separate config file to keep in sync.

### D2: Server-side phase registry per job

When a job starts, the server reads the command's phases from the parsed config and stores them as the "active phase set" for that job. `hooks.ts` validates incoming `agent` names against this set instead of the hardcoded `PHASE_NAMES` array.

The `PhaseMap` type becomes `Record<string, PhaseState>` instead of a fixed union. The init message includes the active command's phase definitions so the client knows what to render.

**Why per-job instead of global**: Multiple jobs can queue. Each may be a different command. The phase set must match the running command.

### D3: Broadcast raw structured events via WebSocket

Currently, `queue-manager.ts` calls `extractDisplayText()` to convert JSON events to strings, then broadcasts only the string via `emitLine()`. Instead:

1. For JSON-parsed stdout events: broadcast a new `type: 'event'` WebSocket message containing the raw event data (event_type, payload, timestamp, jobId).
2. Keep `emitLine()` for the in-memory log buffer (backwards compat for init message).
3. `JobDetailPage` handles `type: 'event'` messages by appending them directly as `EventRow` objects — same format as historical events from the API.

This means `LogViewer` processes live events identically to historical ones, with full `assistant`/`tool_use`/`result` parsing.

**Why not replace log messages entirely**: The log buffer serves as the init payload for late-connecting clients. Keeping it as simple text strings is efficient for that purpose. The new `event` message is additive.

### D4: WebSocket URL from origin

Replace `ws://localhost:4200` with:
```typescript
const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
```

This ensures the WebSocket connects to wherever the page is served from.

## Risks / Trade-offs

**[Risk] Existing hook callers send hardcoded phase names** → The hook `POST /hooks/events` with `agent: "architect"` still works because implement's phases declare `key: "architect"`. No breaking change for current consumers.

**[Risk] Commands without frontmatter (implement.md, batch-implement.md)** → These use prose headers, not YAML frontmatter. The `parseFrontmatter()` function in `config.ts` won't extract phases from them. Mitigation: add YAML frontmatter blocks to these two files with their phase definitions, keeping the prose content below.

**[Risk] Init message size grows with raw events** → The log buffer stays as display text (not raw events). Raw events are only sent live. Historical events come from the API. No size increase for the init payload.

**[Trade-off] PhaseMap becomes dynamic** → TypeScript loses compile-time key checking. Acceptable because phases are data-driven by design. Runtime validation in hooks.ts catches invalid phase names.
