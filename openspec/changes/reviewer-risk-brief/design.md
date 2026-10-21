## Context

The reviewer node (`graph/nodes.ts`) invokes the reviewer through `createRoleInvoker` with `REVIEW_OUTPUT_SCHEMA`. Its `accept` callback validates the verdict (`evaluateReview`) and the acceptance report; throwing an `Invalid …` error spends one repair turn in the same session. Both engines share this node: engine 1 directly, engine 2 through the `implementation` piece.

## Decisions

1. **Brief is a sibling of the verdict, not part of it.** `evaluateReview` is unchanged; the brief is parsed after the verdict and acceptance report succeed. Alternative (score adjustments from risks) rejected: the feedback explicitly keeps the gate stable.
2. **Repair through the existing budget.** The `accept` callback counts replies. On the first reply a malformed brief throws `Invalid review brief: …` (matches the invoker's repairable pattern). On a later reply (the repair) `settleReviewBrief` drops the brief and returns a diagnostic. No new repair loop, no extra invocation budget.
3. **Cap in code, not in the schema.** The schema has no `maxItems` on `risks`, so a model listing seven risks is not a schema failure. Core sorts by severity (stable by original order) and keeps five; overflow becomes `acceptance.findings` lines so nothing the reviewer said is lost. Findings are supplementary evidence and never gate.
4. **Host record outside the change directory.** `review-brief.json` lives in the run's pipeline state directory, which candidate fingerprints and artifact hashes already exclude, so writing it at every verdict (including rejections) cannot invalidate gates. `confidence-score.json` gains `brief` only on approval, before the archive approval hash is taken.
5. **Tolerant parsing.** Unknown keys are ignored, `null` sections (Codex strict mode) are treated as absent, text is trimmed and bounded (2,000 chars, 20 items). Required item fields and enums are enforced so the brief is safe to render.
6. **Compact reviewer pass-through only.** The OpenAI-compatible compact reviewer has a tight token budget; it is not prompted for the brief but forwards one if the model sends it.

## Risks / Trade-offs

- A malformed brief on the first reply costs a repair invocation. Accepted: same budget as any malformed verdict; the second failure never fails the review.
- The repaired reply can change the verdict. This is the existing behaviour for any repair turn.
- Engine 2 `runtime-result` does not carry `reviewBrief`; hosts read the per-implementation `review-brief.json` or the implementation output `review.brief`.
