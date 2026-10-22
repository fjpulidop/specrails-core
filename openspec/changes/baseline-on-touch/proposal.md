## Why

External feedback (feedback-2026-10, Phase 3 task 3.4) pointed at legacy code: most of an existing project has no OpenSpec capability, so a change that touches it starts from undocumented, untested behaviour and the review has nothing to compare against. The spec of an old module should be written the first time work passes through it, backed by tests that describe how it behaves today.

## What Changes

- **Capability map.** The archive step maintains `openspec/capability-map.json`: per capability, the files archived changes touched. It is excluded from the reviewed candidate.
- **Detection.** After planning, Core intersects the design's Blast radius with the map and with path mentions in `openspec/specs/`. Existing code files nothing covers are "uncovered".
- **Baseline plan.** With `baselineOnTouch: true` (config, default false) and uncovered files, the architect adds, in the same session, a `## 0. Baseline` task group: characterization tests of current behaviour and a minimal as-built spec (ADDED requirements, tagged per spec-trace).
- **Hard rule.** The developer's first turn writes only the Baseline group; Core refuses non-test edits and runs the verification plan on the unchanged code. A failure stops the run with an explicit host blocker (`baseline_characterization_failed`) before the developer touches the module.
- **Review.** The reviewer checks that as-built requirements describe behaviour their characterization tests demonstrate.
- **Cost.** Baseline turns run with invocation kind `baseline`; the efficiency summary reports their spend apart.
- **Contract.** `ROLE_INSTRUCTIONS_VERSION` 17 → 18, integration contract 5.5 → 5.6 with `agentRuntime.baselineOnTouch`, `runtime api` capability `baselineOnTouch: 1`, `runtime-result.baseline`.

## Capabilities

### New Capabilities
- `baseline-on-touch`: the capability map, uncovered-code detection, the Baseline plan and stage, the hard rule and its blocker, review and cost attribution.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/. -->

## Impact

- **Code:** `graph/capability-map.ts` and `graph/baseline.ts` (new), `graph/nodes.ts` (architect turn, developer stage, archive hook), `graph/artifacts.ts` (archive hook), `pipeline-state.ts` (candidate exclusion for new journals), `prompts.ts`, `role-routing.ts` (`baseline` kind), `efficiency-summary.ts`, `config.ts`, `executor-types.ts`, `cli.ts`, `index.ts`, `schemas/agent-runtime.schema.json`.
- **Contract:** `integration-contract.json` 5.6; new optional config key `baselineOnTouch` in the schema Desktop copies byte for byte.
- **Compatibility:** off by default. The capability map is written by every new run's archive; journals created before this change keep their candidate exclusions and never write it.
- **Out of scope:** Desktop setting, packet section and docs (Desktop side of task 3.4).
