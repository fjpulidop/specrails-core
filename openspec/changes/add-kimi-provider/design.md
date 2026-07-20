## Context

Core currently treats providers as a closed union duplicated across installer modules and renders from Claude-authored canonical templates into provider-specific trees. Claude receives commands, agents, skills, rules, and memory; Codex and Gemini use dedicated render paths. Kimi Code 0.27 provides an agentic CLI with headless prompt mode, JSONL output, project `AGENTS.md`, direct-child project skills, MCP, sessions, model selection, and file/shell tools.

The requested integration must work in standalone and Desktop-relocated installs, coexist with other providers, and remain usable without a daemon. Published OpenSpec releases currently place Kimi skills under legacy `.kimi/skills`, while the current Kimi runtime scans `.kimi-code/skills`.

## Goals / Non-Goals

**Goals:**

- Make `kimi` a fully validated Core provider with explicit detection, version, auth guidance, paths, scaffold, update, doctor, and framework behavior.
- Render every applicable SpecRails workflow and selected rail role as a valid Kimi skill.
- Preserve the observable architect/developer/reviewer, profile, batch, retry, worktree, memory, and OpenSpec behavior.
- Define a deterministic headless invocation contract that Desktop and scripts can consume.
- Preserve existing Claude, Codex, and Gemini output byte-for-byte except where generic provider lists must include Kimi.
- Work on macOS and Linux with native or npm-installed `kimi`; on Windows,
  support short native-executable prompts and require the standard npm shim
  for complete SpecRails workflows that exceed `CreateProcess`'s argv limit.

**Non-Goals:**

- Bundling or installing Kimi Code.
- Starting `kimi server`, registering an OS service, or implementing ACP.
- Reporting a fabricated USD cost.
- Depending on undocumented custom Kimi subagent profile files.
- Translating Claude model aliases silently into Kimi models.

## Decisions

### Materialize the initial skill before `kimi -p`

Kimi 0.27 does not interpret arbitrary slash commands in print mode:
`run-prompt.ts` forwards the `-p` value to `session.prompt()`, while TUI and ACP
clients explicitly call `activateSkill`. Therefore
`kimi -p "/skill:<name> ..."` is ordinary user text, not skill activation.

Core installs a self-contained
`.kimi-code/specrails/run-skill.mjs` helper. It validates a canonical
direct-child skill id, loads `.kimi-code/skills/<id>/SKILL.md`, parses full YAML
frontmatter through a vendored `js-yaml` ESM distribution, applies Kimi 0.27's
argument tokenizer and placeholder order, and renders the exact
`renderUserSlashSkillPrompt` envelope. Only then does it spawn external
`kimi -m <model> -p <materialized-prompt> --output-format stream-json` with an
argv array and `shell: false`.

For valid generated skills the helper canonicalizes the skill directory with
`realpath`, matching Kimi's scanner for ordinary and relocated/symlinked
installations. That canonical path is used in both `${KIMI_SKILL_DIR}` and the
activation wrapper. The helper deliberately fails closed on an empty body or a
frontmatter name that differs from its direct-child directory. Upstream may
load those malformed shapes, but SpecRails never generates them and treating
them as install corruption is an explicit hardening, not claimed
malformed-input parity. A present `type` still follows upstream validation and
must be a non-empty supported string.

The runner and its vendored parser, MIT license, and provenance notice are one
managed static subtree. This avoids relying on the target project's
`node_modules`, works in relocated installs, and remains daemon-free.

Plain-prompt invocations use the same managed helper with
`--plain-prompt-stdin`: Core sends one non-empty prompt of at most 1 MiB over
stdin, so the prompt does not cross the host-to-helper argv boundary. The
helper then passes that exact string as Kimi's native `-p` value. This second
boundary is deliberately explicit: Kimi 0.27 exposes no documented
stdin/file-prompt equivalent, so native Kimi processes necessarily expose the
prompt in their own OS argv. Replacing the prompt with a file-reading envelope
was rejected because it changes the first user turn, requires an additional
tool call, and changes telemetry and failure semantics. The official Windows
npm shim remains the qualified exception: its fixed Node bootstrap can
reconstruct the exact `-p` value from stdin inside the child process.

Alternative considered: Kimi Server. Rejected for this change because Core is an installer/framework package, not a long-lived process supervisor.

### Render Kimi-native skills rather than Claude command files

Kimi artifacts live under `.kimi-code/`. Its loader enumerates only immediate
children of `.kimi-code/skills`, so every invocable directory uses a disjoint
flat namespace: `specrails-*` workflows, `openspec-*` OpenSpec workflows,
`sr-*` managed roles, and `custom-*` user roles. Workflow commands become
directory-form skills with valid `name` and `description` frontmatter. Agent
definitions become rail-role skills, while non-invocable persona data lives
outside the scanner at `.kimi-code/personas/`. Claude
`Skill("opsx:<id>")` references are translated to calls to Kimi's built-in
`Skill` tool with the mapped `openspec-*` name and raw `args`. Internal
`/specrails:*` references are likewise rendered as native `Skill` tool
instructions, never as slash text. Interactive `/skill:*` examples remain only
in `AGENTS.md` and user documentation. Provider-specific paths and tool
terminology are removed or mapped to `.specrails`/`.kimi-code`.

Generated workflow and role skills retain semantic `KIMI_RUNTIME_*`,
`KIMI_BACKLOG_*`, and `KIMI_PR_CREATE` markers instead of silently erasing
Claude-time placeholders. At activation time their instructions resolve
project, persona, architecture, CI, backlog, and pull-request context from
`.kimi-code/project-context.md`, `.kimi-code/personas/*.md`, and
`.specrails/backlog-config.json`. These identifiers are declarative markers,
never executable command names, and backlog access fails closed to read-only
behavior when configuration is absent or invalid.

The pre-release renderer placed roles under `skills/rails`, which Kimi never
discovers. Init/update removes nested managed `sr-*` copies and regenerates
them as direct children. A nested `custom-*` role is atomically renamed to the
direct level only when that target is absent. If a same-named direct role
already exists, both copies remain byte-untouched and doctor requires manual
resolution. Unknown nested directories are also preserved and diagnosed.

### Keep orchestration provider-owned but role execution process-addressable

The Kimi implement/batch/retry skills retain the same lifecycle and receipts as
the other provider ports. Kimi's built-in Agent/AgentSwarm may be used for
homogeneous subtasks, but SpecRails role identity and model choice are
represented by a role skill and a separate top-level helper-launched Kimi
process. This avoids relying on child-agent model overrides that Kimi does not
expose. Once a role session is running, nested workflow activation uses Kimi's
native `Skill` tool so native behavior and private `skill.activated` telemetry
remain available for those nested calls.

Role instructions never interpolate model or context into a shell command.
For each single or parallel launch they write one bounded wave through Kimi's
structured WriteFile tool to the fixed
`.specrails/kimi-role-wave.json` path. Its exact schema is
`{run, roles:[{key, skill, model, profile, args, workspace}]}`; `profile` is
`inherit` or a validated profile filename stem, and `run`, `key`, profile, and
the optional `worktree:<id>` suffix use a lowercase 1–64 character safe grammar.
The orchestrator then executes one static foreground
`run-skill.mjs --role-wave-file ...` command. The helper accepts only that
regular, non-symlink path, bounds it to 1 MiB and 32 roles, rejects extra keys,
validates all identifiers, and deletes the one-shot file before setup. One
helper owns and awaits the complete concurrent wave, eliminating the
WriteFile→spawn race even for roles that target the same repository.

`workspace: current` gives each role a private execution directory with a
managed `.kimi-code` overlay while setting the child's `SPECRAILS_REPO_DIR` to
the target repository. This separates nested request paths and run-state
without redirecting source edits. `workspace: worktree:<id>` creates or reuses
a detached git worktree using argv arrays and `shell: false`. At the first
isolated wave, a temporary index snapshots starting tracked and non-ignored
untracked files into a private synthetic commit, excluding `.kimi-code` and
SpecRails run-state without changing the user's HEAD, branch, or index. It sets both
the Kimi cwd and `SPECRAILS_REPO_DIR` to that worktree. Sequential developer,
test, and documentation roles reuse the same id; concurrent entries may not
share it.

The helper atomically persists source HEAD, immutable synthetic base commit,
worktree id→path,
and role key→execution/repository mapping at
`.specrails/kimi-role-worktrees/<run>.json`. Generated Kimi merge instructions
consume `--role-wave-status` A/M/D inventories and apply exclusive copy/delete
actions through a fixed, schema-validated merge request, never shell filename
interpolation. A setup failure removes worktrees created by that failed setup.
A role failure leaves valid worktrees and the manifest for retry; pipeline state
persists and reuses the exact run/workspace mapping. After successful merge,
`--role-wave-cleanup` removes registered worktrees, execution state, manifest,
git excludes, and the private synthetic ref.

Every status, merge, reuse, and cleanup operation treats the persisted manifest
as untrusted input. The helper recomputes each permitted canonical worktree,
execution, and git-exclude path from the canonical base repository,
repository key, run id, role key, and worktree id; verifies every worktree is
still registered to that repository; checks each workspace mapping and the
exclude file's exact managed contents; and requires the private synthetic ref
to resolve to the manifest's immutable base commit. Absolute paths supplied by
the manifest are never accepted merely because they exist.

When a platform cannot use the preferred linked provider overlay and must copy
it, an ownership marker alone is insufficient. The helper records and
revalidates a deterministic SHA-256 over the complete provider tree, including
relative paths, entry types, executable bits, and file bytes. A validly owned
but stale or corrupted copy is rebuilt; unmarked or invalidly marked
directories remain user-owned and fail closed. Symlinks and special files are
never admitted into either the managed source tree or its copy.

Concurrent child JSONL streams are never inherited into one ambiguous stdout.
The helper captures each child's stdout/stderr, emits attributed
`specrails.role.*` frames, waits for every child, and returns nonzero if any
required role fails. SIGINT/SIGTERM/SIGHUP are forwarded once to every live
child. Current-repository execution directories also make a nested workflow's
fixed wave path unique per parent role; isolated roles naturally use their
distinct worktree paths. There is still no server or daemon.

The initial helper-materialized activation reproduces the complete visible
user prompt but cannot manufacture Kimi's internal `skill.activated` telemetry
or activation-origin metadata: those are emitted inside the private
`activateSkill` path, before `session.prompt`. This is an explicit telemetry
limitation, not a claim of private-internal parity.

### Validate every spawn-boundary identifier

Role ids are lowercase direct-child identifiers. Model ids and configured
aliases must be 1–128 characters and match
`^[A-Za-z0-9][A-Za-z0-9._/:-]*$`; leading dashes, whitespace, controls, shell
metacharacters, and oversized values fail before spawn. Only `k3`,
`kimi-for-coding`, and `kimi-for-coding-highspeed` gain the documented
`kimi-code/` prefix. Other safe aliases, such as
`company/Kimi-Custom:v2`, remain byte-identical.

The Kimi branch of profile schema validation applies that same 128-character
model grammar before a workflow can render a role wave; provider-generic
model ids remain unchanged for Codex and Gemini.

On Windows, the helper launches a native Kimi executable directly. For the
standard npm `.cmd`/`.bat` shim it extracts the JavaScript entry and launches
that entry with Node, still with `shell: false`; a non-standard shim fails
closed rather than sending user-controlled values through `cmd.exe`.

The largest complete workflows exceed Windows `CreateProcess`'s command-line
limit when placed directly after `-p`. For the official npm shim, a fixed,
user-input-free Node `-e` bootstrap reads the materialized UTF-8 prompt from
stdin, replaces Core's fixed marker in `process.argv`, and imports Kimi's
official ESM entry. Kimi then observes the original full `-p` value without the
prompt ever crossing the OS argv boundary. The transported command line is
limited to 30,000 UTF-16 code units. A native executable is direct-spawned only
under that budget and otherwise fails with npm-shim remediation.

Known session ids are passed to Kimi as one `--session=<id>` argv element.
This keeps even option-like values bound to the session option instead of
allowing Commander to reinterpret them as new flags. The Windows bootstrap
locates the fixed marker only as the value immediately following `-p`.

The qualified execution contract targets Kimi 0.27's stable v1 engine. The
runtime overlay explicitly unsets `KIMI_CODE_EXPERIMENTAL_FLAG`, and the helper
also removes that key case-insensitively from its child environment. Unknown
experimental CLI flags fail argument parsing rather than selecting an
unverified engine with different policy or stream semantics.

Every managed child forces `KIMI_DISABLE_CRON=1` because SpecRails owns one
bounded invocation and has no scheduler lifecycle/UI for persistent CronCreate
work. It also forces `KIMI_CODE_NO_AUTO_UPDATE=1` so a job cannot mutate its
external CLI/version during startup. Both keys override inherited casing and
values. Print mode's normal foreground task drain/steer semantics remain
unchanged.

The helper forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to its direct Kimi child
and removes listeners after exit. An embedding host such as Desktop still owns
platform-specific process-tree teardown; Core does not claim that forwarding a
signal to one PID replaces the host's tree-kill policy.

`KIMI_MODEL_THINKING_EFFORT` is equally model-scoped. Core's invocation overlay
unsets inherited effort unless the caller explicitly supplies `low`, `high`,
or `max` for K3. The standalone helper preserves an inherited valid value only
when the normalized model is `kimi-code/k3`; non-K3 and invalid values are
removed before spawn. With no explicit value, Kimi retains its documented K3
default of `high`; SpecRails never changes that default to `low`.

### Normalize OpenSpec output in staging

Core will invoke the pinned OpenSpec tool target and then normalize any
generated `.kimi/skills/openspec-*` directories into `.kimi-code/skills`. The
normalizer validates the complete source tree with `lstat` and canonical
containment checks, accepts only real directories and regular files, rejects
symlinks and special entries (including a symlinked artifact root or
`SKILL.md`), and copies through an unpredictable same-filesystem staging
directory. Replacement and rollback use unpredictable sibling backup paths,
so pre-existing user directories with old predictable names are untouched.
The copy is additive and atomic, removes only the generated legacy Kimi
directory after success, and never moves user-authored content.

### Use explicit Kimi branches and fail closed

No unknown provider may fall through to Claude. Kimi gets explicit path, scaffold, settings, memory, manifest, and linked-subtree behavior. Provider lists, validation, help, and tests are updated together.

### Keep profile schema backward compatible

The existing v1 schema remains valid for Claude. It is extended in a
backward-compatible manner with an optional provider and exact provider model
identifiers, while preserving the baseline-role and routing rules. Kimi adds
the same safe 128-character grammar enforced at spawn. Its defaults are
explicit (`k3`), and role model selection is never inferred from
`sonnet`/`opus`/`haiku`.

## Risks / Trade-offs

- **Kimi JSONL lacks Claude's terminal result envelope** → Expose a session ID
  only from a valid, non-empty `session.resume_hint` in the terminal JSONL
  record and only when the child exits successfully; earlier, malformed, or
  failed-process hints are not resumable.
- **A first-turn cancellation can occur before the session ID is emitted** → Treat cancellation as terminal and do not promise resume for that edge case.
- **`${KIMI_SESSION_ID}` is not known before the first prompt** → Reject a
  fresh helper invocation of a skill using that placeholder; allow it only
  after a known `session.resume_hint` is passed with `--session`.
- **Published OpenSpec Kimi layout is stale** → Normalize only generated `openspec-*` skills and cover both legacy and corrected upstream layouts.
- **Pre-release SpecRails role layout is undiscoverable** → Rematerialize even
  same-version Kimi frameworks that contain `skills/rails`; safely migrate
  custom roles, regenerate managed roles, and diagnose collisions or unknown
  nested content without deleting it.
- **Claude-authored workflow prose may leak provider syntax** → Add inventory
  tests rejecting `.claude`, `/specrails:`, `/skill:`, `subagent_type`, and
  `Skill("opsx:` in generated Kimi skill bodies, while requiring native
  `Skill(skill=..., args=...)` instructions for nested activation.
- **Prompt materialization cannot emit private activation telemetry** → State
  the limitation explicitly; do not synthesize `skill.activated`. Nested
  in-session activations continue through Kimi's native `Skill` tool.
- **Complete prompts can exceed Windows argv limits** → Preserve the full
  workflow and use stdin only as transport into the official npm JavaScript
  entry; never compact away phases or send prompt content through a shell.
- **Native Kimi exposes the exact prompt in its process argv** → Document this
  upstream CLI limitation honestly. Core protects the host-to-helper boundary,
  but does not substitute a file/tool envelope that would alter the user turn;
  sensitive secrets should not be placed in prompts.
- **Persisted role state and copied overlays are locally editable** → Recompute
  exact managed paths, worktree registration, exclude contents, and private-ref
  identity before any stateful operation, and hash the complete copied
  provider tree before reuse.
- **Provider additions can regress existing installations** → Snapshot all providers and run standalone, relocated, framework, update, and multi-provider tests.
- **Kimi evolves rapidly while pre-1** → Set a minimum tested version and keep parsing tolerant of unknown JSONL event types.

## Migration Plan

1. Release Core with Kimi scaffold/runtime contract but no automatic selection preference over existing providers.
2. Existing projects opt in with `--provider kimi` or a Kimi install config.
3. Update materializes `.kimi-code` alongside existing provider trees,
   preserves user-owned skills/MCP, and migrates undiscoverable nested Kimi
   roles to direct skill children when conflict-free.
4. Desktop consumes the new Core version before exposing Kimi.
5. Rollback removes only SpecRails-managed Kimi artifacts; other providers and user Kimi configuration remain intact.

## Open Questions

- Live Kimi contract fixtures cannot be captured in this environment unless a Kimi account/CLI is available; fixture schemas will therefore be derived from the official 0.27 contract and clearly versioned.
