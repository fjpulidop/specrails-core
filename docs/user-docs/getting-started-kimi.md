# Getting Started with SpecRails + Kimi Code

SpecRails supports Kimi Code as an independent AI provider. The integration
uses the installed `kimi` CLI in non-interactive prompt mode; it does not embed
Kimi Code, start `kimi web`, or require a SpecRails-owned server.

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Kimi Code | 0.27.0 or newer | Agentic runtime |
| Node.js | 20.19.0 or newer | Runs the SpecRails installer and pinned OpenSpec 1.4.1 CLI |
| Git | 2.25 or newer | Repository and worktree operations |

Install Kimi Code using an official method:

```bash
# macOS / Linux
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

The optional npm distribution is `@moonshot-ai/kimi-code` and requires the
Node.js version documented by Kimi Code (22.19 or newer at the time this
integration was implemented). The standalone installer is preferable when the
project itself may remain on Node 20.19.0 or newer.

Verify the executable and authenticate once:

```bash
kimi --version
kimi login
```

SpecRails checks installation and version without sending a model prompt. Kimi
does not expose a non-billing command that conclusively proves every OAuth
session is usable, so an inconclusive auth probe is allowed and the first real
invocation will surface any login error.

## Install SpecRails

From the repository that should receive SpecRails:

```bash
npx specrails-core@latest init --root-dir . --provider kimi
```

For a quick, template-only install:

```bash
npx specrails-core@latest init --root-dir . --provider kimi --quick
```

Without `--provider`, automatic selection preserves the established priority:
Claude, Codex, Gemini, then Kimi. Pass `--provider kimi` when several CLIs are
installed and Kimi is the intended runtime.

## Generated Kimi layout

```text
.kimi-code/
├── AGENTS.md
├── mcp.json
├── personas/
├── rules/
├── specrails/
│   ├── run-skill.mjs
│   └── vendor/js-yaml/
│       ├── js-yaml.mjs
│       ├── LICENSE
│       └── NOTICE.md
└── skills/
    ├── specrails-enrich/SKILL.md
    ├── specrails-implement/SKILL.md
    ├── specrails-…/SKILL.md
    ├── openspec-…/SKILL.md
    ├── sr-architect/SKILL.md
    ├── sr-developer/SKILL.md
    └── …
```

Kimi's skill loader inspects each immediate child of `.kimi-code/skills`; it
does not recursively discover grouping directories. SpecRails therefore gives
every workflow (`specrails-*`), OpenSpec workflow (`openspec-*`), managed role
(`sr-*`), and custom role (`custom-*`) its own direct-child directory.
Non-invocable persona data lives separately under `.kimi-code/personas/`, so
the skill scanner never mistakes it for a skill. The managed headless runner
also lives outside the scanner.

Interactive workflow invocations in Kimi's TUI differ from Claude/Gemini
syntax:

```text
/skill:specrails-enrich
/skill:specrails-implement add passkey authentication
/skill:specrails-batch-implement #41 #42
```

OpenSpec workflows use their complete published skill names, for example:

```text
/skill:openspec-ff-change add-passkeys
/skill:openspec-apply-change add-passkeys
/skill:openspec-verify-change add-passkeys
```

OpenSpec versions that initially generate `.kimi/skills/openspec-*` are
normalized into `.kimi-code/skills/` by SpecRails. Existing `.kimi-code`
content and user-owned skills are preserved. Normalization rejects symlinked
or special-file sources/destinations, copies only a verified contained tree,
and uses unpredictable same-filesystem temporary/backup directories for each
atomic replacement.

## Models and reasoning effort

SpecRails persists Kimi's public model ids:

- `k3` (default)
- `kimi-for-coding`
- `kimi-for-coding-highspeed`

Managed Kimi login config exposes these as CLI aliases under `kimi-code/`.
At process launch, SpecRails maps only those known ids:

```text
k3                            -> kimi-code/k3
kimi-for-coding               -> kimi-code/kimi-for-coding
kimi-for-coding-highspeed     -> kimi-code/kimi-for-coding-highspeed
```

Already-prefixed aliases and custom aliases pass through unchanged. This keeps
profiles portable without silently rewriting custom Kimi configuration.
At the process boundary, every model id must be 1–128 characters and match
`^[A-Za-z0-9][A-Za-z0-9._/:-]*$`. This preserves common configured aliases such
as `company/Kimi-Custom:v2` while rejecting leading flags, whitespace, control
characters, and shell syntax before spawn.

When profile scaffolding is requested, Kimi's provider-bound fallback is stored
at `.specrails/profiles/kimi-default.json`. It can coexist with Claude's
historical `project-default.json` in a multi-provider project.

K3 supports `low`, `high`, and `max` reasoning effort. Desktop launches apply
the selected value only to that child process through
`KIMI_MODEL_THINKING_EFFORT`; SpecRails never mutates the user's global shell
environment. The Core invocation overlay removes inherited effort unless the
caller explicitly selects a valid value for K3. The managed helper preserves
an inherited `low`, `high`, or `max` only for `k3`/`kimi-code/k3`; it removes
the variable for every other model and drops invalid values. Kimi's documented
K3 default is `high`; leaving the variable unset deliberately retains that
upstream default. SpecRails does not substitute `low`.

## Headless and session behavior

Kimi 0.27 handles `/skill:...` in its TUI and ACP clients. Prompt mode does not:
`kimi -p "/skill:specrails-implement ..."` forwards that string directly to
the model and silently fails to call Kimi's skill activation path.

The canonical headless invocation therefore uses Core's managed Node helper:

```bash
node .kimi-code/specrails/run-skill.mjs \
  --skill specrails-implement \
  --model k3 \
  --args "add passkey authentication"
```

The helper validates a direct-child skill id, reads and expands its `SKILL.md`
using Kimi 0.27's argument and XML rules, and launches the separately installed
`kimi` executable with `-p` and `--output-format stream-json`. It passes each
value as an argv element with `shell: false`; it never evaluates skill names,
model aliases, or multiline arguments as shell source.

Provider hosts can submit a plain user turn to the helper with
`--plain-prompt-stdin`; Core bounds that UTF-8 input to 1 MiB and keeps it out
of the host-to-helper argv. Kimi 0.27 exposes no native stdin/file equivalent
to `-p`, so the helper passes the exact turn—not a file-reading envelope—to
the external CLI. Consequently, an official native Kimi binary still exposes
the exact prompt in its own process argv. The Windows npm shim is the one
verified exception described below. Do not place secrets in agent prompts.

Generated Kimi skills resolve project-specific stack, CI, layer, persona,
backlog, and PR context at activation time from `.kimi-code/project-context.md`,
`.kimi-code/personas/*.md`, and `.specrails/backlog-config.json`. Their
`KIMI_RUNTIME_*`/`KIMI_BACKLOG_*` markers are semantic operations, never shell
command names. Missing or read-only backlog configuration fails closed for
writes instead of fabricating a provider command.

Generated workflows use an even stricter boundary for role launches. For each
single role or parallel group, the orchestrator writes one exact object through
Kimi's structured WriteFile tool to `.specrails/kimi-role-wave.json`:

```json
{
  "run": "implement-20260719",
  "roles": [
    {
      "key": "developer-feature-a",
      "skill": "sr-developer",
      "model": "k3",
      "profile": "inherit",
      "args": "Complete context for feature A",
      "workspace": "worktree:feature-a"
    }
  ]
}
```

`run`, `key`, the optional profile stem, and the worktree suffix are lowercase
letters/digits/hyphens, 1–64 characters. `profile` is `inherit` or the stem of
a validated `.specrails/profiles/<name>.json`; the helper passes its absolute
path only to that child. A wave contains 1–32 roles and no extra fields. The
orchestrator then runs one static foreground command with `--role-wave-file`;
model names and arbitrary multiline context never enter shell source. The
runner accepts no alternate path, symlink, duplicate role/worktree, unsafe
identifier, or file above 1 MiB, and deletes the one-shot file before setup.

```bash
node .kimi-code/specrails/run-skill.mjs \
  --role-wave-file .specrails/kimi-role-wave.json \
  --add-dir "${SPECRAILS_REPO_DIR:-.}"
```

`workspace: "current"` still gives each parallel role a unique execution
directory, while `SPECRAILS_REPO_DIR` points at the repository it must edit.
This prevents nested workflow state/request collisions. A
`worktree:<feature-id>` entry creates or reuses a detached git worktree from a
private synthetic commit that snapshots the initial dirty tracked and
non-ignored untracked files without changing the user's index or branch. Reuse the
same worktree id for that feature's developer, test, and documentation waves.
The helper excludes managed `.kimi-code`/run-state from the role's git index
and records source HEAD, immutable synthetic base commit, and every path under
`.specrails/kimi-role-worktrees/<run>.json`; merge instructions use that commit
instead of assuming `main`.

Before status, merge, reuse, or cleanup, Core recomputes the only valid temp
worktree/execution/exclude paths from the canonical repository hash and run/id,
requires every isolated path to be that exact registered worktree, and verifies
the private baseline ref still equals the manifest commit. Editing the manifest
cannot redirect `git worktree remove`, status, or merge to another registered
worktree. A Windows copied `.kimi-code` overlay is likewise accepted only with
a managed marker and a full deterministic content hash; stale bytes are rebuilt.

Child streams are emitted as attributed `specrails.role.*` JSONL frames. The
helper waits for the whole wave and exits nonzero if any role fails. Termination
signals reach every live child. A role failure keeps valid worktrees for retry;
a setup failure removes only worktrees partially created by that setup, and
retry reuses the manifest's exact run/worktree mapping.

Merge begins with `--role-wave-status <run>`, which emits complete A/M/D
inventories across committed, staged, unstaged, and non-ignored untracked
changes. Exclusive paths are applied through the fixed
`.specrails/kimi-role-merge.json` request and `--role-merge-file`; filenames are
never interpolated into shell source. After a successful merge,
`--role-wave-cleanup <run>` removes registered worktrees, execution state, the
manifest, and the private synthetic-baseline ref. Failed or unmerged runs are
never cleaned automatically.

The supported contract is qualified against Kimi 0.27's stable v1 engine.
SpecRails removes `KIMI_CODE_EXPERIMENTAL_FLAG` from the child environment and
rejects experimental runner flags instead of silently opting into a different,
unverified runtime. Every Core-managed child also receives
`KIMI_DISABLE_CRON=1` and `KIMI_CODE_NO_AUTO_UPDATE=1`: a bounded SpecRails
invocation must not leave persistent scheduled work behind or self-update the
external CLI during startup. These controls do not disable Kimi print mode's
normal foreground task drain or steering lifecycle.

On Windows npm installs, large materialized workflows never travel in the
`CreateProcess` command line. The helper launches the official Kimi JavaScript
entry through a fixed Node bootstrap, sends the full UTF-8 prompt over stdin,
and restores that one `-p` argv value before importing Kimi. This preserves the
complete workflow even when it exceeds Windows' command-line limit. A native
executable remains direct-spawned only while its command line is at most 30,000
UTF-16 code units; larger native launches fail with guidance to use the
standard npm shim.

Once that initial skill is running, nested SpecRails and OpenSpec workflows use
Kimi's built-in `Skill` tool with explicit `skill` and `args` fields. This is
the native in-session path and retains Kimi's nested activation behavior and
`skill.activated` telemetry. The external helper reproduces the exact visible
initial prompt, but cannot emit Kimi-private activation-origin telemetry; no
such events are synthesized.

Kimi emits a `session.resume_hint` record at the end of a successful prompt.
A host trusts and persists it only when it is the terminal non-empty JSONL
record, its id passes the grammar below, and the Kimi child exits with code 0.
When that session id is known, a later skill invocation can resume it explicitly:

```bash
node .kimi-code/specrails/run-skill.mjs \
  --skill sr-reviewer \
  --model k3 \
  --args "continue with the review feedback" \
  --session=<session-id>
```

`${KIMI_SESSION_ID}` cannot be populated before a fresh prompt emits that hint.
The helper rejects a fresh invocation of a skill that uses this placeholder
instead of silently substituting an incorrect empty id. Resume ids are bounded
to 1–128 characters in `[A-Za-z0-9._-]`, with `.` and `..` rejected, and the
external Kimi process receives the id as one `--session=<id>` argument.

The helper forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to its direct Kimi child
and removes those handlers when the child exits. Desktop or another embedding
host remains responsible for its normal platform-specific process-tree
teardown. There is no background Kimi service for SpecRails to install,
monitor, or uninstall.

One JSONL assistant record may contain text and several tool calls. Consumers
must retain every event from that record. The telemetry skill reads Kimi's
persisted `~/.kimi-code/session_index.jsonl`, validated session `state.json`,
and `agents/*/wire.jsonl` `usage.record` events. Those records expose
input-other, output, cache-read, and cache-creation tokens per model. They do
not expose an authoritative USD charge or reliable role outcome, so cost and
success rate remain unavailable rather than being synthesized.

## Permissions and attachments

Kimi prompt mode is autonomous: it temporarily uses Kimi's `auto` permission
policy and still honors static deny rules from the user's Kimi configuration.
Run agentic workflows only in repositories and worktrees you trust. SpecRails
does not add `--auto`, `--yolo`, or `--plan`; Kimi rejects those flags when
combined with `-p`.

Kimi has no dedicated image CLI flag. SpecRails accepts only absolute,
readable, regular, non-symlink attachment files, canonicalizes each path, and
adds every unique parent as `--add-dir`. It then places those canonical media
references in the prompt so Kimi can use `ReadMediaFile` or `ReadFile`. Core's
helper does not read or inline attachment contents. Missing files, directories,
symlinks, and unreadable inputs fail before spawn.

## MCP

Kimi reads project MCP declarations from `.kimi-code/mcp.json`. SpecRails
creates an empty file when none exists and merges its own entries additively.
It never replaces an existing valid user configuration or copies OAuth/API
credentials into the repository.

## Updating

Update a Kimi installation explicitly:

```bash
npx specrails-core@latest update --root-dir . --provider kimi
```

Framework-owned `specrails-*` and `sr-*` skills are refreshed. These remain
outside the cleanup boundary:

- OpenSpec `openspec-*` skills
- direct-child `custom-*` role skills
- unknown user skill directories
- existing MCP servers
- agent memory and runtime state

The managed `.kimi-code/specrails/run-skill.mjs` file is refreshed from the
trusted Core package and recorded in the manifest. It is executable framework
code, not a user-authored skill; keep custom helpers outside
`.kimi-code/specrails/`. Its complete managed bundle includes the unmodified
`js-yaml` ESM distribution, MIT `LICENSE`, and provenance `NOTICE.md` under
`.kimi-code/specrails/vendor/js-yaml/`; this gives the helper complete YAML
frontmatter parsing without using the project's `node_modules`.

Pre-release SpecRails builds placed role skills below `skills/rails`, where
Kimi cannot discover them. Update moves a legacy `custom-*` role to the direct
level only when no same-named direct role exists, and recreates managed `sr-*`
roles from the framework. A collision preserves both copies and is reported by
`doctor` instead of guessing which user-authored role should win.

## Troubleshooting

### `kimi` is not found

Open a new terminal after installation and check:

```bash
kimi --version
```

On Windows, also verify that the directory containing `kimi.cmd` is present in
`PATH`.

### Login or model configuration error

Run:

```bash
kimi login
kimi -p "Reply with OK" --output-format stream-json
```

The second command is a real model request and can consume quota; SpecRails
does not run it automatically as a setup probe.

### Model alias is not configured

Complete managed login again, choose an alias configured in
`~/.kimi-code/config.toml`, or pass one of the managed aliases such as
`kimi-code/k3`.

### Legacy `.kimi/skills` remains

Run the Kimi-specific update command. SpecRails moves only recognized
`openspec-*` output and removes the legacy directory only when it is empty.
Unknown files are left for manual review.

### Doctor reports a nested `skills/rails` layout

Run the Kimi-specific update command first. If the diagnostic remains, compare
the reported legacy `skills/rails/custom-*` role with its direct
`skills/custom-*` counterpart, keep the intended version at the direct path,
and remove the nested duplicate. Unknown nested directories are never deleted
automatically.

## Official Kimi references

- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
- [Getting started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
- [Environment variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)
- [What is new](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html)
