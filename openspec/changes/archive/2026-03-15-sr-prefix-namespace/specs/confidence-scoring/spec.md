## MODIFIED Requirements

### Requirement: Agent references in scoring spec
References to agents in the confidence scoring system SHALL use sr-prefixed names.

#### Scenario: Reviewer agent reference
- **WHEN** the spec describes which agent MUST emit a confidence score
- **THEN** it refers to `sr-reviewer` (not `reviewer`)

#### Scenario: Future agent references
- **WHEN** the spec describes future agents that MAY emit scores
- **THEN** it refers to `sr-developer` and `sr-architect`

### Requirement: Pipeline gate reference
The pipeline gate reference SHALL use `/specrails:implement` instead of `/implement`.

#### Scenario: Gate position documentation
- **WHEN** the spec describes Phase 4b-conf position
- **THEN** it references `/specrails:implement` as the host command
