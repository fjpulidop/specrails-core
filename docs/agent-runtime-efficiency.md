# Efficient programmatic implementation

New runs use workflow 5 and instructions 7. Architect, developer and reviewer keep their official OpenSpec workflow: fast-forward, apply and verify. Verification remains deterministic Core execution, not a fourth AI agent. Custom role text does not replace the mandatory scope, response or OpenSpec protocol.

## Configuration

Optional schema-version-1 settings:

```json
{
  "efficiency": {
    "schemaVersion": 1,
    "contextMode": "incremental",
    "reviewMode": "incremental",
    "planning": "proportional",
    "acceptDeveloperChecks": true,
    "verification": { "maxConcurrency": 1 }
  }
}
```

These defaults are normalized once at admission and frozen. `full` disables the corresponding adaptive policy. Incremental context requires a compatible session and a transport that explicitly guarantees continuation. Built-in CLI transports currently report continuation as unknown; stateless API and Kimi transports cannot receive a partial packet. They receive full context. A smaller prompt in the offline continuation fixture does **not** imply the same saving on every provider.

Each role optionally accepts `effort` and one `escalation: { model, effort? }` within the same provider. Query actual installed support with `specrails-core runtime capabilities --config config.json`; this never runs inference. Unknown effort support rejects an explicit value at admission. Omitting effort leaves the provider default. No economic tier is selected automatically.

Architect escalation is limited to the existing deepen pass. Developer escalation can begin on the third permitted candidate, after two failed outcomes; it adds no attempt to the configured limit. Reviewer escalation repairs malformed responses only, never a valid code rejection. Selected tiers and role session identities persist across interruption. All calls, including repairs, consume the existing budgets.

## Checks and evidence

Host and architect checks form an immutable baseline. Developers can add up to 20 checks per response, with at most 100 effective checks. Reusing a developer key replaces that addition's active revision; omitted additions remain required. A harness contains at most eight UTF-8 source files, 64 KiB each and 256 KiB per proposal. Sources live outside delivery under the run's state directory, not in the product repository. The runtime expands a structured command and exports `SPECRAILS_CHECK_REPO_ROOT` for locating repository files.

Receipts, acceptance and archive approval bind the candidate and complete verification plan. Source changes, interrupted checks or a newer failure cannot reuse an older green result. A nonterminal continuation rechecks and asks the reviewer to certify the current acceptance criteria; terminal reads do not execute checks. Previously granted archive consent only survives when the candidate, plan and acceptance decisions remain identical.

Checks default to `policy.reuse: "never"`. Host-only `snapshot-local` reuse requires explicit deterministic/read-only declarations, complete input/toolchain/dependency contents and a proven executable identity. Ignored installed dependencies must be declared; an unchanged lockfile is insufficient. Unknown inputs rerun. Concurrency defaults to one, with a maximum of four. Only contiguous checks in the same host-declared independence group, on distinct repositories with explicit nonoverlapping resources, run together. Missing resources mean unknown; an explicit empty array means no shared resources.

Read recorded evidence without invoking agents:

```sh
specrails-core runtime evidence --context desktop-context.json --limit 25
specrails-core runtime evidence --context desktop-context.json --id EVIDENCE_ID --section stdout
specrails-core runtime evidence --context desktop-context.json --id EVIDENCE_ID --section source --source-id SOURCE_ID
```

List responses discover opaque evidence/source IDs and bound pagination cursors. Output pages are bounded; stdout/stderr captures retain at most 1 MiB each, with redaction, hashes and truncation markers. Historical source snapshots remain readable after worktree removal. They describe that execution, not current validity. The same scoped resolver is available to developer/reviewer through API and MCP tools.

## Reproducible evaluation

Build first, then run the actual offline command:

```sh
npm run build
node bin/specrails-core.mjs runtime evaluate --output /tmp/specrails-efficiency-evaluation
```

Five fixed cases cover static Tetris-like logic, a local feature, a cross-repository contract, verification correction and review correction. Each independent oracle must accept its reference implementation and reject deliberately defective variants. Full and optimized modes use fresh repositories/sessions and identical acceptance gates. The fixed long-context correction must shrink at least 40% without extra invocations. Reports record task, oracle, repository, configuration and runtime identities, failures, sample variation and independent acceptance.

Offline tokens and zero fixture cost are synthetic. The initial offline run accepted 5/5 cases in both modes and reduced its fixed correction prompt from 4,774 to 1,777 bytes (62.8%). It did not demonstrate lower monetary cost or faster real-provider execution. Repeat after implementation changes; the report records the tested package identity.

Real evaluation is opt-in only: `runtime evaluate --real --config EXPLICIT_MODELS.json --max-cost-usd BUDGET --output OUTPUT`. Select all models and authorize the aggregate spend first. Unsupported spend limits prevent launch; incomplete billing stops further calls. The report distinguishes same-model from configured routing experiments and evaluates the descriptive target of 20% lower aggregate cost per independently accepted output. Small samples and uncontrolled provider caches do not establish universal quality or savings.

## Compatibility and rollback

A v4 checkpoint requires its original runtime. Never rewrite checksums or substitute a newly installed package. Desktop retains an immutable package and dependency closure per admitted run. Restoring that proven package is the recovery path; an unknown original package cannot be inferred from matching workflow inputs alone. New runtime configuration or package changes affect new runs only.

This source tree is a development package. Publishing Core and updating Desktop's exact version/integrity lock are separate coordinated release steps; local assembly is not proof that a new version has been published.
