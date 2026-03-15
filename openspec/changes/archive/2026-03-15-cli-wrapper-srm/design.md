# Design: CLI Wrapper (srm)

## Architecture Overview

`srm` is a single-file Node.js CLI script (`cli/srm.ts`) compiled to `cli/dist/srm.js`. It is distributed as a `bin` entry in the web-manager `package.json`. It has three distinct execution paths:

```
srm <args>
    │
    ├── --status          → GET /api/state, print JSON summary, exit
    ├── --jobs            → GET /api/jobs, print table, exit
    │
    └── <command>
            │
            ├─ web-manager reachable?
            │       YES → POST /api/spawn + WebSocket stream → print summary
            │       NO  → spawn claude directly → parse stream-json → print summary
```

---

## CLI Argument Parsing

`srm` uses no external argument-parsing library. A minimal hand-rolled parser is sufficient given the surface is small and stable.

### Supported invocations

| Invocation | Behaviour |
|---|---|
| `srm implement #42` | Prepends `/sr:` → routes command `/sr:implement #42` |
| `srm "any raw prompt"` | Routes prompt as-is (no `/sr:` prefix) |
| `srm --status` | Prints web-manager state; exits 0 if running, 1 if not |
| `srm --jobs` | Prints recent job list from `GET /api/jobs`; exits 1 if no server |
| `srm --help` / `srm -h` | Prints usage and exits 0 |
| `srm --port <n>` | Overrides the default port (4200) for all HTTP/WS calls |

### Command vs raw prompt detection

A "command" token is any first argument that matches a known specrails verb (implement, batch-implement, why, etc.) or begins with `/`. Everything else is treated as a raw prompt and passed unchanged to claude.

Known verbs map to `/sr:<verb>`. The remaining tokens are appended after the slash command.

### `/sr:` prefix injection

When a known verb is detected:
```
srm implement #42  →  /sr:implement #42
srm batch-implement #40 #41  →  /sr:batch-implement #40 #41
```

Raw prompts bypass injection:
```
srm "summarise last 5 commits"  →  "summarise last 5 commits"
```

---

## Web-Manager Detection

Before routing, `srm` probes the web-manager with a lightweight HEAD/GET request:

```
GET http://127.0.0.1:<port>/api/state
timeout: 500ms
```

If the request resolves within 500ms with any 2xx status, the web-manager is considered running.
If it times out, errors with ECONNREFUSED, or returns non-2xx, `srm` falls back to direct execution.

The 500ms timeout is deliberately short. Users invoked `srm` to run a job; they should not wait for a detection probe.

---

## Web-Manager Path

### 1. Spawn

```
POST http://127.0.0.1:<port>/api/spawn
Content-Type: application/json
{ "command": "<resolved command string>" }
```

Response: `{ "processId": "<uuid>" }`

On HTTP 409 (busy): print `[srm] error: web-manager is busy (another job is running)` and exit 1.
On HTTP 4xx/5xx: print the error message from the response body and exit 1.

### 2. WebSocket Streaming

Immediately after a successful spawn, `srm` opens a WebSocket connection:

```
ws://127.0.0.1:<port>/
```

Message handling:

| Message type | Action |
|---|---|
| `init` | Discard log buffer (job not started yet when this fires on fresh connection; skip replayed lines prior to our processId) |
| `log` | Print `line` to stdout (stdout source) or stderr (stderr source), preserving ANSI codes |
| `phase` | Print a dim phase-change annotation: `  → [phase] running` |
| `done` | Not a WS message — inferred from log line matching `[process exited with code N]` |

Log lines from the spawned claude process may already contain ANSI escape codes. `srm` passes them through unchanged. It does NOT re-colorise them.

Phase annotations use ANSI dim + cyan to visually separate them from claude output without clashing.

### 3. Job Completion Detection

The server emits a log line:
```
[process exited with code N]
```

`srm` detects this pattern via regex on incoming log lines. When matched:
- Extract exit code N.
- Close the WebSocket.
- Proceed to summary.

### 4. Summary Line

After the WebSocket closes, `srm` queries the server for job metadata:

```
GET http://127.0.0.1:<port>/api/jobs/<processId>
```

This endpoint is provided by #57 (SQLite persistence). If the endpoint returns 404 (server predates #57), `srm` falls back to a duration-only summary using a locally-tracked start time.

Summary format:
```
[srm] done  duration: 4m32s  cost: $0.08  tokens: 12 400  exit: 0
```

Fields omitted if unavailable (e.g. cost/tokens when #57 not present).

---

## Direct Fallback Path

When the web-manager is not running, `srm` invokes claude directly:

```
claude --dangerously-skip-permissions -p <command> \
  --output-format stream-json --verbose
```

### Stream-JSON parsing

Claude's `--output-format stream-json` emits newline-delimited JSON. Each line is one of:

- `{ "type": "text", "content": "..." }` — print content directly
- `{ "type": "result", "cost_usd": 0.08, "input_tokens": 9000, "output_tokens": 3400, ... }` — capture for summary
- Other types — silently ignore

`srm` reads stdout line by line, parses each JSON object, and handles it accordingly. Stderr from claude is passed through unchanged.

On process exit, `srm` prints the standard summary line using the captured result object.

### Exit code propagation

`srm` exits with the same code as the claude child process.

---

## `--status` Flag

```
GET http://127.0.0.1:<port>/api/state
```

Output when running:
```
web-manager: running
project:     my-project
busy:        false
phases:      architect=idle  developer=idle  reviewer=idle  ship=idle
```

Output when not running:
```
web-manager: not running (http://127.0.0.1:4200)
```

Exit code: 0 if running, 1 if not running.

---

## `--jobs` Flag

```
GET http://127.0.0.1:<port>/api/jobs
```

Output (tabular):
```
ID           COMMAND                    STARTED             DURATION  EXIT
a1b2c3d4...  /sr:implement #42          2026-03-15 14:22    4m32s     0
e5f6a7b8...  /sr:implement #40          2026-03-15 12:01    2m18s     0
```

If web-manager not running: print error and exit 1.
If `/api/jobs` returns 404 (no SQLite yet): print `[srm] jobs history requires web-manager with SQLite persistence (#57)` and exit 1.

---

## Terminal Output Formatting

All `srm`-generated lines are prefixed with `[srm]` in dim text to distinguish them from claude output.

Color usage:
- `[srm]` prefix: dim
- Phase annotations: dim cyan
- Error messages: red
- Summary line: bold for `[srm] done`, normal for fields

ANSI codes are suppressed when stdout is not a TTY (e.g., piped to a file). Detect via `process.stdout.isTTY`.

---

## File Layout

```
templates/web-manager/
├── package.json          (add bin entry, add cli/srm.ts to build)
├── server/
├── client/
└── cli/
    ├── srm.ts            (single-file CLI implementation)
    └── srm.test.ts       (unit tests for arg parsing, stream parsing, formatting)
```

No sub-package. `cli/srm.ts` is compiled by the same `tsconfig.json` as the server. The compiled output goes to `cli/dist/srm.js`.

---

## `package.json` Changes

```json
{
  "bin": {
    "srm": "./cli/dist/srm.js"
  },
  "scripts": {
    "build:cli": "tsc --project tsconfig.cli.json",
    "build": "cd client && npm run build && npm run build:cli"
  }
}
```

A separate `tsconfig.cli.json` targets `cli/srm.ts` with `"outDir": "cli/dist"` and `"module": "commonjs"` (or ESM with `--experimental-vm-modules` depending on Node target). CommonJS is preferred for maximum compatibility with `npm link` / global install paths.

---

## Error Handling Matrix

| Condition | Behaviour |
|---|---|
| Web-manager not reachable at spawn time | Fallback to direct |
| Web-manager becomes unreachable mid-stream | Print `[srm] warning: lost connection to web-manager`, close WS, exit with last known code or 1 |
| claude not on PATH (fallback path) | Print `[srm] error: claude binary not found` and exit 1 |
| Spawn returns 409 | Print busy error, exit 1 |
| claude exits non-zero | Propagate exit code |
| `--jobs` with no server | Print actionable message, exit 1 |

---

## Compatibility Impact

No existing CLI flags, agent names, or template placeholders are modified. The `srm` binary is net-new. The `bin` entry and `build:cli` script are additive changes to `package.json`.

`POST /api/spawn` already exists. `GET /api/state` already exists. `GET /api/jobs` and `GET /api/jobs/:id` are new server endpoints added as part of this change (they are documented in the delta-spec).

Compatibility: No contract surface changes to existing elements detected. New surface added only.
