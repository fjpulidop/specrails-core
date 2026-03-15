# Tasks: CLI Wrapper (srm)

Ordered by dependency. All tasks are in the `templates/web-manager/` tree unless noted.

---

## Task 1 — Scaffold CLI directory and tsconfig [cli]

**Description:** Create `cli/` directory and `tsconfig.cli.json`. This unblocks all subsequent CLI tasks.

**Files:**
- `templates/web-manager/cli/` (new directory, add `.gitkeep` until srm.ts is created)
- `templates/web-manager/tsconfig.cli.json` (new file)

**Acceptance criteria:**
- `tsconfig.cli.json` extends root `tsconfig.json`, sets `outDir: "cli/dist"`, `module: "commonjs"`, `rootDir: "cli"`, includes `cli/**/*.ts`, excludes `cli/**/*.test.ts`
- Running `tsc --project tsconfig.cli.json` with an empty `cli/index.ts` produces no errors

**Dependencies:** none

---

## Task 2 — Add `bin` entry and `build:cli` script to package.json [cli]

**Description:** Register `srm` as a binary and wire up the CLI build step.

**Files:**
- `templates/web-manager/package.json`

**Acceptance criteria:**
- `"bin": { "srm": "./cli/dist/srm.js" }` is present
- `"build:cli"` script runs `tsc --project tsconfig.cli.json`
- `"build"` script appends `&& npm run build:cli` after the client build
- `npm run build:cli` succeeds after Task 1 is complete (with a stub `cli/srm.ts`)

**Dependencies:** Task 1

---

## Task 3 — Implement argument parser [cli]

**Description:** Write the minimal hand-rolled argument parser in `cli/srm.ts`. No external libraries. Covers all supported invocation forms.

**Files:**
- `templates/web-manager/cli/srm.ts` (new file — create with full arg parser + types)

**Acceptance criteria:**
- `srm implement #42` → resolves to `{ mode: "command", resolved: "/sr:implement #42" }`
- `srm batch-implement #40 #41` → resolves to `{ mode: "command", resolved: "/sr:batch-implement #40 #41" }`
- `srm "any raw prompt"` → resolves to `{ mode: "raw", resolved: "any raw prompt" }`
- `srm --status` → resolves to `{ mode: "status" }`
- `srm --jobs` → resolves to `{ mode: "jobs" }`
- `srm --help` → prints usage text and exits 0
- `srm --port 5000 implement #42` → port 5000 used for all HTTP/WS calls
- Unknown first argument with no `/` prefix and not a known verb → treated as raw prompt
- Unit tests cover all cases above

**Dependencies:** Task 1

---

## Task 4 — Implement web-manager detection [cli]

**Description:** Implement the 500ms probe against `GET /api/state`. Returns a typed result indicating running/not-running and the resolved base URL.

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- Probe resolves in ≤500ms
- ECONNREFUSED → not running (no thrown error)
- Timeout (>500ms) → not running
- 2xx → running; base URL captured
- Non-2xx → not running
- Unit tests mock the HTTP layer and cover all four cases

**Dependencies:** Task 3

---

## Task 5 — Implement web-manager spawn + WebSocket streaming path [cli]

**Description:** POST to `/api/spawn`, open WebSocket, stream log lines to terminal with ANSI pass-through, detect exit via log pattern, close WS, collect processId for summary.

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- `POST /api/spawn` sends `{ command }`, captures `processId`
- HTTP 409 → prints busy error, exits 1
- HTTP 4xx/5xx → prints error body, exits 1
- WebSocket `log` messages: stdout lines print to process.stdout, stderr lines to process.stderr
- WebSocket `phase` messages: print dim cyan phase annotation
- `[process exited with code N]` pattern in a log line → exit code N captured, WS closed
- WS disconnection mid-stream → warning printed, exit code 1
- ANSI codes in log lines are passed through unchanged
- When `process.stdout.isTTY` is false, `[srm]` prefix and phase annotations emit no ANSI codes
- Unit tests cover 409, WS message routing, exit detection, non-TTY mode

**Dependencies:** Task 4

---

## Task 6 — Implement direct fallback path [cli]

**Description:** When web-manager is not running, spawn claude directly with `--output-format stream-json --verbose`. Parse NDJSON output; print text content lines; capture result object for summary.

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- `claude --dangerously-skip-permissions -p <command> --output-format stream-json --verbose` is the exact invocation
- `type: "text"` lines: content printed to stdout
- `type: "result"` line: `cost_usd`, `input_tokens`, `output_tokens` captured
- Unknown JSON types: silently ignored
- Stderr from claude passed through unchanged
- claude not on PATH → `[srm] error: claude binary not found`, exits 1
- Exit code propagated from child process
- Unit tests mock child_process.spawn and feed synthetic NDJSON lines

**Dependencies:** Task 4

---

## Task 7 — Implement summary line printer [cli]

**Description:** After either path completes, print the standardised summary line. Assemble from available data (duration always available; cost/tokens only when captured).

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- Full summary: `[srm] done  duration: 4m32s  cost: $0.08  tokens: 12 400  exit: 0`
- Cost/tokens omitted when not available: `[srm] done  duration: 4m32s  exit: 0`
- Duration formatted as `Xm Ys` when ≥60s, `Xs` when <60s
- Token count formatted with space as thousands separator (e.g. `12 400`)
- Summary suppresses ANSI bold when stdout is not a TTY
- Unit tests cover all formatting variants

**Dependencies:** Tasks 5, 6

---

## Task 8 — Implement `--status` flag [cli]

**Description:** Fetch `GET /api/state` and print a formatted status block.

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- Running: prints project name, busy flag, per-phase states; exits 0
- Not running: prints `web-manager: not running (http://127.0.0.1:<port>)`; exits 1
- Output is human-readable, aligned columns
- Unit tests cover running and not-running cases

**Dependencies:** Task 4

---

## Task 9 — Implement `--jobs` flag [cli]

**Description:** Fetch `GET /api/jobs` and print a tabular job list.

**Files:**
- `templates/web-manager/cli/srm.ts`

**Acceptance criteria:**
- Columns: ID (truncated to 8 chars), COMMAND, STARTED, DURATION, EXIT
- 501 response → prints `[srm] jobs history requires web-manager with SQLite persistence (#57)`, exits 1
- Web-manager not running → prints error, exits 1
- Empty job list → prints `[srm] no jobs recorded yet`, exits 0
- Unit tests cover happy path, 501, not-running, empty list

**Dependencies:** Task 4

---

## Task 10 — Add `GET /api/jobs` and `GET /api/jobs/:id` routes to server [server]

**Description:** Register two new routes on the Express server. For MVP (pre-#57), both return 501 with a clear error code. The route structure is in place so `srm --jobs` can distinguish "server running, no persistence" from "server not running".

**Files:**
- `templates/web-manager/server/index.ts`
- `templates/web-manager/server/jobs.ts` (new file — route handler)

**Acceptance criteria:**
- `GET /api/jobs` returns `{ "error": "job history not available", "code": "NO_PERSISTENCE" }` with HTTP 501
- `GET /api/jobs/:id` returns same 501 response
- Routes registered before server.listen call
- Existing routes (`/api/spawn`, `/api/state`, `/hooks`) are unaffected
- Server integration tests updated to assert both new routes return 501

**Dependencies:** none (parallel with CLI tasks)

---

## Task 11 — Update `GET /api/state` response to include version field [server]

**Description:** Add `"version": "<semver>"` to the state response so `srm --status` can show the web-manager version and future clients can negotiate capabilities.

**Files:**
- `templates/web-manager/server/index.ts`
- `templates/web-manager/package.json` (version already present; just read it at startup)

**Acceptance criteria:**
- `GET /api/state` response includes `"version": "x.y.z"` matching `package.json` version
- Existing state response fields (`projectName`, `phases`, `busy`) unchanged
- Server integration test updated

**Dependencies:** none

---

## Task 12 — Write integration test for srm web-manager path [tests]

**Description:** End-to-end test that starts a test Express+WS server, runs `srm implement #42` against it, and asserts the full flow: spawn called, WS lines received, summary printed.

**Files:**
- `templates/web-manager/cli/srm.test.ts`

**Acceptance criteria:**
- Test starts a real in-process test server (no mocks for HTTP/WS layer in this test)
- Asserts `POST /api/spawn` was called with correct command
- Asserts log lines appear on stdout
- Asserts summary line is printed with correct duration and exit code
- Test runs under `vitest` alongside existing tests

**Dependencies:** Tasks 5, 7, 10

---

## Task 13 — Write integration test for srm direct fallback path [tests]

**Description:** Test that when no server is reachable, `srm` invokes claude and parses its stream-json output correctly.

**Files:**
- `templates/web-manager/cli/srm.test.ts`

**Acceptance criteria:**
- Mocks child_process.spawn to emit synthetic NDJSON
- Asserts text lines printed to stdout
- Asserts summary printed with cost and token values parsed from result object
- Asserts exit code propagated

**Dependencies:** Tasks 6, 7

---

## Task 14 — Update web-manager README with srm usage [cli]

**Description:** Add a "Using srm" section to `templates/web-manager/README.md` documenting installation, all commands, and the web-manager-detection behaviour.

**Files:**
- `templates/web-manager/README.md`

**Acceptance criteria:**
- Documents `npm install -g` or `npm link` for local development
- Documents all four invocation modes with examples
- Documents fallback behaviour
- Notes that `--jobs` requires #57

**Dependencies:** Tasks 1–9 must be finalised so docs reflect actual behaviour

---

## Compatibility Impact

Compatibility: No contract surface changes detected for existing elements. New surface (srm binary, `/api/jobs`, `/api/jobs/:id`) is additive only.
