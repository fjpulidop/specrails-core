## Why

The reviewer's verdict (approved, score, aspects, issues, acceptance) tells Core whether to archive, but it does not tell the human who merges the change where to look. External feedback (feedback-2026-10, Phase 1 task 1.1) asked for a short, reviewer-authored risk brief: what behaviour changed, which invariants the change leans on, what no test exercises, the top risks with a `file:line`, and the checks a read-only reviewer cannot perform. Desktop will harvest it at settle and show it next to the PR.

## What Changes

- **Reviewer output.** `REVIEW_OUTPUT_SCHEMA` gains an optional `brief` object (`behaviourChanges`, `invariantsTouched`, `untested`, `risks`, `humanChecks`, `divergences`; every section optional, every list may be empty). The reviewer prompt asks for it after the verdict with concrete rules.
- **Deterministic normalization.** Core validates the brief, sorts `risks` by severity (stable) and keeps the top five; overflow risks become acceptance findings.
- **Repair policy.** A malformed brief uses the reviewer's existing single structured-output repair turn; if the repaired reply is still malformed the brief is dropped with a diagnostic and the review proceeds.
- **Gate unchanged.** `review-policy.ts` does not read the brief.
- **Exposure.** The brief is recorded in `<backlogRoot>/.specrails/pipeline/<runId>/review-brief.json` at every verdict, in `runtime-result.reviewBrief`, in `confidence-score.json` (approved verdicts) and in the reviewer step output / graph state.
- **Contract.** `ROLE_INSTRUCTIONS_VERSION` 14 → 15, integration contract schema 5.2 → 5.3 with `agentRuntime.reviewBrief`, `runtime api` capability `reviewBrief: 1`.

## Capabilities

### New Capabilities
- `reviewer-risk-brief`: the reviewer's optional, advisory risk brief, its normalization and repair policy, and where hosts read it.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/. -->

## Impact

- **Code:** `src/agent-runtime/graph/review-brief.ts` (schema, parser), `graph/review-brief-record.ts` (host record), `graph/nodes.ts` (reviewer node), `graph/state.ts` (`ReviewRecord.brief`), `prompts.ts`, `cli.ts`, `compact/reviewer.ts` (pass-through), `index.ts` (exports).
- **Contract:** `integration-contract.json` 5.3; paired Desktop change harvests `review-brief.json` / `runtime-result.reviewBrief` when `reviewBrief >= 1`.
- **Compatibility:** additive. Older reviewer replies without a brief stay valid; frozen runs keep their original runtime identity (instructions version bump).
- **Out of scope:** Desktop UI, spec-divergence detection (`divergences`, Phase 3), changing the gate.
