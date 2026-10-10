## ADDED Requirements

### Requirement: Installed direct dependencies are checked against declared ranges

`driftedNodeDependencies(root)` SHALL return `Array<{ name, declared, installed }>` for each direct dependency that `package.json` declares in `dependencies`, `devDependencies` or `optionalDependencies` and that meets both of these conditions:

- its specifier is a valid semver range;
- `node_modules/<name>/package.json` exists, with a `version` that does not satisfy that range (`semver.satisfies` with `includePrerelease: false`).

The function SHALL ignore `workspace:`, `file:`, `link:`, `portal:`, `patch:`, `npm:`, git or URL specifiers and dist-tags. It SHALL never throw, and SHALL return at most 20 entries. Absent packages are reported by `missingNodeDependencies`, not by this function.

#### Scenario: Stale minor version

- **WHEN** `package.json` declares `"@busuu/experiments": "^5.24.0"` and the installed version is `5.23.0`
- **THEN** the result contains `{ name: '@busuu/experiments', declared: '^5.24.0', installed: '5.23.0' }`

#### Scenario: Satisfied range

- **WHEN** the declared range is `^5.24.0` and the installed version is `5.26.1`
- **THEN** the dependency is not reported

#### Scenario: Workspace protocol

- **WHEN** a dependency is declared as `workspace:*`
- **THEN** it is not reported, whatever is installed

### Requirement: Drift triggers the existing install plan

`plannedInstalls(root)` SHALL plan the runner's install command (`npm install …` / `yarn install` / `pnpm install`, selected by lockfile as today) when `node_modules` is absent, when any declared dependency is missing, **or** when `driftedNodeDependencies(root)` is non-empty. `prepareEnvironment` SHALL therefore repair drift before the first role turn. The installed outcome detail SHALL name up to five drifted packages, with their installed version and declared range.

#### Scenario: Up-front repair

- **WHEN** a run starts on a root whose `node_modules` holds `@busuu/experiments@5.23.0` against `^5.24.0`
- **THEN** `prepareEnvironment` runs the runner install once, and its outcome detail names `@busuu/experiments 5.23.0 does not satisfy ^5.24.0`

#### Scenario: Healthy install

- **WHEN** no dependency is missing or drifted
- **THEN** no node install is planned

### Requirement: Verification repairs drift once

When the `environment-repair` guardrail is enabled, a verification that fails while `driftedNodeDependencies` is non-empty for a root containing a failing command's `cwd` SHALL be treated as an environment failure. The host SHALL install once and verify again through the existing single re-run. Only the second receipt SHALL become feedback. When the guardrail is disabled, the behaviour SHALL be unchanged from today.

#### Scenario: Lint fails on a stale package

- **WHEN** lint exits 1 and the verified root has drifted dependencies
- **THEN** the host runs one install, verifies again, and records `environmentRepair` with `reverified: true` and the drifted packages

#### Scenario: Drift persists after the install

- **WHEN** the install succeeds but the dependency is still drifted, for example because the lockfile pins the old version
- **THEN** no further install runs, the second receipt becomes feedback, and the progress line states that the lockfile still resolves the drifted version
