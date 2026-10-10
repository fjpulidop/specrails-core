## 1. Detection in the pipeline verifier

- [x] 1.1 Add `diffCandidateManifests(before, after)` to `src/pipeline/pipeline-state.ts`. It returns `{ repositoryId, path, change }[]` sorted by repository, then path. Add unit tests for added, modified, removed and unchanged files, plus multi-repository input.
- [x] 1.2 Capture the candidate manifest where `candidateHash` is computed. In `commitReceipt`, when `!isCurrent()`, diff it against the current manifest and attach `selfMutation: { files, commands }` (executed commands only). Set `reason` to `Verification commands modified N candidate file(s): <first 3 paths>`. Extend `VerificationReceipt` with the optional field. Make the matching change in `executeVerification`'s `changed` branch.
- [x] 1.3 Tests in `pipeline-state.test.ts`, using a real temporary git repository:
  - A command that rewrites a tracked file yields `selfMutation` and the new reason.
  - A command that writes to `coverage/`, or to an ignored path, yields no `selfMutation` and a valid receipt.
  - A command that touches an excluded scope path is not reported.

## 2. Guardrail

- [x] 2.1 Add `verification-output-adoption` to `GUARDRAIL_IDS` and `GUARDRAIL_CATALOG` (host phase) in `src/agent-runtime/guardrails.ts`. Add tests for the default-on behaviour and for validation.

## 3. Adoption and blocker in the verify piece

- [x] 3.1 In `src/agent-runtime/engine/pieces/verify.ts`, adopt when the receipt is invalid only because of `selfMutation` and the guardrail is on:
  - Every command exited 0, there was no abort or deadline, and the run is not infrastructure.
  - Run the request once more, without touching the no-progress counter.
  - On a valid second receipt, return `pass` with `output.adoptedOutputs`, and use the second receipt as `verified`.
  - Emit a `[verification] adopted N generated file(s): …` progress line.
- [x] 3.2 Return a `verification_nondeterministic_output` blocker when the re-run mutates again, or when the guardrail is off. Its `reason` lists the files. Its `requiredAction` is to commit the generated output on the base branch or make the generator idempotent. Route it to `blocked` with `hostBlockers`, and otherwise to `failed` with that error code. Never route it to the fixer.
- [x] 3.3 A failing command combined with `selfMutation` keeps today's routing: the fixer runs, the summary leads with the failing command, and there is no adoption re-run.
- [x] 3.4 Engine tests in `engine/pieces/verify.test.ts` covering:
  - An idempotent generator converges and is adopted.
  - A timestamp generator produces the blocker, both with and without `hostBlockers`.
  - With the guardrail off, the result is a blocker and there is no re-run.
  - A failing command plus mutation does not re-run, and the summary names the command.
  - A run with no mutation is unchanged.

## 4. Failure description and convergence

- [x] 4.1 In `src/agent-runtime/graph/convergence.ts`, have `describeFailure` summarize self-mutation receipts as `verification commands modified N candidate file(s): …`. Derive the signature from the sorted paths. Tests in `convergence.test.ts`.
- [x] 4.2 Check that the legacy graph path (`graph/nodes.ts`) gets the same summary and does not hand a self-mutation-only receipt to the fixer as a code failure. Bring it to parity with 3.1–3.2, or document that it is engine-only, and add a test either way.
  - Done: parity. The Implement pipeline runs these nodes through the `implementation-step` piece, so the real-world loop needs it. Tests are in `core-host.test.ts`.

## 5. Role prompts

- [x] 5.1 In `src/agent-runtime/prompts.ts`, when `adoptedOutputs` is present, render a "Host-adopted verification output" block in the reviewer and fixer instructions. It lists the paths, says not to request or perform a revert to base, and says the reviewer may still challenge their content. Narrow the reviewer's blast-radius rule 4 and the developer/fixer "never regenerate … generated files" rule so they exempt the listed paths.
- [x] 5.2 Plumb `adoptedOutputs` from the verify output to the reviewer and fixer role turns (correction context). Tests in `prompts.test.ts`: the block renders when there are adopted outputs, and the prompts are byte-identical to today when there are none.

## 6. Contracts, docs and compatibility

- [x] 6.1 Export the new receipt field, the blocker code and the guardrail id through the public runtime contract types that Desktop consumes. Update the runtime contract docs and the guardrail list in the docs.
- [x] 6.2 Run `npm run typecheck`, the affected vitest suites and the full suite. Bump the contract minor version if the compat check requires it.
  - Not required: every addition is optional, the contract tests pass and `ROLE_INSTRUCTIONS_VERSION` is unchanged (prompts are byte-identical without adopted output).
- [x] 6.3 Write the Desktop follow-up note:
  - Render `selfMutation`, `adoptedOutputs` and `verification_nondeterministic_output` in Job Detail and in the PR-decision `statusDetail`.
  - Add the guardrail label and description in all 8 locales.
