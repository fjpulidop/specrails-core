## Why

Some repositories' own verification commands rewrite tracked files. One example is busuu-courses, where `yarn test` regenerates `eslint-config/styled-component-mappings.js` before lint runs. The host fingerprints the candidate before and after verification, so every receipt is marked invalid with `Candidate changed during verification`, even though every command exits 0.

The roles then loop against each other:

1. The reviewer is told to revert "regenerated generated files".
2. The fixer reverts the file.
3. The next verification regenerates it.

The run ends in a no-progress stop that reports an opaque `implementation_failed`. A real run (Skills #207, 2026-10-09) burned two Implement launches on this before a human diagnosed it from the raw log.

## What Changes

- **Detect self-mutation.** Verification diffs the candidate manifest taken before the commands against the one taken after. It records the tracked or candidate files the commands added, modified or removed, with the commands that ran in that wave. Today it records only a boolean.
- **Adopt deterministic output.** When verification changes only files the commands themselves wrote, the host keeps those files in the candidate and runs verification once more on the mutated candidate.
  - If the second run leaves the candidate unchanged, its receipt is valid and the files are reported as adopted verification output.
  - If the second run changes the candidate again, the host returns a typed blocker, `verification_nondeterministic_output`, naming the files. The fixer does not get another correction round.
- **Name the cause in receipts and failure summaries.** An invalidated receipt carries `selfMutation.files`. `describeFailure` summarizes it as "verification commands modified N files: …" and no longer reports a generic "verification failed".
- **Stop roles from reverting adopted output.** Reviewer and fixer prompts receive the adopted-output list. The blast-radius rules exempt those files from "regenerated generated files are an issue to REVERT". The reviewer may still flag one if its content is wrong for the change.
- **Guardrail.** A guardrail `verification-output-adoption`, on by default, gates adoption. When it is off, the host still detects and names the files, and returns the typed blocker instead of adopting them.

## Capabilities

### New Capabilities
- `verification-self-mutation`: detects candidate files that verification commands modify, adopts deterministic tool output into the candidate, returns a typed blocker for non-deterministic output, and makes reviewer and fixer respect adopted output.

### Modified Capabilities
<!-- None: there is no canonical openspec/specs/ tree in Core yet; verification receipt behaviour is specified by the new capability. -->

## Impact

- **Core verification** (`src/pipeline/pipeline-state.ts`):
  - Adds a manifest diff around `executeVerification`.
  - Adds a receipt field `selfMutation`, which is optional and additive.
- **Engine verify piece** (`src/agent-runtime/engine/pieces/verify.ts`):
  - Adds one adoption re-run, bounded like the existing environment-repair re-run.
  - Adds a new blocker code.
  - Adds output field `adoptedOutputs`.
- **Failure description** (`src/agent-runtime/graph/convergence.ts`): adds a summary for self-mutation receipts.
- **Prompts** (`src/agent-runtime/prompts.ts`): adds the reviewer and fixer exemption for host-adopted verification output.
- **Guardrail registry:** adds the new default-on guardrail `verification-output-adoption`.
- **Desktop:** no contract break. The new receipt and blocker fields are additive. A Desktop follow-up should show `selfMutation`, `adoptedOutputs` and the new blocker code in Job Detail and in the PR-decision `statusDetail`.
- **Not in scope:** stale warm-linked `node_modules`, where declared versions are not satisfied by installed packages. That is a separate environment-repair gap.
