## ADDED Requirements

### Requirement: Kimi provider selection and detection
Core SHALL accept `kimi` anywhere an AI provider can be selected, detect the `kimi` executable cross-platform, retain the historical provider auto-selection priority, and never fall through to Claude rendering for Kimi.

#### Scenario: Explicit Kimi selection
- **WHEN** a user runs init with `--provider kimi`
- **THEN** Core selects Kimi even when another provider executable is installed

#### Scenario: Kimi-only environment
- **WHEN** Kimi is the only supported provider executable detected
- **THEN** Core selects Kimi and reports it in prerequisites

#### Scenario: Multiple provider environment
- **WHEN** Claude and Kimi are both installed and no provider is explicit
- **THEN** Core preserves the historical Claude-first default

### Requirement: Kimi prerequisites and authentication guidance
Core SHALL report Kimi installation, version, and authentication status using bounded non-interactive probes and SHALL provide official installation and `kimi login` guidance without reading or copying credential secrets.

#### Scenario: Missing Kimi executable
- **WHEN** Kimi is explicitly selected but `kimi` is not executable
- **THEN** init fails with an actionable official installation hint

#### Scenario: Kimi authentication unavailable
- **WHEN** Kimi is installed but its non-interactive auth probe reports that login is required
- **THEN** init fails with a `kimi login` instruction unless prerequisite checks were explicitly skipped

### Requirement: Kimi-native project layout
Core SHALL render managed Kimi artifacts under `.kimi-code` using valid Kimi
`AGENTS.md`, skill, MCP, state, and memory conventions and SHALL not generate
Claude command or agent files inside that tree. Every invocable workflow and
role SHALL be an immediate child of `.kimi-code/skills`, using disjoint
`specrails-*`, `openspec-*`, `sr-*`, and `custom-*` namespaces, because Kimi's
loader does not recurse into grouping directories.

#### Scenario: Standalone Kimi scaffold
- **WHEN** a project is initialized for Kimi
- **THEN** `.kimi-code/AGENTS.md` and all selected SpecRails workflow and rail-role `SKILL.md` files exist

#### Scenario: Skill validity
- **WHEN** a generated Kimi directory-form skill is inspected
- **THEN** its frontmatter contains non-empty `name` and `description`, nested
  workflows use Kimi's built-in `Skill` tool with explicit `skill` and `args`
  fields, and its body does not depend on interactive slash interception

#### Scenario: Direct-child role discovery
- **WHEN** selected managed or custom role skills are rendered
- **THEN** each role exists at `.kimi-code/skills/<sr-*|custom-*>/SKILL.md` and no managed role depends on a nested `skills/rails` directory

### Requirement: Complete workflow availability
Core SHALL make every SpecRails workflow available to Kimi that is available to the selected installation tier for Claude, including implement, batch, retry, diagnostics, analysis commands, and selected custom roles.

#### Scenario: Full-tier inventory
- **WHEN** a full Kimi installation completes
- **THEN** its managed skill inventory represents the same applicable workflow catalog and selected role catalog as a full Claude installation

#### Scenario: Quick-tier inventory
- **WHEN** a quick Kimi installation completes
- **THEN** tier exclusions match the provider-neutral quick-tier rules rather than a Kimi-specific reduced catalog

### Requirement: Kimi headless invocation contract
Core SHALL install and test a self-contained managed Node helper which
materializes Kimi 0.27's visible user-slash skill prompt before launching
external Kimi in prompt mode with an explicit validated model and stream JSON
output. `/skill:<name>` SHALL be documented as interactive TUI syntax only and
SHALL NOT be passed as literal headless prompt text.

#### Scenario: New headless invocation
- **WHEN** a caller launches a Kimi workflow
- **THEN** it executes `node .kimi-code/specrails/run-skill.mjs` with the skill,
  model, and raw arguments, and the helper launches Kimi with `-p`,
  `--output-format stream-json`, and the selected model without a shell

#### Scenario: Exact plain-prompt transport
- **WHEN** a provider host launches a plain Kimi turn through Core
- **THEN** the host sends at most 1 MiB of non-empty UTF-8 prompt text to the
  managed helper over stdin instead of host argv
- **AND** the helper passes the exact turn to Kimi's native `-p` boundary,
  documenting that native Kimi exposes it in its own process argv; it SHALL NOT
  replace the turn with a prompt-file/read-tool envelope

#### Scenario: Shell-free role wave
- **WHEN** a generated workflow launches one role or a parallel role group
  with arbitrary context
- **THEN** it writes one exact `{run, roles[]}` object through the structured
  WriteFile tool to `.specrails/kimi-role-wave.json` and runs one static
  foreground helper command
- **AND** each role entry contains exactly `key`, `skill`, `model`, `profile`,
  `args`, and `workspace`, with `profile` set to `inherit` or a safe profile
  stem and a safe `current` or `worktree:<id>` workspace
- **AND** the helper rejects alternate paths, symlinks, extra keys, duplicate
  ids/worktrees, unsafe identifiers, more than 32 roles, and files above
  1 MiB, deletes the one-shot wave before setup, and never evaluates request
  content as shell source

#### Scenario: Parallel role isolation and aggregation
- **WHEN** a role wave contains parallel current-repository and/or isolated
  roles
- **THEN** current roles receive unique execution directories and isolated
  roles receive distinct reusable git worktrees created without a shell
- **AND** every child receives `SPECRAILS_REPO_DIR` for its actual source
  target, output is framed with the role key, all roles are awaited, and the
  helper exits nonzero if any role fails

#### Scenario: Worktree lifecycle
- **WHEN** the first role for `worktree:<id>` is launched
- **THEN** the helper creates a private synthetic commit from a temporary index
  that snapshots dirty tracked and non-ignored untracked inputs while excluding
  provider/run-state, exposes the managed Kimi artifacts, and
  atomically persists the base/path mapping
- **AND** later waves with the same run and worktree id reuse that path for
  test/documentation roles and merge uses the recorded base commit
- **AND** setup failures remove partial worktrees while role failures preserve
  valid worktrees for retry and workflow-owned cleanup

#### Scenario: Complete merge and retry lifecycle
- **WHEN** an isolated role wave completes or a later phase is retried
- **THEN** status emits complete committed/staged/unstaged/untracked A/M/D
  inventories, structured merge actions apply safe copy/delete operations
  without shell filename interpolation, and retry reuses the persisted run and
  worktree mapping
- **AND** successful cleanup removes worktrees, execution state, manifest, git
  excludes, and the private synthetic ref, while failed/unmerged state remains

#### Scenario: Tamper-resistant persisted wave
- **WHEN** status, merge, retry, or cleanup reads a role-wave manifest
- **THEN** Core recomputes every worktree, execution, and git-exclude path from
  the canonical repository hash plus run/role/worktree ids and rejects any
  different path, even if it names another registered worktree
- **AND** the private baseline ref must still resolve to the exact recorded
  base commit before any worktree operation

#### Scenario: Wave cancellation
- **WHEN** the helper receives SIGINT, SIGTERM, or SIGHUP during a wave
- **THEN** it forwards the signal to every live Kimi child and retains the
  aggregate completion/failure contract

#### Scenario: Upstream-compatible materialization
- **WHEN** the helper loads a direct-child `SKILL.md`
- **THEN** it parses complete YAML frontmatter, strips the fences, applies
  Kimi's named/indexed/raw argument and context placeholder semantics, XML
  escaping, canonical skill-root `realpath`, and exact
  `kimi-skill-loaded` wrapper before spawn

#### Scenario: Literal slash backstop
- **WHEN** a headless caller or generated workflow would otherwise pass an
  interactive slash command as model text
- **THEN** Core routes the initial call through the helper and nested calls
  through Kimi's native `Skill` tool instead

#### Scenario: Native nested skill
- **WHEN** a materialized Kimi workflow invokes a SpecRails or OpenSpec
  subworkflow
- **THEN** its generated instructions call the built-in `Skill` tool using the
  mapped direct-child `skill` id and raw `args`, preserving native nested
  behavior and activation telemetry

#### Scenario: Session resume
- **WHEN** a completed Kimi stream produced a session resume hint
- **THEN** a later invocation can include that session ID using Kimi's native
  session flag only after the hint is the terminal non-empty record, passes the
  session-id grammar, and the child exits successfully

#### Scenario: Runtime project context
- **WHEN** a generated Kimi role or workflow needs stack, CI, layer, persona,
  backlog, or PR context
- **THEN** it resolves explicit semantic markers at activation time from
  `.kimi-code/project-context.md`, regular non-symlink persona files, and the
  validated backlog configuration instead of relying on enrich-time mutation
- **AND** backlog markers are never executed as shell command names and writes
  fail closed for invalid, missing, or read-only configuration

#### Scenario: Safe attachments
- **WHEN** an attachment is supplied to a plain or skill invocation
- **THEN** Core accepts only an absolute readable regular non-symlink file,
  canonicalizes it, and exposes each unique parent through `--add-dir`

#### Scenario: Fresh session placeholder
- **WHEN** a skill body references `${KIMI_SESSION_ID}` before any session hint
  is known
- **THEN** the helper fails before spawn rather than substituting a false empty
  identifier

#### Scenario: Safe model boundary
- **WHEN** a model id is empty, begins with `-`, contains whitespace or control
  characters, or exceeds 128 characters
- **THEN** Core rejects it before process spawn, while a safe configured alias
  such as `company/Kimi-Custom:v2` remains byte-identical

#### Scenario: Stable Kimi engine
- **WHEN** the parent environment contains `KIMI_CODE_EXPERIMENTAL_FLAG` or a
  caller supplies an unknown experimental runner option
- **THEN** Core removes the environment opt-in and rejects the option before
  launching Kimi, preserving the qualified stable v1 contract

#### Scenario: Bounded child lifecycle
- **WHEN** Core launches a managed Kimi child
- **THEN** it forces `KIMI_DISABLE_CRON=1` and
  `KIMI_CODE_NO_AUTO_UPDATE=1`, overriding case-insensitive inherited values
- **AND** it does not disable print mode's normal foreground task drain or
  steering lifecycle

#### Scenario: Model-scoped thinking effort
- **WHEN** the child environment contains `KIMI_MODEL_THINKING_EFFORT`
- **THEN** only `low`, `high`, or `max` is preserved for normalized K3, while
  non-K3 and invalid values are removed before spawn
- **AND** when no effort is explicitly supplied, the variable remains unset so
  Kimi uses its documented K3 default of `high`

#### Scenario: Windows npm shim
- **WHEN** `kimi` resolves to a standard npm `.cmd` or `.bat` shim on Windows
- **THEN** the helper launches its JavaScript entry with Node and `shell: false`,
  transports the full prompt over stdin to a fixed bootstrap which restores
  the `-p` argv value, and rejects a non-standard shim instead of invoking
  `cmd.exe`
- **AND** the bootstrap replaces only the fixed marker immediately following
  `-p`, never a marker-shaped value in another argument

#### Scenario: Session option binding
- **WHEN** a known resume id is passed to the external Kimi process
- **THEN** Core emits one `--session=<id>` argv element so the id cannot be
  reinterpreted as a separate Kimi option

#### Scenario: Oversized native Windows command
- **WHEN** a native Kimi executable would require more than 30,000 UTF-16 code
  units in its command line
- **THEN** Core fails before spawn with guidance to use the standard npm shim
  instead of truncating or compacting the workflow

#### Scenario: Initial activation telemetry boundary
- **WHEN** the initial headless skill is materialized outside Kimi's private
  `activateSkill` path
- **THEN** Core reproduces the visible prompt but does not claim or synthesize
  private `skill.activated` or activation-origin telemetry

### Requirement: Profiles, roles, and models
Core SHALL support Kimi model identifiers in provider-aware profiles and SHALL allow every selected baseline or custom role to be represented as a Kimi skill without interpreting Claude-only aliases as Kimi models.

#### Scenario: Kimi profile model
- **WHEN** a Kimi profile selects `k3` or another model reported by Kimi
- **THEN** profile validation and rendering retain the exact safe identifier,
  enforce the same 128-character process-boundary grammar, and only the three
  documented official short ids gain `kimi-code/` at spawn

#### Scenario: Custom role preservation
- **WHEN** update encounters a user-managed Kimi `custom-*` role skill
- **THEN** it preserves that role and its profile references

### Requirement: OpenSpec Kimi normalization
Core SHALL install the required OpenSpec workflow skills into `.kimi-code/skills` even when the pinned published OpenSpec release emits the legacy `.kimi/skills` layout.

#### Scenario: Legacy upstream layout
- **WHEN** OpenSpec generates `.kimi/skills/openspec-*`
- **THEN** Core atomically installs those generated skills under `.kimi-code/skills` and leaves no generated legacy `.kimi` tree

#### Scenario: Corrected upstream layout
- **WHEN** OpenSpec already generates `.kimi-code/skills/openspec-*`
- **THEN** Core accepts the corrected layout without double-copying or deleting it

#### Scenario: Safe atomic normalization
- **WHEN** Core normalizes a generated OpenSpec Kimi tree
- **THEN** it rejects symlinked/special source and destination entries, copies
  only contained regular files/directories, and uses unpredictable
  same-filesystem temporary and backup paths without deleting collisions

### Requirement: Framework, relocation, and update parity
Kimi SHALL participate in versioned framework materialization, standalone and relocated workspace assembly, manifests, reserved paths, update, cleanup, and rollback under the same provider-neutral lifecycle guarantees as existing providers.

#### Scenario: Relocated workspace
- **WHEN** Desktop requests a relocated Kimi workspace
- **THEN** the workspace receives usable `.kimi-code` managed artifacts while source and OpenSpec paths resolve through the existing relocation contract

#### Scenario: Copied overlay integrity
- **WHEN** Windows uses a copied Kimi provider overlay instead of a junction
- **THEN** Core verifies a deterministic hash of the complete provider tree,
  repairs an owned stale/corrupt copy, and never trusts the ownership marker
  alone

#### Scenario: Provider-preserving update
- **WHEN** a multi-provider project containing Kimi is updated
- **THEN** Core updates managed Kimi artifacts without pruning other provider trees or user-owned Kimi configuration

#### Scenario: Legacy nested role migration
- **WHEN** update encounters a pre-release `.kimi-code/skills/rails` layout
- **THEN** managed `sr-*` roles are regenerated as direct children, an
  unconflicted `custom-*` role is moved atomically to its direct-child path,
  and unknown or conflicting user content is preserved for doctor to report

#### Scenario: Same-version framework repair
- **WHEN** the current Kimi framework stamp matches the package version but its
  roles remain under `skills/rails` or any managed runner/vendor file is absent
- **THEN** Core rematerializes that provider framework instead of taking the idempotent skip

#### Scenario: Managed runner bundle lifecycle
- **WHEN** Core scaffolds, relocates, updates, or manifests a Kimi provider tree
- **THEN** `run-skill.mjs`, vendored `js-yaml`, its MIT license, and provenance
  notice move together under `.kimi-code/specrails`, outside the skill scanner

### Requirement: CLI-only ownership boundary
Core SHALL require an externally installed Kimi CLI and SHALL NOT bundle Kimi, start Kimi Server, register an OS service, or persist Kimi credentials.

#### Scenario: Kimi setup
- **WHEN** Core initializes a Kimi project
- **THEN** no Kimi binary, server process, service registration, or copied credential is created by Core

### Requirement: Kimi diagnostics
Doctor and manifests SHALL validate Kimi-specific paths, managed skill and
runner-bundle presence, provider version, OpenSpec placement, and stale legacy
output with provider-specific remediation.

#### Scenario: Misplaced OpenSpec skills
- **WHEN** OpenSpec skills exist only under `.kimi/skills`
- **THEN** doctor reports the stale location and the update command that repairs it

#### Scenario: Healthy Kimi installation
- **WHEN** all managed Kimi artifacts and prerequisites are valid
- **THEN** doctor reports Kimi healthy without requiring Claude

#### Scenario: Incomplete headless runner bundle
- **WHEN** the runner, parser, license, or provenance notice is missing
- **THEN** doctor fails with a Kimi-specific update remediation

#### Scenario: Undiscoverable nested Kimi roles
- **WHEN** role directories remain below `.kimi-code/skills/rails`
- **THEN** doctor fails with provider-specific remediation and does not silently treat the nested roles as installed
