## 1. Engine role

- [x] 1.1 Add `ENGINE_ROLES`/`ENGINE_ROLE_POLICY` (`deriver`) to `executor-types.ts`; resolve it on the architect assignment in `config.ts`, reserve the id, admit it in `configuredRoles`.
- [x] 1.2 Add the deriver instructions, `DERIVER_OUTPUT_SCHEMA` and the reviewer derivation section to `prompts.ts`; bump `ROLE_INSTRUCTIONS_VERSION` to 15; pass committed derivations to reviewer role turns.

## 2. Piece

- [x] 2.1 Pure coverage parser `derivation-coverage.ts` with unit tests (sections, whole-path matching, spaces, unicode, escapes, multi-repository, counters).
- [x] 2.2 `derive-change.ts`: summary admission, change set, deriver turn, coverage, `derivation.json`, task/validate/preflight gates with a repair note, verification proposals.
- [x] 2.3 Share `checkOpenSpecChange` and `taskCheckboxes` with the existing pieces; register the kind, schemas, validator rule and invocation role attribution; `NODE_KINDS_VERSION` 8.

## 3. Reference definition and tests

- [x] 3.1 `__fixtures__/flow-spec.json` and integration tests: 5/5 archive with receipts, unexplained file, absent/empty summary, empty diff, repair, single repair limit, summary admission, definition validation, role resolution.

## 4. Contract and docs

- [x] 4.1 `integration-contract.json` 5.3 with `agentRuntime.deriveChange`, `runtime api` capability `deriveChange: 1`, parity tests.
- [x] 4.2 Docs: engine-v2 pieces (regenerated catalog), definition format (Flow Spec), Desktop integration, agent runtime roles and capabilities.

## 5. Bounded correction loop

- [x] 5.1 `role-turn` `stance: 'fixer'` (write roles only; developer FIXER instructions, `rolePrompts.fixer`, `config.fixer` without session carry-over) with validator and unit tests.
- [x] 5.2 `derive-change` `feedback` param: bounded, fenced re-derivation section; unit tests.
- [x] 5.3 `flow-spec.json` correction loop (`correctionLimit` 2, `fix-progress`, `changes-requested`) and integration tests: one resolving round, persistent rejection, unchanged candidate, failing check.
- [x] 5.4 Docs and `integration-contract.json` (`deriveChange.params.feedback`, `deriveChange.correctionLoop`) without a contract or capability bump.
