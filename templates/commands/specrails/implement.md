# Implementation Pipeline

Full OpenSpec lifecycle with specialized agents: architect designs, developer implements, reviewer validates and archives. Handles 1 to N features — adapts automatically (sequential for 1, parallel with worktrees for N).

**MANDATORY: Always follow this pipeline exactly as written. NEVER skip, shortcut, or "optimize away" any phase — even if the task seems simple enough to do directly. The orchestrator MUST launch the architect, developer, and reviewer agents as specified. Do NOT implement changes yourself in the main conversation; delegate to the agents defined in each phase. No exceptions.**

**Input:** $ARGUMENTS — accepts three modes:

1. **Ticket numbers** (recommended): `#85, #71, #63` — implement these specific tickets from the local backlog (`local-tickets.json`). Skips exploration and selection.
2. **Text description** (single feature): `"add price history chart"` — implement a single feature from a description. Skips exploration and selection.
3. **Area names** (fallback): `Analytics, UI, Testing` — explores areas and picks the best items. Only use if no backlog tickets exist.

**IMPORTANT:** Before running, ensure Read/Write/Bash/Glob/Grep permissions are set to "allow" — background agents cannot request permissions interactively.

---

## Repository location (read first)

Your working directory may NOT be the user's source repository. **Repo-resident** things — the source code, `openspec/**`, `.git`, and the GitHub remote — live under **`${SPECRAILS_REPO_DIR:-.}`**. The spawner sets `SPECRAILS_REPO_DIR` to the repo path; **when it is unset it defaults to `.` (the current directory), making every command below byte-identical to a classic in-repo run.**

Rules used throughout this pipeline:
- **openspec reads/writes** → `${SPECRAILS_REPO_DIR:-.}/openspec/...`
- **git commands** → `git -C "${SPECRAILS_REPO_DIR:-.}" ...`
- **`gh` commands** (PR — they need the repo's remote) → run them from the repo: `(cd "${SPECRAILS_REPO_DIR:-.}" && gh ...)`
- **worktree merge-back** → the merge *target* side (the main working tree) is `${SPECRAILS_REPO_DIR:-.}/<file>`

**Run-state stays with the working directory** (NOT the repo): `.claude/pipeline-state/`, `.claude/agent-memory/`, `.claude/backlog-cache.json`, and the dry-run cache `.claude/.dry-run/` are all written relative to the current directory. **Profile/agent files** (`.claude/agents/sr-*.md`) are likewise resolved relative to the current directory — do NOT prefix them with `${SPECRAILS_REPO_DIR:-.}`.

---

## Phase -1: Environment Setup (cloud pre-flight)

**This phase runs BEFORE anything else.** Detect if we're in a cloud/remote environment and ensure all required tools are available.

### Detection

Check the environment variable `CLAUDE_CODE_ENTRYPOINT`. If it contains `remote_mobile` or `remote_web`, OR if `CLAUDE_CODE_REMOTE` is `true`, we're in a **cloud environment**.

### Checks to run (sequential, fail-fast)

#### 1. Backlog provider availability

```bash
[[ -f ".specrails/local-tickets.json" ]] && echo "Local tickets storage: OK" || echo "WARNING: local-tickets.json not found"
```
- Set `LOCAL_TICKETS_AVAILABLE=true/false` based on file existence.
- Set `GH_AVAILABLE=false` (backlog is always local).
- Set `BACKLOG_AVAILABLE=true` if local-tickets.json exists.

#### 2. OpenSpec CLI

```bash
which openspec && openspec --version
```

- If missing: try `npm install -g @fission-ai/openspec`
- If install fails: **STOP** — openspec is required.

#### 3. Project dependencies

{{DEPENDENCY_CHECK_COMMANDS}}

#### 4. Test runner

{{TEST_RUNNER_CHECK}}

#### 5. Agent discovery

`AVAILABLE_AGENTS` resolves through a single path: **a profile if one is active, otherwise the baseline trio**. There are no modes — the baseline is just the default value the resolution falls back to when no profile is present.

##### Resolve the profile path

A profile is active when either condition holds (highest precedence first):

1. `SPECRAILS_PROFILE_PATH` is set AND points to a readable file. Tools like `specrails-desktop` set this to a job-scoped snapshot.
2. `.specrails/profiles/project-default.json` exists and is readable.

```bash
if [[ -n "${SPECRAILS_PROFILE_PATH:-}" && -r "${SPECRAILS_PROFILE_PATH:-}" ]]; then
  PROFILE_PATH="$SPECRAILS_PROFILE_PATH"
elif [[ -r ".specrails/profiles/project-default.json" ]]; then
  PROFILE_PATH=".specrails/profiles/project-default.json"
else
  PROFILE_PATH=""
fi
```

##### No profile → baseline default

When `PROFILE_PATH` is empty, `AVAILABLE_AGENTS` is the baseline trio and there are no per-agent model overrides (each agent uses the `model:` in its own `.md` frontmatter). No profile file is written — the baseline is an in-memory default, honoring the reserved-paths contract (`.specrails/profiles/**` is never created by the pipeline):

```bash
if [[ -z "$PROFILE_PATH" ]]; then
  AVAILABLE_AGENTS="$(printf '%s\n' sr-architect sr-developer sr-reviewer)"
  PROFILE_NAME=""
fi
```

##### Profile present → load, validate, populate

`jq` is required to read a profile JSON:

```bash
command -v jq >/dev/null 2>&1 || { echo "[error] 'jq' is required to read a profile. Install with: brew install jq / apt install jq / https://stedolan.github.io/jq/"; exit 1; }
PROFILE="$(cat "$PROFILE_PATH")"
```

Validate the schema version. Only `schemaVersion: 1` is supported:

```bash
SCHEMA_VERSION="$(jq -r '.schemaVersion // empty' <<<"$PROFILE")"
case "$SCHEMA_VERSION" in
  1) ;;
  "") echo "[error] profile validation failed: missing required field 'schemaVersion'"; exit 1 ;;
  *) echo "[error] profile validation failed: unsupported schemaVersion '$SCHEMA_VERSION'. Supported: 1"; exit 1 ;;
esac
```

Validate required top-level fields. Every valid v1 profile MUST contain `name`, `orchestrator.model`, `agents` (non-empty array), and `routing` (non-empty array):

```bash
for field in name orchestrator agents routing; do
  jq -e ".$field" <<<"$PROFILE" >/dev/null 2>&1 || { echo "[error] profile validation failed: missing required field '$field'"; exit 1; }
done
jq -e '.orchestrator.model' <<<"$PROFILE" >/dev/null 2>&1 || { echo "[error] profile validation failed: missing required field 'orchestrator.model'"; exit 1; }
jq -e '.agents | length > 0' <<<"$PROFILE" >/dev/null 2>&1 || { echo "[error] profile validation failed: 'agents' must be a non-empty array"; exit 1; }
jq -e '.routing | length > 0' <<<"$PROFILE" >/dev/null 2>&1 || { echo "[error] profile validation failed: 'routing' must be a non-empty array"; exit 1; }
```

Validate baseline agents — `sr-architect`, `sr-developer`, and `sr-reviewer` MUST appear in `agents[]`:

```bash
for required in sr-architect sr-developer sr-reviewer; do
  jq -e --arg id "$required" '[.agents[].id] | index($id)' <<<"$PROFILE" >/dev/null 2>&1 \
    || { echo "[error] profile validation failed: required baseline agent '$required' missing from 'agents[]'"; exit 1; }
done
```

Validate routing terminal rule — exactly one entry SHALL have `default: true` and it MUST be the last element:

```bash
DEFAULT_COUNT="$(jq '[.routing[] | select(.default == true)] | length' <<<"$PROFILE")"
if [[ "$DEFAULT_COUNT" -ne 1 ]]; then
  echo "[error] profile validation failed: routing must contain exactly one entry with 'default: true' (found $DEFAULT_COUNT)"; exit 1
fi
IS_LAST="$(jq '(.routing | last | .default) == true' <<<"$PROFILE")"
if [[ "$IS_LAST" != "true" ]]; then
  echo "[error] profile validation failed: the 'default: true' routing rule must be the last element of 'routing'"; exit 1
fi
```

Populate `AVAILABLE_AGENTS` from the profile. The three baseline agents are **hard-required**: if a baseline agent's file is missing, STOP. A **non-baseline** agent whose file is missing is **warned and skipped** — this is how a pre-v5 profile that still references a removed agent (e.g. `sr-frontend-developer`) degrades gracefully:

```bash
AVAILABLE_AGENTS=""
for id in $(jq -r '.agents[].id' <<<"$PROFILE" | sort); do
  if [[ -f ".claude/agents/$id.md" ]]; then
    AVAILABLE_AGENTS="$AVAILABLE_AGENTS$id"$'\n'
  elif [[ "$id" == "sr-architect" || "$id" == "sr-developer" || "$id" == "sr-reviewer" ]]; then
    echo "[error] Core agent $id not found. Run npx specrails-core update to reinstall."; exit 1
  else
    echo "[warn] profile references agent '$id' but no agent file exists — skipping (removed in v5; use a custom-* agent)"
  fi
done
AVAILABLE_AGENTS="$(printf '%s' "$AVAILABLE_AGENTS" | sed '/^$/d')"
```

Also store per-agent model overrides and the orchestrator model for use in later phases:

```bash
# ORCHESTRATOR_MODEL is informational; the caller is responsible for spawning
# the orchestrator with this model (e.g. specrails-desktop reads this field directly).
ORCHESTRATOR_MODEL="$(jq -r '.orchestrator.model' <<<"$PROFILE")"

# Per-agent model overrides keyed by agent id.
# Consumed by subagent invocation sites in later phases.
declare -A AGENT_MODEL
while IFS=$'\t' read -r id model; do
  [[ -n "$model" && "$model" != "null" ]] && AGENT_MODEL[$id]="$model"
done < <(jq -r '.agents[] | [.id, (.model // "null")] | @tsv' <<<"$PROFILE")

# Routing rules (array), consumed by Phase 3b.
ROUTING="$(jq '.routing' <<<"$PROFILE")"

PROFILE_NAME="$(jq -r '.name' <<<"$PROFILE")"
```

##### Apply per-agent model overrides (only when a profile declares them)

Claude Code's Agent tool determines a subagent's model from the `model:` line in the agent's `.md` frontmatter at invocation time — there is no per-call model parameter. When a profile declares model overrides, rewrite each agent's frontmatter `model:` value in-place to match `AGENT_MODEL[$id]`.

This rewrite is safe because:
- Multi-feature runs execute in **isolated git worktrees** (`isolation: worktree`), so each rail mutates its own copy of `.claude/agents/` without cross-rail contention.
- Single-feature runs are sequential within a single checkout.
- The desktop app writes a job-scoped snapshot of the profile and spawns `claude` with `$SPECRAILS_PROFILE_PATH` pointing at it; the frontmatter rewrite follows the snapshot, never the catalog.

```bash
for id in "${!AGENT_MODEL[@]}"; do
  model="${AGENT_MODEL[$id]}"
  file=".claude/agents/$id.md"
  [[ -f "$file" ]] || continue
  # Rewrite the first `model:` line within the frontmatter block (lines between the
  # first two `---` separators). Use awk with portable syntax (macOS + Linux).
  awk -v new="$model" '
    BEGIN { in_fm=0; done=0 }
    /^---$/ { in_fm = !in_fm; print; next }
    in_fm && !done && /^model:[[:space:]]/ { print "model: " new; done=1; next }
    { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
done
```

If a profile does not declare `model` for a given agent (the field is optional), that agent's frontmatter is left untouched.

##### Agent roles

The pipeline ships exactly three first-party agents. Any additional agent comes from an active profile that declares a user-owned `custom-*` agent (with routing) — the installer never ships or manages non-core agents.

| Agent | Role | Required? | Phase(s) affected |
|-------|------|-----------|-------------------|
| sr-architect | Architecture & design | **Core** (always present) | 3a |
| sr-developer | Full-stack implementation | **Core** (always present) | 3b |
| sr-reviewer | Quality gate (correctness, tests, security, performance) | **Core** (always present) | 4b |
| custom-* | Profile-declared specialist | Optional — only when an active profile lists it | per profile routing |

**Gate rules** (applied throughout the pipeline):
- The three baseline agents are the source of truth for the non-profile default; a profile's `agents[]` (baseline + any `custom-*`) is the source of truth when a profile is active. Agents not in `AVAILABLE_AGENTS` are unavailable regardless of what is on disk.
- If a `custom-*` agent routed by the profile is not in `AVAILABLE_AGENTS` (e.g. skipped above), that routing target is dropped — the task falls through to the profile's `default: true` rule.
- If a core agent is missing, **STOP** and print: `[error] Core agent <name> not found. Run npx specrails-core update to reinstall.`

### Summary

Print a setup report:

```
## Environment Setup
| Tool | Status | Notes |
|------|--------|-------|
| Backlog provider | ok/missing | {{BACKLOG_PROVIDER_NAME}} |
| OpenSpec | ok | ... |
| Dependencies | ok | ... |
| Test runner | ok | ... |
| Agents | N available | baseline: 3/3, custom (profile): M |
```

**Pass `TEST_CMD`, `BACKLOG_AVAILABLE`, and `AVAILABLE_AGENTS` forward** — all later phases must use these.

---

## Phase 0: Parse input and determine mode

### Flag Detection

Before parsing input, scan `$ARGUMENTS` for control flags:

- If `--dry-run` or `--preview` is present in `$ARGUMENTS`:
  - Set `DRY_RUN=true`
  - Strip the flag from the arguments before further parsing
  - Print: `[dry-run] Preview mode active — no git, PR, or backlog operations will run.`
  - Set `CACHE_DIR=.claude/.dry-run/<kebab-case-feature-name>` (derive after parsing the remaining input)
  - Note: if a cache already exists at `CACHE_DIR`, print `[dry-run] Overwriting existing cache at CACHE_DIR` before overwriting.

- If `--apply <feature-name>` is present in `$ARGUMENTS`:
  - Set `APPLY_MODE=true`
  - Set `APPLY_TARGET=<feature-name>` (the argument immediately following `--apply`)
  - Set `CACHE_DIR=.claude/.dry-run/<feature-name>`
  - Verify `CACHE_DIR` exists. If it does not: print `[apply] Error: no cached dry-run found at CACHE_DIR` and stop.
  - Skip Phases 1–4b. Go directly to Phase 4c (the apply path handles the rest).
  - Strip `--apply` and the feature name before further parsing.

- If `--confidence-override "<reason>"` is present in `$ARGUMENTS`:
  - Set `CONFIDENCE_OVERRIDE_REASON=<reason>` (the quoted string immediately following `--confidence-override`)
  - Strip `--confidence-override` and the reason before further parsing.

If none of these flags is present: `DRY_RUN=false`, `APPLY_MODE=false`, `CONFIDENCE_OVERRIDE_REASON=""`. Pipeline runs as normal.

Note: `CACHE_DIR` for `--dry-run` is finalized after the feature name is derived from the remaining input. All subsequent phases that reference `CACHE_DIR` have access to it.

Initialize conflict-tracking variables:
- `SNAPSHOTS_CAPTURED=false` — set to true in Phase 0 if issue snapshots are successfully written.
- `CONFLICT_OVERRIDES=[]` — list of conflict records where the user chose to continue; appended by Phase 3a.0 and Phase 4c.0.

---

**If the user passed a text description** (e.g. `"add feature X"`):
- **Single-feature mode**. Derive a kebab-case change name.
- Set `SINGLE_MODE = true`. No worktrees, no parallelism.
- Go directly to Phase 3a.

**If the user passed ticket references** (e.g. `#85, #71` or `#1, #2`):
- Fetch each ticket from `.specrails/local-tickets.json` at `tickets["{id}"]`.
- Extract area, value, effort, and feature details from each ticket body.
- If only 1 ticket: set `SINGLE_MODE = true`.
- Go directly to the confirmation table.

#### Phase 0 snapshot capture

After fetching issue refs, capture a baseline snapshot for conflict detection.

##### If `BACKLOG_PROVIDER=local` and input mode was issue numbers:

For each resolved ticket ID, read `.specrails/local-tickets.json` and extract the ticket object at `tickets["{id}"]`.

Build a snapshot object for each ticket:
- `number`: ticket `id` (integer)
- `title`: ticket `title` string
- `state`: map ticket `status` — `"done"` or `"cancelled"` → `"closed"`, otherwise → `"open"`
- `assignees`: `[ticket.assignee]` if non-null, else `[]`
- `labels`: ticket `labels` array, sorted alphabetically
- `body_sha`: SHA-256 of the ticket `description` string — compute with:
  ```bash
  echo -n "{description}" | sha256sum | cut -d' ' -f1
  ```
  If `sha256sum` is not available, fall back to `openssl dgst -sha256 -r` or `shasum -a 256`.
- `updated_at`: ticket `updated_at` value
- `captured_at`: current local time in ISO 8601 format

Write the following JSON to `.claude/backlog-cache.json` (overwrite fully — this establishes a fresh baseline for this run):

```json
{
  "schema_version": "1",
  "provider": "local",
  "last_updated": "<ISO 8601 timestamp>",
  "written_by": "implement",
  "issues": {
    "<id>": { <snapshot object> },
    ...
  }
}
```

If the write succeeds: set `SNAPSHOTS_CAPTURED=true`.

If the write fails: print `[backlog-cache] Warning: could not write cache. Conflict detection disabled for this run.` and set `SNAPSHOTS_CAPTURED=false`. Do NOT abort the pipeline.

##### Otherwise (no backlog available or non-ticket input):

Set `SNAPSHOTS_CAPTURED=false`. Print: `[conflict-check] Snapshot skipped — backlog unavailable or non-issue input.`

#### Gitignore advisory

If `SNAPSHOTS_CAPTURED=true`, check whether `.gitignore` already covers the cache file:

```bash
grep -q "backlog-cache" .gitignore 2>/dev/null || \
grep -q "\.claude/" .gitignore 2>/dev/null
```

If neither pattern is found, print:

```
[backlog-cache] Suggestion: add '.claude/backlog-cache.json' to .gitignore to avoid committing ephemeral cache state.
```

This advisory is non-blocking and suppressed when `.gitignore` already covers the file.

#### Pipeline state initialization

Set `PIPELINE_STATE_PATH=.claude/pipeline-state/<feature-name>.json` (use the same kebab-case feature name derived above).

Create the directory if it does not exist:

```bash
mkdir -p .claude/pipeline-state
```

Write the initial state file:

```json
{
  "schema_version": "1",
  "feature": "<feature-name>",
  "started_at": "<current ISO 8601 timestamp>",
  "updated_at": "<current ISO 8601 timestamp>",
  "phases": {
    "architect": "pending",
    "developer": "pending",
    "reviewer": "pending",
    "ship": "pending",
    "ci": "pending"
  },
  "last_successful_phase": null,
  "failed_phase": null,
  "error_context": null,
  "openspec_artifacts": "openspec/changes/<feature-name>/",
  "implemented_files": [],
  "input": {
    "issues": [<issue numbers, or null for text-description mode>],
    "flags": {
      "dry_run": <DRY_RUN>,
      "apply_mode": <APPLY_MODE>,
      "single_mode": <SINGLE_MODE>
    }
  }
}
```

If the write fails: print `[pipeline-state] Warning: could not write state file. Smart retry (/specrails:retry) will not be available for this run.` Set `PIPELINE_STATE_AVAILABLE=false`. Do NOT abort the pipeline.

If the write succeeds: set `PIPELINE_STATE_AVAILABLE=true`.

**State update helper** — used by all subsequent phases to record progress:

When a phase completes or fails, update `PIPELINE_STATE_PATH`:
1. Read the current file.
2. Set `phases.<phase-key>` to `"done"`, `"failed"`, or `"skipped"`.
3. If `"done"`: set `last_successful_phase` to the phase key.
4. If `"failed"`: set `failed_phase` to the phase key; set `error_context` to a one-line description of the failure (agent name, error type, exit code if known).
5. Set `updated_at` to the current ISO 8601 timestamp.
6. Overwrite the file.

If `PIPELINE_STATE_AVAILABLE=false`: skip all state updates silently.

**If the user passed area names** (no concrete issue/spec):
- Check for open backlog issues. If found, filter and pick top 3.
- If none, STOP with: `[input] No backlog issue or spec resolved from the given area(s). Product exploration was removed in v5 — pass a backlog issue number or a feature description/spec.`

---

## Phase 1 & 2: (removed in v5)

Product exploration and idea selection were driven by `sr-product-manager`, which is not shipped in v5. The pipeline works from concrete inputs — backlog issues or a feature description/spec passed to the command — and proceeds directly from Phase 0 to Phase 3a. If you want product discovery, run it as a separate step and feed the resulting spec/issue into `/specrails:implement`.

## Phase 3a.0: Pre-architect conflict check

**Guard:** If `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`, print `[conflict-check] Skipped — SNAPSHOTS_CAPTURED=false (or dry-run mode).` and proceed directly to Phase 3a.

Otherwise, re-fetch each ticket in scope and diff against the Phase 0 snapshot:

For each ticket ID in `ISSUE_REFS`, read `.specrails/local-tickets.json` and extract the ticket at `tickets["{id}"]`. If the ticket does not exist (deleted): treat as a CRITICAL conflict — field `"state"`, was `<cached state>`, now `"deleted"`. Otherwise, reconstruct a current snapshot using the same mapping as the Phase 0 local snapshot (sort `assignees` and `labels`, compute `body_sha`).

**Short-circuit:** If `current.updatedAt == cached.updated_at`, mark the issue as clean and skip field comparison.

**Field comparison** (only when `updatedAt` differs):

| Field | Conflict if... | Severity |
|-------|----------------|----------|
| `state` | value differs (`open` → `closed`) | CRITICAL |
| `state` | value differs (`closed` → `open`) | WARNING |
| `title` | string differs | WARNING |
| `assignees` | sorted array differs | WARNING |
| `labels` | sorted array differs | INFO |
| `body_sha` | SHA differs | WARNING |

Collect all conflicts across all issues. If none: print `[conflict-check] All issues clean (Phase 3a.0). Proceeding.` and continue to Phase 3a.

**If conflicts exist**, print the following report and await user input:

```
## Backlog Conflict Detected

The following issues changed since Phase 0 snapshot (captured at <captured_at>):

| Issue | Field | Severity | Was | Now |
|-------|-------|----------|-----|-----|
| #N    | state | CRITICAL | open | closed |
| #N    | body  | WARNING  | <sha-prefix> | <sha-prefix> |

How would you like to proceed?
  [A] Abort — stop the pipeline and exit cleanly
  [C] Continue — proceed despite the conflicts (logged)

Enter A or C:
```

For `body_sha` rows in the table, display only the first 8 characters of each SHA as the "Was" and "Now" values.

**Input handling:**
- Accept `A`, `a` (abort) or `C`, `c` (continue).
- Re-prompt on any other input, up to 3 times total.
- After 3 invalid inputs: print `[conflict-abort] Defaulting to abort after 3 invalid inputs.` and abort.

**On abort:** Print `[conflict-abort] Pipeline aborted. Re-run /specrails:implement after resolving the issues.` and exit. No git state is left behind.

**On continue:** Print `[conflict-override] Continuing. N conflict(s) logged.` Append each conflict to `CONFLICT_OVERRIDES` as `{phase: "3a.0", issue: "#N", field: "<field>", severity: "<severity>", was: "<was>", now: "<now>"}`. Proceed to Phase 3a.

## Phase 3a: Architect (parallel, in main repo)

For each chosen idea, launch an **sr-architect** agent (`subagent_type: sr-architect`, `run_in_background: true`).

Each architect creates OpenSpec artifacts in `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/`.

Each agent's prompt should include:
- Description of the feature
- Context from exploration (if applicable)
- Instructions to create: proposal.md, design.md, delta-spec, tasks.md, context-bundle.md
- Tags for each task: {{LAYER_TAGS}}

### 3a.1 Identify shared file conflicts

**Only runs in multi-feature mode** (more than one feature). Skip entirely if `SINGLE_MODE=true`.

After all architect agents complete, before launching any developer agent:

#### Step 1: Extract file references

For each `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/tasks.md`, extract all paths listed under `**Files:**` entries (both `Create:` and `Modify:` lines). Normalize paths: strip leading `./`.

#### Step 2: Build the shared-file registry

Group file paths across all features. Any path appearing in two or more features' task lists is a **shared file**. Store as `SHARED_FILES` map: `{path: {features: [...], risk: ""}}`.

#### Step 3: Classify risk

For each shared file, classify risk based on file type and which regions each feature modifies (consult each feature's context-bundle.md "Exact Changes" section):

| Risk | Condition |
|------|-----------|
| `low` | Both features only append new named sections not present in the other feature's changes |
| `medium` | Both features modify structurally distinct regions (different `##` sections or different top-level YAML keys) |
| `high` | Both features modify the same region (same `##` section, same YAML key subtree, or any region in shell scripts) |

Shell scripts (`.sh`, `.bash`): always `high`.
Non-existent files that two features both create: always `high`.

#### Step 4: Derive MERGE_ORDER

Sort features so that for any pair sharing a `high`-risk file, one appears before the other. Use topological sort; break ties alphabetically. Set `MERGE_ORDER` = sorted feature list.

#### Step 5: Print pre-flight report

```
## Shared File Analysis

| File | Features | Risk |
|------|----------|------|
| <path> | <feature-a>, <feature-b> | <risk> |

Merge order: <feature-a> → <feature-b> → <feature-c>

High-risk files detected. These files will be merged sequentially.
Developers will still run in parallel — merge order applies at Phase 4a only.
```

If no shared files: print `No shared files detected. All features modify independent files.`

### 3a.2 Pre-validate architect output

Quick-check each architect's artifacts:
1. tasks.md exists and has tasks
2. context-bundle.md exists
3. File references are real (>70% must exist)
4. Layer tags present on tasks

**Pipeline state:** update `architect` → `done`. If any architect agent failed (skipped area): update `architect` → `failed` with error context `"sr-architect failed for: <area-names>"`.

## Phase 3b: Implement

### Pre-flight: Verify Bash permission

Before launching any developer agent, run a trivial Bash command to confirm Bash is allowed.

### Launch developers

**Read reviewer learnings:** Check `.claude/agent-memory/sr-reviewer/common-fixes.md` and include in developer prompts.

#### Dry-Run: Redirect developer writes

**If `DRY_RUN=true`**, include the following in every developer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified files under:
>   .claude/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. For example:
>   Real path:   src/utils/parser.ts
>   Write to:    .claude/.dry-run/\<feature-name\>/src/utils/parser.ts
>
> Do NOT write to real file paths. After writing each file, append an entry
> to .claude/.dry-run/\<feature-name\>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

**If `DRY_RUN=false`**: developer agent instructions are unchanged.

#### Choosing the right developer agent

For each feature, read `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/tasks.md` and classify every task by its layer tags and file references.

**Step 1 — Classify tasks into layers:**

For each task, determine its layer from:
1. **Explicit layer tags** in tasks.md (e.g., `[frontend]`, `[backend]`, `[core]`, `[infra]`, `[docs]`, etc.)
2. **File references** under `**Files:**` entries — apply the same extension/path rules used in Phase 4b:
   - Frontend: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`, or paths under `components/`, `pages/`, `views/`, `ui/`, `client/`, `frontend/`, `app/`, `public/`, `static/`, `assets/`
   - Backend: `.py`, `.go`, `.java`, `.rb`, `.php`, `.rs`, `.cs`, `.sql`, or paths under `server/`, `api/`, `routes/`, `controllers/`, `services/`, `models/`, `db/`, `backend/`, `migrations/`
   - Mixed/other: everything else (shell scripts, config files, markdown, YAML, etc.)

Produce three sets: `FRONTEND_TASKS`, `BACKEND_TASKS`, `OTHER_TASKS`.

**Step 2 — Route tasks to developer agents:**

Routing has a single path. When **no profile** is active, every task goes to `sr-developer` — `DEVELOPER_ROUTING = { sr-developer: <all tasks> }`. When a **profile** is active, apply its `ROUTING` rules (below), which may direct some tasks to profile-declared `custom-*` agents.

##### Profile routing

Apply `ROUTING` rules in their array order. For each task, collect its tag set (the layer tags from Step 1 plus any explicit `[tag]` markers in tasks.md). The first rule whose `tags` array intersects the task's tag set wins. The terminal `default: true` rule catches tasks matched by no earlier rule.

Example (pseudocode):

```bash
assigned_agent_for_task() {
  local -a task_tags=("$@")
  local rule_count
  rule_count=$(jq 'length' <<<"$ROUTING")
  local i=0
  while [[ $i -lt $rule_count ]]; do
    local is_default rule_tags agent
    is_default=$(jq -r ".[$i].default // false" <<<"$ROUTING")
    agent=$(jq -r ".[$i].agent" <<<"$ROUTING")
    if [[ "$is_default" == "true" ]]; then
      echo "$agent"
      return
    fi
    rule_tags=$(jq -r ".[$i].tags[]" <<<"$ROUTING")
    for rtag in $rule_tags; do
      for ttag in "${task_tags[@]}"; do
        if [[ "$rtag" == "$ttag" ]]; then
          echo "$agent"
          return
        fi
      done
    done
    i=$((i + 1))
  done
}
```

Produce `DEVELOPER_ROUTING` from the per-task decisions, grouping by assigned agent. If a rule routes a task to an agent that is **not** in `AVAILABLE_AGENTS` (e.g. a `custom-*` agent that was warned-and-skipped in Phase -1 because its file is missing), that routing target is dropped and the task falls through to the terminal `default: true` rule (which resolves to a baseline agent). Do not STOP for a missing non-baseline target — graceful degradation is intentional.

##### Routing trace

After computing `DEVELOPER_ROUTING`, optionally emit a trace line to aid debugging:

```
[phase-3b] routing decision: profile=${PROFILE_NAME:-none} agents=[list]
```

**Step 3 — Print routing decision:**

```
## Developer Routing

| Agent | Tasks | Reason |
|-------|-------|--------|
| sr-developer     | Task 1, Task 2 | Default (no profile / default rule) |
| custom-api-dev   | Task 3         | Profile routed [backend] tasks here |
```

Also store `DEVELOPER_AGENTS_USED` (the set of developer agent IDs actually launched) — reported in the Phase 4e summary.

#### Launch modes

For each entry in `DEVELOPER_ROUTING`, launch the assigned developer agent using its `subagent_type` (`sr-developer` or a profile-declared `custom-*` developer) with its task subset.

**If `SINGLE_MODE` and only one agent in routing**: Launch in the main repo, foreground.
**If `SINGLE_MODE` but multiple agents in routing**: Launch agents sequentially in the main repo (one at a time, foreground), passing only their assigned tasks.
**If multiple features**: Launch in isolated worktrees (`isolation: worktree`, `run_in_background: true`).

Wait for all developers to complete.

**Summary timing (multi-feature mode):** When running multiple background developer agents, individual `task_notification` completions MUST NOT trigger a final Phase 3b summary. As each agent completes, emit only a brief one-line acknowledgment:
```
[phase-3b] Developer for <feature> ✓ (<N> tool uses, <duration>)
```
Only after the LAST background agent sends its completion notification, emit the consolidated summary:
```
## Phase 3b Complete

| Feature | Agent | Tool uses | Duration |
|---------|-------|-----------|----------|
| <feature-a> | sr-developer | 64 | 8m 02s |
| <feature-b> | sr-developer | 50 | 7m 35s |

All N developers complete. Proceeding to Phase 4.
```

This prevents stale "still waiting" text from appearing as the terminal result when the job completes.

**Pipeline state:** update `developer` → `done`. Also update `implemented_files` in the state file with the complete list of files created or modified by the developer agent(s). If developer failed: update `developer` → `failed` with error context `"<agent-id> failed: <exit code or error description>"`.

> **Note (v5):** dedicated test-writing (`sr-test-writer`) and doc-sync (`sr-doc-sync`) phases were removed. Tests and documentation are part of each OpenSpec task and are produced by `sr-developer`; the reviewer's TDD and spec-completeness checklist enforces them. A profile may reintroduce equivalent stages via `custom-*` agents with routing.

## Phase 4: Merge & Review

**This phase is fully autonomous.**

### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used). Proceed to Phase 4b.
- If `DRY_RUN=true`: apply the merge algorithm below, writing all outputs to `CACHE_DIR/<file-path>` instead of the main repo working tree. Do NOT clean up worktrees in dry-run mode.
- Otherwise: apply the merge algorithm below, writing outputs to the main repo working tree. Clean up worktrees at the end.

#### Merge Algorithm

The merge **target** (the main repo working tree where merged files land) is `<target>` = **`${SPECRAILS_REPO_DIR:-.}`**. Every `<target>/<file>` below therefore resolves to `${SPECRAILS_REPO_DIR:-.}/<file>` so merged code lands in the real repo, not the working directory. (`<worktree-path>` is an absolute git-worktree path supplied by the runtime; `git -C <worktree-path>` already targets it directly.)

Process features in `MERGE_ORDER` sequence. For each feature:

**Step 1: Identify changed files**

```bash
git -C <worktree-path> diff main --name-only
```

Split into `exclusive_files` (only this feature modifies them) and `shared_files_for_this_feature` (also modified by another feature in MERGE_ORDER).

**Step 2: Merge exclusive files**

Copy directly from worktree to target:
```bash
cp <worktree-path>/<file> "${SPECRAILS_REPO_DIR:-.}"/<file>
```
Log: `Copied (exclusive): <file>`

**Step 3: Merge shared files**

For each shared file, choose strategy by file type:

**Strategy A — Markdown section-aware merge** (`.md` files):
1. Read base: current content of `${SPECRAILS_REPO_DIR:-.}/<file>` (the merge target).
2. Read incoming: `<worktree-path>/<file>`.
3. Parse both into sections using `##` heading boundaries (heading line + all content until next `##` or EOF).
4. Build section maps: `{heading_text: content}` for base and incoming.
5. Merge:
   - Section in base only: keep.
   - Section in incoming only: append to merged output.
   - Section in both, content identical: keep base.
   - Section in both, content differs: insert conflict markers:
     ```
     <<<<<<< <feature-name>
     <incoming section content>
     =======
     <base section content>
     >>>>>>> base
     ```
     Log: `CONFLICT: <file> — section "<heading>" requires manual resolution.`
6. Write merged result to `${SPECRAILS_REPO_DIR:-.}/<file>` (the merge target).

**Strategy B — Unified diff sequential apply** (all other file types):
1. Generate incoming diff against original `main`:
   ```bash
   git -C <worktree-path> diff main -- <file>
   ```
2. Apply to current target:
   ```bash
   patch --forward --fuzz=3 "${SPECRAILS_REPO_DIR:-.}"/<file> < <diff>
   ```
3. If `patch` succeeds: log `Merged (diff-apply): <file>`.
4. If `patch` fails: insert conflict markers around rejected hunks. Log: `CONFLICT: <file> — N hunks rejected.`

If `patch` is not available (detected in Phase -1): use Strategy A for all file types and print: `[warn] patch not available — using section-aware fallback for all shared files.`

**Step 4: Record outcomes**

Maintain `MERGE_REPORT`:
- `cleanly_merged`: exclusive files + shared files with no conflicts
- `auto_resolved`: shared files merged without conflict markers
- `requires_resolution`: `{file, feature, regions}` for files with conflict markers

**Step 5: Emit initial merge report**

After all features are processed, print the preliminary report:

```
## Phase 4a Merge Report (preliminary)

### Cleanly Merged
- <file> (exclusive to <feature>)

### Auto-Resolved
- <file> (features: <a>, <b> — distinct sections)

### Requires Resolution (N file(s))
- <file> (features: <a>, <b> — conflicting section: "<heading>")
```

**Step 5a: Conflict handling** (orchestrator-owned; skip if `SINGLE_MODE=true` or `DRY_RUN=true`)

There is no dedicated resolver agent. The built-in section-aware / `patch --forward` merge above IS the only resolution path. If `MERGE_REPORT.requires_resolution` is non-empty after the merge, the orchestrator does not guess:

- Leave the conflict markers in place in the affected files.
- **Halt the affected features** — do not proceed to Phase 4c (git/PR) for any feature whose files still carry conflict markers. Independent features with no unresolved conflicts continue normally.
- Print: `[merge] N file(s) have unresolved conflict markers — halting the affected feature(s). Resolve manually, then re-run.`

Files in `requires_resolution` MUST appear in the Phase 4e final report so the user sees exactly what to fix.

**Step 5b: Emit final merge report**

```
## Phase 4a Merge Report

### Cleanly Merged
- <file> (exclusive to <feature>)

### Auto-Resolved
- <file> (features: <a>, <b> — distinct sections)
- <file> (smart-resolver: additive-concat, confidence 92)

### Requires Manual Resolution
- <file> (features: <a>, <b> — low-confidence: see merge-resolution-report.md)
  Search for `<<<<<<< <feature-name>` to locate conflict markers.

Pipeline will continue. Fix remaining conflicts before the reviewer runs CI.
Resolution report: openspec/changes/<feature>/merge-resolution-report.md
```

If `MERGE_REPORT.requires_resolution` is now empty: print `All conflicts resolved.` and omit the "Requires Manual Resolution" section.

**Step 6: Clean up worktrees** (skip if `DRY_RUN=true`)

```bash
git worktree remove <worktree-path> --force
```

Pass `MERGE_REPORT` to the Phase 4b reviewer agent prompt, listing any files in `requires_resolution`.

### 4b. Review

There is a single reviewer, `sr-reviewer`. It owns every review dimension — correctness, TDD/spec completeness, code quality, **security**, and **performance** — scaled to what the change actually touches (its checklist covers all of them). There are no separate layer-reviewer passes.

Construct the reviewer's invocation prompt with:
- `MODIFIED_FILES_LIST`: the complete list of all files created or modified during this run
- `PIPELINE_CONTEXT`: a brief description of what was implemented
- `MERGE_REPORT`: any files still in `requires_resolution` (multi-feature runs)
- The security-exemptions config path: `.claude/security-exemptions.yaml` (if present)
- Full CI commands
- Cross-feature merge issue checks
- Instruction to record learnings to `common-fixes.md`
- Instruction to archive completed changes via OpenSpec

The reviewer emits `SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN`. Set `SECURITY_BLOCKED=true` if `BLOCKED`, otherwise `false`.

**The security gate (blocking ship on `SECURITY_STATUS: BLOCKED`) is enforced in Phase 4c.** Do not apply it here.

Launch the **sr-reviewer** agent (`subagent_type: sr-reviewer`, foreground, `run_in_background: false`). Wait for it to complete.

**Pipeline state:** update `reviewer` → `done` (or `failed` with error context `"sr-reviewer timed out or did not complete"` if the agent errored out).

**If `DRY_RUN=true`**, add the following to the reviewer agent prompt:

> Note: This is a dry-run review. Developer files are under .claude/.dry-run/\<feature-name\>/.
> Read modified files from there. Write any reviewer fixes back to CACHE_DIR (not real paths).
> CI commands may be run — they read the real repo, but be aware developer changes are not
> yet applied to real paths.

### 4b-conf. Confidence Gate

After the generalist reviewer agent completes, evaluate the confidence score before proceeding to Phase 4c.

**In multi-feature mode (worktrees):** run this gate once per feature immediately after that feature's reviewer completes. Each feature is evaluated independently — a block on one feature does not prevent another feature's gate from running.

#### Step 1 — Read score file

Path: `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<name>/confidence-score.json`

- If the file does not exist:
  - Set `CONFIDENCE_STATUS=MISSING`
  - Print: `[confidence] Warning: confidence-score.json not found. Proceeding without gate.`
  - Continue to Phase 4c.

#### Step 2 — Read config

Path: `.claude/confidence-config.json`

- If the file does not exist:
  - Use built-in defaults (overall: 70; type_correctness: 60; pattern_adherence: 60; test_coverage: 60; security: 75; architectural_alignment: 60).
  - Print:
    ```
    [confidence] No confidence-config.json found. Using built-in defaults.
    [confidence] To customize thresholds, create .claude/confidence-config.json.
    ```
- If `enabled: false` in the config:
  - Print: `[confidence] Gate disabled. Skipping.`
  - Set `CONFIDENCE_STATUS=DISABLED`
  - Continue to Phase 4c.

#### Step 3 — Compare scores

- Check `overall` against `thresholds.overall`.
- Check each of the five aspects against `thresholds.aspects.<aspect>`.
- Collect all breaches as a list: `{aspect, actual_score, threshold, delta}`.

#### Step 4 — Apply on_breach

**If no breaches:**
- Print: `[confidence] All scores meet thresholds. Proceeding.`
- Set `CONFIDENCE_STATUS=PASS`
- Continue to Phase 4c.

**If breaches exist and `on_breach: "block"`:**

1. Check for `--confidence-override`:
   - If `CONFIDENCE_OVERRIDE_REASON` is non-empty and `override_allowed: true` in the config:
     - Print: `[confidence] Override accepted. Reason: <CONFIDENCE_OVERRIDE_REASON>. Proceeding with gate bypassed.`
     - Set `CONFIDENCE_STATUS=OVERRIDE`
     - Continue to Phase 4c.
   - If `CONFIDENCE_OVERRIDE_REASON` is non-empty but `override_allowed: false` in the config:
     - Print: `[confidence] Override is disabled in confidence-config.json.`
     - (Fall through to block below.)
   - If `CONFIDENCE_OVERRIDE_REASON` is empty or override was rejected:
     - Print the Breach Report (see format below).
     - Set `CONFIDENCE_BLOCKED=true`
     - Set `CONFIDENCE_STATUS=BLOCKED`
     - **Halt: do not proceed to Phase 4c.**

**If breaches exist and `on_breach: "warn"`:**
- Print the Breach Report.
- Set `CONFIDENCE_STATUS=WARN`
- Continue to Phase 4c.

#### Breach Report Format

```
## Confidence Gate: BLOCKED

The reviewer's confidence scores do not meet configured thresholds.

| Aspect | Score | Threshold | Delta |
|--------|-------|-----------|-------|
| <aspect> | <actual> | <threshold> | <delta (negative)> |

### Reviewer Notes on Low-Scoring Aspects

**<aspect> (<score>):** <note from confidence-score.json>

### Flags

- <flag-1>
- <flag-2>
(omit this section if flags array is empty)

### Next Steps

1. Address the concerns above and re-run `/specrails:implement`.
2. Or, if you have reviewed the concerns and accept the risk, re-run with an override:
   `/specrails:implement #N --confidence-override "reason"`

Pipeline halted. No git operations have been performed.
```

#### Dry-Run Behavior

When `DRY_RUN=true`, the reviewer still writes `confidence-score.json` (it is an OpenSpec artifact, not a git artifact). Phase 4b-conf still evaluates the score. If `CONFIDENCE_BLOCKED=true`, add to `.cache-manifest.json` under `skipped_operations`:
```
"confidence-gate: blocked — Phase 4c skipped"
```

### Phase 4c.0: Pre-ship conflict check

**Guard:** If `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`, print `[conflict-check] Skipped — SNAPSHOTS_CAPTURED=false (or dry-run mode).` and proceed directly to Phase 4c.

This check is independent of Phase 3a.0. Even if the user chose to continue through a conflict at Phase 3a.0, this gate re-checks all in-scope issues against the Phase 0 snapshot. It is the final gate before any code reaches git.

Re-fetch each ticket in `ISSUE_REFS` and diff against `.claude/backlog-cache.json` using the same algorithm as Phase 3a.0:

Read `.specrails/local-tickets.json` and extract each ticket by ID.

If the cache file is missing or malformed JSON at this point: log `[conflict-check] Warning: cache file missing or unreadable. Skipping diff for this run.` and proceed to Phase 4c (treat as clean).

Apply the same short-circuit (`updatedAt` match → clean), field comparison, and severity classification as Phase 3a.0.

If all issues are clean: print `[conflict-check] All issues clean (Phase 4c.0). Proceeding.` and continue.

If conflicts exist: print the same conflict report format as Phase 3a.0 (with `Phase 4c.0` context) and await `A`/`C` input (same re-prompt and default-abort logic).

**On abort:** Print `[conflict-abort] Pipeline aborted. Re-run /specrails:implement after resolving the issues.` and exit. No git operations have been performed at this point.

**On continue:** Print `[conflict-override] Continuing. N conflict(s) logged.` Append each conflict to `CONFLICT_OVERRIDES` as `{phase: "4c.0", issue: "#N", field: "<field>", severity: "<severity>", was: "<was>", now: "<now>"}`. Proceed to Phase 4c.

### 4c. Ship — Git & backlog updates

**Security gate:** If `SECURITY_BLOCKED=true`:
1. Print all Critical findings from the security-reviewer output
2. Do NOT create a branch, commit, push, or PR
3. Print: "Pipeline blocked by security findings. Fix the Critical issues listed above and re-run /specrails:implement."
4. Skip to Phase 4e.

### Dry-Run Gate

**If `DRY_RUN=true`:**
Print: `[dry-run] Skipping all git and backlog operations.`
Record skipped operations to `.cache-manifest.json` under `skipped_operations`:
- `"git: branch creation (feat/<name>)"`
- `"git: commit"`
- `"git: push"`
- `"github: pr creation"` (if `GH_AVAILABLE=true`)
- If `BACKLOG_PROVIDER=local` and `BACKLOG_WRITE=true`:
  - `"local: ticket comment #{id}"` for each ticket in scope
  - `"local: ticket status update #{id}"` for each fully resolved ticket

Then skip the rest of Phase 4c and proceed directly to Phase 4e.

**If `APPLY_MODE=true`:**
1. Read `.cache-manifest.json` from `CACHE_DIR`.
2. For each entry in `files`: copy `cached_path` to `real_path`, creating directories as needed.
3. Print: `[apply] Copied N files from .claude/.dry-run/<feature-name>/ to real locations.`
4. Then proceed with Phase 4c normally (GIT_AUTO logic, backlog updates) using the real files.
5. On successful completion of Phase 4c: delete `CACHE_DIR` and print `[apply] Cache cleaned up.`
   If Phase 4c fails: preserve `CACHE_DIR` for re-run.

**Otherwise:** proceed as normal.

---

This phase respects the `GIT_AUTO` and `BACKLOG_WRITE` settings from configuration.

**Environment override (host owns version control).** Before applying the `GIT_AUTO` logic below, check the `SPECRAILS_GIT_AUTO` environment variable. If it is set to `false` or `0`, treat `GIT_AUTO` as `false` for the rest of this phase (and Phase 4d) **regardless of configuration** — do not create a branch, commit, push, or open a PR; follow the `GIT_AUTO=false` (manual shipping) path instead. A host such as [specrails-desktop](https://github.com/fjpulidop/specrails-desktop) sets this when it owns version control (it runs the pipeline in an isolated worktree and opens the pull request itself), so honouring it prevents a second, uncoordinated PR. When `SPECRAILS_GIT_AUTO` is unset or any other value, resolve `GIT_AUTO` from configuration as normal.

#### If `GIT_AUTO=true` (automatic shipping)

All git operations run against the repo via `git -C "${SPECRAILS_REPO_DIR:-.}"`, and `gh` runs from inside the repo so it can detect the remote.

1. Create branch from `main`: `git -C "${SPECRAILS_REPO_DIR:-.}" checkout -b feat/<descriptive-name>`
2. One commit per feature with descriptive messages (`git -C "${SPECRAILS_REPO_DIR:-.}" add … && git -C "${SPECRAILS_REPO_DIR:-.}" commit -m …`)
3. If the reviewer modified files, create an additional commit: `git -C "${SPECRAILS_REPO_DIR:-.}" commit -m "fix: resolve CI issues (reviewer)"`
4. Push with `-u` flag: `git -C "${SPECRAILS_REPO_DIR:-.}" push -u origin <branch-name>`
5. Create PR (if GitHub CLI is available), running it from the repo:
   ```bash
   (cd "${SPECRAILS_REPO_DIR:-.}" && {{PR_CREATE_CMD}})
   ```
   If `gh` is not authenticated, print a compare URL for manual PR creation.

#### If `GIT_AUTO=false` (manual shipping)

Do NOT create branches, commits, or push. Instead display a summary:

```
## Changes Ready for Review

All implementation is complete and CI checks pass.

### Files Changed
- [list all modified/created files per feature]

### Suggested Next Steps
1. Review the changes: `git -C "${SPECRAILS_REPO_DIR:-.}" diff`
2. Create a branch: `git -C "${SPECRAILS_REPO_DIR:-.}" checkout -b feat/<name>`
3. Stage and commit: `git -C "${SPECRAILS_REPO_DIR:-.}" add <files> && git -C "${SPECRAILS_REPO_DIR:-.}" commit -m "feat: ..."`
4. Push and create PR manually
```

#### Backlog updates (both modes)

**If `BACKLOG_WRITE=true`:**
- For fully resolved issues/tickets: add a comment noting completion and reference the PR:
  ```bash
  {{BACKLOG_COMMENT_CMD}}
  ```
  - Update the ticket status to `"done"` using `{{BACKLOG_UPDATE_CMD}}` and add a comment: `"Implemented in PR #XX. All acceptance criteria met."` via `{{BACKLOG_COMMENT_CMD}}`. Tickets are closed directly in `local-tickets.json`.
- For partially resolved issues/tickets: add a comment noting progress:
  ```bash
  {{BACKLOG_PARTIAL_COMMENT_CMD}}
  ```
  - Additionally update the ticket status to `"in_progress"` via `{{BACKLOG_UPDATE_CMD}}` if it is still `"todo"`.

**If `BACKLOG_WRITE=false`:**
- Do NOT create, modify, or comment on any issues/tickets.
- Instead, display what the user should update manually:
  ```
  ## Backlog Updates (manual)

  The following tickets should be updated:
  | Ticket | Status | Suggested Action |
  |--------|--------|-----------------|
  | #85 | Fully implemented | Mark as Done in local-tickets.json |
  | #71 | Partial progress | Update to "in_progress": "X completed, Y remaining" |
  ```

**Pipeline state:** update `ship` → `done` if git operations and PR creation succeeded, or `failed` with error context describing which step failed (e.g. `"git push failed: <exit code>"`, `"gh pr create failed"`, `"security gate blocked ship"`). If `DRY_RUN=true`: update `ship` → `skipped`.

### 4d. Monitor CI

**Only if `GIT_AUTO=true` and code was pushed.**

Check CI status after pushing. Fix failures (up to 2 retries).

**Pipeline state:** update `ci` → `done` if CI passed, or `failed` with error context `"CI failed after 2 retries: <summary>"`. If CI was not run (`GIT_AUTO=false` or dry-run): update `ci` → `skipped`.

If `GIT_AUTO=false`: skip — the user will push and monitor CI themselves.

### 4e. Report

**If `DRY_RUN=true`**, show this report instead of the standard pipeline table:

---

## Dry-Run Preview Report

### Artifacts Generated

| Type | Location |
|------|----------|
| OpenSpec proposal | openspec/changes/\<name\>/proposal.md |
| OpenSpec design | openspec/changes/\<name\>/design.md |
| OpenSpec tasks | openspec/changes/\<name\>/tasks.md |
| OpenSpec context-bundle | openspec/changes/\<name\>/context-bundle.md |
| Developer files | .claude/.dry-run/\<name\>/ (N files) |

### What Would Change

[For each file in `.cache-manifest.json` `files` array:]
- `<real_path>` — [new file / modified] ([approximate line delta if available])

### Confidence

| | |
|-|--|
| Score file | `openspec/changes/<name>/confidence-score.json` |
| Gate result | `<CONFIDENCE_STATUS>` (PASS / WARN / BLOCKED / OVERRIDE / MISSING / DISABLED) |
| Overall score | `<overall score from confidence-score.json, or N/A if MISSING/DISABLED>` |

### Operations Skipped

[List items from `.cache-manifest.json` `skipped_operations` array]

### Next Steps

To apply these changes and ship:
```
/specrails:implement --apply <feature-name>
```

To discard this dry run:
```
rm -rf .claude/.dry-run/<feature-name>/
```

---

**Otherwise**, show the standard pipeline table:

```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Frontend | Backend | Confidence | Security | CI | Conflicts | Status |
|------|---------|-------------|-----------|-----------|-------|------|----------|----------|---------|------------|----------|----|-----------|--------|
```

Confidence column values:

| Value | Meaning |
|-------|---------|
| `PASS (82)` | All scores met thresholds; overall score shown in parens |
| `WARN (62)` | Scores below threshold but `on_breach=warn`; overall score in parens |
| `BLOCKED (62)` | Gate blocked the pipeline; overall score in parens |
| `OVERRIDE (62)` | Gate bypassed by `--confidence-override`; overall score in parens |
| `MISSING` | `confidence-score.json` not found after reviewer completed |
| `DISABLED` | Gate disabled via `enabled: false` in config |

If `CONFIDENCE_OVERRIDE_REASON` is non-empty, append a `### Confidence Override` section below the table:

```
### Confidence Override

**Reason:** <CONFIDENCE_OVERRIDE_REASON>
```

Column values:
- **Frontend**: `CLEAN`, `ISSUES`, or `SKIPPED` (no frontend files in changeset)
- **Backend**: `CLEAN`, `ISSUES`, or `SKIPPED` (no backend files in changeset)
- **Security**: `CLEAN`, `WARNINGS`, `BLOCKED`, or `SKIPPED`

The `Conflicts` column values:
- `skipped` — `SNAPSHOTS_CAPTURED=false` (non-issue input or GH unavailable)
- `clean` — both conflict checks ran and found no changes
- `overridden (N)` — user chose Continue at one or both gates; N is the total number of conflict records in `CONFLICT_OVERRIDES`

If `MERGE_REPORT.requires_resolution` is non-empty, print an additional section:

```
### Merge Conflicts Requiring Resolution

| File | Features | Conflicting Region | Resolver Status |
|------|----------|--------------------|-----------------|
| <file> | <feature-a>, <feature-b> | <section heading or hunk description> | LOW_CONFIDENCE / SKIPPED |

Fix these conflicts (search for `<<<<<<<` in each file), then commit the resolved files.
To retry smart resolution after addressing context: `/specrails:merge-resolve --files <file>`
```

If `CONFLICT_OVERRIDES` is non-empty, print:

```
## Conflict Overrides

The following backlog conflicts were detected but overridden by the user:

| Phase | Issue | Field | Severity | Was | Now |
|-------|-------|-------|----------|-----|-----|
| 3a.0  | #42   | state | CRITICAL | open | closed |
```

If `CONFLICT_OVERRIDES` is empty or `SNAPSHOTS_CAPTURED=false`: omit the `## Conflict Overrides` section entirely. Do not print an empty table or a "No conflict overrides" line.

Include the shipping mode in the report:
- If automatic: show PR URL, CI status, backlog updates made
- If manual: show summary of changes, suggested git commands, backlog updates pending

---

## Error Handling

- If a sr-architect fails: skip that area, report the failure
- If a sr-developer fails: report which phase it failed at
- If the sr-reviewer finds unfixable issues: report them, push what works
- If Phase 4c (ship) fails: report the failure
- Never block the entire pipeline on a single agent failure. Always produce a final report.
