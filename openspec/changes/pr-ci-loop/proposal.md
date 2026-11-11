## Why

Desktop needs an autonomous loop that waits for a pull request's CI, fixes failures, merges the base branch on conflicts and pushes to the same PR. Waiting for GitHub and pushing are host effects (`ownership.git: "host"`), so today a definition cannot express them: the only interrupts are human (`approval | question | gate`). Putting the loop in Desktop would duplicate round budgets, stall detection and routing outside Core.

## What Changes

- New piece `host-task`: a definition asks the host for a named effect Core cannot perform (`task`, templated `input`, declared `outcomes`, `effect: read | write`, optional `timeoutMs` hint and `requiresVerified`). The run pauses on a **machine** interrupt (`kind: 'host-task'`) with no live process or lease; the host resolves it and resumes with a typed result.
- `runtime resume --host-result <file> --interrupt-id <id>`: the host's result `{ outcome, output? }` for one pending `host-task` interrupt. `--answer`/`--approve` are refused for a `host-task` interrupt, and `--host-result` for a human one.
- The result is validated (declared outcome or `failed`, output ≤ 256 KiB) and redacted with the shared secret redaction before it enters `$outputs` and `$history`.
- `pendingInterrupts` in `runtime-result` and `runtime status` carry `task`, `input`, `outcomes`, `effect`, `timeoutMs` and Core's candidate attestation (`candidate: { hash, verified, receiptId? }`).
- Capability `hostTasks: 1`, `nodeKindsVersion` 9, integration contract 5.11 (additive).
- Core learns nothing about GitHub or CI: it only transports the request and the result.

## Capabilities

### New Capabilities
- `host-task-piece`: machine interrupts a definition raises for host-owned effects, their resume transport and result validation.

### Modified Capabilities
(none)

## Impact

`src/agent-runtime/engine/pieces/host-task.ts` (new), `pieces/index.ts`, `engine/contracts.ts`, `engine/runs.ts` (answer validation), `engine/cli.ts` (`--host-result`), `definition-schema.ts` + `schemas/workflow-definition.schema.json`, `piece-registry.ts` (`NODE_KINDS_VERSION` 9), `src/agent-runtime/cli.ts` (capability + help), `integration-contract.json` (5.11), docs `docs/engine-v2/{pieces,desktop-integration,recovery}.md`. Paired Desktop change `pr-ci-loop` (specrails-desktop). An older Desktop never emits the piece; an older Core never advertises `hostTasks`, so Desktop hides the feature.
