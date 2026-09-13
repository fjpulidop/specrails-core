## Context

Planning baseline: main commit `2427141b` (2026-09-13), branch `codex/implementation-efficiency`. Implementation has not started. The implementing coding assistant is **GPT-6 Astra, reasoning medium**; this is unrelated to customers' runtime model assignments.

The existing graph is architect → developer → verify → reviewer → archive. Keep it. Verify avoids paying a reviewer for a candidate whose checks already fail. Existing OpenSpec 1.4.1 bindings, scoped tools, leases, interrupted-write recovery, acceptance floors and host-owned delivery are requirements, not optimization targets.

Verified gaps:
- `graph/roles.ts` appends up to 20,000 characters of repository context to every call, including corrections and repairs. `repository-context.ts` can truncate the final repositories without marking that omission.
- Developer session reuse exists; reviewer continuation does not. API calls and current Kimi ACP start fresh sessions, even when an adapter returns a session ID.
- `prompts.ts` already requests focused developer tests and proportional planning. Extend its handoff, do not add another planner or copy OpenSpec templates.
- `pipeline-state.ts:verifyPipeline` always executes commands sequentially; receipts bind candidate and environment but not a requested plan. Ignored dependency directories and external services are not completely captured by those fingerprints.
- Developer `verification` is prose. Useful temporary harnesses can be deleted before the reviewer sees them.
- Runtime role configuration has provider/model/maxTurns, with no explicit effort/escalation contract. Existing metrics count executor invocations, not necessarily HTTP inference requests.

## Goals / Non-Goals

Goals: reduce repeated inference/context/work; reduce time to independently accepted implementation; preserve or improve coverage, reproducibility and defect detection. Measure whole runs, including failed attempts and human rescues.

Non-goals: another QA agent, merging verifier with reviewer, skipping official OpenSpec procedures, weaker review floors, global agent memory, autonomous price lookup/model selection, mandatory browser/tool installation, general dependency analysis, or claims of savings based only on fixtures. Personal-provider configuration isolation is a separate security/capability change.

## Decisions

### D1. Explicit contracts and boundaries

`contracts.md` is the normative shared boundary with Desktop. Keep runtime API 1 and negotiate versioned optional capabilities. New behavior uses workflow protocol 5 and instructions version 7; checkpoint envelope format need not change unless its serialization actually changes. Preserve old configuration parsing; never apply new defaults to an already admitted request.

Use small focused modules for context packets, route selection, verification planning and evidence indexing. Reuse existing executors, command validation, subprocess cancellation, receipts, candidate inventories and event store. Do not build a second orchestrator or duplicate receipt authority in Desktop. `pipeline-state.ts` is distributed as a builtins-only standalone module: extraction requires updating and testing its installer packaging, not an import that works only in the source repo.

### D2. Capability-aware context and handoffs

An executor exposes capabilities per actual transport: supported continuation, effort values and observable usage. A returned sessionId alone never establishes continuation. Current API and Kimi ACP are sessionless; send full role instructions and current context to them. Claude/Codex/Gemini continuation requires adapter contract tests proving that a follow-up packet cannot silently start a fresh session; failure to restore the session must occur before inference. Transports unable to guarantee this receive full context. Expose installed-transport capabilities to Desktop through the read-only query in contracts.md.

Store a role-session identity containing role, provider configuration fingerprint, requested model/effort, prompt version, OpenSpec binding identity, admitted scope and transport. A change starts a fresh role session with full context. Never share sessions across roles.

Build a `RepositoryContextSnapshot` with schema version, hash and one entry per repository. Each entry records root/id, source paths and hashes, bounded facts and explicit omitted paths. Maximum context body is 20,000 characters, fairly allocated across repositories; every repository identity survives truncation. Oversized source material is referenced for scoped reading. Do not silently omit later repositories or freeze changing manifest facts forever.

First call and sessionless calls receive the full role instructions, current snapshot and bounded handoff. A confirmed continuation receives its correction/deepen/repair instructions, current acceptance obligations and only changed snapshot entries. A changed entry is a complete versioned replacement for that repository, listing removed sources and revoking prior facts, not an ambiguous patch with silent omissions. Re-read/hash context source files before reuse; stale entries force an updated packet. The immutable official skill still loads and its required context files still must be read; host-side caching is never a substitute for agent participation.

Handoffs contain verified reference paths, decisions, scope, outstanding issues, actual changed-file inventory and evidence IDs. Summaries are claims/references, not authority to waive source inspection. Do not embed entire logs or artifact copies when a stable path and scoped reader exist. Preserve read access to all evidence needed for a complete acceptance decision.

Narrow session fallback to explicit session-not-found/expired/unsupported outcomes. Generic auth, rate limit, cancellation, invalid scope and work failures must not automatically buy a second full invocation. One permitted session fallback per role invocation, counted within existing budgets, is logged and measured.

### D3. Incremental review with complete recertification

Store the reviewer session identity and a paths/hashes candidate manifest for approved AND rejected reviews. Compare against the actual previous reviewed candidate, not HEAD (which includes the whole implementation). Detect additions, modifications, renames as delete/add, deletions and mode changes without commits or full source snapshots.

After a correction, send changed-file inventory, previous issues, current developer summary and current authoritative verification evidence. The reviewer starts with corrections and related effects and emits the complete existing acceptance contract for every criterion. Never merge old `met` entries into a new verdict or treat session memory as fresh evidence.

First validate frozen scope/artifact/config identities. An unauthorized mutation blocks or invalidates through existing gates; sending more context cannot legalize it. Within an allowed continuation, use full review context when a session is unavailable, manifests are missing/truncated, an authorized planning revision invalidates the comparison, or a shared contract, lockfile, build/security/configuration file changes. This is a conservative explicit path policy with tests; no inferred dependency graph. Full context fallback does not weaken gates or discard previous findings.

### D4. Proportional planning and deterministic escalation

The architect may return optional planning metadata: depth `focused|full`, a bounded reason, reference patterns and risk flags. Missing metadata means full. Focused means local, clear scope and no public contract, migration, security or multi-repository/cross-layer change. It produces the same official proposal/design/spec/tasks artifact types with all acceptance obligations; it only reduces redundant explanation/investigation. No arbitrary universal task-count limit and no extra classification model call.

Base role models remain explicitly configured. Optional escalation is ONE higher tier within the same provider; require explicit base/escalation model identifiers. No automatic inference that a model name is cheaper or better. Effort is an optional transport capability, not a universal enum.

Deterministic triggers:
- Architect: its existing single low-confidence deepen may use the configured higher tier; existing ask/proceed behavior follows.
- Developer: after two completed failed candidate outcomes caused by verification or rejected review, including the initial attempt and counting once per developer attempt, the next already-allowed attempt uses the higher tier. With maxAttempts3, failures on attempts1/2 permit escalation on attempt3; with maxAttempts2, the run stops. Do not create an extra attempt solely to escalate.
- Reviewer: rejection of implementation is useful work, never an escalation trigger. One malformed/protocol response gets the existing repair; if a configured escalation is enabled, the final protocol repair can replace that repair at the higher tier. Total repair count remains bounded at one; the policy cannot create an unbounded repair ladder.
- Auth/access/capability/scope/integrity errors, cancellation and exhausted budgets never escalate.

Persist route decision, reason and tier before invoking. Tier is monotonic within the run, including resumes. A model/effort change requires fresh session/context. Existing attempt, token, duration and supported dollar caps include all tiers and failures; the route must pass limit capability preflight too. Unknown billing remains unknown.

In v5, the single logical deepen/repair budget is independent of session support. Confirmed sessions receive follow-ups; sessionless or changed-tier transports receive full original instructions, a bounded prior response, precise diagnosis and current handoff. This deliberately removes current sessionId-based eligibility differences across providers without increasing the logical one-deepen/one-repair limits. Record this separately in same-model benchmarks because API/Kimi may now exercise a repair previously unavailable to them.

Effort support must be verified per installed CLI/transport in implementation: reuse a supported adapter mapping only after its contract is tested. Current Kimi legacy helper support does not imply ACP support; Codex template configuration does not prove every CLI version. Unsupported requested values are rejected before paid work; omission means provider default and must not be displayed as an invented effective effort.

### D5. Additive checks and persistent harnesses

Developer output gains optional `verificationChecks` (flat tagged records, to avoid breaking Codex optional-field restoration). Absence means none; present malformed data is a repairable protocol error inside role acceptance. Never silently filter invalid checks or execute verification prose.

The architect/host baseline remains mandatory and ordered. Core validates all proposals before materializing any file, normalizes them and deduplicates by semantic execution identity. Accepted additions persist across correction cycles. A developer cannot delete/replace baseline checks, lower required coverage, opt into caching/parallelism or mark its result passed. A modified harness replaces the active revision of that developer key; the old revision/evidence remains historical and is not concurrently required. Coalesced host policies combine restrictively; an exact developer duplicate retains an existing host check's authority, while developer-only entries remain serial/nonreusable. Different env/timeout/runner/harness definitions do not coalesce. Configured checks gain optional stable key/label fields and deterministic legacy admission identities as defined in contracts.md.

Harness contents arrive as bounded UTF-8 source in the structured result. Core materializes them under its own state directory; agents are never granted write access to the journal. A harness is executable test code under the same host verification authority as an admitted command; placing it outside the repository is not a sandbox. Existing process/environment/scope controls still apply and tests must prove rejected declarations never spawn.

Limits: at most 20 new checks per developer response and 100 effective plan entries; at most 8 files per harness, 64 KiB per file and 256 KiB total per response. Safe relative file/entrypoint paths, unique paths, no traversal, symlinks, device names or supplied executable modes. Core writes immutable source as mode 0600. A harness runner uses structured command/args, with Core appending the resolved entrypoint. Core sets `SPECRAILS_CHECK_REPO_ROOT` for the admitted target; proposals cannot override it. Harnesses use this to reference application files from their separate location.

Persist `verification/plan.json`, `verification/harnesses/<checkId>/<manifestHash>/...` and `verification/runs/<executionId>/...` below the run state directory. The plan and source manifests are versioned and written atomically under the existing run lease. They remain outside delivery and OpenSpec archives, but their hashes participate in evidence validity.

Use one bounded read-only evidence resolver for the CLI, Desktop and the new scoped agent tool. The API dispatcher and existing MCP bridge expose it to developer/reviewer with host-injected run context and explicit provider bindings/allowlists. Summary descriptors enumerate source IDs for multi-file harnesses. The agent can retrieve source/output pages without shell access or widening generic filesystem access to .specrails. This wiring is a required cross-provider capability, not optional UI polish.

### D6. Evidence and conservative reuse

A canonical plan hash covers policy version, full/scoped kind, uncovered repositories, ordered check IDs/origins/repository IDs, normalized semantic command/args/cwd, configured/normalized timeout, environment override hash, harness manifest, reuse/input policy and scheduling policy. Hash stable logical references before expansion into execution-specific paths. Record actual argv/cwd, applied timeout and remaining deadline separately in each execution; a deadline reduction must not create an artificial plan revision on resume.

Every execution records plan/candidate/scope/artifact/environment identities, toolchain/input fingerprints, source hashes, time/duration, exit/signal/timeout/cancel status and output references. Preserve bounded stdout/stderr separately with a digest, byte counts and explicit truncation; never label a truncated tail as a full log. Default per-stream persisted cap 1 MiB, reviewer tail 6,000 characters per check and 24,000 total, with IDs for further reads. Redact credential values before persisted/UI output using shared diagnostics helpers, not a separate secret-scanning system.

The current full receipt is authoritative. Plan changes invalidate verification, acceptance, review and archive approval, even if application code is unchanged. A later failed scoped check invalidates earlier full success; never search history for an older green result behind that failure. A scoped receipt never becomes full by relabeling. A full receipt covers every mandatory entry of the current plan, executed or validly reused.

Reuse defaults to NEVER. A host-authored check policy may opt into `snapshot-local` only with declared read-only/deterministic behavior and an explicit manifest of inputs/toolchain/dependency contents. toolchainInputs are host-admitted file paths hashed by content, not opaque version strings; an executable alone is not its interpreter/module/dependency closure. Agent proposals cannot opt in. Matching lockfiles alone do not prove matching node_modules, tools or external services. Hash declared ignored input contents; missing inputs, excessive inventory, symlinks outside scope, ambiguous executable identity, mutable/external services or unprovable assumptions make the entry non-reusable. Report the reason and execute normally. This opt-in expresses a host guarantee; do not claim generic hermeticity from fingerprints.

Reuse additionally requires the current, noninvalidated success receipt, exact plan/key, no post-check source/harness edits and matching inputs. Re-check identities at reuse time and again before completion. Cross-resume reuse uses the same full validation; never reuse an interrupted/failed/unknown execution. Record a new reuse event referring to the original execution, not a fake zero-duration test pass.

This applies to resuming completed verify checkpoints too. On a new nonterminal invocation, validateCompleted cannot bypass the policy merely because verify once finished: before pending reviewer/archive work, rerun never/ineligible checks and recertify downstream authorization. This can increase the cost of a manual continuation but avoids blessing changed external conditions. Fully terminal status/history reads never execute checks or replay archive. Explicitly test both paths.

### D7. Bounded independent scheduling

Default maxConcurrency=1, maximum 4. Only host-declared independent checks can overlap, across distinct admitted repositories with nonoverlapping resource keys. The safe default for undeclared and developer-only checks is serial. resources absent means unknown; [] is an explicit host declaration of no shared resources. Only contiguous eligible checks with the same nonempty independentGroup form a wave; a serial entry, group change or conflict is a barrier, with no lookahead/reordering of the baseline. Shared DB/ports/output locations or uncertain write effects prohibit overlap. Only one check per repository runs at a time in this iteration; no general dependency graph is introduced.

Use a small wave queue around existing executeCheck. Correct its current early stop settlement: request process-tree termination, await close with a bounded grace/escalation path, and preserve uncertain termination as failure rather than proceeding to another agent. Pass the remaining workflow deadline explicitly and cap every check's effective timeout to it. On failure stop scheduling pending checks; stop/await active siblings and report passed/failed/cancelled/not-run individually. Logs carry repository/check IDs and preserve per-check order. Publish a valid full receipt only after every required result is available and the post-execution fingerprint is still valid. Reuse is accounted as resolved work, not a running subprocess.

### D8. Evaluation and measurements

Keep RuntimeEfficiency schema 1 meanings and null handling. Add optional versioned metadata: invocation kind, confirmed context mode, prompt/context/handoff UTF-8 byte counts, selected tier and reason, requested/observed model/effort, and check executions/reuses/durations. Existing providerCalls remains executor invocations. Add modelRequests only where actually observable; never infer it for opaque CLIs.

Add an offline evaluation runner/corpus and a separately enabled real-provider mode. At least five cases: static Tetris-like logic with no package manifest; local feature with existing tests; cross-repository contract change; deliberately failing verification; rejected review followed by correction. Cases freeze repo/base, task and acceptance hashes, config, runtime version, toolchain and independent acceptance checks. Add deliberately defective variants so the acceptance oracle itself is exercised.

Compare (A) same provider/model/effort to isolate orchestration and (B) explicitly configured base/escalation policy. Fresh workspaces and sessions per replicate; randomized paired order and recorded cache state. Default runner is offline, never calls paid providers or silently installs tools. Real inference mode requires an explicit aggregate budget, selected models and stop policy; unsupported hard monetary caps are labeled and managed with available usage/attempt/time limits rather than promised.

Offline gates: all safety/acceptance regressions pass; no added provider invocation in unchanged-context correction fixtures; materially smaller correction prompt payload (target at least 40% on the fixed long-context fixture); stale/changed plans never reuse; serial vs parallel independent fixtures yield the same verdict. These demonstrate mechanics, not AI savings.

Real evaluation target: at least 20% lower aggregate cost per independently accepted implementation, with median active duration improved, no drop in observed independent acceptance and no new critical/high defects. All attempts/failures/rescues count in numerator; zero accepted outputs means metric unavailable, not zero. Partial/unknown billing makes the cohort's monetary comparison inconclusive; never compare sums of only known costs as aggregate savings. Continue reporting observed tokens/time/acceptance. Start with three paired replicas per case; report sample size, variation and inconclusive results, not a robust p95 or universal guarantee. A missed target blocks claiming/activating an economical default, not the visibility of truthful measured results. Never adjust review gates or the acceptance corpus after seeing results.

## Risks / Trade-offs

- Context reduction hides a requirement → mandatory scope/acceptance retained, per-repo truncation visible, source references available, sessionless calls full.
- Session mistaken for evidence → session and receipt identities separate, complete acceptance recertification each candidate.
- More tests increase time/cost → dedupe and focused iteration, retain required checks; measure time-to-accepted-result rather than smallest test count.
- Hashing dependencies costs more than rerunning a quick test → reuse opt-in with bounded inventory; skip expensive/uncertain caching.
- Scheduler races or leaked processes → conservative independence, per-repo serialization, cancellation barriers and portability fixtures.
- New configuration strands old runs → runtime pinning and the migration gates below precede new defaults.

## Migration Plan

1. First add capability negotiation and a durable runtime identity for new admissions in Core/Desktop, while old behavior is still available. Store package version, workflow/instructions versions and integrity, not a mutable path alone.
2. Ship new protocol 5/prompt 7 for NEW jobs only. Persist the full effective config and version identity at admission. No rewriting old checkpoint checksums or frozen input to make them fit.
3. Retain the exact installed/bundled runtime needed by active saved jobs before replacing it, and verify integrity when reopening/resuming. Old v4 requests lack package identity: mark it unrecorded; require trustworthy package provenance/integrity and exact compatibility. An optional read-only probe reconstructs and compares input/workflow fingerprints without runCoreWorkflow, initializePipeline or prepareOpenSpec side effects; equality alone does not prove package provenance. Store proven legacy resolution in Desktop's side record. Never guess from the current global version. An unresolved legacy run remains inspectable with an actionable original-runtime recovery path; no paid attempt is made with an incompatible package.
4. Fixture a real v4 checkpoint/request and its original runtime, verify successful continuation through Desktop without migration; fixture unavailable original runtime and verify safe, clear recovery messaging. New v5 resume preserves config/tier/evidence without duplicating accounting or replaying still-valid work, subject to D6 verification revalidation and downstream recertification. This is a release gate, not a later cleanup.
5. Publish reviewed Core capability support, then pin Desktop's release lock and production bundle. Development source assembly is not proof of a published package. Rollback affects new admissions; retained runtimes continue their pinned jobs. Do not delete evidence/runtime pins on failed upgrades.

## Open Questions

No unresolved product decision blocks coding. Adapter effort/continuation support and trustworthy legacy-runtime provenance are empirical capability checks in the first tasks: unsupported/unknown means explicit unavailability with original behavior retained, never an invented implementation. Real benchmark provider/model selection and aggregate spend are supplied when running that optional experiment; fixtures require neither.
