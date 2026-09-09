# Implementation Pipeline

Implement one feature or a batch as one frozen candidate: architect designs, developer implements, reviewer validates, then the coordinator authorizes archive and delivery. Reuse completed phases only when the executable journal confirms current evidence.

**Input:** $ARGUMENTS: ticket references (`#85, #71`), a feature description, area names to explore before selecting scope, `--dry-run`/`--preview`, or `--apply <change>`.

## Execution scope and ownership (read first)

Use the installed runtime `node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}"`, never an assumed global/downloaded substitute. `SPECRAILS_EXECUTION_CONTEXT` identifies the authoritative schemaVersion 1 context: runId, frozen specs[] with acceptance criteria, backlogRoot/backlogPath, artifactRoot/artifactRepositoryId, selected repositories[] and ownership. Do not refetch tickets to replace this scope.

The working directory may be a framework workspace. Set `SPECRAILS_REPO_DIR` to artifactRoot for `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<change>/`. Source edits and tests use the explicit selected repository ID/path; secondary tasks never default to the artifact root. Backlog belongs to backlogPath, independently of source roots.

Inspect ownership **before any mutation**:
- Host-owned worktrees: use supplied roots; no nested allocation, merge, deletion or reconstruction.
- Host-owned git: no staging, commits, pushes, PRs or shipping CI; return the candidate for host delivery.
- Host-owned backlog: no closing tickets/status writes; host acceptance owns completion.
- Core ownership permits only operations authorized by the user/settings. Preview or false GIT_AUTO disables shipping regardless. Never change permissions or forge context to bypass ownership.

Give every worker the absolute runtime/context paths, exact change, selected roots and frozen task group. Include env in each invocation; exports do not persist across tools. Workers stay foreground and must return terminal results. A background task start, summary or empty final message is not completion evidence.

### Standalone admission

Without host context, choose one stable aggregate change and freeze requested tickets once:

```bash
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" init --change <change> --tickets "85,71"
```

Optional `--backlog-path <absolute-file>` selects a file under the workspace. Freeform/selected proposals use `--scope-request <absolute-file>` containing `{"specs":[{"id":"feature","title":"...","description":"...","acceptanceCriteria":["..."]}],"ownership":{"git":"host","backlog":"host","worktrees":"host"}}`. Populate real user requirements; never invent a ticket or discard scope. Complete multi-repository standalone scope uses `--context <absolute-file>`.

Default fallback ownership is review-only. An explicitly authorized Core ownership request may accompany --tickets without a specs field. After init, run status and pass the returned absolute stateDir/context.json to every child/retry as SPECRAILS_EXECUTION_CONTEXT. Same-change init preserves progress and original scope; another change creates a new run. Never select the most recently modified artifact directory or use old ad-hoc state as authority.

## Phase 0: Preflight

1. Read supplied context or perform standalone admission. Resolve --apply to its existing journal; never silently initialize a missing preview.
2. Confirm Node, Git, managed runtime, official OpenSpec commands/skills and project dependencies. Missing required tooling stops with a concrete repair command. Do not emulate missing skills or silently install an unpinned global.
3. Inspect dependencies and CI commands once per selected repo; relevant package/config changes invalidate assumptions.
4. Resolve the profile below and honor host model/effort/custom roles.
5. Read `status --json`: a completed valid phase requires no new model call; blocked/failed phases are resumable and dependents remain pending.

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


##### Invocation configuration

Forward resolved models through supported per-invocation configuration; never rewrite shared agent frontmatter or profiles. If an override cannot be honored, report that limitation, not a false model claim. The caller selects the orchestrator model before launch.

Route task groups by the first matching rule and final default. Missing optional targets fall through to default. Custom roles assist a canonical phase; they never bypass its acceptance gate. The baseline trio is required.

## Durable phases and verification

Use `architect → developer → reviewer → archive → ship → ci`. Start a phase with running; only actual completion and its runtime gate permit done. Failed/blocked needs a concrete reason. Reopening resets dependent completion. Never skip an implementation phase because its predecessor failed.

```bash
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" phase --phase architect --status running
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" phase --phase architect --status done
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" phase --phase reviewer --status blocked --reason "Unresolved acceptance condition"
```

Store check requests/notes under stateDir, not as candidate files. Verification is executable argv:

```json
{"kind":"full","commands":[{"repositoryId":"primary","command":"npm","args":["test"],"cwd":"/absolute/selected/repo","env":{"CI":"1"},"timeoutMs":900000}]}
```

```bash
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" verify --request <stateDir/full-checks.json>
```

Derive actual CI-equivalent checks from each selected repository's scripts/config/workflows. The example is not universal. Full requests cover every selected root and required cross-repository integration; scoped requests target repair cycles. The runtime executes commands and binds exits/output, command/argv/cwd/environment identity to frozen scope and actual candidate, including additions and deletions.

Reuse a full receipt only while status.verification.valid is true **and recorded commands cover the required checks**. Baseline-only/stale evidence cannot certify changes. After candidate edits, use scoped repairs and one fresh final full pass. Command success still needs semantic acceptance review; do not replace it with another full-suite run.

## Phase 1: Architect

Start architect if required by resumePhase, then invoke sr-architect once with specName and aggregate frozen scope/roots. Use the actual `Skill("opsx:ff", "<change>")` workflow (or provider-native equivalent) for `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<change>/`.

One design covers shared contracts, explicit repository task ownership, integration order and acceptance. Batch tickets are dependency-ordered task groups within this change, not separate full pipelines. Validate existing Modify paths and genuinely new Create paths against selected roots; do not reject a plan by a percentage-of-paths-exist heuristic.

Require proposal/design/specs/tasks and medium/high design-confidence.json. Missing, malformed or low confidence blocks development with the unresolved issue. The runtime checks this before architect done. Reuse valid design after interruption; task checkbox progress does not invalidate its contract.

## Phase 2: Developer

Invoke sr-developer or profile-routed roles with immutable task groups and official `Skill("opsx:apply", "<change>")`. Serialize dependent/shared-file groups in supplied candidate roots. Read-only investigations may run concurrently, but collect every result; no recursive full pipeline or colliding writers.

Keep real checked task progress. Use meaningful scoped regressions during implementation and bounded repairs (at most two unsuccessful cycles per issue, then a concrete blocker). After all aggregate tasks finish, run one full CI-equivalent request. Runtime developer done requires completed tasks and current actual evidence.

Supplied roots already contain the candidate: inspect additions, renames and deletions there. Do not copy changed-file lists over another checkout, patch against an assumed main branch or force-remove worktrees.

## Phase 3: Reviewer and confidence

Invoke sr-reviewer once with the context, exact specName, candidate summary and receipt. Map every frozen requirement to code and behavioral evidence. Existing green tests with missing implementation mean incomplete, not PASS.

Reuse unchanged full evidence; run cheap static/scoped checks as needed. Any review edit requires one fresh full request after all fixes. Security, acceptance gaps, missing required regressions, untested critical side effects or unchecked tasks block acceptance.

Before archive, write `${SPECRAILS_REPO_DIR:-.}/openspec/changes/<change>/confidence-score.json` with canonical change, overall and five numeric aspects. Require overall ≥70, security ≥75, other aspects ≥60; stricter configured thresholds still apply. Missing/malformed score fails closed; a numeric average never overrules an explicit blocker.

Normal reviewer returns acceptance/security verdict and confidence **without archiving**. Validate SECURITY_STATUS, task completion and acceptance, then runtime reviewer done. A human-facing PASS alone is insufficient.

## Phase 4: Archive after approval

```bash
node "${SPECRAILS_PIPELINE_RUNTIME:-.specrails/runtime/pipeline.mjs}" archive-check
```

Approval binds candidate, requirements and exact confidence bytes. Invoke reviewer with ARCHIVE_ONLY=true and ARCHIVE_AUTHORIZED=true, or execute the equivalent official workflow in the coordinator. No rescoring/code edits after approval. Run the Skill from `${SPECRAILS_REPO_DIR:-.}`:

```
Skill("opsx:archive", "<change>")
```

Confirm active artifacts moved and canonical specs synced, then record archive done. Do not emulate with file moves or automatically accept incomplete-task prompts. Failure is a resumable archive blocker, not permission to redevelop or reship.

## Phase 5: Delivery and backlog

Host-owned git: only ship/ci may be skipped; return ready-for-delivery evidence. Host-owned backlog stays untouched until host acceptance.

For explicitly Core-owned git and GIT_AUTO=true, use the project's shipping workflow in each correct selected repo, staging only reviewed candidate changes. Preserve unrelated preexisting work. Record real commits/PRs and CI results per repository; partial delivery is not whole-batch success. CI-only retry checks existing delivery and does not ship again.

Only Core-owned backlog can close after all required delivery succeeds. First compare live ticket requirements against frozen scope; changed requirements remain open with the conflict reported. Failures preserve open tickets and resumable phase details.

## Preview and apply

--dry-run/--preview prepares bytes under stateDir without source edits/shipping/backlog writes. Manifest entries are `{repositoryId,path,operation:"write"|"delete",sourcePath?}`; targets are repository-relative. Record with `preview --request <stateDir/preview-request.json>`. Report **UNVERIFIED PREVIEW**; tests on untouched code describe only baseline.

--apply resumes the exact journal and calls `apply-preview --request <stateDir/full-checks.json>`. Runtime rejects stale base/cache, applies exact additions/edits/deletions and executes checks on the actual candidate. Failed checks retain reviewable applied work without success evidence. Continue developer task completion, reviewer/confidence and archive gates; never skip directly to shipping.

## Completion

Report run/change, frozen tickets/roots, phase statuses, actual receipt commands, acceptance, confidence, archive and per-repository delivery. Distinguish reused evidence, newly executed checks and gaps. Keep failure excerpts bounded and refer to durable receipts. Missing workers, failed gates or incomplete required repositories stay blocked/failed, never falsely complete.


### Acceptance evidence and completion

After development, normal review MUST write `stateDir/acceptance.json` and run
`acceptance --request <absolute-path>` before `phase --phase reviewer --status done`.
The request is `{criteria: [...], checks: [...], findings: [...]}`:
- Each criterion has `specId` (string), `criterionIndex` (zero-based), `requirement`
  (exact frozen text), `status` (`met`, `exception`, `blocked`, `pending`) and a
  nonempty `evidence` array of concrete code/test/capture references and observations.
  Cover every frozen acceptance criterion once. If a spec has no explicit criteria,
  use its complete frozen description (or title if empty) at index 0.
- An `exception` MUST include `{reason, impact, material, acceptedBy, approvalEvidence}`.
  `acceptedBy` is `reviewer`, `user`, or `host`. Material scope changes require actual
  user/host authorization; do not invent approval or label material changes minor.
  Previously authorized decisions need no new confirmation. Unresolved requirements
  remain `blocked` or `pending`, never `met` through a rewritten interpretation.
- Each check has `{name, status, required, evidence, scope, limitations}`; status is
  `passed`, `failed`, or `unavailable`. Include required and supplementary checks from
  the design. Record the original required classification; never downgrade a failed
  check to make the gate pass. For benchmarks state what is measured and excluded:
  a Node microbenchmark does not establish browser Canvas/GPU/frame performance.
- `findings` lists concrete review conclusions, risks and resolutions; use an empty
  array only when no findings remain. Numeric confidence cannot replace this report.

The runtime binds this evidence to frozen scope, source and design. Missing/stale
acceptance or unresolved requirements/required checks block review and archive.
Accepted exceptions and supplementary failures produce `with-exceptions` validation.
Replacing the report requires review and archive authorization again; a green command
receipt alone is insufficient. Evidence references and approval attribution remain
reviewer assertions, not independently authenticated proof of human approval.

Keep operational completion notes, check requests and reports in `stateDir` from
start to finish. Run scoped checks for repairs and one final full verification after
all edits. Reuse that full receipt while runtime status says it is valid and its
commands cover required checks. New prose/phase handoffs alone do not warrant reruns.

End with ONE concise summary from runtime `status.completion`: implementation,
validation (including exceptions), archive, delivery, and evidence references.
Host-owned delivery stays `pending-host`; do not call uncommitted files "landed".
Report phase durations/attempts from `status.phases`; report per-phase cost only when
provider telemetry attributes it, otherwise unavailable. Do not invent cost splits.
