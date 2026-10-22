## Why

External feedback (feedback-2026-10, Phase 3 task 3.3, annex D.6) asked that every spec requirement have a test that demonstrates it, and that the system count the ones that do not. Today nothing links an OpenSpec requirement to a test: a change can archive ADDED requirements no test exercises, and specs drift from the code without anyone noticing.

## What Changes

- **Stable ids and tags.** A requirement's id is `<capability>/<slug>` from `### Requirement: <name>` (NFKD, accents stripped, lowercase, non-alphanumerics to single dashes). Tests claim requirements with `[spec:<id>]` in a title or `// spec: <id>` (`# spec:` for Python and shell) on the previous line, in any language.
- **Scanner.** New `src/pipeline/spec-trace.ts` (Node built-ins only, copied into projects as `.specrails/runtime/spec-trace.mjs` with a `trace.mjs` runner) reads canonical specs plus the change's deltas, walks test files, crosses tags with verification receipts and reports `demonstrated`, `undemonstrated` (with a reason) and `untagged`.
- **CLI.** `specrails-core pipeline trace [--check] [--json] …`: normal mode never fails; `--check` fails when a requirement the change adds, modifies or renames is not demonstrated.
- **Runtime.** The verify node writes `spec-trace.json` after every passing verification, bound to the receipt, and records an advisory acceptance finding. The developer is asked to tag one test per touched requirement; the reviewer treats a touched requirement without a demonstrated tag as an issue, and a new check 9 fills `brief.divergences` with spec claims the code contradicts.
- **Drift sweep.** A read-only reference definition (`engine/__fixtures__/drift-sweep.json`) runs the divergence check across every capability on demand.
- **Contract.** `ROLE_INSTRUCTIONS_VERSION` 16 → 17, integration contract 5.6 → 5.7 (both bumped once for the branch) with `agentRuntime.specTrace`, `runtime api` capability `specTrace: 1`, `runtime-result.specTrace`.

## Capabilities

### New Capabilities
- `spec-trace`: requirement ids, test tags, the scanner and its CLI, the runtime trace and its exposure, and the drift sweep definition.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/. -->

## Impact

- **Code:** `src/pipeline/spec-trace.ts` (new), `graph/spec-trace-record.ts` (new), `graph/nodes.ts` (developer tags, verify trace, acceptance finding), `graph/state.ts`, `prompts.ts`, `cli.ts`, `index.ts`, `installer/cli.ts` (`pipeline trace`), `installer/phases/scaffold.ts` (copy), `graph/review-brief.ts` (comment).
- **Contract:** `integration-contract.json` 5.7. Desktop reads `spec-trace.json` / `runtime-result.specTrace` when `specTrace >= 1` to show "Requirements demonstrated X/Y".
- **Compatibility:** additive and advisory; verification and acceptance outcomes are unchanged.
- **Out of scope:** Desktop packet, analytics and CI template UI (Desktop side of task 3.3).
