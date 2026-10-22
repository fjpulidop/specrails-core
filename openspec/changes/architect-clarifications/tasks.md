## 1. Clarifications

- [x] 1.1 `graph/clarifications.ts`: schema, parser, blocking rule, question text, design-section detection and validation, host record.
- [x] 1.2 `ARCHITECT_OUTPUT_SCHEMA.clarifications`; architect step 0, Non-Goals/Assumptions rule, output contract and policy line; repair text names artifacts; `ROLE_INSTRUCTIONS_VERSION` 16.
- [x] 1.3 `architect.clarifications` in `config.ts`, `executor-types.ts` and `schemas/agent-runtime.schema.json`.

## 2. Architect node

- [x] 2.1 Pause on blocking clarifications through the existing question interrupt; record `awaiting-answers`.
- [x] 2.2 Validate design sections for replies that proceed (repair turn); record `proceeded` with the Assumptions lines; step output and graph state carry the list.
- [x] 2.3 Exempt clarification-only replies from the participation check.

## 3. Contract and docs

- [x] 3.1 `runtime api` capability `architectClarifications: 1`; `runtime-result.clarifications`; `integration-contract.json` 5.4; parity tests.
- [x] 3.2 `docs/agent-runtime.md` "Architect clarifications" section and config reference.

## 4. Tests

- [x] 4.1 Unit: parser, blocking policy, question text, section detection, validation, record.
- [x] 4.2 Core host fixtures: high (pause and resume), low (proceed with assumptions), none, always-proceed, Non-Goals repair and repair failure.
- [x] 4.3 `npm run ci`.
