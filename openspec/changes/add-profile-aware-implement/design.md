## Context

The specrails pipeline today is stateful in markdown. `templates/commands/specrails/implement.md` contains both the orchestration algorithm AND the routing rules as prose. There is no config surface between "the prompt specrails-core ships" and "how Claude actually runs the pipeline in a given project". Any customization either (a) edits the shipped `implement.md` and gets overwritten on `update`, or (b) requires a fork.

This design introduces a declarative config layer — **agent profiles** — that the pipeline reads at runtime, so the same shipped `implement.md` can produce different behaviors across projects, rails, and developers without modifying the file.

The design is explicitly scoped to preserve 100% backward compatibility with standalone CLI users who will never have a profile. Profile-awareness is an **optional enhancement**, not a prerequisite.

Consumers on the hub side (specrails-hub) need a stable contract to build UI against. This change publishes a versioned JSON schema and a resolution order that the hub can rely on.

## Goals / Non-Goals

**Goals:**
- Make `implement.md` read agent discovery, routing, and per-agent models from an optional profile JSON.
- Publish a stable, versioned profile schema consumable by external tools (specrails-hub).
- Guarantee zero behavior change for users without a profile (no file, no env var).
- Support concurrent rails in `batch-implement` using distinct profiles per rail.
- Harden `update.sh` / `install.sh` so they never overwrite `.specrails/` or `.claude/agents/custom-*.md`.

**Non-Goals:**
- UI for managing profiles (belongs to specrails-hub).
- Automatic migration of existing projects to profile-mode (opt-in only).
- Cross-project profile sharing or marketplace (future capability, not part of this change).
- Runtime mutation of profiles mid-job (profiles are resolved once at spawn time; see snapshot-per-job below).
- Changes to `ChatManager` / `SetupManager` flows in the hub — those remain uninstrumented by profiles.

## Decisions

### 1. Profile resolution order

Precedence (highest wins):

1. `$SPECRAILS_PROFILE_PATH` env var → absolute path to a profile JSON snapshot.
2. `<cwd>/.specrails/profiles/project-default.json` → checked-in per-project default.
3. Legacy fallback → current hardcoded behavior in `implement.md` (today's status quo).

**Rationale:** env var is for callers that pin a specific snapshot (the hub spawning a rail with a frozen profile — see decision 5). File is for standalone users who want a default without the env var. Fallback guarantees zero-config standalone continues to work.

**Alternative considered:** single mechanism (env only, or file only). Rejected: env-only breaks standalone CLI use; file-only breaks per-rail concurrency in batch because all rails share a cwd.

### 2. Profile schema (v1)

```json
{
  "schemaVersion": 1,
  "name": "default",
  "description": "Human-readable summary",
  "orchestrator": { "model": "opus" },
  "agents": [
    { "id": "sr-architect",  "model": "opus",   "required": true },
    { "id": "sr-developer",  "model": "sonnet", "required": true },
    { "id": "sr-reviewer",   "model": "sonnet", "required": true }
  ],
  "routing": [
    { "tags": ["etl","data","schema"], "agent": "sr-data-engineer" },
    { "tags": ["frontend"],            "agent": "sr-frontend-developer" },
    { "default": true,                 "agent": "sr-developer" }
  ]
}
```

Rules:
- `schemaVersion` is mandatory. `implement.md` errors clearly if unknown.
- `agents[].id` MUST match a file at `.claude/agents/<id>.md`. Missing agent → error at Phase -1, not silent skip.
- `agents[].model` overrides the frontmatter `model:` of the referenced `.md`.
- `agents[].required: true` means the agent cannot be routed-past (reviewer must run, architect must run, etc.). UI on the hub will prevent removing required agents.
- `routing` is ordered. First rule whose `tags` intersects the task tags wins. A single entry with `default: true` catches everything else and MUST be last.

**Rationale:** Small, declarative, trivially serializable. No logic in the profile — only facts. All policy stays in `implement.md`.

**Alternative considered:** YAML with richer expressions (regex routing, weighted models). Rejected: increases complexity of the reader in `implement.md` (needs more than `jq`), and early users don't need it. Ship JSON v1, extend to v2 when a concrete need appears.

### 3. Legacy fallback lives inside `implement.md`

Phase -1 and Phase 3b become two-branch:

```markdown
## Phase -1: Agent discovery

If $SPECRAILS_PROFILE_PATH is set OR .specrails/profiles/project-default.json exists:
  Read the profile JSON. Set AVAILABLE_AGENTS = profile.agents[].id.
  Set AGENT_MODEL[$id] = profile.agents[$id].model (defaults to the .md frontmatter).

Otherwise (legacy mode, identical to today):
  AVAILABLE_AGENTS = $(ls .claude/agents/sr-*.md | sed ...)
  AGENT_MODEL[$id] = (frontmatter default)
```

```markdown
## Phase 3b: Route task to specialist

If a profile is active:
  Apply profile.routing rules in order. First rule whose tags intersect the task
  tags wins. Fall through to the `default: true` rule.

Otherwise (legacy mode):
  [frontend] → sr-frontend-developer (if available)
  [backend]  → sr-backend-developer (if available)
  [data|etl|schema] → sr-data-engineer (if available)
  default    → sr-developer
```

**Rationale:** both branches are explicit in the markdown. A human reading the file sees exactly how each mode works. No hidden state.

**Alternative considered:** extract legacy defaults to a shipped `default-profile.json` and always run in "profile mode" under the hood. Rejected: adds a mandatory file to every install, changes the mental model for standalone users ("why does my project have a .json I didn't create?"), and complicates `update.sh`.

### 4. Subagent model override

Today, subagents inherit their `model` from the frontmatter of their `.md` file. Under profiles, the same agent must be runnable with different models in different rails concurrently. Rewriting frontmatter per-rail is racy and leaves git-tracked noise.

Decision: the orchestrator invokes each subagent with an explicit model parameter sourced from the profile's `AGENT_MODEL[$id]`. The agent's `.md` stays untouched; `model:` in frontmatter becomes a *default* used only in legacy mode.

**Rationale:** keeps `.md` immutable across rails. Two concurrent rails can invoke `sr-security-reviewer` with `opus` and `sonnet` respectively without touching disk.

**Alternative considered:** render per-rail `.claude/agents/` under a rail-specific directory and point Claude at it. Rejected: Claude Code does not support configurable agent directories; would require every rail to run in a sandboxed checkout. Too heavy.

### 5. Snapshot-per-job (contract with hub)

The hub is expected to:
1. Resolve the profile selection for a job at spawn time.
2. Write the resolved JSON to a job-scoped snapshot, e.g. `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json`.
3. Spawn `claude` with `SPECRAILS_PROFILE_PATH=<snapshot path>`.

This contract is not *enforced* by specrails-core (core only knows how to read `$SPECRAILS_PROFILE_PATH` or the default file), but it is **documented** so hub-side implementations converge.

**Rationale:** snapshot semantics avoid mid-job races when the user edits a profile or switches the project default. Jobs are atomic w.r.t. profile state.

### 6. Reserved directories

`.specrails/` (project-level): owned by specrails; `update.sh` and `install.sh` must never touch it.
`.claude/agents/custom-*.md`: user-authored agents; `update.sh` must never touch files matching the `custom-*` glob.

**Rationale:** establishes a stable contract with the hub (which writes profiles and custom agents) and with power users who hand-author them. Without a formal "hands-off" zone, every upgrade is a potential data loss event.

### 7. `batch-implement` per-rail forwarding

Current `batch-implement.md` spawns one `/specrails:implement` invocation per feature. Change: each spawn inherits an optional profile path from its own env var (set by the hub or by a new `--profile` flag when invoked manually).

The batch orchestrator itself does not need to know about profiles — it just forwards whatever it was told. This keeps `batch-implement.md` simple.

### 8. Schema location and versioning

Schema is published at `schemas/profile.v1.json` inside specrails-core, referenced from the README. Future breaking changes create `profile.v2.json`. `implement.md` reads `schemaVersion` and errors on unknown versions with a clear upgrade message.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| `update.sh` accidentally overwrites `.specrails/` or `custom-*.md` | Explicit skip-list in installer; add a test that runs `update.sh` against a fixture project and asserts those paths survive |
| Profile JSON drifts from runtime behavior (schema mismatch) | `schemaVersion` check + clear error + advisory to update specrails-core |
| `jq` unavailable in some user environments | Preflight check in Phase -1; clear error with install instructions; alternative pure-bash parser if jq missing is too common |
| Standalone user accidentally creates `.specrails/profiles/project-default.json` half-filled and pipeline breaks | Validate schema at Phase -1; fall back to legacy mode with a warning rather than crash, if opt-in safe mode requested |
| Hub and core fall out of sync on schema version | Hub pins `specrails-core@>=4.1.0 <5.0.0` and reads `schemaVersion` from every profile before writing |
| `implement.md` becomes harder to read with two code paths | Keep branches clearly labeled and minimal; profile branch should mostly read JSON and delegate to the same downstream logic |
| Required agents silently dropped from a profile | Schema validation: `agents[]` must contain `sr-architect`, `sr-developer`, and `sr-reviewer` (the baseline). Error if missing. |
| Routing rule ordering surprises users | Document "first match wins" prominently; hub UI enforces visible ordering with drag handles |
| Users edit the snapshot at `~/.specrails/.../jobs/<id>/profile.json` mid-run | Document the snapshot as read-only; the hub can chmod 400 after writing |

## Migration Plan

1. **Ship 4.1.0 with the new capability opt-in.**
   - `implement.md` gains the profile branch but defaults to legacy when no profile is present.
   - No existing project is affected.

2. **Hub pins `>=4.1.0` and begins writing profiles.**
   - Hub's "link project" flow optionally scaffolds `.specrails/profiles/default.json` (never without user consent).

3. **Observe in the wild.**
   - Track how many projects opt in; collect schema edge cases.

4. **Iterate toward v2 if needed.**
   - If users demand richer routing, design v2 schema additively (v1 still works).

**Rollback**: revert the `implement.md` change. Because the profile branch is gated on file/env existence, reverting harms no standalone user. Hub users would lose profile features until a new version ships, but their projects continue to function (fall back to legacy).

## Open Questions

- Should the baseline profile's `required` flag be enforced at schema validation time or only advisory? (Leaning: enforced — prevents footgun.)
- Is `jq` acceptable as a hard dep for profile mode, or do we want a node-based reader? (Leaning: jq is fine; Phase -1 detects and errors clearly.)
- Do we want a `specrails profile validate <path>` CLI command as part of this change, or defer it? (Leaning: add it — one-shot utility, low cost, high value for troubleshooting.)
- Where does the schema live for IDE support (VSCode JSON schema association)? (Leaning: publish under `schemas/` in the npm package and surface the URL in the README.)
