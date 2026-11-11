## ADDED Requirements

### Requirement: Definitions can request host effects through a machine interrupt

The engine SHALL provide a `host-task` piece whose parameters are `task`, `input`, `outcomes`, `effect`, optional `timeoutMs` and optional `requiresVerified`, whose outcomes are the declared `outcomes` plus `failed`, and whose effect is the declared `effect`. Executing it SHALL pause the run with an interrupt of kind `host-task` carrying the task, the interpolated input, the declared outcomes, the effect, the timeout hint and Core's candidate attestation. Core SHALL NOT perform the effect itself.

#### Scenario: Invalid parameters are rejected

- **WHEN** a definition declares a `host-task` with an outcome named `failed`, more than 8 outcomes, an unknown parameter or a task outside `^[a-z0-9][a-z0-9.-]{0,63}$`
- **THEN** validation fails with `invalid_piece_params`

#### Scenario: The run pauses for the host

- **WHEN** a run reaches a `host-task` node
- **THEN** it exits 2 with one pending interrupt of kind `host-task` whose payload lists the task, input, outcomes, effect and `candidate { hash, verified }`

#### Scenario: A verified candidate is required

- **WHEN** `requiresVerified` is true and the current candidate has no current verification
- **THEN** the node ends with outcome `failed` and error code `unverified_candidate` without pausing

### Requirement: The host resumes a host task with a validated, redacted result

`runtime resume` SHALL accept `--host-result <file>` with `--interrupt-id <id>` for a pending `host-task` interrupt. The result `{ outcome, output? }` SHALL name a declared outcome or `failed` and its output SHALL not exceed 256 KiB; otherwise the resume is refused before anything is persisted. Secrets in the output SHALL be redacted before the output enters `$outputs` and `$history`. `--answer` and `--approve` SHALL be refused for a `host-task` interrupt, and `--host-result` for a human interrupt.

#### Scenario: Declared outcome routes the run

- **WHEN** the host resumes with `{ outcome: 'green', output: { checks: 3 } }`
- **THEN** the node commits `$outputs[node] = { task, outcome: 'green', result: { checks: 3 }, candidateHash }` and the run follows the `green` edge

#### Scenario: Undeclared outcome or oversized output

- **WHEN** the result names an undeclared outcome or its output exceeds 256 KiB
- **THEN** the resume fails with `invalid_resume` and the interrupt stays pending

#### Scenario: Idempotent resume

- **WHEN** the same result is submitted twice for the same interrupt
- **THEN** the second resume does not change the recorded answer, and a different result is refused with `answer_conflict`

#### Scenario: Host failure

- **WHEN** the host resumes with outcome `failed`
- **THEN** the node fails with error code `host_task_failed` and routes through its `failed` edge

### Requirement: Hosts discover host tasks through a capability

`runtime api` SHALL advertise `hostTasks: 1` and the integration contract SHALL describe the interrupt payload and the resume flag.

#### Scenario: Capability advertised

- **WHEN** a host runs `runtime api`
- **THEN** `capabilities.hostTasks` is `1` and `nodeKinds` includes `host-task`
