## 1. Foundations

- [x] 1.1 Capture real Claude (2.1.285) and Codex (0.153.4) sub-agent transcripts; store sanitized fixtures and findings in `reference/`
- [x] 1.2 Write `docs/agent-sessions/protocol.md` (methods, notifications, event union, error codes, versioning) and `docs/agent-sessions/architecture.md` (layers, patterns, extension rules); link from `docs/agent-runtime.md`
- [x] 1.3 Add `src/shared/specrails-home.ts` (`specrailsHome()`, `sessionsRoot(scope)`) honouring `SPECRAILS_REGISTRY_HOME`; adopt in `src/installer/util/registry.ts` with unchanged behaviour and tests
- [x] 1.4 Extend `src/architecture.test.ts` with session layering rules (domain isolation, application → domain/ports only, drivers/journal/host mutually isolated, only `cli.ts` imports `host/`, no provider-id comparisons outside drivers)

## 2. Domain (pure)

- [x] 2.1 Event union and value types (`domain/events.ts`, `domain/types.ts`) with schema definitions shared by host validation
- [x] 2.2 State machines as transition tables for session, turn, input and sub-agent (re-entrant), with exhaustive transition tests
- [x] 2.3 Reducers folding events into snapshot, sub-agent tree and recorded settled state, with live-vs-replay equivalence tests (the time-based settle debounce lives in the application, task 3.3)
- [x] 2.4 `domain/policy.ts` validation against driver descriptors (`policy_unenforceable`) and defaults module for limits
- [x] 2.5 `domain/usage.ts` per-declaration usage math (session-cumulative USD, per-thread cumulative tokens, per-turn tokens; null preservation; estimated flag) with tests derived from fixture numbers
- [x] 2.6 `domain/interruption.ts` one-time interruption notice builder

## 3. Ports, application and supervision

- [x] 3.1 `ports.ts`: `DriverFactory`, `DriverSession`, `DriverEventSink`, `SessionJournal`, `ProcessSpawner`, `Clock`, `Ids` (narrow, use-case owned)
- [x] 3.2 `application/session-service.ts` use cases: open/resume, send (idempotent by inputId, commit-before-write), interrupt, stopSubagents, update (applied/deferred), close, snapshot, events, list
- [x] 3.3 `application/supervisor.ts`: idle/stall/background-max/turn-inactivity timers, LRU resident cap, graceful retirement, reasons; fake-clock tests
- [x] 3.4 Continuation handling: provider-native, `resume-agent` with bounded handoffs, `notify-only`; tests per mode
- [x] 3.5 Restart recovery: mark running turns/sub-agents/inputs interrupted on open; never auto-start providers

## 4. Journal

- [x] 4.1 SQLite adapter (`journal/`): private path, WAL/FULL/foreign keys, forward-only ordered migrations by `user_version`, refusal of newer versions
- [x] 4.2 Epoch-fenced host lease (TTL/heartbeat as engine), `journal_locked`, stale-owner fencing with `host_lost` interruption
- [x] 4.3 Atomic event + snapshot commits, gap-free per-session sequence, cursor reads, usage baselines, retention sweep (output caps live in the application; blobs dropped, see design D6)
- [x] 4.4 Crash tests (child process + SIGKILL during commit) and `journal/README.md` (owns, invariants, bounds, crash semantics, tests)

## 5. Drivers and conformance kit

- [x] 5.1 `testing/fixture-replayer.ts` implementing `ProcessSpawner` from recorded transcripts (time-compressed), plus synthetic edge fixtures
- [x] 5.2 `testing/driver-conformance.ts` shared suite (descriptor, ordering, receipts, turn delimitation, interrupt, close idempotency, policy, usage semantics, no events after close, sub-agent invariants)
- [x] 5.3 `drivers/registry.ts` closed frozen registry with descriptor validation
- [x] 5.4 Claude driver: transport via `cli-process.ts`, pure translator, policy mapping (`--disallowedTools Agent Task`, tools, MCP strict config), SIGTERM capture of stopped/killed notifications; passes conformance + fixture scenarios
- [x] 5.5 Codex driver: app-server JSON-RPC client, thread demux, pure translator, policy mapping (`features.multi_agent`, sandbox, approvals, MCP overrides — verify isolation with a new fixture), resume via `thread/resume`; passes conformance + fixture scenarios
- [x] 5.6 Executor-backed driver adapting `AgentExecutor` for Gemini, Kimi and OpenAI-compatible (non-resident, sub-agents unsupported); passes conformance
- [x] 5.7 Opt-in live re-capture script (`SPECRAILS_LIVE_PROVIDER_SMOKE=1`) documented, excluded from CI

## 6. Host and contract

- [x] 6.1 `host/`: NDJSON framing with size limit, Ajv-validated closed method table (one handler per method), error mapping, committed-event notification fan-out with bounded backpressure (coalesce deltas only)
- [x] 6.2 `cli.ts`: `runtime host --stdio --scope`, signal handling and `host.shutdown`; add to `RUNTIME_CLI_OPERATIONS`
- [x] 6.3 `runtime api` capability `sessions: 1`; `integration-contract.json` `agentRuntime.sessions` block; contract test updates
- [x] 6.4 Composition root `createSessionRuntime` and package exports `./agent-runtime/session` and `./agent-runtime/session/testing`; `scripts/verify-package.mjs` smoke-imports them
- [x] 6.5 Built-binary smoke: spawn `runtime host` with a fake driver, run open/send/stream/close/replay over stdio (all platforms in CI)

## 7. Documentation and release

- [ ] 7.1 `docs/agent-sessions/drivers.md` (driver contract, capability matrix, adding a provider), `journal.md`, `extending.md`; READMEs in `session/`, `drivers/`, `journal/`, `host/`
- [ ] 7.2 Update `docs/agent-runtime.md` capability table and CLAUDE.md layering note
- [ ] 7.3 Gates: `npm run typecheck`, `npm test`, `npm run ci` (coverage gates unchanged), `npm run check:package`
- [ ] 7.4 Coordinate release with the paired Desktop change `core-agent-sessions-host` (Core released first; Desktop pins and negotiates `sessions`)
