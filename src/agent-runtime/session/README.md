# Agent session runtime

This subsystem owns long-lived, multi-turn agent sessions. Desktop and other
hosts drive it over the session protocol (`runtime host --stdio`). Design and
contracts are in [`docs/agent-sessions/`](../../../docs/agent-sessions/architecture.md).

## Where to change behaviour

| Change | Owner |
| --- | --- |
| Event vocabulary, state machines, snapshot fold | [`domain/events.ts`](domain/events.ts), [`domain/state-machines.ts`](domain/state-machines.ts), [`domain/snapshot.ts`](domain/snapshot.ts) |
| Policy resolution against driver capabilities | [`domain/policy.ts`](domain/policy.ts), [`domain/descriptor.ts`](domain/descriptor.ts) |
| Usage deltas and estimates | [`domain/usage.ts`](domain/usage.ts) |
| Interruption notice | [`domain/interruption.ts`](domain/interruption.ts) |
| Turn and process lifecycle, settlement, limits, teardown | [`application/active-session.ts`](application/active-session.ts) |
| Use cases, per-session serialization, resident cap, startup recovery | [`application/session-service.ts`](application/session-service.ts) |
| Ports | [`ports.ts`](ports.ts) |
| Providers | [`drivers/`](drivers/README.md) |
| Persistence | [`journal/`](journal/README.md) |
| Protocol server | [`host/`](host/README.md) |
| Wiring | [`index.ts`](index.ts) (`createSessionRuntime`) |
| Test kit (exported) | [`testing/`](testing/index.ts) |

## Invariants

- **Commit before effect:** every state change goes through `ActiveSession.commit`, which folds the events with the domain reducer before appending them. The journal therefore never holds an event that would not replay.
- **No replay:** inputs are journaled before they reach a provider, and an uncertain delivery is recorded as interrupted. A previous host's work is never restarted silently.
- **Generation fencing:** events from a retired provider process are ignored. A process that is closing may still report how its tasks stopped.
- **Settlement:** sub-agents count as settled only after a debounce window *and* the provider's roster agree, because providers restart sub-agents under the same id.

## Verify

```sh
npx vitest run src/agent-runtime/session src/architecture.test.ts
npm run build && npx vitest run src/agent-runtime/session/journal src/agent-runtime/session/host
```

The second command runs the crash test and the binary smoke test against `dist/`.
