# Provider pipeline contracts

Core installs a local, self-contained Node helper at
`.specrails/runtime/pipeline.mjs`. It uses no global Core lookup or network download.
The shared contract is embedded in the installed Claude, Codex, Gemini and Kimi workflows.
`SPECRAILS_PIPELINE_RUNTIME` can explicitly identify that helper for a child process.

An absolute `SPECRAILS_EXECUTION_CONTEXT` JSON file supplies immutable specs, selected
repositories, OpenSpec artifactRoot, backlogRoot (the workspace containing
`.specrails/local-tickets.json`), optional backlogPath, and host/core ownership.
Batch uses one aggregate OpenSpec change and journal; task groups retain ticket and
repository identity. Final verification and semantic review cover the whole batch.

Standalone invocation admits ticket IDs with `init --tickets "17,18"` or a structured
`--scope-request` for free-form specs. Reuse the generated context on retry; explicit
host context always takes precedence. Core-owned delivery requires explicit ownership.

Use the helper's init/status/phase/verify/archive-check operations. Status identifies
the first invalid phase. Retry reuses valid earlier work; blocked remains retriable.
Explicit role handoffs contain frozen criteria and exact paths, not a promise that
another provider conversation retained memory. Archive-only execution preserves the
reviewed confidence file; the gate binds its exact bytes and the candidate.

## Gemini

OpenSpec is installed with an isolated complete workflow profile, then Gemini skills
are placed in the actual execution workspace. Updates preserve custom skill folders.
The adapter requires invoke_agent and role activate_skill availability. Turn limits
are capability-dependent: older loaders reject optional metadata. By default Core
omits it and uses progress-bound continuation handoffs. After verifying loader
support, an installer may set SPECRAILS_GEMINI_AGENT_LIMITS=supported and
SPECRAILS_GEMINI_MAX_TURNS (1–200, default 60). This does not confer native session
continuity; every reinvocation still receives an explicit checkpoint.

## Kimi

The managed runner preserves the absolute execution context, shared backlog path,
helper path and selected repository access across private role working directories.
SPECRAILS_BACKLOG_PATH is the exact ticket-file path; SPECRAILS_BACKLOG_ROOT is its
logical workspace. Host-owned contexts reject sibling worktree requests before any
role process starts. Role models remain exact profile values. Standalone managed
worktree manifests and their guarded merge/cleanup mechanism remain available.

## Validation limits

Local regression fixtures install the real provider artifacts and run the real
helper against temporary repositories, including failed gates, review retry,
archive authorization and unchanged frozen scope. Kimi process fixtures additionally
exercise private cwd, shared-backlog access and host worktree rejection. They do not
make paid model calls or claim identical behavior across every native CLI release.

See [Core installation and update consistency](core-updates.md) for version
selection, rollback and Desktop integration.


## Acceptance evidence and completion


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
