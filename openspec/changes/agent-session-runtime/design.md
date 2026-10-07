## Context

Core today (6.4.0) executes frozen implementation workflows. `ExecutorRegistry` runs one-shot provider processes per step (`cli-executor.ts`, `openai-executor.ts`, `kimi-acp.ts`). Engine v2 persists runs in per-run SQLite with a lease/epoch fence. The steering inbox accepts operator text for the next attempt. Desktop drives Core through one CLI process per operation and reads JSONL from stdout. Nested agents are explicitly disallowed.

Desktop runs every conversational surface itself: missions, explore, blueprint, agent refine, interactive jobs, plus about 14 one-shot features. They sit on `server/providers/*`, a second provider layer. Missions kill background sub-agents at turn end (Claude) and cannot express Codex's thread-based sub-agents.

The spike in [reference/provider-findings.md](reference/provider-findings.md) recorded the real wire behaviour of Claude Code 2.1.285 and codex-cli 0.153.4. Its consequences shape this design:

- turns are serialized by Claude itself, with per-input `command_lifecycle` receipts;
- Claude starts continuation turns on its own; Codex never does;
- Claude sub-agent status is re-entrant (`completed → running`);
- Codex sub-agents are child threads demultiplexed by `threadId`;
- Claude's USD is cumulative per session across `--resume`; Codex reports per-thread cumulative tokens and no USD;
- both providers can disable sub-agents by flag.

Engineering conventions this design follows:

- **Core:**
  - layering `shared ← pipeline ← agent-runtime ← installer`;
  - spawn only through `cli-process.ts`;
  - inject runners and never mock `child_process`;
  - `node:sqlite` with WAL, FULL sync, `user_version` and private paths;
  - lease/epoch fencing;
  - per-subsystem README (owns, invariants, bounds, crash semantics, tests);
  - closed, reviewed extension points (no plugins);
  - contract test against `integration-contract.json`.
- **Desktop:**
  - capability modules with *selective* ports and adapters;
  - composition over DI containers, service locators and base-class hierarchies;
  - an interface only where variation is real;
  - fakes that honour the same contract (LSP).

## Goals / Non-Goals

**Goals:**
- One provider-neutral session model and one place where provider protocols are interpreted.
- Long-lived, multi-session host with a versioned, explicitly negotiated protocol.
- First-class sub-agents for Claude and Codex, with policy enforcement, including disabling them.
- Durable, replayable session state outside any repository, grouped per project.
- Correct usage semantics proven against captured provider behaviour.
- Extensibility: a new provider or a new policy is added by implementing a narrow contract, passing the conformance kit and registering it. Existing code does not change.

**Non-Goals:**
- Migrating engine role turns or `ExecutorRegistry` to session drivers (later change; this design keeps the seam ready).
- Gemini/Kimi sub-agents (unverified; declared unsupported).
- Product rules: queue UX, mission cards, Specrails MCP capability minting, tiers, PR decisions. They stay in Desktop.
- Network transport (the host is stdio-only; remote access is a separate concern).

## Decisions

### D1. Subsystem layout and dependency rules (hexagonal core, enforced)

```
src/agent-runtime/session/
  domain/        pure model: types, state machines, reducers, usage math, policy (no I/O, no node: except types)
  application/   use cases (SessionService, Supervisor) depending only on domain + ports
  ports.ts       narrow interfaces owned by the application (DriverFactory, DriverSession, SessionJournal, Clock, Ids, ProcessSpawner)
  drivers/
    claude/      transport (stream-json over ProcessSpawner) + translator (pure reducer) + policy mapping
    codex/       JSON-RPC client + thread demux + translator (pure reducer) + policy mapping
    executor/    adapter exposing existing AgentExecutor as a non-resident driver
    registry.ts  DriverRegistry (closed list, frozen descriptors)
  journal/       SQLite adapter for SessionJournal (+ README)
  host/          JSON-RPC stdio server: framing, schema validation, method handlers, notification fan-out (+ README)
  testing/       driver conformance kit + fixture replayer (exported for tests only)
  index.ts       composition root: createSessionRuntime(options)
```

`src/architecture.test.ts` gains rules:

- `domain/` imports nothing outside `domain/` (and `src/shared/`).
- `application/` imports only `domain/` and `ports.ts`.
- `drivers/*`, `journal/` and `host/` may not import each other. They meet only in `index.ts`.
- Only `cli.ts` imports `host/`.

This is dependency inversion where variation is real: providers, storage and transport. It is not an interface for every function.

*Alternative rejected:* extending `ExecutorRegistry`/`AgentExecutor` with streaming methods. That contract is request/response by design (`execute(request): Promise<AgentResult>`) and validated as such. Widening it would break interface segregation for every batch caller. The adapter in `drivers/executor/` connects the two models instead.

### D2. Domain model: event-sourced session with explicit state machines

The journal stores an append-only, gap-free sequence of `SessionEvent`s per session. All read models (snapshot, sub-agent tree, usage totals) are **folds** over events by pure reducers (`domain/reducers.ts`). Replay after a crash or reconnect is the same code path as live updates.

State machines live in `domain/` as transition tables. Illegal transitions are typed errors, which are tested exhaustively.

- **Session:** `opening → idle ⇄ turn ⇄ background → closed`, plus `interrupted`, `failed`.
- **Turn:** `pending → running → completed | failed | stopped | interrupted`, with `origin: user | subagent | system`.
- **Input:** `accepted → queued → started → completed | rejected | interrupted`, mapped from Claude `command_lifecycle` and Codex request acknowledgements.
- **Sub-agent:** `starting → running → idle(completed) → running …` (re-entrant). Terminal states: `failed | stopped | killed | interrupted`. "Completed" is a *phase*, not a terminal guarantee. The tree is settled only when no sub-agent is `running`/`starting` for a debounce window, or when the driver confirms the roster is empty.

*Why event sourcing here:* hosts reconnect and restart. Desktop needs exact replay from a cursor, and the journal must explain usage and interruption after the fact. Engine v2 already uses a ledger plus committed events with JSONL observers that only project. This follows the same discipline: observers never cause effects.

### D3. Driver contract (Strategy + Adapter, anti-corruption layer)

```ts
interface DriverDescriptor {           // frozen, declared up front
  id: string                           // 'claude' | 'codex' | 'gemini' | 'kimi' | 'openai-compatible' | ...
  capabilities: {
    resident: boolean                  // multi-turn on one process
    nativeInputQueue: boolean          // provider serializes turns + receipts
    subagents: 'unsupported' | 'supported'
    subagentDisable: boolean           // policy 'disabled' enforceable by flag
    autonomousContinuation: boolean    // provider starts turns after sub-agent completion
    steer: boolean                     // mid-turn input
    usage: { costUsd: 'session-cumulative' | 'per-turn' | 'none'; tokens: 'per-turn' | 'cumulative' | 'none' }
  }
}
interface DriverFactory { descriptor: DriverDescriptor; open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession> }
interface DriverSession {
  send(input: DriverInput): Promise<void>      // receipts arrive as events
  interrupt(): Promise<void>                   // current turn only
  stopSubagents(ids?: string[]): Promise<void>
  close(reason: CloseReason): Promise<void>    // idempotent; tree-kill via cli-process
}
```

- Each driver has a **transport**, which is effectful, and a **translator** `(state, wireFrame) → { state, events[] }`, which is pure.
- Translators are the anti-corruption layer. Provider vocabulary (`task_started`, `collabAgentToolCall`, `command_lifecycle`, `thread/tokenUsage/updated`) never leaves `drivers/<id>/`.
- The application depends only on `DriverFactory` / `DriverSession` / normalized `DriverEvent`s.
- `DriverRegistry` is a closed, frozen list, mirroring `PieceRegistry`. Duplicate ids and invalid descriptors are rejected at construction.
- Adding a provider means a new folder, a registry entry and passing the conformance kit (D9). This is open/closed in practice.

*Liskov:* every driver passes the same conformance suite. Missing capabilities are declared, never faked. For example, the executor-backed driver has `resident=false` and `subagents='unsupported'`, and the application adapts its behaviour to the declaration, not to the provider id. No `if (provider === 'claude')` exists outside `drivers/`.

### D4. Policy model (Specification-style value object, resolved once)

`SessionPolicy` is a validated value object fixed at `session.open`. It changes only through `session.update` at a safe boundary.

```ts
{
  subagents: 'enabled' | 'disabled'
  onSubagentsSettled: 'provider-native' | 'resume-agent' | 'notify-only'
  tools: { mode: 'default' | 'read-only' | 'none'; allow?: string[]; deny?: string[] }
  permissions: 'bypass' | 'workspace-write' | 'read-only'
  mcp: { servers: McpServerSpec[]; inheritUserScope: boolean }
  limits: { idleMs; stallMs; backgroundMaxMs; turnInactivityMs; maxSubagents?: number }
}
```

- `domain/policy.ts` validates the policy against the driver descriptor. Asking `subagents:'disabled'` from a driver with `subagentDisable=false` while `subagents='supported'` is rejected at open with `policy_unenforceable`. It is never silently ignored.
- Each driver has a `policy-mapping.ts` that turns a policy into argv or config:
  - Claude: `--disallowedTools Agent Task`, `--tools`, `--strict-mcp-config` + `--mcp-config` when `inheritUserScope=false`.
  - Codex: `-c features.multi_agent=false`, sandbox and approval policy, MCP overrides.
- `onSubagentsSettled`:
  - `provider-native` (Claude): the provider resumes on its own.
  - `resume-agent` (Codex default): when the tree settles and the parent is idle, the application starts a `system`-origin turn on the parent asking it to collect results. It is bounded by `MAX_SETTLE_HANDOFFS`, the same safeguard as Desktop's interactive jobs.
  - `notify-only`: emit `subagents.settled` and let the host decide.

  This lets Desktop present one UX across providers without provider branches.
- The **toggle** the product adds later is just Desktop choosing `subagents` per project. The contract carries the field from day one, and Desktop initially sends `enabled` to preserve current behaviour.

### D5. Host process and protocol (Command + Observer, versioned contract)

- **Entry point:** `specrails-core runtime host --stdio --scope <projectKey|global>`. It is added to `RUNTIME_CLI_OPERATIONS`.
- **Framing:** JSON-RPC 2.0 over NDJSON. Each line is at most 2 MiB, matching current limits; larger payloads are rejected with `payload_too_large`. stdout carries protocol only, and logs go to stderr.
- **Method handlers:** one handler per method (Command pattern), registered in a closed table. Each handler validates params with a schema (Ajv, as in `PieceRegistry`), calls one application use case and maps domain errors to protocol errors. Handlers contain no business logic.
- **Methods:**
  - `initialize {protocolVersions[], host{name,version}, scope}` → `{protocolVersion, runtimeIdentity, capabilities, drivers[]}`
  - `session.open {sessionId?, resume?, driver, model, effort?, cwd, systemPrompt?, policy, attachments?}` → `{sessionId, providerSessionRef, snapshot}`
  - `session.send {sessionId, input{inputId, text, attachments?, delivery:'queue'|'steer'}}` → `{accepted}` (idempotent by `inputId`)
  - `session.interrupt {sessionId}`, `session.stopSubagents {sessionId, subagentIds?}`
  - `session.update {sessionId, model?, effort?, policy?}`: applied at the next safe boundary; the response says `applied | deferred`
  - `session.close {sessionId, reason}`, `session.snapshot {sessionId}`, `session.events {sessionId, afterSeq, limit}`, `session.list {}`
  - `host.shutdown {graceMs}`
- **Notifications:** `session.event {sessionId, seq, event}`, published only **after** the journal commit (Observer over committed events). Hosts resume from their last `seq` via `session.events`, so delivery is at-least-once and idempotent by `seq`.
- **Versioning:**
  - `protocolVersion` is an integer negotiated at `initialize`.
  - `runtime api` advertises `sessions: 1`.
  - `integration-contract.json` gets `agentRuntime.sessions {protocolVersion, cliOperation:'host', journalRoot:'~/.specrails/sessions/<scope>', eventTypes[]}`, kept in sync by the contract test.
  - Breaking changes bump `protocolVersion`, and old versions stay supported for one Desktop release window.
- **Errors:** stable codes such as `session_not_found`, `driver_unavailable`, `policy_unenforceable`, `input_conflict`, `journal_locked`, `protocol_mismatch` and `payload_too_large`, each with `data.retryable`.

### D6. Journal (per-project SQLite, epoch-fenced, bounded)

- **Location:** `~/.specrails/sessions/<scope>/sessions.sqlite`. `<scope>` is the host-provided project key (Desktop's project slug, the same key as `~/.specrails/projects/<slug>`) or `global`. It is resolved through the new `src/shared/specrails-home.ts`, honouring `SPECRAILS_REGISTRY_HOME`. Private permissions come from `engine/storage/private-path.ts`.
- **Schema:**
  - `PRAGMA user_version`; WAL; `synchronous=FULL`; `foreign_keys=ON`.
  - Tables: `sessions`, `events (session_id, seq, type, payload, committed_at)`, `inputs`, `subagents` (projection), `usage_baselines (provider_ref, baseline_json)`, `host_lease`.
  - Unlike run databases, the journal is long-lived. It therefore uses an **ordered forward-only migration list** keyed by `user_version`. Each migration runs in `BEGIN IMMEDIATE`, and an unknown future version is refused. This is the only new storage pattern in the change, and the README justifies it.
- **Ownership:** one host per scope. `host_lease` is epoch-fenced, with the same TTL and heartbeat as engine leases. A second host for the same scope gets `journal_locked`. A stale owner is fenced and its live sessions are marked `interrupted` (`host_lost`).
- **Bounds:**
  - per-turn and per-sub-agent output is capped, with an explicit `output.truncated` event;
  - snapshots keep the latest 100 turns and 500 terminal inputs (the journal keeps every event);
  - closed-session retention is configurable.
  - Content-addressed blobs were considered and dropped: capped output leaves nothing that needs them.
- **Crash semantics:**
  - events are committed before notification;
  - provider writes (`send`) happen after `input.accepted` is committed, so a crash between them yields `input.interrupted`, never a replay;
  - restart marks `running` turns and sub-agents `interrupted` with reason `restart`;
  - nothing is relaunched.

### D7. Usage accounting (pure, provider-declared semantics)

`domain/usage.ts` computes per-turn usage from driver events, according to the descriptor's `usage` declaration:

- **Session-cumulative USD (Claude):** turn cost = `reported − baseline(providerSessionRef)`. The baseline persists across processes and `--resume`; this is verified in the spike.
- **Per-thread cumulative tokens (Codex):** per-thread deltas from `tokenUsage.total`. Child-thread usage is attributed to its sub-agent, and USD is `estimated` from the rate card when the host supplies one; otherwise it is null.
- **Missing values** stay `null`, and estimated values carry `estimated: true`.
- **Sub-agent usage** is a breakdown of the turn or session, never added on top of billed totals.

### D8. Supervision and limits

`application/supervisor.ts` owns timers and resident-process lifecycle, behind an injected `Clock`:

- Idle retirement applies only in `idle`.
- In `background`, stall and maximum-lifetime limits apply; they mark sub-agents `interrupted`/`stopped` with a reason.
- Turn inactivity counts sub-agent frames as activity.
- When the resident cap is exceeded, the LRU idle session is retired. The cap governs keep-alive, not admission.

All limits come from policy with defaults in one constants module. Retirement is graceful (EOF, grace period, then tree-kill through `cli-process.ts`). On Claude, SIGTERM produces `stopped`/`killed` notifications that are captured before exit.

After any interruption the next user input is prefixed with a driver-neutral interruption notice built by `domain/interruption.ts`. It lists the affected sub-agents and says not to relaunch them unless asked. It is emitted once per interruption set.

### D9. Conformance kit and testing strategy

- **Fixtures:** `src/agent-runtime/session/testing/fixtures/` holds the sanitized spike transcripts, plus synthetic edge cases: malformed frames, unknown subtypes, out-of-order roster, re-entrant completion.
- **Fixture replayer:** implements `ProcessSpawner` and plays a transcript with its timing compressed. Drivers are tested through their real transport and translator. There are no `child_process` mocks, matching `CliProcessRunner` practice.
- **Shared conformance suite** (`testing/driver-conformance.ts`), run against every registered driver. It checks:
  - descriptor validity;
  - open/send/receipt ordering;
  - turn delimitation;
  - interrupt;
  - close idempotency;
  - policy enforcement or `policy_unenforceable`;
  - usage semantics per declaration;
  - no events after close;
  - sub-agent tree invariants when supported.
- **Pure reducer tests:** exhaustive transition tables and property tests for fold equivalence (live vs replay).
- **Host tests:** in-process duplex streams plus one built-binary smoke test (`runtime host`) with a fake driver.
- **Journal crash tests:** child process plus SIGKILL, in the style of the checkpoint harness.
- **Opt-in live smoke** (`SPECRAILS_LIVE_PROVIDER_SMOKE=1`) that re-captures fixtures with cheap models. It is never part of CI.

### D10. Composition and public surface

- `createSessionRuntime({ scope, home?, drivers?, clock?, spawner?, limits? })` in `session/index.ts` is the only composition root. It wires the registry, journal adapter, supervisor and use cases. `cli.ts host` calls it and hands it to `host/`.
- Package export `./agent-runtime/session` exposes:
  - the protocol types, event union and error codes for hosts;
  - `createSessionRuntime` for in-process embedding in tests;
  - the conformance kit under a separate `./agent-runtime/session/testing` export.

## Risks / Trade-offs

- [Provider wire formats are undocumented and drift] → Translators isolated per driver; unknown frames become `provider.unknown` diagnostic events, not failures; fixtures pinned per CLI version; opt-in live re-capture; descriptor declares tested CLI range and `initialize` reports detected versions.
- [Long-lived host is a single point of failure for a project] → One host per scope limits blast radius; journal makes restart lossless for state; Desktop supervises and restarts; sessions resume with `--resume`/`thread/resume`.
- [Event volume (streaming deltas)] → Deltas coalesced in the driver (≥50 ms or 4 KiB), output caps per sub-agent, notifications backpressured with bounded queue; overflow drops coalescible deltas only, never lifecycle events.
- [Re-entrant sub-agent status confuses consumers] → Domain exposes `phase` plus explicit `settled` boolean computed by debounce + roster; UI guidance in docs.
- [Codex `resume-agent` handoff loops] → bounded handoffs, origin `system` turns visible and costed, policy can switch to `notify-only`.
- [Two provider layers during migration (Desktop legacy + Core)] → explicit capability gate; Desktop legacy path untouched until each surface migrates; final phase deletes Desktop providers.
- [Journal migrations on a long-lived store] → forward-only ordered migrations with tests per step and refusal of unknown future versions.

## Migration Plan

1. Land `src/shared/specrails-home.ts` and adopt it in the installer (no behaviour change).
2. Land domain + journal + fixture replayer + conformance kit (no CLI exposure).
3. Land Claude driver, then Codex driver, then executor-backed driver; each behind the registry.
4. Land host + `runtime host` + `sessions: 1` + contract block; release Core.
5. Desktop (`core-agent-sessions-host`) negotiates `sessions`; legacy transports remain the fallback.
Rollback: Desktop stops negotiating `sessions`; the journal directory is inert. No batch-runtime data is touched.

## Open Questions

- Rate card ownership for Codex USD estimates: Core (shared table) vs host-supplied. Proposal: host-supplied in protocol v1, revisit when Core owns pricing.
- Codex MCP isolation flag set (`-c mcp_servers=…` overrides vs profile): verify during the Codex driver task with a fixture.
- Retention defaults for session journals (proposal: keep 90 days of closed sessions, configurable by host).
