## Why

External feedback (feedback-2026-10, Phase 3 task 3.1) found that the architect plans straight through ambiguous tickets: it guesses, and the guess surfaces only at review. The low-confidence question exists, but it is a last resort after the design is written. The architect should first say what it does not know, ask when a wrong guess is expensive, and otherwise write its assumptions down. Every design should also say what it deliberately does not do.

## What Changes

- **Architect output.** `ARCHITECT_OUTPUT_SCHEMA` gains optional `clarifications: [{question, impact: high|medium|low, default: string | null}]` (at most 5), produced as step 0 of the architect's task, before planning.
- **Policy.** `architect.clarifications: 'ask-on-high' | 'always-proceed'` in `schemas/agent-runtime.schema.json` and `config.ts` (default `ask-on-high`).
- **Pause.** Under `ask-on-high`, a high-impact clarification with `default: null` reuses the architect's pause-with-question (`pendingQuestion`, `resume --answer`); answers return as authoritative, as for the low-confidence question. A clarification-only reply is exempt from the artifact-participation check.
- **Proceed.** Otherwise the architect plans on its defaults and writes them under `## Assumptions` in `design.md`.
- **Design sections.** Whenever the architect proceeds, Core validates `design.md`: a non-empty Non-Goals section always (heading or OpenSpec's `**Non-Goals:**` label), and Assumptions when clarifications were listed. A missing section spends the single in-session repair turn.
- **Host record.** `<backlogRoot>/.specrails/pipeline/<runId>/clarifications.json` and `runtime-result.clarifications`, so Desktop can post questions and assumptions to the ticket tracker.
- **Contract.** `ROLE_INSTRUCTIONS_VERSION` 15 → 16, integration contract 5.3 → 5.4 with `agentRuntime.architectClarifications`, `runtime api` capability `architectClarifications: 1`.

## Capabilities

### New Capabilities
- `architect-clarifications`: the architect's pre-planning clarifications, the policy that settles them, the design-section checks and the host record.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/. -->

## Impact

- **Code:** `src/agent-runtime/graph/clarifications.ts` (new), `graph/nodes.ts` (architect node), `graph/roles.ts` (participation exemption), `graph/state.ts`, `prompts.ts`, `config.ts`, `executor-types.ts`, `cli.ts`, `index.ts`.
- **Contract:** `integration-contract.json` 5.4; `schemas/agent-runtime.schema.json` gains an optional key. Desktop copies that schema byte for byte, so the paired Desktop change must copy it again.
- **Compatibility:** additive. A reply without `clarifications` behaves as before except for the Non-Goals check, which a design produced from OpenSpec's template already satisfies once filled in.
- **Out of scope:** Desktop UI and the Jira comment (task 3.2), any change to the low-confidence policy.
