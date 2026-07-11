# Delta Spec: doctor-command

## ADDED Requirements

### Requirement: Remediation hints reference init/update only
Every remediation hint printed by `doctor` SHALL point to `npx specrails-core init` or `npx specrails-core update` as the regeneration path. No hint SHALL reference `/specrails:enrich`, `/setup`, install tiers, or any removed command.

#### Scenario: Missing agent files hint
- **WHEN** `doctor` detects missing or corrupt agent files
- **THEN** the fix line reads `Run npx specrails-core update to regenerate.` (not `Run /specrails:enrich inside Claude Code to regenerate.`)

#### Scenario: No stale surface references
- **WHEN** the doctor implementation and its command body are searched for `enrich`, `tier`, or removed agent names
- **THEN** zero matches are found
