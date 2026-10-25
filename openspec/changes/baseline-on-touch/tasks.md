## 1. Capability map

- [x] 1.1 `graph/capability-map.ts`: read, merge per archived change, qualified paths.
- [x] 1.2 Archive hook before the archive phase is done; candidate exclusion for new journals.

## 2. Baseline

- [x] 2.1 `graph/baseline.ts`: blast radius parsing, coverage detection, plan validation, non-test edit check, host record.
- [x] 2.2 Architect baseline turn (kind `baseline`) and `baseline.json` (`not-needed`, `planned`).
- [x] 2.3 Developer baseline stage: test-only edits, reachability, full plan on the base code, blocker `baseline_characterization_failed`; `passed` with receipt.
- [x] 2.4 Prompts: architect plan, developer stage, developer and reviewer `## Baseline`; `ROLE_INSTRUCTIONS_VERSION` 17 (shared bump).
- [x] 2.5 `baselineOnTouch` in config and schema; invocation kind `baseline`; `efficiencySummary.baseline`.

## 3. Contract and docs

- [x] 3.1 `runtime api` capability `baselineOnTouch: 1`; `runtime-result.baseline`; `integration-contract.json` 5.7 (shared bump); parity tests.
- [x] 3.2 `docs/agent-runtime.md` "Baseline on touch".

## 4. Tests

- [x] 4.1 Unit: blast radius, detection with and without coverage (map, spec paths, generic directories), plan validation, edits, record.
- [x] 4.2 Core host: capability map after archive, baseline passes then change (cost attributed apart), characterization failing on base ⇒ blocker, module edited in the stage ⇒ blocker, covered module ⇒ nothing added.
- [x] 4.3 `npm run ci`.
