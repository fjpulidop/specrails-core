## Context

The host fingerprints the candidate (`fingerprintCandidate`, in `src/pipeline/pipeline-state.ts`) when verification starts and again when the receipt is committed. If the two differ, `commitReceipt` marks the receipt invalid with `Candidate changed during verification`. The guard exists so that a receipt never certifies a candidate it did not test. It cannot tell an external writer apart from the verification commands themselves.

In a real run on busuu-courses (Skills #207, 2026-10-09), `yarn test` ran a lint pre-step that rewrote the tracked file `eslint-config/styled-component-mappings.js`. The run then looped:

- Every receipt was invalid, even though every command exited 0.
- The reviewer prompt (`prompts.ts`, blast-radius rule 4) classifies regenerated generated files as an issue to REVERT.
- The fixer reverted the file with `git checkout`.
- The next verify regenerated it.
- The correction loop stalled and Desktop showed `implementation_failed`, without naming any file.

During a verify step no role turn is running. Within one verification run, the only writers to the worktree are the verification commands. Running the receipt commit under a lock does not change that. A manifest diff taken around the run therefore attributes the change to verification with high confidence.

## Goals / Non-Goals

**Goals:**
- Name the exact files that verification modified, in the receipt and in failure summaries.
- Converge automatically when the output is deterministic, by adopting it into the candidate and re-verifying once.
- Stop with a typed, explained blocker when the output is not deterministic. No fixer rounds for it.
- Stop the reviewer and fixer from reverting adopted output.

**Non-Goals:**
- Attributing each file to a specific command when several commands run in parallel. The receipt lists the wave's commands.
- Repairing stale warm-linked `node_modules`, where a declared version is not satisfied. That gap lives in environment repair and Desktop warm links, and is tracked separately.
- Desktop UI changes. They belong to a Desktop follow-up that renders the new fields and the guardrail label in all locales.

## Decisions

1. **Diff the manifests, not git status.**
   - The diff reuses `candidateManifest` before and after the run, so it uses exactly the rules that drive invalidation: scope exclusions, agent-memory and generated-output roots.
   - Alternative: `git status`/`git diff`. Rejected, because it ignores the candidate scope rules and could report files the fingerprint does not count, or miss ones it does.
   - Cost: one extra manifest read. Verification already computes the candidate hash, so the "before" manifest is captured where the hash is computed.

2. **Adopt by re-running once, not by rehashing.**
   - Alternative: accept the receipt by recomputing the hash after the commands. Rejected, because tests ran against the pre-mutation tree. Lint, for example, read the regenerated mappings partway through the run.
   - A second full run on the mutated candidate is the only honest evidence.
   - The run is bounded to one extra attempt, the same budget as environment repair, which already re-runs once after installing.
   - Idempotent generators converge on the second run, because they report "up-to-date" (as busuu-courses' generator did).

3. **Adopt only all-green receipts.**
   - If any command failed, the run is already a real failure, and the fixer needs the failing command first.
   - The mutation stays in the worktree, because that is what a developer's local run would leave, and the next verification starts from it.
   - `selfMutation` stays on the receipt for diagnosis.

4. **Use a typed blocker for non-convergence.**
   - Add `verification_nondeterministic_output` next to the existing precondition blockers.
   - The cause belongs to the repository or the operator: commit the generated file on base, or make the generator idempotent.
   - A fixer cannot fix it inside the change boundary, so it must not consume correction budget.

5. **Make the prompt exemption data-driven.**
   - The reviewer and fixer instructions get a block that lists `adoptedOutputs` only when the list is present.
   - The global blast-radius rule stays as it is for the other generated files, such as snapshots and lockfiles, that roles regenerate on their own initiative.

6. **Gate adoption behind a guardrail, on by default.**
   - Add `verification-output-adoption`.
   - With it off, the run is strict: detect, name the files and block.
   - Some operators may want generated files never to land in a ticket branch. The guardrail lets them choose that.

## Risks / Trade-offs

- [A command writes a tracked file that is not generated output, for example a formatter rewriting source] → It is adopted only if a second run leaves it stable. The file appears in `adoptedOutputs`, which the reviewer still sees and may challenge on content. The guardrail can turn adoption off.
- [The second run doubles verification time on affected repos (busuu-courses: about 5 minutes)] → It happens at most once per verify step, and only when there is a mutation. After the developer commits the adopted file, later runs do not mutate, so there is no repeat cost.
- [A parallel wave makes attribution coarse] → The receipt lists the wave's commands. Exact attribution is a non-goal.
- [A large generated diff ends up in the PR] → It is visible in `adoptedOutputs` and the review packet. Operators who object commit the output on base or disable the guardrail.

## Migration Plan

The change is additive:

- The receipt field `selfMutation` is optional.
- The verify output field `adoptedOutputs` is optional.
- The new blocker code and the new guardrail id are additive.
- Older Desktop builds ignore the unknown fields and still see `valid`, `outcome` and the error code.
- No persisted-format migration is needed.

Rollback: disable the guardrail, or revert the change. Receipts with `selfMutation` stay readable either way.

## Open Questions

- Should Desktop's commit step use a distinct commit trailer for adopted files, so reviewers can spot them? Proposed answer: no. The review packet lists them.
