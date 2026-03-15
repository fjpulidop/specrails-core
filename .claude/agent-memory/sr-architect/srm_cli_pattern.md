---
name: srm_cli_pattern
description: Design patterns for the srm CLI wrapper — detection probe, web-manager vs fallback paths, 501 stub for future endpoints, CommonJS output
type: project
---

# srm CLI — Design Patterns

## Detection probe

500ms GET /api/state probe before every command. ECONNREFUSED or timeout → fallback. This is intentionally short to avoid user-visible delay.

## Dual-path execution

- Web-manager running: POST /api/spawn → WebSocket stream → GET /api/jobs/:id for summary
- Web-manager not running: spawn claude directly with --output-format stream-json --verbose → parse NDJSON

## processId filtering on WS init

The WS init message replays last 500 log lines. srm must discard any log line in the init buffer that predates the current processId (belongs to prior jobs). Connect WS after spawn, filter on processId.

## 501 stub pattern

When adding routes that depend on a future feature (#57 SQLite), add the routes now returning 501 with `{ code: "NO_PERSISTENCE" }`. This allows the CLI to distinguish "server not running" (ECONNREFUSED) from "server running, feature not ready" (501). Avoids merge coordination.

## CommonJS output for bin

tsconfig.cli.json uses "module": "commonjs". Global npm installs are sensitive to ESM/CJS mismatch; CommonJS avoids Node version compatibility issues.

## No external CLI library

Arg parser is hand-rolled in srm.ts. Surface is small (4 modes, 1 flag, ~5 known verbs). External libraries (commander, yargs) add unnecessary transitive deps to a globally-installed binary.

## Known verbs list

Lives as a const array in cli/srm.ts. First arg matching a known verb gets /sr: prefix injected. Everything else treated as raw prompt. Adding new slash commands = adding to this array only.
