# Shared Core/Desktop contracts — implementation target, not implemented API

This file is authoritative for both changes. Desktop must mirror the shipped Core schema and use contract fixtures from the built package. Wire names below are decisions for implementation; they are not claims of current support.

## 1. Capability negotiation and identity

Extend `runtime api` additively:

```json
{
  "type": "runtime-api",
  "apiVersion": 1,
  "coreVersion": "<installed package version>",
  "capabilities": {
    "efficientRoleExecution": 1,
    "reproducibleVerification": 1,
    "implementationEfficiencyMetrics": 1
  },
  "workflowVersions": ["5"]
}
```

Only list workflow versions that THIS executable really supports. Missing capabilities means unavailable, not enabled by default. Unknown versions are not parsed optimistically. Preserve legacy API1 behavior when no new feature is requested. Unsupported requested features fail configuration/admission before provider invocation.

Persist `runtimeIdentity` at new admission in Core's frozen request and Desktop's host record: packageVersion, workflowVersion, instructionsVersion, package integrity/reference and apiVersion. Retain the original package before replacing the active runtime and verify integrity on reopen/resume; a filesystem path alone is not immutable identity. Changes to globally active Core/settings never rewrite a saved request. Legacy requests with no identity are labeled `unrecorded` and use only proven original-runtime resolution. A read-only compatibility probe can reconstruct and compare exact input/workflow fingerprints, but cannot call runCoreWorkflow or prepare/initialize state. Fingerprint equality alone does not establish package provenance/integrity. Store a proven legacy resolution in Desktop's side record, never rewrite the legacy request.

Expose read-only `runtime capabilities --config <file> --json` for the configured roles and every configured base/escalation model. This command validates configuration shape and returns schemaVersion1, runtime identity and per-role/tier provider/model/transport, continuation support, supportedEfforts (null when unknown), effortSupport (`supported|unsupported|unknown`), and observed-model/effort flags. Capability introspection must be able to report unsupported requested values without invoking full admission and losing the explanatory response. It performs no inference, authentication action, tool installation or workspace mutation. Cache by immutable runtime identity plus transport executable identity and queried provider/model; global feature flags alone are insufficient for the form. Unknown installed transport support never falls back to a legacy provider catalog.

## 2. Configuration additions

Keep config schemaVersion 1. All additions optional, strict/validated and included in frozen identity:

```typescript
interface RoleSelection {
  provider: string;
  model?: string;
  maxTurns?: number;
  effort?: string; // validated against the actual provider/transport capability
  escalation?: { model: string; effort?: string }; // same provider, one monotonic tier
}
interface EfficiencyPolicy {
  schemaVersion: 1;
  contextMode?: 'full' | 'incremental';
  reviewMode?: 'full' | 'incremental';
  planning?: 'full' | 'proportional';
  acceptDeveloperChecks?: boolean;
  verification?: { maxConcurrency?: number }; // integer 1..4, default 1
}
interface HostCheckPolicy {
  reuse?: 'never' | 'snapshot-local';
  inputs?: string[]; // complete explicit repository-relative input trees/files
  deterministic?: boolean;
  readOnly?: boolean;
  toolchainInputs?: string[]; // host-admitted file paths hashed by contents; no opaque version strings
  independentGroup?: string;
  resources?: string[]; // shared resource keys; overlap prevents concurrency
}
```

`agents[role]` extends current fields with effort/escalation; root `efficiency?: EfficiencyPolicy`; configured `verification[]` gains optional `key?: string`, `label?: string` and `policy?: HostCheckPolicy`. Keys are unique safe slugs in the host namespace. For a new v5 admission, legacy entries without keys receive deterministic run-local keys from their frozen slot and semantic digest; duplicates receive distinct occurrence IDs. Desktop assigns stable row keys before editing/reordering and persists them only to a capable configuration, never to old frozen requests. Changing a definition retains its logical key with a new semantic revision; labels are display metadata, not command text. Preserve cwd/env/timeoutMs. Agent proposals cannot set policy. Core interprets policy; it is not passed as an executable environment variable or arbitrary command argument.

toolchainInputs are repository-relative files or absolute paths admitted by the host's toolchain resolver, hashed by content; unsupported/unresolved files make reuse ineligible. They cannot grant access to arbitrary agent-selected paths. An executable hash alone does not establish its interpreter, modules or dependency closure; the complete declared identity remains required. independentGroup is a nonempty scheduling-wave key. resources absent means unknown/serial; an explicit empty array means a host declaration of no shared resources. Only contiguous eligible entries with the same group can overlap; serial entries, group changes and policy conflicts are barriers. No dependency graph or check reordering is inferred.

Defaults for NEW protocol5 jobs: context incremental when continuation is genuinely supported, incremental review with conservative full fallback, proportional planning with full fallback, acceptDeveloperChecks true, maxConcurrency1, reuse never, escalation absent, effort provider default. Omitted efficiency fields normalize once and are frozen. Old requests use their original runtime/defaults.

Escalation requires explicit base and higher model IDs. Existing limit validation must cover both. No model catalog/price lookup in Core. Unsupported effort is an error; an omitted effort is never recorded as effective medium/low.

## 3. Role results and session capabilities

Architecture metadata adds optional planningDepth, planningReason, referencePatterns and riskFlags; all are bounded and schema-validated, omission means full planning. Mandatory scope/acceptance/OpenSpec output remains unchanged. Developer `verification` remains prose for backwards display.

`verificationChecks` uses a FLAT tagged object schema (not a nested anyOf unless Codex null restoration is extended and tested):

```typescript
interface ProposedCheck {
  kind: 'command' | 'harness';
  key: string; // safe local slug; namespaced dev:<key>, immutable semantic revisions
  repositoryId: string;
  label: string;
  command: string;
  args: string[]; // structured argv, no shell string
  cwd?: string; // repository-relative, confined
  timeoutMs?: number; // obey existing command and remaining workflow ceilings
  entrypoint?: string; // required only for harness; Core appends its absolute path
  files?: Array<{ path: string; content: string }>; // required only for harness
}
```

Command checks forbid entrypoint/files. Harness requires a unique declared entrypoint among files. No env, required=false, policy, absolute evidence path, passed flag or origin field is accepted from the agent. Core assigns origin=developer and required=true after admission. Host-configured environment behavior remains existing authority; Core alone supplies harness root reference. Empty/absent proposals mean no additions; malformed present data must not be silently ignored.

A repeated same key+definition is a no-op; a different definition for that key replaces only its active revision and invalidates its prior receipt. Prior immutable revisions remain historical, not required concurrently. An accepted addition cannot disappear just because a later developer response omits it. Baseline host/architect entries cannot be replaced. Exact duplicate execution definitions coalesce while retaining all origins. Conflicting host policies combine restrictively (reuse never wins; uncertain/conflicting scheduling becomes serial; input obligations union). A developer duplicate of an existing baseline does not change that host-authorized policy or add guarantees; developer-only entries are always serial/nonreusable. Hash the resulting effective policy. Different runner/env/timeout/harness definitions are not duplicates.

Executor capability result includes `continuation: 'supported'|'unsupported'|'unknown'`, supported effort values and observability flags. `supported` guarantees that an incomplete continuation packet cannot be silently executed as a fresh session: inability to resume returns a classified failure before inference. If a transport cannot provide that guarantee, declare unknown/unsupported and send full context. Never derive support from sessionId. Internal `RoleSessionIdentity` includes role/provider configuration/model/effort/transport/prompt/OpenSpec/scope identities. Persist reviewer manifests for rejected and accepted candidates. Session fallback is bounded and classified distinctly from work failure.

The logical limit of one architect deepen and one role protocol repair is independent of continuation support in v5. Sessionless/tier-changed calls receive full instructions plus bounded prior response, precise diagnosis and current handoff. No additional repair is purchased. Developer escalation triggers after two failed completed candidate outcomes, including the initial attempt, counted once per developer attempt even if many checks fail. The next already allowed attempt escalates: maxAttempts3 can escalate on attempt3; maxAttempts2 cannot create an attempt3.

## 4. Plan and evidence records

Persist schema1 plan with runId, revision, planHash, scopeHash, candidate context, ordered normalized entries and their origins/policies/harness hashes. Stable IDs are generated from namespaced keys and semantic revisions. Hash the complete policy/versioned semantic plan before expansion into state-directory paths, including the configured/normalized timeout, not its dynamic reduction by remaining deadline. Each execution result stores both logical command identity and actual argv/cwd, applied timeout and deadline used.

Evidence summary schema1 per check:

```typescript
interface CheckEvidenceSummary {
  id: string; // opaque identifier, not a path
  checkId: string;
  repositoryId: string;
  label: string;
  origin: Array<'host' | 'architect' | 'developer'>;
  required: boolean;
  disposition: 'executed' | 'reused' | 'not-run';
  status: 'passed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
  executionId?: string;
  reusedFrom?: string;
  reason?: string; // bounded human explanation + stable internal reason code
  exitCode?: number | null;
  durationMs?: number | null; // current execution only, never replay original duration as new work
  planHash: string;
  harnessHash?: string;
  outputTruncated: boolean;
}
```

A full receipt covers exactly the current required plan. Acceptance and archive approval include plan identity or are invalidated whenever it changes. Only the current valid result is eligible for reuse; a newer failure/cancel/interruption cannot be hidden by an older green result. Scope/candidate/plan/harness/inputs/toolchain/environment changes have explicit invalidation reason codes. Missing or uncertain identity gives `reuse-ineligible`, not presumed cache hit. On a new resumed invocation of a nonterminal workflow, a completed verify checkpoint is not a reuse-policy bypass: before pending reviewer/archive work, nonreusable checks execute again and downstream authorization is recertified. Eligible checks can reuse after full revalidation. Read-only status/history and an already terminal archived workflow never rerun tests or replay archive merely to display history.

Keep log/script bytes out of compact status. Add read-only `runtime evidence --context <file> [--id <opaqueId>] [--section summary|stdout|stderr|source] [--source-id <opaqueSourceId>] [--cursor <opaqueCursor>] [--limit <1..100>]`. Return schema1 page with bounded items/text, truncated flag and nextCursor. Default list page25, maximum100; text page maximum64KiB. The source section requires a registered source ID belonging to the selected evidence; other sections reject source-id. Cursors bind run, evidence, section and source. No shell execution, arbitrary file reads or side effects. This command must work from the saved state after worktree cleanup; source/candidate validity inspection is distinct from historical evidence readability. Missing state returns unavailable, not invented evidence.

Detail summary exposes bounded `sources: [{id, displayPath, byteCount, hash}]` for the registered harness files, so clients can discover opaque source IDs. displayPath is a sanitized relative label, never filesystem authority. Source pagination returns UTF-8 text without splitting code points and explicit byte counts/truncation.

Expose the same resolver as a read-only `read_verification_evidence` agent tool via the existing scoped API tool dispatcher and MCP bridge. Arguments are id/section/sourceId/cursor/limit; run context is injected by the host and cannot be supplied by the agent. Advertise/bind it to developer and reviewer using each CLI/API transport's existing tool allowlists, including Claude/Codex/Gemini/Kimi. No generic filesystem access to .specrails and no shell requirement. CLI, Desktop and agent tools share pagination, authorization and limits, not independent implementations. Every supported reviewer transport must be able to fetch a multi-file harness and a second output page; otherwise fail capability preflight rather than claim evidence access.

## 5. Status, event projection and metrics

`runtime status --compact` and runtime-result may carry optional `efficiencySummary` schema1:
- runId, workflowVersion, planHash, typed technical acceptance status (`pending|validated|with-exceptions|blocked`) and candidate/report IDs.
- effective role selection and origin; selected/observed model and effort distinct, observed unknown is null.
- invocation counts by kind (`initial|correction|repair|deepen|session-fallback`), escalation history (role/from/to/reason/attemptId), prompt/context/handoff bytes, context full/delta counts.
- executed/reused/invalidated check counts, measured verification duration and evidence list availability.
- measurement completeness and existing cumulative metrics, never counterfactual dollars saved.

Keep RuntimeEfficiency.schemaVersion=1 fields unchanged; providerCalls means executor invocations. New `modelRequests` optional and null if opaque. Do not add cached token counts to input totals. Technical runtime validation is not independent benchmark acceptance, human approval, archive or host delivery.

Emit optional JSONL `runtime-efficiency-event` with schemaVersion1, deterministic eventId, runId, attemptId/executionId, kind and bounded typed payload. Kinds: role-context, role-route, check-started, check-finished, check-reused, check-invalidated, efficiency-summary. Persist through the existing ledger/job event mechanism; do not add workflow phases to represent these events. Stable IDs deduplicate replay and continuation. High-volume stdout remains verification-output/evidence storage; each check stream has repository/check attribution.

Desktop persists validated terminal summaries in existing job events and can show them after worktree/Core cleanup. Desktop assigns a durable invocation ID/ordinal before every initial/continuation launch, independently of optional Core payloads. A later invocation supersedes current presentation even if failed/cancelled or missing/malformed efficiencySummary: its current metrics may be unavailable; the earlier summary remains historical. History and cumulative usage remain intact. It must not claim old evidence is still valid against a changed or unavailable worktree: label it as the recorded result for its original candidate.

## 6. Failure semantics

- Invalid proposal/capability: precise role/config error before effect; malformed role result uses the existing bounded repair contract.
- Harness write failure: no partial plan activation; persisted immutable sources without active manifest are recoverable internal orphans, never delivery files.
- Plan revision during execution: invalidate receipt; no acceptance/approval promotion.
- Check failure: return evidence to developer, without invoking reviewer; no extra model dedicated to verification.
- Concurrent failure/cancel: stop scheduling, terminate and await active process trees, preserve individual statuses, no successful full receipt.
- Evidence endpoint with unknown/cross-run ID: not found; no traversal fallback.
- Missing historical fields: unknown/unsupported presentation; no accidental zero cost or passed status.

## 7. Cross-repo delivery sequence

Core owns schemas/capabilities and executable fixtures. Desktop consumes the packaged contract, not a loose sibling-source assertion. Validate both new Core/new Desktop and old Core/new Desktop admission. Preserve original-runtime continuation. Source bundle smoke, exact published package/lock validation and release workflow pins are separate gates. Implementation task checklist in each repo references this contract; no second divergent copy.
