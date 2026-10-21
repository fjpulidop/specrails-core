## Why

Desktop's upcoming Flow mode lets the user correct an agent mid-turn, the way an interactive Claude Code or Codex session does: the running turn stops and the correction becomes the next turn. Today no session path does that. `steer` delivers into the running turn without stopping it (Claude `priority: 'next'`, Codex `turn/steer`), and `session.interrupt` only stops. A host that combines `session.interrupt` with `session.send` races the provider's own queue and can reorder or lose the correction. Interrupting is provider semantics, so it belongs in Core (design: specrails-desktop `docs/plans/flow-arquitectura.md` §3.1).

## What Changes

- **New delivery `'interrupt'`** for `session.send`, next to `queue` and `steer`. It cuts the in-flight turn and starts a new turn with the input. Already queued inputs keep their order, after the interrupting input. With no turn running it behaves like `queue`.
- **Per-driver mechanism.** Claude: `control_request { subtype: 'interrupt' }` followed by the user frame with `priority: 'now'` (verified live on Claude Code 2.1.299: the input runs alone in the next turn, ahead of queued inputs). Codex: `turn/interrupt`, then `turn/start` once the interrupted turn completes (verified live on codex-cli 0.160.1). Drivers without a primitive (executor adapters) use a uniform emulation: stop the turn as `session.interrupt` does, then run the input first.
- **Capability.** `DriverCapabilities.interrupt?: 'native' | 'emulated'` (optional, additive). Claude and Codex declare `native`, executor adapters `emulated`.
- **Events.** No new event types. `input.accepted { delivery: 'interrupt' }`, then `turn.completed { status: 'interrupted' }` for the cut turn (its partial text preserved), then `turn.started` with the interrupting input. If the provider still reports the cut turn's input as cancelled, Core no longer turns that into a warning.
- **Never lose the input.** If the provider does not end the turn within the interrupt grace period, the process is retired; the interrupting input and inputs Core still holds survive and are delivered to a fresh process.
- **Contract.** `integration-contract.json` 5.2 → 5.3: `agentRuntime.sessions.deliveries: ['queue', 'steer', 'interrupt']`. `runtime api` capability `flowSessions: 1`. Protocol docs updated.

## Capabilities

### New Capabilities
- `agent-session-interrupt-delivery`: the `interrupt` delivery of `session.send`, its per-driver mechanism, ordering, event sequence, recovery and capability declaration.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/ yet; agent-session-runtime (in flight) owns the base protocol, which this extends additively. -->

## Impact

- **Code:** `src/agent-runtime/session/` (domain types, ports, active session, host schema, Claude/Codex/executor drivers, scripted test driver), `src/agent-runtime/cli.ts` (capability).
- **Contract:** `integration-contract.json` schemaVersion 5.3; protocol version stays 1 (additive enum value; old hosts never send it).
- **Desktop pairing:** Flow mode sends `delivery: 'interrupt'` only when `runtime api` reports `flowSessions >= 1`; it may read `capabilities.interrupt` per driver from `initialize` to label the behaviour, treating absence as unsupported.
