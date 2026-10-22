## 1. Domain and ports

- [x] 1.1 `InputDelivery` and `DriverInput.delivery` gain `'interrupt'`; `DriverCapabilities.interrupt?: 'native' | 'emulated'`.
- [x] 1.2 Protocol schema accepts `delivery: 'interrupt'`.

## 2. Application

- [x] 2.1 `ActiveSession.send` routes `'interrupt'`: idle → queue; native queue + native primitive → driver; otherwise interrupt queue + `driver.interrupt()`.
- [x] 2.2 Map the cut turn's `stopped` to `interrupted`; keep partial text.
- [x] 2.3 Release the interrupt queue before held inputs; later interrupts queue behind a pending one.
- [x] 2.4 Grace expiry retires the process but keeps and redelivers pending inputs.

## 3. Drivers

- [x] 3.1 Claude: `control_request interrupt` + `priority: 'now'`; ignore `cancelled` for started inputs; declare `interrupt: 'native'`.
- [x] 3.2 Codex: declare `interrupt: 'native'` (application sequences `turn/interrupt` → `turn/start`).
- [x] 3.3 Executor adapters: declare `interrupt: 'emulated'`.

## 4. Contract and docs

- [x] 4.1 `integration-contract.json` 5.3 with `agentRuntime.sessions.deliveries`; `runtime api` `flowSessions: 1`; parity test.
- [x] 4.2 `docs/agent-sessions/protocol.md` and `drivers.md`.

## 5. Tests

- [x] 5.1 Application (scripted drivers): native, emulated, idle, ordering behind queued inputs, repeated interrupt, grace expiry, ambiguous receipt, restart replay.
- [x] 5.2 Claude and Codex recorded fixtures (`claude-interrupt-now`, `codex-0160-interrupt-then-start`).
- [x] 5.3 Executor adapter emulation.
- [x] 5.4 `npm run ci`.
