## Context

The architect node (`graph/nodes.ts`) invokes the architect once, optionally deepens a low-confidence design once, then either pauses with `step.interrupt({kind: 'question'})` (`architect.onLowConfidence: ask`) or proceeds. Answers come back through `state.answers` and the prompt's "Answers from the requester" section. Malformed replies are repaired in-session when `accept` throws an `Invalid …` error.

## Decisions

1. **Clarifications ride on the existing reply.** The list is part of the architect's single structured reply; the prompt makes it step 0. A separate pre-planning turn was rejected: it doubles the architect cost on every run to serve the minority of ambiguous tickets.
2. **Reuse the question pause.** A blocking clarification interrupts with `kind: 'question'`, so the host contract (`pendingQuestion`, `resume --answer`) is unchanged. Several blocking questions become one numbered question; a low-confidence question that pauses too joins it. The structured detail lives in `clarifications.json`.
3. **"No safe default" is `default: null`.** The schema requires the key so models state it explicitly; the parser tolerates a missing or blank default as `null`.
4. **Validate design.md in `accept`.** The Non-Goals and Assumptions checks run only for a reply that proceeds, inside the invoker's repair budget, so a missing section is fixed in the same session. The design gate in `pipeline-state.ts` stays a presence check: tightening it there would fail historical and host-written changes with no repair path.
5. **Section detection is lenient.** A heading containing the name or a bold label (`**Non-Goals:**`, OpenSpec's template) counts; HTML comments and empty bullets do not count as content.
6. **Record outside the change.** `clarifications.json` lives in the run's pipeline directory (excluded from candidate fingerprints), written on pause and on proceed, with the Assumptions lines copied from `design.md`.

## Non-Goals

- Desktop UI, Jira comments and ticket `nonGoals` (task 3.2).
- Changing the low-confidence investigation pass or its policy.

## Assumptions

- Desktop treats `pendingQuestion.question` as free text, so a numbered multi-question string needs no host change.

## Risks / Trade-offs

- Existing custom architect definitions that omit Non-Goals now spend a repair turn. Accepted: the requirement is the point of the change, and the repair names the exact section.
- Under `always-proceed` a reply that still stopped on a question is sent back for repair instead of failing later at the design gate.
