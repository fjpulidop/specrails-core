## ADDED Requirements

### Requirement: Architect design-confidence artifact
The architect agent SHALL, after completing its design and task breakdown, write `openspec/changes/<name>/design-confidence.json` with: `schema_version` (`"1"`), `change`, `agent` (`"architect"`), `scored_at` (ISO 8601), `confidence` (`"high" | "medium" | "low"`), `reason` (1–2 concrete sentences), and `blocking_question` (required non-null single focused question when `confidence` is `"low"`, otherwise `null`). The rubric: high = code evidence conclusive and design unambiguous; medium = likely correct but one non-obvious named assumption; low = multiple plausible designs undecidable without information the architect does not have. The architect SHALL NOT inflate the level; emitting `low` with a sharp blocking question is a successful output.

#### Scenario: Confident design
- **WHEN** the architect located the exact files and the design follows unambiguously
- **THEN** it writes `confidence: "high"` with a concrete reason and `blocking_question: null`

#### Scenario: Ambiguous ticket
- **WHEN** two materially different designs satisfy the ticket and nothing in the repo or ticket decides between them
- **THEN** it writes `confidence: "low"` with exactly one focused `blocking_question` a human can answer

### Requirement: Provider parity for design confidence
The codex architect rail skill SHALL emit the same `design-confidence.json` and include the confidence level (and blocking question when low) in its structured reply; the codex and gemini implement orchestrators SHALL gate on the artifact before spawning the developer, halting with `BLOCKED: design confidence low — <blocking_question>` and leaving the ticket unmodified.

#### Scenario: Codex low-confidence halt
- **WHEN** the codex architect replies with `Design confidence: low — blocking question: <q>`
- **THEN** the orchestrator stops before Phase 2, reports the question, and does not update the ticket
