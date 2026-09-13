# Implementation checklist

Status: local implementation complete; unchecked items retain their native-distribution/publication gates. See the paired Desktop verification record for exact test evidence and limitations. Use GPT-6 Astra with reasoning medium for the subsequent coding phase. Read proposal, design, contracts and all three delta specs before applying. The paired Desktop task groups are D0–D5; C0–C7 below identify dependencies, not additional workflow phases.

## 1. C0 — Contract, capability and compatibility foundation

- [x] 1.1 Add typed optional configuration and API capability fields from contracts.md in `config.ts`, `executor-types.ts`, public exports and `schemas/agent-runtime.schema.json`; add strict valid/invalid/absent-field fixtures shared with the built package.
- [x] 1.2 Implement actual-transport continuation/effort declarations and the read-only runtime capabilities query for both base/escalation models. Fixture Claude/Codex/Gemini CLI arguments, stateless API/Kimi ACP, unknown effort and a transport silently ignoring resume; a partial packet must never start fresh. Do not call real providers to run unit tests.
- [x] 1.3 Add durable runtimeIdentity admission fields, normalized frozen effective policy and versioned workflow5/instructions7 selection in `core-host.ts`; preserve old-runtime admission behavior until migration fixtures pass. Test changed defaults/config cannot alter saved requests.
- [x] 1.4 Produce a real v4 saved request/checkpoint fixture using its original built runtime, without editing checksums. Record trustworthy package identity and exercise original-runtime continuation with Desktop D0; fixture unavailable provenance as a precise preflight recovery state. Any compatibility probe must compare exact fingerprints read-only without runCoreWorkflow/initialization side effects and require independent package integrity/provenance.
- [x] 1.5 Extend CLI API/status parsers and package verification fixtures for optional capabilities, actually supported workflow versions, absent/malformed/unknown versions and old-API compatibility. Gate new features before paid invocations.

## 2. C1 — Context packets and complete incremental review

- [x] 2.1 Introduce versioned per-repository context snapshots in `repository-context.ts` with source hashes, fair 20,000-character budget, explicit omissions and immutable references; test later repositories, missing guidance files and changed manifests.
- [x] 2.2 Refactor `graph/roles.ts` context assembly into full versus confirmed-continuation packets. Preserve mandatory role/OpenSpec/scope/acceptance content and scoped source access; test full/sessionless/unchanged/replaced context, deleted sources and explicit revocation of obsolete facts.
- [x] 2.3 Persist and compare role session identity; invalidate on provider configuration/model/effort/transport/role/scope/prompt/OpenSpec changes. Narrow fresh-session fallback classification and test exactly one allowed fallback, no auth/rate-limit/cancel retry and budget accounting.
- [x] 2.4 Extend `graph/state.ts` review records with compatible session identity and candidate path/hash manifests for both rejection and approval; implement changes since previous review including additions/deletions/modes.
- [x] 2.5 Validate frozen scope/artifact integrity first, then implement full-review fallback for missing/truncated manifests and permitted contract/lockfile/build/security changes. Require every new reviewer response to recertify all acceptance criteria; test no stale met-criterion inheritance or integrity bypass through full context.
- [x] 2.6 Extend existing proportional-planning prompt/result metadata without another model call or replacement OpenSpec templates. Fixture focused local pattern and full multi-repository/security/migration/public-contract cases; missing metadata means full.

## 3. C2 — Optional effort and bounded route selection

- [x] 3.1 Add one pure typed route-selection policy with the exact architect/developer/reviewer triggers in design D4. Count failed candidate outcomes once per developer attempt including the initial attempt; test maxAttempts3 escalates on third and maxAttempts2 adds no attempt. Test no reviewer-rejection escalation and same-provider model validation.
- [x] 3.2 Persist route/tier/reason before invocation under the current lease and restore it across crashes/resume. Test monotonic tier, fresh context on tier change and no escalation on authentication/capability/scope/cancel/integrity errors.
- [x] 3.3 Pass supported requested effort through each proven transport mapping; distinguish selected from observed model/effort. Test absent value is provider default and unsupported explicit values fail before execution.
- [x] 3.4 Include both tiers, repairs and session fallback in existing attempt/time/token/supported cost limits. Test exhausted or unsupported limits prevent invocation and unknown billing stays unknown.
- [x] 3.5 Decouple the single logical repair/deepen allowance from sessionId in v5; test sessionless and changed-tier calls receive full instructions plus bounded previous response/diagnosis, preserve OpenSpec participation and never exceed the one-repair/one-deepen cap.

## 4. C3 — Verification plans, persisted harnesses and evidence

- [x] 4.1 Add the flat optional verificationChecks result schema and strict semantic acceptance before side effects; test Codex optional-null normalization, API/CLI result parity, malformed present proposals and existing no-proposal developer output.
- [x] 4.2 Implement canonical additive plan construction with stable optional host keys/labels, immutable baseline, durable additions and one active revision per developer key. Test omission retains additions, old revisions become historical, duplicates retain all origins with restrictive host policy merging and all effective policy fields affect planHash.
- [x] 4.3 Implement bounded harness validation/materialization under the existing run lease: safe paths, source/entrypoint limits, immutable source, atomic manifest and structured runner argv. Test traversal/symlinks/Windows reserved paths, command rejection, failed writes and zero spawns on invalid proposals.
- [x] 4.4 Integrate effective plans into `graph/nodes.ts` verification and existing `pipeline-state.ts` command execution, preserving scoped/full distinctions and required baseline coverage. Feed failed evidence to developer before reviewer invocation.
- [x] 4.5 Extend receipt/acceptance/review/archive binding to the complete plan identity. Test code-unchanged plan edits, harness edits, late scoped failures, interrupted verification and post-execution edits cannot authorize completion.
- [x] 4.6 Persist bounded redacted stdout/stderr, execution metadata, source hashes and evidence indexes with digests/counts/truncation; implement bounded reviewer tails and references. Test timeout/cancel/signal outcomes and metadata/output separation.
- [x] 4.7 Implement the read-only paged `runtime evidence` CLI contract, with opaque evidence/source IDs and bound cursors. Test cross-run IDs, limits, source-section validation, corrupt/missing state and historical retrieval after worktree removal without source execution.
- [x] 4.8 Preserve standalone builtins-only `pipeline-state.ts` distribution. If extracting helpers, update installer/template copying and package verification; exercise verification/harness/evidence from an installed tarball without source-tree imports.
- [x] 4.9 Bind the shared read_verification_evidence resolver into API scoped tools and the existing MCP bridge/CLI allowlists for developer/reviewer. Test all supported transports can discover multi-file source IDs and read a second output page without shell or generic state-directory access; use the same limits/authorization as CLI.

## 5. C4 — Conservative reuse and independent scheduling

- [x] 5.1 Implement bounded host-only snapshot-local input/toolchain/dependency identity capture with explicit ineligibility reasons. Test unchanged lockfile with changed ignored dependencies, missing files, external services, escaped symlinks and uncertain executable identity all rerun.
- [x] 5.2 Reuse only the current noninvalidated successful result with exact plan/key/identities; revalidate at reuse and completion, including validateCompleted on nonterminal resume. Test checks with reuse='never' rerun before pending reviewer/archive, terminal reads do not rerun, newer failure defeats historical green, edits invalidate and reused results do not replay duration.
- [x] 5.3 Implement bounded contiguous scheduling waves with maxConcurrency 1–4, distinct-repository host independence and nonoverlapping explicit resources. Test missing versus empty resources, serial/group/conflict barriers, no baseline reordering and developer-only/same-repository serialization.
- [x] 5.4 Fix executeCheck.stop early settlement, await close with bounded termination grace/escalation, and pass the remaining workflow deadline to every check. Add scheduler cancellation barriers; test timeout with child process, simultaneous failure, no orphan child, correct not-run/cancelled outcomes and no partial-success receipt on macOS/Linux/Windows.
- [x] 5.5 Attribute interleaved output by repository/check while retaining each stream's order; compare serial and independent-parallel fixtures for identical acceptance and stable evidence identity.

## 6. C5 — Measurements and replay-safe projections

- [x] 6.1 Extend `efficiency-types.ts` / `efficiency.ts` with additive invocation-kind, context bytes/mode, requested/observed route and executed/reused/invalidated check metadata; preserve schema1 meanings and null handling.
- [x] 6.2 Emit bounded deterministic runtime-efficiency-event payloads and compact terminal efficiencySummary through existing durable event mechanisms. Add restart/continuation/replay tests proving no duplicated calls, usage, durations or check counts.
- [x] 6.3 Keep technical acceptance separate from independent acceptance/archive/host delivery and keep providerCalls distinct from optional modelRequests. Fixture opaque CLI usage, cached token totals and missing/corrupt legacy metrics.
- [x] 6.4 Export contract fixtures for Desktop D3 from the built runtime: ordinary success, correction success, failure, reuse, invalidation, incomplete metrics and unavailable evidence. Validate no high-volume log/source content leaks into compact status.

## 7. C6 — Evaluation corpus and report

- [x] 7.1 Create an offline evaluation runner and five frozen cases: static Tetris-like logic, local tested feature, cross-repository contract, failing verification and review correction. Record repo/task/acceptance/runtime/config identities and independently executable acceptance oracles.
- [x] 7.2 Add defective candidate variants and verify each oracle rejects them; compare full/optimized orchestration for identical gates and no extra invocations. Require at least 40% smaller correction prompts in the fixed long-context fixture.
- [x] 7.3 Add opt-in real-provider runner mode with explicit provider/model settings, aggregate spend/stop policy, fresh paired workspaces/sessions, randomized paired order and recorded cache state. Default remains offline with no install or paid invocation.
- [x] 7.4 Generate a machine-readable result plus human report including every failed attempt/rescue, independent acceptance, aggregate cost per accepted output, median active duration, sample count/variation and unavailable metrics. Partial billing makes monetary comparison inconclusive. Separate same-model and routing experiments; encode the 20% economic target without claiming it is proven.
- [x] 7.5 Document a reproducible experiment command after implementing its actual CLI. Validate the command in offline mode; leave real-model selection/spend unset until explicitly supplied and report real savings as not yet measured.

## 8. C7 — Integration, regression and release handoff

- [x] 8.1 Run focused regression groups as each prior section changes; cover `config`, `cli-executor`, `openai-executor`, `kimi-acp`, `codex-schema`, `repository-context`, `prompts`, `workflow`, `pipeline-state`, `efficiency`, `cli` and `core-host` tests as applicable. Avoid repeating slow full host suites after unrelated docs-only changes.
- [ ] 8.2 Run `npm run ci` once on the final implementation and fix failures; require the existing CI OS/Node matrix, OpenSpec and installed-package gates. Verify no installer/runtime helper has an undeclared dependency.
- [x] 8.3 With Desktop D4, run the compiled paired smoke and legacy/current resume fixtures using real OpenSpec and deterministic local provider fixtures. Test old Core/new Desktop feature rejection and new Core/new Desktop successful completion/evidence.
- [x] 8.4 Review code for duplicated orchestration/receipt logic, stale fallback paths and unbounded buffers; remove code made unreachable by this change while preserving required legacy package compatibility. Update runtime configuration/evidence/evaluation documentation.
- [x] 8.5 Validate this OpenSpec change against implementation, record actual test/evaluation evidence, and prepare the versioned Core package artifact and downstream Desktop pin handoff. Publishing follows repository release authorization; no fabricated release version or unmeasured savings claim.

Dependency order: C0 → C1/C2; C0 → C3 → C4; C1/C2/C3/C4 → C5 → C6; all → C7. C0 coordinates Desktop D0; stable C0 contracts unblock D1/D2, C5 fixtures unblock D3, C7 coordinates D4/D5. Real-provider evaluation execution is a later explicitly budgeted experiment, not a reason to mark offline implementation unfinished or savings proven.

Validation note: local CI suites and follow-up regressions passed; the unchecked CI task retains only its native OS/Node distribution-matrix requirement. Publishing and exact production pinning remain separate release steps.
