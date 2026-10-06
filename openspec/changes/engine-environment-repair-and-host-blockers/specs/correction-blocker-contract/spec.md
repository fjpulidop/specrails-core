## ADDED Requirements

### Requirement: The fixer reports host blockers structurally

The fixer output contract SHALL accept an optional `blocker` object `{ kind, command, cwd, evidence, requiredAction }` with `kind` in `network | credential | environment-variable | toolchain | setup | environment | scope`. The fixer prompt SHALL instruct the role to return it, make no speculative edits and state in `summary` that the candidate was intentionally left unchanged, whenever the diagnosed cause lies outside the change.

#### Scenario: Fixer prompt names the structured blocker

- **WHEN** builtin fixer instructions are rendered
- **THEN** they contain the `blocker` field, its allowed kinds and the instruction to make no edits for an external cause

#### Scenario: Fixer may install a documented toolchain artifact

- **WHEN** builtin fixer or developer boundaries are rendered
- **THEN** they admit installing a documented, idempotent toolchain artifact inside the admitted workspace (named example: a Playwright browser) while still forbidding edits to package-manager, registry, credential, CI or environment configuration

### Requirement: The developer cannot bypass the host plan with temporary configuration

The developer prompt SHALL forbid validating through a temporary configuration, alternate runner or local browser the host verification plan does not use, and SHALL require installing a missing project tool through the project's documented command or reporting it as a blocker.

#### Scenario: Developer prompt contains the rule

- **WHEN** builtin developer instructions are rendered
- **THEN** they contain the prohibition of temporary verification bypasses and the install-or-report rule

### Requirement: Write roles see the complete host verification plan

Role instructions for any role with write access, builtin or custom, SHALL list every verification command the host will run for the repositories in scope, including commands proposed by the node named in `additionalCommandsFrom` when the role turn is part of a definition that uses them.

#### Scenario: Custom write role in a Desktop recipe

- **WHEN** a `role-turn` runs a custom role with `access: 'write'` and the configuration has verification commands
- **THEN** the rendered instructions contain the "Core owns these complete verification commands" block listing each command

#### Scenario: Architect proposals included

- **WHEN** the definition's `verify` node uses `additionalCommandsFrom: 'architect'` and the architect output proposed `npm run test:e2e` for a repository without configured checks
- **THEN** the developer and fixer role turns list `npm run test:e2e` in their host plan block

#### Scenario: Read-only role

- **WHEN** a custom role has `access: 'read'`
- **THEN** no host plan block is appended
