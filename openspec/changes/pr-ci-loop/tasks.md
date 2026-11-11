## 1. Piece and contracts

- [x] 1.1 Add `HostTaskInterrupt` to the interrupt union in `engine/contracts.ts`
- [x] 1.2 Implement `pieces/host-task.ts` (closed schema, dynamic outcomes/effect, candidate attestation, `requiresVerified`, result validation and redaction)
- [x] 1.3 Register it in `pieces/index.ts`, the definition schema and `schemas/workflow-definition.schema.json`; bump `NODE_KINDS_VERSION` to 9

## 2. CLI and capability

- [x] 2.1 `runtime resume --host-result <file> --interrupt-id <id>` with mutual exclusion against `--answer`/`--approve`
- [x] 2.2 Validate host results in `validateAnswers` before persistence
- [x] 2.3 Advertise `hostTasks: 1` and document the flag in `runtime help`
- [x] 2.4 Integration contract 5.11 (`hostTasks` block, nodeKinds, nodeKindsVersion)

## 3. Docs and tests

- [x] 3.1 `docs/engine-v2/pieces.md` (semantics + regenerated descriptor reference), `desktop-integration.md`, `recovery.md`
- [x] 3.2 Piece tests: validation rejection, success, undeclared outcome, oversized output, redaction, `requiresVerified`, host failure
- [x] 3.3 Durable tests through the CLI/compiler: pause and reopen, double resume idempotent, conflicting resume refused, human flags refused, cancellation while paused, fork keeps the pending interrupt
- [ ] 3.4 `npm run ci`
