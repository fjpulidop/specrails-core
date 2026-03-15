# Context Bundle: CLI Wrapper (srm)

This document provides the implementation context a developer needs before writing any code for this change. Read it before opening any source file.

---

## What Is Being Built

A single-file Node.js CLI (`cli/srm.ts`) that acts as a terminal bridge to the specrails web-manager. It has two execution paths — web-manager-routed and direct fallback — and two informational flags (`--status`, `--jobs`). See `proposal.md` for product motivation and `design.md` for the full technical specification.

---

## Relevant Source Files

All files are under `templates/web-manager/` unless noted.

| File | Purpose |
|---|---|
| `server/index.ts` | Express server, WS setup, route registration. Add `/api/jobs` routes here. |
| `server/spawner.ts` | `spawnClaude()`, log buffer, `isSpawnActive()`. Read to understand the process lifecycle and log message schema. |
| `server/types.ts` | `WsMessage`, `LogMessage`, `PhaseMessage`, `InitMessage`, `SpawnHandle`. Import these in `cli/srm.ts` for type parity. |
| `server/hooks.ts` | Hook router — reference only, no changes needed. |
| `package.json` | Add `bin` and `build:cli` here. |
| `tsconfig.json` | Root TypeScript config. `tsconfig.cli.json` extends this. |

---

## WebSocket Protocol

Three message types, discriminated by `type` field. Defined in `server/types.ts`:

- `init` — sent once on connection: `{ type, projectName, phases, logBuffer }`. `logBuffer` replays last 500 lines. For `srm`, discard all log lines in `init` that predate the current `processId` (they belong to prior jobs).
- `log` — live output: `{ type, source: "stdout"|"stderr", line, timestamp, processId }`. Emit to terminal as-is.
- `phase` — pipeline state change: `{ type, phase: "architect"|"developer"|"reviewer"|"ship", state: "idle"|"running"|"done"|"error", timestamp }`.

Exit detection: the spawner emits a synthetic log line `[process exited with code N]` via stdout. Match with `/\[process exited with code (\d+)\]/`.

---

## Server API Contract

### Already exists

```
POST /api/spawn      { command: string } → { processId: string }
GET  /api/state      → { projectName, phases, busy }
WS   ws://127.0.0.1:<port>/
```

### Being added by this change

```
GET /api/jobs        → Job[] | { error, code: "NO_PERSISTENCE" } (501)
GET /api/jobs/:id    → Job   | { error, code: "NO_PERSISTENCE" } (501)
```

The 501 stub is intentional — it allows `srm --jobs` to distinguish "server running but no DB" from "server not running". Do not implement actual persistence here; that is #57.

---

## Known Constraints

- **Single-spawn**: the server allows only one active claude process. HTTP 409 means a job is already running — `srm` must surface this clearly and exit 1.
- **`--dangerously-skip-permissions`**: always prepended in `spawnClaude()` (server side). `srm` does not add it again when spawning via the web-manager path.
- **Direct fallback must also prepend `--dangerously-skip-permissions`**: when `srm` invokes claude directly, it must include this flag.
- **No external CLI libraries**: the arg parser is hand-rolled. Keep it in the same file as `srm.ts` to avoid introducing a dependency.
- **CommonJS output**: `tsconfig.cli.json` targets CommonJS (`"module": "commonjs"`). This ensures `npm link`/global install works on all Node.js versions without ESM loader flags.
- **ANSI passthrough**: claude's output may already contain ANSI escape codes. Do not strip or re-encode them.

---

## Dependency on #57

`srm --jobs` and `GET /api/jobs/:id` (used for cost/token summary in the web-manager path) both depend on SQLite job persistence added in #57. The implementation here:
1. Adds the routes now, returning 501.
2. Has `srm --jobs` gracefully handle 501 with a human-readable message referencing #57.
3. Has the summary path in `srm` gracefully degrade when `GET /api/jobs/:processId` returns 404 or 501 (fall back to duration-only summary).

Do not block this change on #57.

---

## Test Setup

Tests use `vitest`. Existing tests are in `server/index.test.ts`, `server/spawner.test.ts`, `server/hooks.test.ts`. Add `cli/srm.test.ts` following the same pattern:
- `vitest` globals are available
- `supertest` is available for HTTP layer tests
- For WS tests in Task 12, use the `ws` package (already a dependency) to create a test client

The `vitest.config.ts` at workspace root should pick up `cli/srm.test.ts` automatically if it follows the `*.test.ts` pattern. Verify this before writing tests.

---

## Token and Cost Formatting Reference

Stream-JSON result object fields:
```json
{
  "type": "result",
  "cost_usd": 0.0812,
  "input_tokens": 9234,
  "output_tokens": 3167
}
```

Total tokens = `input_tokens + output_tokens`. Format with space as thousands separator using `Intl.NumberFormat('en-US', { useGrouping: true }).format(n).replace(/,/g, ' ')` or equivalent.

Cost: `$` prefix, two decimal places, e.g. `$0.08`.

---

## Risks and Edge Cases

| Risk | Mitigation |
|---|---|
| WS connect race between spawn and stream | Use `processId` filtering on `init` log buffer. Connect WS before calling spawn, OR accept that pre-spawn init is always empty. Either is acceptable for MVP; design.md assumes connect-after-spawn with processId filtering. |
| Log line with exit pattern from prior job replayed in init | Filter init log buffer lines by `processId` match |
| Web-manager starts up between detection and spawn | Treated as "running" on retry is fine; non-critical edge case |
| claude process killed externally | Exit code will be non-zero (signal); propagate as-is |
| Very long-running jobs and WS keepalive | The `ws` library sends ping/pong automatically; no manual keepalive needed for MVP |
| Terminal resize during streaming | Not handled; out of scope |
