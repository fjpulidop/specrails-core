## Why

Flow (feedback-2026-10 program, Phase 2) lets a person explore by building in a reserved worktree and only afterwards turn the result into a Specrails delivery. Today the engine can only plan a change before code exists (architect) or apply a planned one (developer). Nothing writes the OpenSpec change for code that already exists, measures whether that change explains every edited file, and hands the result to review and archive like any planned change. Desktop needs that operation from Core so it never learns provider details or OpenSpec internals (design: `specrails-desktop/docs/plans/flow-arquitectura.md` §3.2; guide Tarea 2.4, Anexo D.3).

## What Changes

- **New engine v2 piece `derive-change`** (`pass` | `fail`, effect write, requires AI). Params: `change` (the frozen change name) and optional `summaryPath` (a bounded host-written summary inside `.specrails/pipeline/<runId>/`). It measures the diff with the existing `changeSet` (base `repositories[].baseSha` to the working tree), fails with `empty_change_set` before any provider call when nothing changed, and runs the deriver.
- **New Core engine role `deriver`**: read-only code access, all OpenSpec artifacts, `openspec-ff-change`, the architect's provider assignment, Core-owned instructions ("describe what exists, invent nothing"; `design.md` with Blast radius, Rejected alternatives, Non-Goals, Assumptions; ADDED/MODIFIED deltas; every task checked with one evidence line). The id is reserved in configuration.
- **Deterministic coverage**: a pure parser checks every changed path against design.md's `## Blast radius`. Missing paths become `unexplainedFiles`. The piece writes `derivation.json` (Anexo D.3 fields plus additive detail) to its artifact directory and returns it in its output.
- **Deterministic gates**: every task checked, `openspec validate --strict` and the archive preflight (shared with `openspec-validate`). A failure returns `fail` with a history note and a repair note the next visit sends to the deriver, so definitions can loop back once.
- **Verification plan**: the deriver's `verification[]` (architect schema) is exposed as `output.structured.verification`; `verify` binds it with `additionalCommandsFrom`.
- **Reviewer rule**: a reviewer turn in a run with a derivation receives the report; every unexplained file is an issue. The approval gate is unchanged.
- **Reference definition** `engine/__fixtures__/flow-spec.json`: derive → one repair → verify → reviewer → review gate → archive → verify.
- **Versioning**: `NODE_KINDS_VERSION` 8 (20 kinds), `ROLE_INSTRUCTIONS_VERSION` 15, contract `schemaVersion` 5.3 with `agentRuntime.deriveChange`, runtime capability `deriveChange: 1`.

## Capabilities

### New Capabilities
- `derive-change`: derive an OpenSpec change from an existing diff with Core-measured coverage, a reviewer coverage rule and a reference Flow definition.

### Modified Capabilities
<!-- None: there is no canonical openspec/specs/ tree in Core yet. -->

## Impact

- Engine: new `pieces/derive-change.ts`, `pieces/derivation-coverage.ts`; `openspec.ts` exports `checkOpenSpecChange`; `artifact-contract.ts` exports `taskCheckboxes`; registry, `PIECE_KINDS`, definition schemas, validator (`deriver` must be declared), invocation role attribution.
- Roles: `executor-types.ts` (`ENGINE_ROLES`, `ENGINE_ROLE_POLICY`), `config.ts` (resolution, reserved id), `engine/preflight.ts` (`configuredRoles` admits `deriver`), `prompts.ts` (deriver text, reviewer derivation section), `role-turn.ts` (passes the report to reviewers).
- Contract and CLI: `integration-contract.json` 5.3, `runtime api` capability `deriveChange: 1`.
- Desktop: paired change (Tarea 2.5) consumes the capability; older Cores lack it and Desktop hides Flow. No existing contract changes shape.
