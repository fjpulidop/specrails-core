## MODIFIED Requirements

### Requirement: CLI entry point
The package SHALL expose a `specrails-core` binary via `package.json` `bin` field that dispatches to in-process Node command handlers. The handlers MAY reside in compiled TypeScript output under `dist/installer/**` or equivalent. No subcommand SHALL shell out to a packaged `.sh` script.

#### Scenario: Init subcommand
- **WHEN** user runs `npx specrails-core init`
- **THEN** the CLI SHALL invoke the in-process `init` command handler
- **AND** SHALL inherit stdio so logger output is streamed to the caller

#### Scenario: Init with arguments
- **WHEN** user runs `npx specrails-core init --root-dir /some/path`
- **THEN** the in-process `init` handler SHALL receive `rootDir="/some/path"` as a parsed argument
- **AND** SHALL operate on that directory

#### Scenario: Update subcommand
- **WHEN** user runs `npx specrails-core update`
- **THEN** the CLI SHALL invoke the in-process `update` command handler

#### Scenario: Update with arguments
- **WHEN** user runs `npx specrails-core update --only core`
- **THEN** the in-process `update` handler SHALL receive `only="core"` as a parsed argument

#### Scenario: Doctor subcommand
- **WHEN** user runs `npx specrails-core doctor`
- **THEN** the CLI SHALL invoke the in-process `doctor` command handler

#### Scenario: Perf-check subcommand
- **WHEN** user runs `npx specrails-core perf-check`
- **THEN** the CLI SHALL invoke the in-process `perf-check` command handler

#### Scenario: No subcommand
- **WHEN** user runs `npx specrails-core` without a subcommand
- **THEN** the CLI SHALL print usage help listing available subcommands and exit with code 0

#### Scenario: Unknown subcommand
- **WHEN** user runs `npx specrails-core foo`
- **THEN** the CLI SHALL print an error message with usage help and exit with code 1

#### Scenario: Command failure propagation
- **WHEN** a command handler throws or rejects
- **THEN** the CLI SHALL print the error message to stderr and exit with a non-zero code
- **AND** SHALL preserve the error's exit code when it is an instance of the project's typed error hierarchy (e.g. `PrerequisiteError` → exit code 10)

### Requirement: Runtime dependencies are a vetted allowlist
The package MAY declare runtime dependencies in `package.json` provided they come from a short vetted allowlist. Each runtime dependency SHALL be single-purpose, well-maintained, and have a small install footprint. The combined unpacked size of all runtime dependencies SHALL NOT exceed 200 KB.

#### Scenario: Allowlist enforcement at publish time
- **WHEN** the package is packed or published
- **THEN** every entry in `package.json#dependencies` SHALL appear in the allowlist documented in `openspec/specs/npm-distribution/spec.md` below this requirement
- **AND** `npm pack --dry-run` SHALL report an unpacked dependency footprint ≤ 200 KB

#### Scenario: Current allowlist
- **WHEN** reviewing runtime dependencies
- **THEN** the allowlist SHALL be: `js-yaml` (YAML I/O), `@inquirer/prompts` (interactive prompts), `picocolors` (ANSI colours)
- **AND** any additions require a follow-up change to this spec

### Requirement: Minimal package contents
The package SHALL use a `files` whitelist in `package.json` to include only files needed for installation, update, doctor, and perf-check subcommands at runtime.

#### Scenario: Published package contents
- **WHEN** the package is packed or published
- **THEN** it SHALL include only: `bin/`, `dist/installer/`, `templates/`, `prompts/`, `.claude/skills/`, `commands/`, `schemas/`, `VERSION`
- **THEN** it SHALL NOT include: `src/`, `openspec/`, `tests/`, `docs/`, `.claude/agents/`, `.claude/agent-memory/`, `.claude/rules/`, `.claude/commands/`, `install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`

### Requirement: Cross-platform execution
The package SHALL run correctly on macOS, Linux, and Windows without requiring the user to install `bash`, `python3`, `jq`, or any other POSIX-specific tooling. All filesystem, path, and process operations SHALL be platform-aware.

#### Scenario: Windows NT path handling
- **WHEN** `init` runs on Windows with `--root-dir C:\Users\alice\repos\project`
- **THEN** every filesystem operation SHALL resolve the path using `path.resolve` / `path.join`
- **AND** no scenario SHALL rely on a Unix-style leading `/` or `:` path separator

#### Scenario: Child process invocation on Windows
- **WHEN** the installer spawns an external binary that is distributed as a Windows shim (`claude.cmd`, `npm.cmd`, `git.exe`)
- **THEN** the spawn call SHALL set `shell: true` on Windows and `shell: false` on POSIX

#### Scenario: Line-ending hygiene
- **WHEN** the installer writes any text file to the user's repository
- **THEN** the written file SHALL use LF line endings regardless of the host platform's default
- **AND** `.gitattributes` in the published package SHALL mark all text files as `text eol=lf`

#### Scenario: CI verification matrix
- **WHEN** CI runs on this package
- **THEN** a matrix of `macos-latest`, `ubuntu-latest`, and `windows-latest` runners SHALL execute the full vitest suite
- **AND** a job SHALL run `npx specrails-core init` on a fresh scratch repository on each OS and assert exit code 0

## REMOVED Requirements

### Requirement: Zero runtime dependencies
**Reason**: Replaced by the stricter "Runtime dependencies are a vetted allowlist" requirement above. Hand-rolling YAML parsing, TTY prompts, and ANSI colour handling to preserve the zero-deps constraint introduced more bugs and maintenance cost than it saved, and was a material blocker to completing the Windows port at reasonable quality.

**Migration**: `package.json#dependencies` now contains the three-entry allowlist (`js-yaml`, `@inquirer/prompts`, `picocolors`). Downstream consumers see the same `npx specrails-core` CLI surface; the dependency change is transparent to them.
