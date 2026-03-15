---
name: web_manager_sqlite_patterns
description: SQLite persistence patterns for the web-manager server — driver choice, dependency injection, shared mutable ref, stream-json parsing
type: project
---

# Web Manager SQLite Patterns

## Driver: better-sqlite3 (synchronous)

Use `better-sqlite3` for all SQLite access in the web-manager. Reason: readline `line` handlers are synchronous. Async DB calls inside them risk interleaving. Synchronous writes also eliminate Promise scheduling complexity.

**Why:** See explanation record `2026-03-15-architect-sqlite-sync-driver-choice.md`.

## DB as injected parameter, not module singleton

`initDb(dbPath)` is called once in `index.ts` (the composition root). The returned `Database` handle is passed as a parameter to `spawnClaude(command, broadcast, onReset, db)` and `createHooksRouter(broadcast, db, activeJobRef)`.

**Why:** The `vi.resetModules()` test pattern in `spawner.test.ts` resets module state between tests. A module-level singleton DB handle would be reset too, creating dangling connections. Parameter injection lets tests pass `initDb(':memory:')` cleanly.

## activeJobRef mutable reference

To share the current job id between `spawner.ts` and `hooks.ts` without circular imports:

```typescript
// index.ts (composition root)
const activeJobRef: { current: string | null } = { current: null }
// set activeJobRef.current = handle.processId after spawn
// set activeJobRef.current = null in onResetPhases callback
// pass to both spawnClaude and createHooksRouter
```

**Why:** If `hooks.ts` imported `getCurrentJobId()` from `spawner.ts`, it would create an import edge hooks→spawner. The ref pattern keeps the module graph a DAG.

## stream-json parsing strategy

Spawn args: `['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '-p', ...cmdArgs]`

Per stdout line:
1. Try `JSON.parse(line)`.
2. On success: `appendEvent(db, ...)` with structured type; call `extractDisplayText(parsed)` for WS broadcast.
3. On failure: treat as plain text; `appendEvent(db, ...)` with `event_type: 'log'`; broadcast as before.

Display text rules:
- `assistant`: join `message.content[*].text`
- `tool_use`: `"[tool: name] input..."`
- `tool_result`, `system_prompt`: null (do not broadcast)
- `result`: null (handled in close handler with cost data)
- unknown: `JSON.stringify(event).slice(0, 200)`

The `result` event carries cost/token fields. Store in a closure variable; write to job row in the `close` handler.

## In-memory buffer preserved

The circular log buffer in `spawner.ts` (`LOG_BUFFER_MAX = 5000`) is unchanged. SQLite persistence is additive. The buffer is still the hot path for WS `init` replay.

## Test DB pattern

All tests use `initDb(':memory:')` — no file I/O, no cleanup needed. The `:memory:` special path skips the `fs.mkdirSync` call in `initDb`.

## Orphan sweep on startup

After migrations: `UPDATE jobs SET status='failed', finished_at=? WHERE status='running'`. Handles crash-during-job scenarios. Runs synchronously at startup before the HTTP server binds.
