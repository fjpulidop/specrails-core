# Session drivers

A driver turns one provider's wire protocol into the session model. Its folder
is the only place where that provider's vocabulary appears. The architecture
test enforces this: no code outside `drivers/` compares ids with provider names.

## Contract

| Piece | Role |
| --- | --- |
| `DriverDescriptor` | Frozen identity and capabilities. The application adapts to these declarations, never to provider ids. |
| `DriverFactory.open(spec, sink)` | Starts a provider session for one session generation and reports normalized `DriverEvent`s to `sink`. |
| `DriverSession` | `send`, `interrupt`, `stopSubagents`, `close` (idempotent; no events after it resolves). |
| Translator | Turns one wire frame into normalized events. Deterministic and free of I/O. Unknown frames become one `provider.unknown` diagnostic and never fail a turn. |
| Transport | Process or RPC plumbing (`common/process.ts`, `codex/rpc.ts`). |

### Capabilities

| Capability | Claude | Codex | Executor-backed (Gemini, Kimi, OpenAI-compatible) |
| --- | --- | --- | --- |
| `resident` | yes | yes | no (one invocation per input, provider session resumed) |
| `nativeInputQueue` | yes (`command_lifecycle`) | no (the application holds input) | no |
| `subagents` / `subagentDisable` | supported / yes (`--disallowedTools Agent,Task`) | supported / yes (`features.multi_agent=false`) | unsupported |
| `autonomousContinuation` | yes (task-notification turns) | no (policy `resume-agent` asks the agent to collect) | no |
| `steer` | yes (`priority: next`) | yes (`turn/steer`) | no |
| `toolFiltering` | yes (`--tools`, `--allowedTools`, `--disallowedTools`) | no | no |
| `usage` | USD session-cumulative, tokens per turn | no USD, tokens cumulative per thread | per turn |

### Process ownership

Resident drivers spawn through `common/process.ts`: cross-spawn, their own
process group on POSIX, and two-phase tree-kill (SIGTERM, grace period, then
SIGKILL; `taskkill /T`, then `/F` on Windows). Claude reports stopped tasks
while it shuts down, so those notices are recorded before the process exits.

## Conformance

`testing/driver-conformance.ts` defines framework-free checks that every
driver must pass:

- valid and coherent descriptor;
- unenforceable policies refused;
- ordered receipts and terminal turns;
- usage reported per its declared semantics;
- idempotent close with no events afterwards.

`conformance.test.ts` runs them against every driver. Claude and Codex run
through the fixture replayer (`testing/fixture-replayer.ts`): it plays recorded
transcripts as a `ProcessSpawner`, gates on the driver's input and remaps
request ids and uuids. Tests never mock `child_process` and never call a provider.

## Adding a provider

1. Capture transcripts with the real CLI (see below) and record the behaviour
   in the OpenSpec change's `reference/provider-findings.md`.
2. Create `drivers/<id>/` with argv/config mapping, a pure translator and a
   transport, and declare only what the provider actually does.
3. Register it in `registry.ts`.
4. Add a conformance harness and fixture scenarios, then run
   `npx vitest run src/agent-runtime/session`.

## Re-capturing fixtures

```sh
SPECRAILS_LIVE_PROVIDER_SMOKE=1 node scripts/capture-session-fixtures.mjs claude
SPECRAILS_LIVE_PROVIDER_SMOKE=1 node scripts/capture-session-fixtures.mjs codex
```

The script calls paid providers with cheap models, which costs a few cents.
It refuses to run without the flag and is never part of CI. Paths, host and
installation ids are sanitized. Review the diff before committing.
