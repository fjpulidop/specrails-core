# Session protocol (version 1)

A host talks to `specrails-core runtime host --stdio --scope <scope>` using
JSON-RPC 2.0. Each message is one JSON object on one line (NDJSON) of at most
2 MiB. stdout carries protocol messages only; diagnostics go to stderr.

`runtime api` advertises `capabilities.sessions = 1` when this protocol is
available, and `capabilities.flowSessions = 1` when `session.send` accepts
`delivery: 'interrupt'`. `integration-contract.json` → `agentRuntime.sessions`
lists the protocol versions, the CLI operation, the journal root, the event
types, the `initialize` capabilities and the deliveries; a contract test keeps
them in sync with the code.

## Lifecycle

1. The host spawns `runtime host --stdio --scope <projectKey|global>`.
2. The host sends `initialize`. Nothing else is accepted before it succeeds.
3. The host opens or resumes sessions, sends input and receives `session.event` notifications.
4. The host sends `host.shutdown`, or terminates the process. Live work is recorded as interrupted with reason `shutdown`.

A scope has at most one live host. A second host for the same scope fails
`initialize` with `journal_locked`.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `{ protocolVersions: number[], host: { name, version }, scope }` | `{ protocolVersion, runtime: RuntimeIdentity, capabilities, drivers: DriverDescriptor[] }` |
| `session.open` | `{ sessionId?, resume?: { sessionId }, driver, model, effort?, cwd, systemPrompt?, policy: SessionPolicy, metadata? }` | `{ sessionId, snapshot: SessionSnapshot }` |
| `session.send` | `{ sessionId, input: { inputId, text, attachments?, delivery: 'queue' \| 'steer' \| 'interrupt' } }` | `{ inputId, state }` (idempotent by `inputId`) |
| `session.interrupt` | `{ sessionId }` | `{ turnId \| null }` |
| `session.stopSubagents` | `{ sessionId, subagentIds? }` | `{ stopped: string[] }` (native and delegated) |
| `session.delegate` | `{ sessionId, description, prompt, agentType?, contextTurns? }` | `{ subagentId }`, or `limit_reached` |
| `session.waitSubagents` | `{ sessionId, subagentIds?, timeoutMs }` | `{ results: [{ subagentId, description, status, result }], running: string[] }` |
| `session.update` | `{ sessionId, model?, effort?, systemPrompt?, policy? }` | `{ outcome: 'applied' \| 'deferred' }` |
| `session.close` | `{ sessionId, reason }` | `{}` |
| `session.snapshot` | `{ sessionId }` | `SessionSnapshot` |
| `session.events` | `{ sessionId, afterSeq, limit? }` | `{ events: SessionEvent[], nextSeq, hasMore }` |
| `session.list` | `{ state?: 'open' \| 'closed' \| 'all' }` | `{ sessions: SessionSummary[] }` |
| `host.ping` | `{}` | `{ uptimeMs, sessions, residentProcesses }` |
| `host.shutdown` | `{ graceMs? }` | `{}` (sent before the process exits) |

`initialize` returns `capabilities: { sessions: 1, delegation: 1, flowSessions: 1 }`.
Each driver descriptor in `drivers` may carry `capabilities.interrupt:
'native' | 'emulated'`; treat its absence as "interrupt delivery unsupported"
(an older Core).

### Deliveries

| `delivery` | Turn running | Session idle |
| --- | --- | --- |
| `queue` | Runs as a later turn, after inputs queued before it. | Starts a turn. |
| `steer` | Delivered into the running turn (drivers with `steer`); otherwise queued. | Starts a turn. |
| `interrupt` | Cuts the running turn and runs this input as the next turn, ahead of inputs queued before it. | Exactly like `queue`. |

`interrupt` is a user correcting the agent mid-turn. Core picks the mechanism
per driver (`capabilities.interrupt`): `native` uses the provider's stop
primitive and keeps its session (Claude `control_request interrupt` plus the
input with `priority: 'now'`; Codex `turn/interrupt`, then `turn/start` once the
turn completed); `emulated` stops the turn like `session.interrupt` and runs the
input next (executor-backed drivers resume the provider session).

Event order for an interrupt during a turn:

1. `input.accepted { inputId, delivery: 'interrupt' }`
2. `input.state { state: 'queued' }` when the provider queues it (Claude)
3. `turn.completed { turnId: <cut turn>, status: 'interrupted', text: <partial text> }`; the cut turn's own inputs complete with it
4. `input.state { state: 'started' }` and `turn.started { inputIds: [<interrupting input>] }`
5. later, turns for the inputs that were queued before it, in their order

If the turn finished on its own before the stop landed, step 3 carries the
provider's status (`completed`, `failed`). An `interrupt` sent while an earlier
one has not started yet does not stop again: it runs right after the earlier
one, still ahead of queued inputs. If the provider does not end the turn within
the interrupt grace (5 s), Core retires the process (`session.process retired`,
reason `user_stop`), records the turn `interrupted`, and delivers the
interrupting input and any input Core still held to a new process; inputs that
were inside the dead provider's own queue are recorded `interrupted`
(reason `user_interrupt`) and reported by the next interruption notice. After a
host restart an interrupted turn is never re-run, and an interrupting input that
had not started is recorded `interrupted` (reason `restart`), like any input.

`session.update` replaces the fields it carries; `policy` is resolved as a whole, so send the complete policy. An update that leaves the effective configuration unchanged is a no-op: nothing is journaled and the resident process keeps running. Hosts may re-send their configuration before every turn. A real change applies at once when the session is idle and retires the process, because provider flags are fixed at spawn. While a turn or sub-agents run, the change is `deferred` until the session goes idle.

`resume` reopens a closed, retired or interrupted session from the journal.
The provider session is resumed (Claude `--resume`, Codex `thread/resume`)
the next time a turn needs a process.

## Notifications

`session.event` → `{ sessionId, seq, event: SessionEvent }`

`session.lagged` → `{ sessionId, deliveredSeq }` (queued notifications after `deliveredSeq` were discarded; read them with `session.events`)

`host.leaseLost` → `{}` (another host took over the scope; this host stops serving and exits)

- Notifications are sent only after the event is committed to the journal.
- Notifications, `session.events` replay and `session.open`/`session.snapshot` snapshots carry the journal's redacted text: recognisable secrets in tool I/O and free text read `[REDACTED]` ([journal](journal.md#secret-redaction)). Shapes and usage numbers are unchanged.
- `seq` is gap-free per session and starts at 1. The journal is the source of truth and notifications are a live feed of it.
- A client applies events idempotently by `(sessionId, seq)`. When it sees a gap, it fetches the missing range with `session.events`.
- Under backpressure the host may discard queued notifications of the busiest session. It first sends `session.lagged { sessionId, deliveredSeq }`. Nothing is lost: the client catches up with `session.events`.

## Events

Every event has `{ type, at }`, where `at` is an ISO-8601 commit time.

| Type | Payload |
| --- | --- |
| `session.opened` | `driver, model, effort?, policy, resumed, providerSessionRef \| null` |
| `session.phase` | `phase: 'idle' \| 'turn' \| 'background'` |
| `session.process` | `state: 'started' \| 'retired' \| 'exited', generation, reason?, exitCode?` |
| `session.provider-ref` | `providerSessionRef` (provider session/thread id, learned after the first turn) |
| `session.updated` | `changes, outcome: 'applied' \| 'deferred'` |
| `session.closed` | `reason` |
| `input.accepted` | `inputId, delivery, text, attachments?` |
| `input.state` | `inputId, state: 'queued' \| 'started' \| 'completed' \| 'rejected' \| 'interrupted', turnId?, reason?` |
| `turn.started` | `turnId, origin: 'user' \| 'subagent' \| 'system', inputIds, trigger?: { subagentIds }` |
| `turn.output` | `turnId, channel: 'text' \| 'thinking', delta` |
| `turn.tool` | `turnId, toolUseId, name, phase: 'started' \| 'completed', input?, output?, isError?` |
| `turn.completed` | `turnId, status: 'completed' \| 'failed' \| 'stopped' \| 'interrupted', text, error?, usage: Usage` |
| `subagent.started` | `subagentId, parentId \| null, kind: 'foreground' \| 'background', agentType?, description, prompt?` |
| `subagent.phase` | `subagentId, phase: 'running' \| 'idle' \| 'failed' \| 'stopped' \| 'killed' \| 'interrupted', reason?` |
| `subagent.output` | `subagentId, channel: 'text' \| 'tool', delta?, tool?: { toolUseId, name, phase, input?, output?, isError? }` |
| `subagent.usage` | `subagentId, usage: Usage, toolUses?, durationMs?` |
| `subagent.result` | `subagentId, summary` |
| `subagents.settled` | `settled: boolean, live: number` |
| `output.truncated` | `scope: { turnId } \| { subagentId }, droppedEvents, droppedBytes` |
| `notice.interruption` | `subagentIds, inputIds` (the notice was prefixed to the next input) |
| `provider.diagnostic` | `level: 'info' \| 'warning', code, message` |

`parentId: null` means the session's main agent. A sub-agent's phase can return
from `idle` to `running`, because providers restart sub-agents. `subagents.settled`
is the authoritative "all sub-agent work is done" signal; it is computed with a
debounce window and the provider roster.

```ts
interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number | null      // per-turn delta; never added on top of by sub-agent usage
  costEstimated: boolean      // true when derived from a rate card, not billed by the provider
  model: string | null
}
```

A missing provider value is `null`, never `0`.

## Policy

```ts
interface SessionPolicy {
  subagents: 'enabled' | 'disabled'
  onSubagentsSettled: 'provider-native' | 'resume-agent' | 'notify-only'
  tools: { mode: 'default' | 'read-only' | 'none'; allow?: string[]; deny?: string[] }
  permissions: 'bypass' | 'workspace-write' | 'read-only'
  mcp: { servers: McpServerSpec[]; inheritUserScope: boolean }
  limits?: Partial<SessionLimits>   // idleMs, stallMs, backgroundMaxMs, turnInactivityMs, toolInactivityMs, maxSettleHandoffs
  subagentRuntime?:                  // who launches sub-agents (default: native)
    | { mode: 'native'; model?: string; effort?: string }
    | { mode: 'delegated'; driver: string; model?: string; effort?: string; maxConcurrent?: number }
}

interface McpServerSpec {
  name: string
  command?: string; args?: string[]; env?: Record<string, string>   // stdio
  url?: string; headers?: Record<string, string>                     // http
  autoApprove?: boolean   // the host authorizes each call; providers must not gate its tools
}
```

Set `autoApprove` only for servers the host authorizes itself, such as a
capability-bound bridge. Codex otherwise refuses MCP tools it cannot classify
under its non-interactive approval policy. Claude ignores the flag: its
permissions come from `policy.permissions`.

`subagentRuntime.mode = 'native'` keeps the provider's own sub-agents, with an
optional model and effort when the driver declares `subagentModel` /
`subagentEffort`. `'delegated'` makes Core launch each sub-agent as a child
session on `driver` and switches the provider's own tool off (see
[the delegation section](#delegated-sub-agents)).

`session.open` fails with `policy_unenforceable` when the selected driver cannot
enforce a requested value. For example, `subagents: 'disabled'` on a driver that
supports sub-agents but cannot turn them off.

## Delegated sub-agents

With `policy.subagentRuntime.mode = 'delegated'` (initialize advertises
`capabilities.delegation: 1`), Core launches sub-agents itself:

- `session.delegate` opens a **child session** on the runtime's driver, model and effort. The child has the parent's cwd, permissions and MCP servers, and its sub-agents are disabled. It returns the sub-agent id at once. The parent journals `subagent.started` with `delegated: { driver, model }`.
- The child's text and tools appear in the parent as `subagent.output`. Its final answer becomes `subagent.result`, its spend `subagent.usage` with `billing: 'separate'` (native sub-agents report `'included'`). The child session then closes.
- `session.waitSubagents` returns finished results; those are never sent to the agent again. Results nobody waited for are delivered to the parent in a `system` turn once its sub-agents settle, for every driver, bounded by `limits.maxSettleHandoffs`.
- Delegated children outlive the parent's provider process. They end with their own session, an explicit `session.stopSubagents`, or the parent's `session.close`. After a host restart they are recorded as interrupted and their child sessions are closed.
- At most `subagentRuntime.maxConcurrent` (default 4) run at once; further delegations fail with `limit_reached`.

## Errors

JSON-RPC errors carry `data: { code, retryable, detail? }`.

| `data.code` | Meaning | Retryable |
| --- | --- | --- |
| `protocol_mismatch` | No common protocol version | no |
| `not_initialized` | Method before `initialize` | no |
| `invalid_params` | Schema violation (`detail.path`) | no |
| `payload_too_large` | Line above the framing limit | no |
| `session_not_found` | Unknown session id | no |
| `session_closed` | Operation on a closed session | no |
| `driver_unavailable` | Driver not registered, or its CLI is missing | no |
| `policy_unenforceable` | Policy cannot be enforced by the driver | no |
| `input_conflict` | Same `inputId` with different content | no |
| `journal_locked` | Another live host owns the scope | yes |
| `store_incompatible` | Journal written by a newer schema | no |
| `busy` | Transient contention | yes |
| `internal` | Unexpected failure; see host stderr | yes |

## Versioning

- `protocolVersion` is an integer negotiated at `initialize`.
- New optional fields and new event types are not breaking. Hosts must ignore unknown event types.
- Removing or changing a field's meaning requires a new protocol version. Core keeps the previous version for at least one Desktop release window.
