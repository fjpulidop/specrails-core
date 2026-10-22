## Context

`ActiveSession.deliver` writes an input straight to drivers with a native input queue (Claude) and holds it in `heldInputs` for drivers that run one turn per request (Codex, executor adapters). `session.interrupt` asks the driver to stop the turn and arms a grace timer that retires the process if the provider does not comply. Drivers report a host-requested stop as `turn.completed { status: 'stopped' }`.

## Decisions

### D1. One delivery value, sequencing owned by the application
`'interrupt'` is a third `InputDelivery`. The application decides the sequence from the descriptor:

| Driver shape | Sequence |
| --- | --- |
| No turn running (any driver) | Delivered as `queue`. |
| Native queue + `interrupt: 'native'` (Claude) | The driver receives `delivery: 'interrupt'` and writes the provider primitive plus the input in one call. |
| No native queue (Codex, executors) | The input goes to the front of a dedicated interrupt queue, ahead of `heldInputs`; the application calls `driver.interrupt()`. When the cut turn completes, the interrupt queue is released first. For Codex `driver.interrupt()` is `turn/interrupt` and the release is `turn/start`: the native pair. For executors it aborts the invocation (emulated). |
| Native queue without a primitive | `driver.interrupt()` then `send` as `queue` (emulated; ordering against inputs already inside the provider queue follows the provider). |

Rationale: the application already owns holding and release for non-queueing drivers; a driver-level wait for `turn/completed` inside Codex's `send` would hold the session lock for the whole stop and race the application's own release.

### D2. Claude uses `priority: 'now'`
Live capture (Claude Code 2.1.299, fixture `claude-interrupt-now.jsonl`): after `control_request interrupt`, inputs written with the default or `next` priority are batched with already queued commands into one turn, queued ones first. With `priority: 'now'` the interrupting input runs alone in the next turn and queued inputs follow in their own turn. The interrupt response reports `still_queued`. The CLI then reports the cut turn's input `cancelled`; the translator ignores `cancelled` for an input that already started (the turn result carries the outcome).

A second `'interrupt'` while the first is still pending does not send another `control_request`: it is written with `priority: 'now'` only, so it is not used to cut the correction that just started. Non-queueing drivers likewise queue later interrupts behind the pending one.

### D3. Status mapping and partial output
The application remembers `{ turnId, inputIds }` of the pending interrupt. A `stopped` completion of that turn is journaled as `interrupted`. When the provider reports no final text (Claude's interrupted `result` has none), `turn.completed.text` is the accumulated streamed text. A turn that completed on its own before the primitive landed keeps its status.

### D4. Grace expiry never loses the input
If the cut turn does not end within `interruptGraceMs`, the process is retired with turn status `interrupted`. Inputs of the pending interrupt that have not started, plus inputs Core still holds, are kept (not marked `interrupted`) and delivered to a fresh process (provider session resumed). Inputs that were inside the dead provider's own queue are recorded `interrupted` as today and reported by the next interruption notice.

### D5. Recovery
No new journal state. An interrupted turn is a terminal `turn.completed`; restart recovery only touches open work. An interrupting input committed but not yet started when the host died is recorded `interrupted` (reason `restart`) and never replayed, exactly like any other input.

### D6. Contract
Contract 5.3 adds `agentRuntime.sessions.deliveries`; `runtime api` adds `flowSessions: 1`. The protocol version stays 1: a new enum value on a request is additive because hosts that do not know it never send it; event payloads do not change shape.

## Risks

- Claude's `priority: 'now'` and the `cancelled` lifecycle are CLI behaviours, pinned by the recorded fixture rather than a documented API. The driver conformance and fixture tests fail if a CLI update changes them.
