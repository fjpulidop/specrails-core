## ADDED Requirements

### Requirement: Runtime configuration accepts optional setup commands

The runtime configuration SHALL accept an optional `setup` array whose entries have the same shape as `verification` entries (`repositoryId`, `command`, `args`, optional `cwd`, `env`, `timeoutMs`, `key`, `label`). Validation SHALL apply the same rules as `verification`, including the refusal of credential-like `env` keys and duplicate `key` values across `setup` and `verification`.

#### Scenario: Valid setup entry

- **WHEN** the configuration contains `setup: [{ repositoryId: 'app', command: 'npx', args: ['playwright', 'install', 'chromium'] }]`
- **THEN** validation succeeds and `config.setup` carries the entry

#### Scenario: Credential in setup env

- **WHEN** a setup entry declares `env: { NPM_TOKEN: '…' }`
- **THEN** validation fails on `setup[0].env.NPM_TOKEN`

#### Scenario: Absent setup

- **WHEN** the configuration omits `setup`
- **THEN** validation succeeds and verification runs exactly as before

### Requirement: Setup commands run before each verification plan

The `verify` piece SHALL run the setup commands selected by `params.setup` (`'configured'` or an inline array) sequentially inside the admitted workspace before the first verification run of that visit. Setup receipts SHALL never install a verified candidate and SHALL not participate in the no-progress fingerprint.

#### Scenario: Setup succeeds

- **WHEN** every setup command exits 0
- **THEN** the verification plan runs and `output.setup.commands` lists each setup command with its exit code and bounded output

#### Scenario: Setup fails

- **WHEN** a setup command exits non-zero
- **THEN** the piece produces a `blocker` with `kind: 'setup'`, the command, its cwd and a `requiredAction` to fix or remove the setup command, routed through the `blocked` outcome when `hostBlockers` is set and `fail` otherwise
- **AND** no verification command runs for that visit

#### Scenario: Setup command escapes the workspace

- **WHEN** a setup entry's `cwd` resolves outside the admitted repository scope
- **THEN** the piece throws the same scoped-command validation error as a verification entry would
