---
change: agent-confidence-scoring
type: feature
status: draft
github_issue: 37
vpc_fit: 78%
---

# Proposal: Agent Confidence Scoring & Validation Framework

## Problem

The specrails pipeline produces artifacts — designs, implementations, and reviews — without ever surfacing how certain each agent is about what it produced. A developer agent implementing a complex migration may succeed structurally but have quietly omitted edge-case handling. A reviewer may pass code that it flagged as uncertain internally but never communicated that uncertainty to the lead developer. The pipeline treats all output as equally authoritative, which means the lead developer cannot distinguish between "this is solid" and "this compiles and roughly follows the pattern."

The result is a trust problem. When agents operate as black boxes, lead developers must either review every artifact thoroughly (defeating the automation's purpose) or ship with unknown risk. Neither outcome is acceptable on a production-driven team.

There is currently no mechanism for agents to say "I'm 60% confident in the test coverage aspect of this implementation — you should review it." Uncertainty is buried rather than surfaced.

## Solution

Introduce a structured confidence scoring system where each agent outputs a machine-readable confidence score alongside its human-readable output. The score breaks down by aspect (type correctness, pattern adherence, test coverage, security, architectural alignment) to give lead developers targeted visibility into exactly which dimensions deserve their attention.

The `/implement` pipeline checks scores against configurable thresholds defined in `.claude/confidence-config.json`. If a critical threshold is breached, the pipeline blocks shipping and requires either a score override (with an explicit reason) or re-implementation.

The feature is introduced incrementally:

1. **Phase 1 (this change):** Define the confidence score JSON schema. Add confidence scoring to the reviewer agent. Add the pipeline gate in `/implement`. Add the configuration file and its template.
2. **Phase 2 (future):** Extend scoring to the developer and architect agents.

The reviewer agent is the right starting point: it has the broadest view of what was implemented, already runs CI checks, and is explicitly positioned as a quality gate. Its confidence scores will be the most actionable from day one.

## Non-Goals

- This does not add confidence scoring to the developer or architect agents in this change. That is Phase 2.
- This does not add automatic retry logic when scores are low. The gate blocks and informs; it does not attempt self-correction beyond what the reviewer already does.
- This does not introduce an AI model evaluation layer. Confidence scores are the agent's self-assessment, not ground truth.
- This does not change how CI checks run. The existing CI pipeline remains unchanged.
- This does not require changes to `install.sh` — the config template is picked up automatically by `/setup`'s template copy step.

## Success Criteria

- The reviewer agent outputs a `confidence-score.json` file in `openspec/changes/<name>/` at the end of every review.
- The score schema validates correctly: overall score 0-100, five named aspect scores, a required notes field, and a schema version.
- `.claude/confidence-config.json` is present in every installed repo after `/setup` runs, with documented default thresholds.
- The `/implement` pipeline reads the confidence score after Phase 4b (reviewer) and compares it against thresholds from the config file.
- If any threshold is breached, the pipeline prints a clear blocking report and halts before Phase 4c (git operations).
- If the config file is absent, the pipeline falls back to built-in defaults and prints a one-time notice.
- No `{{PLACEHOLDER}}` tokens remain unresolved in installed files after `/setup` runs.
- The feature works correctly when `confidence-config.json` thresholds are customized by the target repo.
