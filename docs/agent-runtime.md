# Programmatic agent runtime

For immutable definitions, composition, forks and steering, see the
[engine v2 guide](engine-v2/README.md). The built-in implementation workflow
described here remains available through its retained runtime identity.
Interactive, multi-turn agent sessions (missions, chats, sub-agents) use the
separate [agent session runtime](agent-sessions/architecture.md) and its
[session protocol](agent-sessions/protocol.md).

Core executes implementation as a local TypeScript workflow:

```text
architect → developer → verify → reviewer → archive
    │           ↑          │         │
    │           └──────────┴─────────┘  bounded corrections
    └─ investigate once, then ask (or proceed on stated assumptions)
```

The workflow is a [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) state graph. LangGraph owns the traversal, the typed state and its reducers, the checkpoint history, dynamic interrupts (approvals and questions) and time travel; Core owns the role reports, the OpenSpec workflow binding, the verification subprocesses, the acceptance evidence, the receipts, budgets, leases and interrupted-write recovery. Provider adapters execute one role and load its official OpenSpec skill through the explicit headless tool binding; they never invoke the retired implementation orchestrator.

The developer role has the same autonomy the legacy Implement step had: it edits files and runs commands without an OS sandbox (Claude `--tools default --dangerously-skip-permissions` with nested agents and skills disallowed, Codex `--sandbox danger-full-access` like Desktop's legacy rail runs), so it can run the project's tests before handing off, including local servers and browsers: Codex's `workspace-write` seatbelt denies a localhost listen, Chromium's macOS Mach bootstrap registration and the shared browser cache. The architect reads code and authors change artifacts through confined OpenSpec tools; the reviewer stays read-only. Claude roles load only project settings (`--setting-sources project,local`), so `CLAUDE.md` and `.claude/rules` apply while the user's global memory and plugins do not.

This page describes the current source implementation, **runtime API 1**, workflow version 7, checkpoint envelope format 2. An older published Core package can have the same major version and lack this export. Build the paired checkout when developing this feature; do not assume `@latest` contains unreleased changes.

## Requirements and ownership

- Node.js **22.22.3+** and Git on macOS, Linux or Windows. Individual provider CLIs may require a newer Node release.
- Installed and authenticated Claude or Codex CLIs for whichever roles use them; alternatively, a reachable OpenAI-compatible endpoint with tool support.
- A frozen execution context and a new change name. Verification commands are optional: configured commands run as given, the architect proposes the project's own checks for repositories that have none, and a repository with no automated check is admitted and recorded as unverified in the receipt.
- `ownership.git: "host"`. The runtime implements and archives; its caller owns worktrees, commits, pushes, pull requests and backlog delivery. It rejects Core-owned Git delivery rather than reporting success while shipping remains pending.

Specrails, LangGraph and the runtime infrastructure are open source and require no paid orchestration service, tracing backend, Python daemon or database server. Model inference, hardware and existing provider CLIs retain their own costs and license terms. No model download or provider subscription is included.

## Configure providers and roles

Save this as `.specrails/agent-runtime.json`, adapting the verification command to your repository:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "providers": [
    { "id": "claude", "kind": "cli", "cli": "claude" },
    { "id": "codex", "kind": "cli", "cli": "codex" },
    {
      "id": "local",
      "kind": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1"
    }
  ],
  "agents": {
    "architect": { "provider": "claude", "maxTurns": 100 },
    "developer": { "provider": "codex", "maxTurns": 100 },
    "reviewer": { "provider": "claude", "maxTurns": 100 }
  },
  "limits": { "maxAttempts": 3, "timeoutMs": 900000 },
  "verification": [
    { "repositoryId": "app", "command": "node", "args": ["--test"] }
  ],
  "review": { "minScore": 80, "aspects": { "security": 85 } },
  "architect": { "onLowConfidence": "ask", "clarifications": "ask-on-high" },
  "approvalBeforeArchive": false
}
```

`setup` is an optional array with the same entry shape as `verification` (`repositoryId`, `command`, `args`, optional `cwd`, `env`, `timeoutMs`, `key`, `label`; `policy` is accepted and ignored). Validation applies the same rules, including the refusal of credential-like `env` keys and one `key` per check across both lists. The engine v2 `verify` piece runs these commands sequentially inside the admitted workspace before each verification plan (`setup: 'configured'` on the node); they must be idempotent and cheap because they run on every verify visit. A failing setup command blocks the run with a `setup` blocker instead of starting a correction round. Example: `"setup": [{ "repositoryId": "app", "command": "npx", "args": ["playwright", "install", "chromium"] }]`.

`verification` may be an empty array. At run time Core builds the effective plan from the configured commands plus the architect's proposals for uncovered repositories; the plan is frozen in the graph state and reused by every verification and resume. When the plan covers no repository at all, the run still passes through task completion and review, and the receipt lists those repositories under `unverifiedRepositories`.

`review` tightens the review gate. Core's own gate is the floor: overall score at least 70, `security` at least 75, every other aspect at least 60. A lower value is rejected by validation, because the pipeline journal enforces the floor regardless of configuration. The reviewer is told the effective thresholds.

`architect.onLowConfidence` decides what happens when the architect still reports low confidence after its investigation pass (see [Questions and approvals](#questions-and-approvals)): `ask` (default) pauses the run with the architect's question; `proceed` continues on the assumptions the architect stated, recording `design-confidence.json` as `medium` with `assumed: true` and the original `reportedConfidence`. `architect.clarifications` decides whether a high-impact clarification without a safe default pauses the run before planning (`ask-on-high`, default) or the architect proceeds on stated assumptions (`always-proceed`); see [Architect clarifications](#architect-clarifications).

A CLI role's optional `model` is passed to that provider; omitting it uses the CLI's default. Provider IDs are aliases, so you can configure several endpoints or replace an executor without changing workflow code.

To use the local endpoint, set the desired role to `{"provider":"local","model":"your-installed-model-id","maxTurns":100}`. The endpoint must support `POST <baseUrl>/chat/completions`, OpenAI-style function tool calls and a final assistant result. Its model must actually be able to use these tools; a chat-only endpoint is insufficient for the developer role. The example port is a placeholder for your own running server.

For an authenticated endpoint, add `"apiKeyEnv":"MY_MODEL_API_KEY"` to its provider configuration and set that variable in the process launching Core. Omit `apiKeyEnv` when no key is required. URLs cannot contain credentials, query parameters or fragments. Verification commands inherit process credentials; do not put secrets into their persisted `env` overrides.

The configuration schema is [agent-runtime.schema.json](../schemas/agent-runtime.schema.json). `validateRuntimeConfig()` also checks relationships such as role-to-provider references and the review floors. Runtime configuration is separate from Desktop-owned profiles; it does not translate legacy profile routing into programmatic phases.

The [integration contract](../integration-contract.json) is schema 5.7, API 1, legacy workflow 7 and role instructions 17. Its CLI operation catalog includes every machine operation, including offline `evaluate`; `help` is a presentation operation. This source also advertises engine 2, JSON definitions and the implemented piece catalog. Hosts must inspect the selected runtime's capabilities: older retained runtimes still report engine 1 and an empty piece catalog. Source capability support does not establish publication or rollout acceptance.

Legacy resume identity is protected by `definitionFingerprint()` and `implementationWorkflowDefinition()`. The fingerprint fixture covers both normal and compact-developer transition budgets against the actual node descriptors, preserving declaration order, effects, retries and exits. Keep that fixture unchanged during additive engine work; existing runs must continue through their retained original runtime package.

## Declared roles and explicit permissions

The required `agents` assignments remain architect, developer and reviewer. Add optional roles without changing their built-in prompts, invocation argv or workflow identity:

```json
{
  "roles": {
    "security-reviewer": {
      "provider": "claude",
      "access": "read",
      "artifacts": "none",
      "prompt": "Inspect the change for security regressions and report concrete evidence."
    }
  }
}
```

This fragment extends the configuration above. Role IDs match `^[a-z][a-z0-9-]{0,63}$`; `fixer` remains reserved for developer corrections and `deriver` for the Core engine role below. `access` controls source tools and native CLI policies. `artifacts` controls scoped OpenSpec tools: `all` permits proposal/design/specs/tasks, `tasks-checkboxes` permits only task checkbox changes, and `none` denies writes. Progress records require `all` or `tasks-checkboxes`. Native CLIs retain their own workspace sandbox; artifact permissions are not an operating-system filesystem ACL.

A role can declare `openspecSkill` as `openspec-ff-change`, `openspec-apply-change` or `openspec-verify-change`; absent means no OpenSpec binding. `rolePrompts` can override the prompt of a declared role. Built-ins retain implicit read/all, write/tasks-checkboxes and read/none policies respectively. Explicit built-in descriptors must match their assignment and policy. Validation of saved configuration adds no fields; new-run normalization materializes descriptors without editing the original document.

### Engine role `deriver`

`deriver` is a Core engine role used only by the engine v2 `derive-change` piece (capability `deriveChange: 1`). It needs no configuration: it takes `agents.architect`'s provider assignment with the fixed policy `access: read`, `artifacts: all`, `openspecSkill: openspec-ff-change`, and its instructions belong to Core (`prompts.ts`, versioned by `ROLE_INSTRUCTIONS_VERSION`). Its posture is the architect's, inverted: it writes the OpenSpec change for code that already exists and must not invent requirements. A definition that uses `derive-change` declares `deriver` in `roles`; `configuredRoles(config)` always admits it. It is not a pipeline phase and does not appear in `roleIds(config)`, the legacy efficiency summary or `configuredCapabilities`. A reviewer turn in the same run receives the piece's `derivation.json` coverage report and must raise every unexplained file as an issue; see [`derive-change`](engine-v2/pieces.md#derive-change).

`resolveRoleDescriptor(config, id)` and `roleInstructions(descriptor, context, change)` are public APIs. Custom roles use the guarded free loop on OpenAI-compatible providers; the compact architect/developer/reviewer pipelines remain specific to those built-in protocols. Existing context limits, read reuse, budgets, nullable accounting, review gates and verification stay in force. Select models and effort explicitly; no new automatic escalation or cheaper-model policy is inferred for custom roles.

Programmatic `AgentRequest` accepts `access`, `artifacts`, `instructions: 'role'|'none'` and optional `nativeCommand: { id, args? }`. Old built-in requests retain compatible defaults; custom requests require explicit policy. A free request receives no appended role instructions. Native requests use an empty `prompt`, `instructions: 'none'` and no OpenSpec binding; arguments are literal data and cannot contain NUL.

Claude receives `/<id> <args>` and Codex `$<id> <args>`. Unknown namespaces, missing skills and OpenAI-compatible native commands fail with `native_command_unsupported` before provider inference.

`runtime api` advertises `openRoles: 1` together with the engine v2 capabilities listed under [Run from the CLI](#run-from-the-cli). Desktop schema/settings support is paired through D1b. Existing frozen runs continue to use their retained runtime package.

## Run from the CLI

Use an installed Core package that exposes runtime API 1. For a source checkout, run `npm ci` and `npm run build` in Core, then replace `specrails-core` below with `node /path/to/specrails-core/bin/specrails-core.mjs`.

Desktop constructs the execution context automatically. For standalone use, create a context JSON with absolute paths:

```json
{
  "schemaVersion": 1,
  "runId": "feature-navigation-01",
  "backlogRoot": "/absolute/path/to/app",
  "artifactRoot": "/absolute/path/to/app",
  "artifactRepositoryId": "app",
  "repositories": [
    { "id": "app", "name": "App", "path": "/absolute/path/to/app" }
  ],
  "ownership": { "git": "host", "backlog": "host", "worktrees": "host" },
  "specs": [
    {
      "id": "navigation",
      "title": "Keyboard navigation",
      "description": "Implement the agreed keyboard navigation behavior.",
      "repositoryIds": ["app"],
      "acceptanceCriteria": ["Every setting can be reached using the keyboard."]
    }
  ]
}
```

On Windows use absolute paths such as `C:/work/app` or JSON-escaped `C:\\work\\app`. Repository paths must identify existing Git repositories. Multi-repository contexts list every selected repository; `artifactRoot` must be the path of `artifactRepositoryId`. Choose a fresh, portable run ID and a new kebab-case change name. Every acceptance criterion (or the description when a spec has none) becomes a frozen requirement the reviewer must certify.

```sh
specrails-core runtime api
specrails-core runtime validate --config .specrails/agent-runtime.json
specrails-core runtime run --context .specrails/context.json --config .specrails/agent-runtime.json --change keyboard-navigation
specrails-core runtime status --context .specrails/context.json
specrails-core runtime resume --context .specrails/context.json --answer "Keep the existing shortcut map"
specrails-core runtime resume --context .specrails/context.json --approve archive
```

The commands work in macOS shells and PowerShell; quote paths and answers containing spaces. Verification uses `command` plus an `args` array, not a shell command string. Prefer portable Node/npm commands over Bash scripts when the project supports Windows.

Run and resume emit JSON lines: `workflow-event` (the durable ledger events), `agent-event` (role narration and tool activity), `verification-output`, `span` (one per finished role attempt, with `traceId`, `spanId`, timing, status and usage, ready for an OpenTelemetry bridge) and a final `runtime-result`. The direct runtime entry point is `dist/agent-runtime/cli.js`; it also emits JSON errors. The main package CLI can report command-validation errors on stderr. Exit codes are `0` for success, `2` for a pause (approval or question pending), and `1` for failure, blocking or cancellation. A successful Core result means implementation, verification, review, acceptance evidence and archive completed; host delivery remains separate.

`runtime api` returns `{type:"runtime-api",apiVersion:1,coreVersion,runtimeIdentity,workflowVersions:["7"],engineVersion:2,engines:[1,2],nodeKindsVersion,nodeKinds,capabilities,guardrails}` without invoking providers. `nodeKinds` lists the seventeen piece kinds registered by the validation registry (`prompt`, `role-turn`, `decider`, `verify`, `shell`, `openspec-validate`, `openspec-archive`, `condition`, `end`, `approval`, `question`, `gate`, `assign`, `component`, `map`, `implementation`, `join`); `runtime workflows list` returns their full descriptors and `integration-contract.json` (`agentRuntime.engine`, `agentRuntime.nodeKinds`) mirrors the same catalog and `nodeKindsVersion`. Every capability value is a positive integer:

| Capability | Meaning |
| --- | --- |
| `engineV2: 1` | `runtime run --definition` executes published workflow definitions on the SQLite-backed engine; `status`, `resume`, `fork`, `signal` and `cancel` operate on those runs |
| `workflowDefinitions: 1` | `runtime workflows list` and `runtime workflows validate --stdin` expose the piece catalog, definition schema and Core-computed definition hash |
| `openRoles: 1` | Declared roles with explicit access, artifact and instruction policies |
| `fanOut: 1` | `map`/`join` fan-out with bounded concurrency and deferred joins |
| `fork: 1` | `runtime fork` and `resume --invalidate` create a new run from a selected historical visit without modifying the original |
| `steeringInbox: 1` | `runtime signal --stdin` queues bounded operator messages claimed at the next AI attempt; `runtime cancel` is the idempotent cancellation inbox |
| `scopedRecovery: 1` | `runtime recovery --context <json> --stdin` (see [Scoped recovery API](#scoped-recovery-api)) |
| `hostBlockers: 1` | The `verify` piece classifies host preconditions and environment failures before a correction round, repairs the environment once, and exposes a structured `blocker` (`kind`, `reason`, `command`, `args`, `cwd`, `requiredAction`) in its output; `hostBlockers: true` adds the `blocked` outcome and `end.blockerFrom` copies the blocker into `completion.blocker` |
| `setupCommands: 1` | The runtime configuration accepts `setup` and the `verify` piece runs it before each plan (`setup: 'configured'` or an inline list) |
| `deriveChange: 1` | The `derive-change` piece and the `deriver` engine role: derive an OpenSpec change from an existing diff (Flow), with deterministic Blast-radius coverage in `derivation.json` (see `agentRuntime.deriveChange` in `integration-contract.json`) |
| `sessions: 1` | `runtime host --stdio --scope <projectKey\|global>` serves long-lived agent sessions (Claude, Codex, executor-backed providers) with sub-agents, durable journals under `~/.specrails/sessions/<scope>/` and the [session protocol](agent-sessions/protocol.md). Batch operations are unaffected. |
| `flowSessions: 1` | `session.send` accepts `delivery: 'interrupt'`: the running turn ends `interrupted` and the input runs next, ahead of queued inputs; drivers declare `capabilities.interrupt` (`native` or `emulated`). See [deliveries](agent-sessions/protocol.md#deliveries). |
| `reviewBrief: 1` | The reviewer returns an optional advisory risk brief, recorded at every verdict and exposed in `runtime-result.reviewBrief` (see [Reviewer risk brief](#reviewer-risk-brief)) |
| `efficientRoleExecution: 1`, `reproducibleVerification: 1`, `implementationEfficiencyMetrics: 1`, `compactAgentLoop: 1`, `configurableGuardrails: 1`, `compactOutputBudget: 1`, `roleThinkingControl: 1`, `repositoryScope: 1` | Existing built-in workflow capabilities; unchanged |

`engines` lists the engines this package can launch: `1` is the legacy built-in pipeline (`runtime run` without `--definition`) and `2` is workflow definitions. `integration-contract.json` mirrors it as `agentRuntime.engines`. A Core without engine 1 (planned for Core 7) advertises `[2]`; hosts then refuse a legacy launch before admission with `legacy_engine_unavailable`. Hosts that meet a Core predating the field treat it as `[1, 2]` when `engineV2: 1` is advertised, otherwise `[1]`.

Hosts negotiate on these capability keys, never on the Core major version. Saved runs keep working with the package that created them: the frozen `agent-runtime-request.json` records which engine owns the run, and `resume`/`status` honor that record instead of guessing from the installed package. Hosts can send a JSON configuration through stdin to `runtime validate --stdin` (maximum 2 MiB), avoiding temporary files and platform-specific shell quoting. It is mutually exclusive with `--config`. Use `runtime status --context <file> --compact` for process/UI integration: it retains the run and trace identities, phase status and visits, `pendingApproval`, `pendingQuestion`, usage, the completion verdict and the acceptance summary while omitting accumulated outputs, history and frozen context. Omit `--compact` for full inspection.

## Verification output and correction limits

A verification failure caused by the environment is the host's to repair, never the fixer's. Both the legacy graph and the engine v2 `verify` piece share one classifier (`src/agent-runtime/verification-repair.ts`): a host precondition (a registry that rejects the available credentials or cannot be reached, an `Environment variable not found (NAME)` from a package-manager configuration, a git credential prompt, a Playwright browser download that cannot reach its CDN, a failing `setup` command) stops the run as `blocked` with a structured blocker and its `requiredAction`; an environment failure (exit 127, `command not found`, `Cannot find module`, a missing Playwright browser build) triggers the planned installs once (`npm|pnpm|yarn install`, `pip install`, `go mod download`, `cargo fetch`, `npx playwright install <browser>` bounded to 10 minutes) and one re-run of the same plan, narrated in the verification output with the `[environment]` prefix. The `environment-repair` and `lockfile-repair` guardrails switch the installs off; classification always applies. An ordinary assertion failure is untouched. See [engine v2 pieces](engine-v2/pieces.md#verify). The host also prepares the environment before every writer turn (missing Node dependencies and Playwright browser builds) and repairs a `toolchain`/`setup`/`environment` blocker a writer reports, rerunning that turn once; see [`role-turn`](engine-v2/pieces.md#role-turn).

Version drift is an environment failure too. `driftedNodeDependencies(root)` (`src/agent-runtime/compact/environment.ts`) compares each direct dependency a `package.json` declares (`dependencies`, `devDependencies`, `optionalDependencies`) with the version installed in `node_modules/<name>/package.json`, using npm range semantics (`semver.satisfies`, prereleases excluded). It skips specifiers with no locally checkable version (`workspace:`, `file:`, `link:`, `portal:`, `patch:`, `npm:` aliases, git or URL specifiers, dist-tags), never reports absent packages (those are missing dependencies), never throws and reports at most 20. Drift plans the same runner install as a missing dependency (`npm install` / `yarn install` / `pnpm install`), so the preparation before a writer turn repairs a stale warm-linked tree up front, and its outcome names up to five packages (`installed node dependencies in app (@busuu/experiments 5.23.0 does not satisfy ^5.24.0)`). At verification, a failed check whose `cwd` lies inside a package root with drift is classified as an environment failure whatever its output says (a lint error on an untouched file): the host installs once, verifies again, and records the drifted packages in `environmentRepair.drift` (`[{ root, name, declared, installed }]`) in the engine `verify` piece and as an `[environment]` note in the legacy graph. When a successful install leaves a package drifted, the lockfile itself resolves the old version: the host says so (`the lockfile still resolves the drifted version`) and never installs a second time; the second receipt becomes feedback. All of this stays under the `environment-repair` guardrail.

Verification that rewrites candidate files itself (a lint pre-step regenerating a tracked mapping) is not a code failure either. Core diffs the candidate manifest taken before the commands with the one after them, using the candidate's own inclusion rules (ignored files, `node_modules`, `coverage` and other generated-output roots, agent memory and owned OpenSpec artifacts never count), so the receipt names the files in `selfMutation` (`files: [{ repositoryId, path, change }]`, `omittedFiles?`, `commands: [{ repositoryId, label }]`) and its `reason` reads `Verification commands modified N candidate file(s): …` instead of the bare `Candidate changed during verification`. When every command exited 0, the `verification-output-adoption` guardrail (host phase, on by default) keeps those files in the candidate and runs the same plan once more; a stable second run passes and the files are reported as host-adopted verification output (`adoptedOutputs`), which the reviewer and fixer instructions list as exempt from the blast-radius rule on regenerated generated files for the rest of the run. Output that changes again on that re-run, or any self-mutation with the guardrail switched off, stops the run as `blocked` (`nondeterministic-output` blocker, error code `verification_nondeterministic_output`) with the required action to commit the generated output on the base branch or make the generator idempotent; no correction round is spent on it. A failing command keeps the ordinary correction path, led by that command. The legacy graph and the engine v2 `verify` piece share this behaviour (`selfMutationOnly` and `nondeterministicOutputBlocker` in `verification-repair.ts`).

The `exit-code-honesty` guardrail catches test harnesses that print failures but exit with code 0. It recognizes complete count summaries (including TAP `# fail N`, Jest/Vitest test totals and Mocha-style counts) and explicit failure markers. Passing test names such as `rethrows non-404 failures` are descriptions, not failure counts. ANSI colors and Windows line endings are normalized; a partial line at the diagnostic tail boundary is discarded. TAP TODO/SKIP results are not treated as ordinary failed tests. A green suite does not erase another suite's explicit failure.

This is a conservative text diagnostic over the last 16,000 characters of captured output, not a universal parser for every test framework. Test commands must still propagate real failures through their exit status. When the guardrail rejects output, the log includes the matching line so the reported failure can be checked against the runner's results.

Verification failures return to the fixer. `limits.maxAttempts` bounds fixer invocations (default: 3), after which Core blocks with `Implementation correction limit reached`. An explicit resume grants a fresh budget. If the fixer repeatedly reports no defect, inspect the quoted verification evidence before resuming; rerunning an unchanged command cannot correct a diagnostic false positive.

## Questions and approvals

The graph pauses through LangGraph interrupts; the host resumes it with the matching answer.

- **Low design confidence.** When the architect reports `low`, Core first asks the same architect session to investigate the code once more and decide from evidence. If confidence is still low, the run pauses with the architect's single blocking question (`pendingQuestion`), the draft proposal is left on disk for inspection, and `resume --answer <text>` re-runs the architect with the answer as authoritative input. With `architect.onLowConfidence: "proceed"` the run continues on the stated assumptions instead of pausing.
- **High-impact clarifications.** Before planning the architect lists its clarifications; with `architect.clarifications: "ask-on-high"` (default) a `high` one without a safe default pauses the run the same way (`pendingQuestion`, `resume --answer`). See [Architect clarifications](#architect-clarifications).
- **Archive approval.** With `approvalBeforeArchive: true` the run pauses before archive (`pendingApproval`); `resume --approve archive` grants it. The default is no approval, so a fully autonomous run implements, verifies, reviews and archives without a human in the loop.

A resumed node collects its answer before doing any work, so the pass that asked the question is never repeated. Approvals and answers are persisted; a granted approval survives interruption, but invalidated candidate evidence clears it.

## Architect clarifications

The architect's first job is to say what it does not know. Its structured reply carries an optional `clarifications` list (`ARCHITECT_OUTPUT_SCHEMA.clarifications`, at most five):

```json
{"confidence":"high","clarifications":[{"question":"Should archived projects appear in search?","impact":"high","default":null},{"question":"Page size?","impact":"low","default":"25, as in the projects list"}]}
```

- `impact` is `high` (a different answer changes user-visible behaviour, persisted data, a public contract or most of the plan), `medium` or `low`. `default` is the answer the architect would assume, or `null` when no default is safe. A clear ticket has no clarifications.
- **Policy** `architect.clarifications` in `.specrails/agent-runtime.json` (`schemas/agent-runtime.schema.json`):
  - `ask-on-high` (default): when at least one `high` clarification has `default: null`, the architect authors no artifacts and Core pauses the run before planning with `pendingQuestion` (the single question, or a numbered list when several block). `resume --answer <text>` re-runs the architect with the answer as authoritative input, exactly like the low-confidence question. If the architect also reported `low` confidence, its question joins the same pause.
  - `always-proceed`: the run never pauses for clarifications; the architect states a default for each one.
- When the run proceeds, the architect records every clarification it planned on under `## Assumptions` in `design.md`.
- **Design sections.** Whenever the architect proceeds, Core checks the active change's `design.md`: it must contain a `Non-Goals` section (a `## Non-Goals` heading or OpenSpec's `**Non-Goals:**` label) with at least one line of content, and an `Assumptions` section when clarifications were listed. Template placeholders (`<!-- … -->`) do not count. A missing section spends the architect's single structured-output repair turn (`Invalid design.md: …`) in the same session; the run fails if the repaired design is still incomplete.

Where hosts read it:

| Location | Content |
| --- | --- |
| `<backlogRoot>/.specrails/pipeline/<runId>/clarifications.json` | Rewritten when the architect pauses (`status: "awaiting-answers"`, `blocking` lists the questions) and when it proceeds (`status: "proceeded"`, `assumptions` copies the Assumptions lines of `design.md`): `{schemaVersion:1, change, policy, status, recordedAt, clarifications, blocking, answers, assumptions}`. Engine 2 implementation steps write it in their own implementation pipeline directory. Desktop can post the questions or the assumptions to the ticket's tracker from this file. |
| `runtime-result.clarifications` (engine 1 `runtime run`/`resume`) | The same record read at settle, or `null` when the architect has not recorded one. |
| Architect step output (`runtime status`, non-compact) → `clarifications` | Graph state `architecture.clarifications` (omitted when empty). |

The capability is announced as `architectClarifications: 1` by `runtime api` and as `agentRuntime.architectClarifications` in `integration-contract.json` (since schema 5.7). A Core without the capability never pauses for clarifications and writes no record. Desktop copies `schemas/agent-runtime.schema.json` byte for byte; the new `architect.clarifications` key is optional.

## Recovery and durable state

State lives below `<backlogRoot>/.specrails/pipeline/<runId>/`:

| File | Purpose |
| --- | --- |
| `state.json` and `receipts/` | Authoritative Core gates, verification and acceptance evidence |
| `agent-runtime-request.json` | Frozen CLI change name, runtime configuration, runtime identity and `workflow: { id, version, source: builtin \| definition, definitionHash, engine: 1 \| 2 }`. Written once with no overwrite by both engines (a fork destination receives its own); `resume`/`status` select the engine from `workflow.engine`, a request without the block is a legacy run, and `definitionHash` is `null` for the built-in workflow whose identity is the checkpoint `workflowFingerprint` |
| `agent-workflow/<runId>/checkpoint.json` | Legacy engine: one atomic envelope with the host ledger (attempts, receipts, usage, ordered events, pending interrupts) and the complete LangGraph checkpoint history |
| `agent-workflow/<runId>/.lease/` | Legacy engine: exclusive runtime process ownership |
| `agent-workflow/run.sqlite` | Engine v2: the frozen definition, config and context, LangGraph checkpoints, ledger, events, leases and steering inbox in one SQLite database |

Resume uses the saved configuration and change. It rejects a different frozen input, Core/instruction identity or workflow definition. Valid completed phases are retained; stale evidence invalidates the affected phase and everything declared after it, and the graph travels back in time to the checkpoint taken right before that phase last ran, so its predecessors' state is exactly what it saw then. The ledger is authoritative for which node runs next: if LangGraph's own position disagrees after a crash, traversal follows the ledger. Once archived, changed evidence requires a new run.

Correction loops: when verification or review sends work back, the developer receives the feedback together with the change made so far. Session reuse depends on the provider's declared `continuation` capability. Claude CLI declares it `unknown`, so Core never passes `--resume` and every correction is a fresh turn with the full role prompt plus feedback. Codex CLI declares it `supported` when `codex exec resume --help` exposes the expected flags; the previous session is resumed with `exec resume`, but because a resume may fall back cold (`resumeRequiresFullContext`) the full role prompt is resent rather than a short correction prompt. Only a provider that supports continuation without requiring full context receives the short correction prompt and an incremental repository packet. If a resumable session is gone the developer starts a fresh full turn with the same feedback. Unchecked tasks in `tasks.md` are returned to the developer as feedback, not treated as a workflow failure. A run blocked at `limits.maxAttempts` can be resumed explicitly: the resume grants a fresh attempt budget and transition ceiling; visits and history keep the complete record.

Architect and reviewer replies are validated against a JSON Schema (Claude `--json-schema`, Codex `--output-schema`; other providers are parsed leniently, accepting fenced or prefixed objects). The developer finishes with a structured summary (files, tests, verification run, incomplete tasks) validated the same way; a provider that returns prose instead is recorded as such rather than repaired. An unusable architect or reviewer reply gets one repair turn inside the same session before the phase fails. Omitting the assigned OpenSpec workflow uses that same single repair budget: the role must load and execute its official skill, not merely resend JSON. Sessionless providers receive the full original role prompt for this correction. Evidence from an older role visit cannot satisfy a new invocation.

```sh
# Retry a reported failure with the same frozen configuration.
specrails-core runtime resume --context .specrails/context.json

# After inspecting partial edits, explicitly allow an interrupted write to run again.
specrails-core runtime resume --context .specrails/context.json --recover developer

# Recheck evidence explicitly; this also invalidates downstream review/archive.
specrails-core runtime resume --context .specrails/context.json --invalidate verify
```

Inspect the saved phase and worktree before using `--recover`; it authorizes repeating an effect whose completion was not durably recorded. Dead local process leases can be reclaimed. Live, remote or unverifiable leases are never silently stolen. Do not delete a lease while its process may still be running.

Cancellation propagates to owned provider and verification processes. Programmatic callbacks must cooperate with `AbortSignal` and finish subprocess cleanup before returning; the engine retains its lease until they settle. A write step that settles after cancellation is recorded as interrupted and requires explicit recovery.

## Acceptance evidence

Core 5.2 requires acceptance evidence before a change can be archived. The runtime produces it without a separate role:

- The reviewer receives every frozen acceptance criterion with stable coordinates (`specId`, `criterionIndex`) and certifies each one as `met`, `exception`, `blocked` or `pending` with concrete evidence. A reviewer may only accept a non-material exception itself; material scope changes stay `blocked`.
- Core records the verification commands it actually ran as required checks (passed or failed by exit code, with the receipt id as evidence), repositories admitted without a check as unavailable checks, and the reviewer's own inspections as supplementary, never required, checks.
- The report is validated against the frozen scope inside the reviewer turn (a malformed report gets the repair turn), then bound to the exact candidate before the reviewer verdict is recorded. Unresolved requirements or a failed required check block review and archive; the CLI status exposes the reasons.

## Reviewer risk brief

After its verdict the reviewer may add an optional `brief` object to the same structured reply (`REVIEW_OUTPUT_SCHEMA.brief`). The brief is advisory for the human who merges the change: the approval gate (`review-policy.ts`) never reads it, so a brief full of `high` risks does not block an approval and an empty brief does not weaken a rejection.

```json
{"brief":{
  "behaviourChanges":[{"what":"…","where":"src/x.ts:41","userVisible":true}],
  "invariantsTouched":[{"invariant":"…","evidence":"src/q.ts:120-138","status":"kept|changed|at-risk"}],
  "untested":[{"path":"src/x.ts","why":"…"}],
  "risks":[{"severity":"high|medium|low","area":"data|security|api|ux|performance|ops|other","whatToLookAt":"…","ref":"file:line"}],
  "humanChecks":["…"],
  "divergences":[{"capability":"…","requirement":"…","observed":"…"}]
}}
```

- Every section is optional and may be empty; a reply without `brief` (an older reviewer, a custom reviewer definition that ignores it) is valid and records no brief. The reviewer is told that every risk points to `file:line`, that `untested` lists code paths the diff touches which no test in the verification plan exercises, and that `humanChecks` lists what it cannot verify read-only. `divergences` lists spec claims of a touched capability that the code contradicts (reviewer check 9, see [Requirement traceability](#requirement-traceability)); it is empty when the specs and the code agree.
- Core validates the brief after the verdict and the acceptance report. Text fields are trimmed and bounded (2,000 characters, 20 items per list). Core orders `risks` by severity (stable within a severity) and keeps the first five; the remaining risks are appended to `acceptance.findings` as `Additional <severity> <area> risk (beyond the brief's top 5): <whatToLookAt> (<ref>)`.
- A malformed brief on the first reply spends the reviewer's single structured-output repair turn (`Invalid review brief: …`). If the repaired reply still carries a malformed brief, Core keeps the repaired verdict, drops the brief and records a diagnostic (`briefDiagnostic`, plus a reviewer narration line) instead of failing the review.
- The compact (OpenAI-compatible) reviewer passes a `brief` through unchanged when its model sends one; it is not prompted for it.

Where hosts read it:

| Location | Content |
| --- | --- |
| `<backlogRoot>/.specrails/pipeline/<runId>/review-brief.json` | Rewritten at every reviewer verdict, approved or not: `{schemaVersion:1, change, approved, score, recordedAt, brief: ReviewBrief \| null, diagnostic?}`. Engine 2 implementation steps write it in their own implementation pipeline directory. |
| `runtime-result.reviewBrief` (engine 1 `runtime run`/`resume`) | The same record read at settle, or `null` when no reviewer verdict was recorded. |
| `openspec/changes/<change>/confidence-score.json` → `brief` | Approved verdicts only; archived with the change. Absent when there is no brief. |
| Reviewer step output (`runtime status`, non-compact) → `brief`, `briefDiagnostic` | Graph state `review`; the engine 2 `implementation` piece output carries it as `review.brief`. |

The capability is announced as `reviewBrief: 1` by `runtime api` and as `agentRuntime.reviewBrief` in `integration-contract.json` (since schema 5.5). Hosts must treat every field as optional.

## Requirement traceability

Every OpenSpec requirement has a stable id and tests claim the requirements they demonstrate. `src/pipeline/spec-trace.ts` (Node built-ins only; installed projects get it as `.specrails/runtime/spec-trace.mjs`) crosses both with verification receipts.

- **Requirement id.** `<capability>/<slug>`: `capability` is the directory under `openspec/specs/`, `slug` comes from the `### Requirement: <name>` heading: Unicode NFKD with accents removed, lowercase, every run of non-alphanumeric characters one `-`, no leading or trailing `-`. `### Requirement: Pausa con pregunta: ¿qué ocurre?` in `openspec/specs/runs/spec.md` is `runs/pausa-con-pregunta-que-ocurre`. The OpenSpec format is unchanged.
- **Test tag.** `[spec:<id>]` anywhere in a test title, or a comment `// spec: <id>` (`# spec: <id>` in Python and shell; `--`, `;`, `%` and block-comment openers work too) on the line before the test. Any language.
- **States.** `demonstrated`: a tagged test file was reached by a verification command that exited 0. `undemonstrated`: `no-test` (no tag), `not-executed` (tagged but no passing command reached the file, or no evidence) or `failed` (only failing commands reached it). `untagged`: a tag that matches no requirement (a typo, or a renamed or removed requirement); advisory.
- **Touched requirements.** The ADDED, MODIFIED and RENAMED (new name) requirements of the change's delta specs (`openspec/changes/<change>/specs/`, or its archive). They count as requirements before the change is archived; REMOVED and renamed-from requirements no longer count.
- **Test files.** Every test-shaped file of each repository (`*.test.*`, `*.spec.*`, `test_*.py|sh`, `*_test.*`, `*_spec.rb`, `*Test.java`, `*.bats`; `node_modules`, `dist`, `build`, `.git`, `.specrails`, `openspec` and similar are skipped), optionally restricted to `--tests` globs, plus the files the developer reported.

**In a run.** After every passing verification the verify node writes `<backlogRoot>/.specrails/pipeline/<runId>/spec-trace.json` (bound to the receipt id; Core's test-reachability check decides which commands reached which files) and puts a summary in the verification record (`verifyResult.specTrace`). The trace is advisory: it never changes the verification outcome or the acceptance status. The acceptance report records it as a finding, `Spec trace (advisory, receipt <id>): Requirements demonstrated X/Y; touched by this change A/B (not demonstrated: …).`

- The developer prompt lists the requirement ids the change touches under `## Requirement tags` and asks for one tagged test per id.
- The reviewer receives the trace with the verification result. A touched requirement that is not demonstrated is an issue naming the id (check 3). Check 9 compares the claims of each touched capability's specs with the code and reports contradictions in `brief.divergences` (`{capability, requirement, observed}`).

| Location | Content |
| --- | --- |
| `<backlogRoot>/.specrails/pipeline/<runId>/spec-trace.json` | `{schemaVersion:1, generatedAt, changes, evidence: "receipt", receiptId, requirements, demonstrated[{id, name, tests}], undemonstrated[{id, name, reason, tests}], untagged[{tag, repositoryId, file, line, form}], touched, touchedUndemonstrated, scannedFiles}`. Desktop shows "Requirements demonstrated `demonstrated.length`/`requirements`" from it. |
| `runtime-result.specTrace` (engine 1 `runtime run`/`resume`) | The same report, or `null` before the first passing verification. |

**From the CLI or CI.**

```sh
specrails-core pipeline trace [--root <dir>] [--context <context.json>] [--change <name>[,…]] [--tests <glob>[,…]] [--tests-passed] [--check] [--json] [--out <file>]
node .specrails/runtime/trace.mjs --check --tests-passed   # inside an installed project
```

- Without `--context` it scans `--root` (default: the working directory) and checks the active changes under `openspec/changes/` (or `--change`). It has no receipt, so nothing is executed unless `--tests-passed` says the tests already passed in this job. With `--context` it reads the run's receipt from `state.json` and the run's change.
- Normal mode never fails: it reports and exits 0, even when it cannot read something. `--check` exits 1 when a requirement touched by the change is not demonstrated (or the scan fails).
- A CI step after the test suite: `"spec:check": "specrails-core pipeline trace --check --tests-passed"` in `package.json`, run as `npm test && npm run spec:check`.

**Drift sweep.** `src/agent-runtime/engine/__fixtures__/drift-sweep.json` is a read-only reference definition that runs check 9 across every capability on demand: one `role-turn` of a host-declared read role `drift-auditor` (`roles: {"drift-auditor": {provider, access: "read", artifacts: "none"}}`) with structured output `{divergences: [{capability, requirement, observed}], unchecked: [string]}`. Remove its `version`, bind the provider and publish it like any definition.

The capability is announced as `specTrace: 1` by `runtime api` and as `agentRuntime.specTrace` in `integration-contract.json` (since schema 5.7).

## Baseline on touch

With `baselineOnTouch: true` in `.specrails/agent-runtime.json` (default `false`), a change that reaches code no capability describes starts by describing it: characterization tests of today's behaviour and a minimal as-built spec, proven on the unchanged code before the developer edits the module.

1. **Capability map.** The archive step maintains `openspec/capability-map.json`: `{schemaVersion: 1, capabilities: {<capability>: {files, changes}}}`, merging the files each archived change touched (from Core's change set, OpenSpec and `.specrails/` paths excluded; `<repositoryId>:` prefix outside the artifact repository) into every capability of its delta specs. The file is Core metadata: new journals exclude it from the reviewed candidate, and it is committed with the change by the host. It is updated whether or not `baselineOnTouch` is on, so coverage accumulates before the setting is enabled.
2. **Detection.** After planning, Core reads the `Blast radius` section of `design.md` (backticked paths, or the first path of each bullet; `<repositoryId>:path` for other repositories). A file needs a baseline when it exists, is code (tests, documentation, lockfiles and OpenSpec files are skipped), is not listed in the capability map, and neither its path nor one of its specific directories (`src/search/`, not a bare `src/`) appears in any `openspec/specs/*/spec.md`.
3. **Plan.** Uncovered files send the architect, in the same session, an extra turn (invocation kind `baseline`) to insert a `## 0. Baseline` task group before the change tasks (characterization tests per module) and an as-built spec under `## ADDED Requirements` with requirements tagged per [requirement traceability](#requirement-traceability). Core validates both and spends the single repair turn otherwise.
4. **Hard rule.** The developer's first turn (kind `baseline`) completes only the Baseline group. Core then refuses any non-test edit, checks that the verification plan reaches the characterization tests and runs the full plan on the unchanged code. A non-test edit, an unreached test, a missing verification command or a failing receipt stops the run as `blocked` with error code `baseline_characterization_failed` and a sentence naming what to fix; resume reruns the stage. Only a passing receipt lets the visit continue with the change tasks.
5. **Review.** The developer and reviewer prompts carry a `## Baseline` section with the receipt and the characterization tests. The reviewer checks that every as-built requirement describes behaviour its tagged test demonstrates on the base code; one that does not is an issue.

| Location | Content |
| --- | --- |
| `<backlogRoot>/.specrails/pipeline/<runId>/baseline.json` | `{schemaVersion: 1, change, status: "not-needed" \| "planned" \| "passed" \| "failed" \| "violated", recordedAt, detection: {blastRadius, covered, uncovered, skipped}, tests, receiptId?, reason?}` |
| `runtime-result.baseline` (engine 1 `runtime run`/`resume`) | The same record, or `null` when the setting is off. |
| `efficiencySummary.invocations.byKind.baseline`, `efficiencySummary.baseline` | Baseline turns counted apart: `{invocations, roles, costUsd, inputTokens, outputTokens}` (null when a provider reported no value). The receipts of the base-code run are ordinary verification receipts. |

The capability is announced as `baselineOnTouch: 1` by `runtime api` and as `agentRuntime.baselineOnTouch` in `integration-contract.json` (since schema 5.7).

## Project rules inventory

`specrails-core rules inventory` records what a repository already enforces and how each of its written rules is checked, in `.specrails/rules.json`. It is re-runnable; `init` runs it offline after installing.

```sh
specrails-core rules inventory [--root <repo>] [--artifact-root <dir>] [--offline] [--reclassify] [--json]
```

1. **Gates (deterministic).** Package scripts (`lint`, `format`, `typecheck`, `test`, architecture and OpenSpec scripts, run through the lockfile's package manager), lint and format configurations without a script (ESLint, Biome, Prettier, Ruff, Black, mypy, golangci-lint, rustfmt, clippy, RuboCop), a `strict` `tsconfig.json`, architecture tests and dependency-cruiser, git hooks (`.husky/`, `.githooks/`, pre-commit, lefthook), the check-like `run:` steps of `.github/workflows/*.yml` and `openspec validate` when `openspec/` exists. Each gate is `{id, kind, command, source}`; commands are deduplicated.
2. **Rules (deterministic).** List items and strongly normative sentences (must, never, always, do not, required…) of `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` (also under `.github/` and `docs/`), outside code fences, tables and Specrails-managed blocks, at most 200. Each rule keeps its text and `source` as `file:line`; its id is a hash of the file and the statement, so it survives line moves.
3. **Classification (one AI call).** The `agents.architect` provider of `.specrails/agent-runtime.json` receives the gates and the rules not yet classified, read-only and without role instructions, and returns a status per id: `enforcedBy` (with the gate id or test that enforces it), `automatable` (with `proposedCheck`) or `humanOnly`. The model cannot add, drop or reword a rule; unknown ids and statuses are ignored. Offline (`--offline`, `init`), without a configuration or on a failed call, rules stay `unclassified` and `classification.status` says why. Classifications are cached by rule id: a re-run classifies only new or changed statements (`--reclassify` forces all).

| Field | Content |
| --- | --- |
| `gates[]` | `{id, kind: "lint" \| "format" \| "typecheck" \| "test" \| "architecture" \| "hook" \| "ci" \| "spec", command, source}` |
| `rules[]` | `{id, text, source: "<file>:<line>", status: "enforcedBy" \| "automatable" \| "humanOnly" \| "unclassified", enforcedBy?, proposedCheck?}` |
| `classification` | `{status: "classified" \| "cached" \| "offline" \| "unavailable" \| "failed" \| "empty", provider?, model?, reason?, classifiedAt?, usage?}` |

The runtime reads `<backlogRoot>/.specrails/rules.json`, then `<artifactRoot>/.specrails/rules.json`:

- The reviewer receives the `humanOnly` rules under `## Project rules that need a human` and copies the ones the change could break into `brief.humanChecks`. They never become issues for the developer.
- When the host configured no verification command, the architect receives the discovered gates under `## Project gates (default verification)` as the default verification proposal for the artifact repository; it keeps only the gates that exercise the change.

Claude Code installs also get a Specrails-managed block in the root `CLAUDE.md` (between `<!-- specrails-managed:start -->` and `<!-- specrails-managed:end -->`, content outside it preserved), as Codex (`AGENTS.md`), Gemini (`GEMINI.md`) and Kimi (`.kimi-code/AGENTS.md`) already did. It points the agent at `.specrails/rules.json`.

The capability is announced as `rulesInventory: 1` by `runtime api` and as `agentRuntime.rulesInventory` in `integration-contract.json` (since schema 5.7).

## Budgets and provider capability differences

| Setting | Behavior |
| --- | --- |
| `agents.<role>.maxTurns` | Bounded role/tool interaction, default 100; provider transports enforce their available turn/tool events |
| `limits.maxAttempts` | Maximum development visits per invocation, including correction cycles, default 3; an explicit resume starts a fresh budget |
| `limits.timeoutMs` | Workflow duration limit and provider timeout; default provider timeout is 15 minutes when omitted |
| `limits.maxTokens` | Rejects missing required usage or an observed overrun; CLI accounting may arrive only after a call |
| `limits.maxCostUsd` | Accepted by the built-in Claude executor through its native dollar limit; rejected by built-in Codex and OpenAI-compatible executors |

Do not configure `maxCostUsd` for a mixed-provider run unless every selected custom executor can enforce the requested cap. An observed token limit cannot guarantee that an opaque CLI stops before spending those tokens. Provider spend is accounted the moment each call returns, so a pause or failure after a call never loses it. Unknown usage stays `null`; known spend is tracked as a lower bound, never fabricated as zero. Local endpoints can report zero cost, but absent billing data remains unknown.

## Embed and extend

Import the public ESM entry point; TypeScript declarations are included:

```ts
import { readFileSync } from 'node:fs'
import { runCoreWorkflow, validateRuntimeConfig } from 'specrails-core/agent-runtime'

const context = JSON.parse(readFileSync('.specrails/context.json', 'utf8'))
const config = validateRuntimeConfig(JSON.parse(readFileSync('.specrails/agent-runtime.json', 'utf8')))
const controller = new AbortController()
const state = await runCoreWorkflow({
  context, config, change: 'keyboard-navigation', signal: controller.signal,
  onEvent: event => process.stdout.write(JSON.stringify(event) + '\n'),
  onSpan: span => process.stdout.write(JSON.stringify(span) + '\n'),
})
console.log(state.status, state.nextStep, state.pendingQuestion?.question)
```

Programmatic hosts retain their input/config and supply the same values with `resume: true`, plus `approve`, `answer`, `recoverInterrupted` or `invalidate` as needed. The CLI additionally creates the frozen request file for you.

Register an executor directly to add a provider in code. This example registers a private local endpoint with no CLI installation:

```ts
import {
  ExecutorRegistry, OpenAICompatibleExecutor, runCoreWorkflow,
  type RuntimeConfig,
} from 'specrails-core/agent-runtime'

const registry = new ExecutorRegistry().register('on-prem',
  new OpenAICompatibleExecutor({
    id: 'on-prem', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1',
  }),
)
const config: RuntimeConfig = {
  schemaVersion: 1, enabled: true, providers: [],
  agents: {
    architect: { provider: 'on-prem', model: 'your-installed-model-id' },
    developer: { provider: 'on-prem', model: 'your-installed-model-id' },
    reviewer: { provider: 'on-prem', model: 'your-installed-model-id' },
  },
  verification: [{ repositoryId: 'app', command: 'node', args: ['--test'] }],
}
// context is the frozen JSON object from the preceding example.
await runCoreWorkflow({ context, config, registry, change: 'local-navigation' })
```

A custom executor implements `AgentExecutor.execute(request): Promise<AgentResult>`. The request contains role, central instructions, allowed roots, model, limits and signal. Return final text and honest `{inputTokens, outputTokens, costUsd}` usage; use `null` for unavailable values. The executor must enforce role permissions and supported limits, own its tool/process cleanup, and throw on incomplete results. `createExecutorRegistry(config, {executors: {alias: executor}})` can replace or supplement configured providers.

An optional, side-effect-free `validateLimits({maxTokens, maxCostUsd})` method rejects unsupported limits before any role runs. Built-in executors provide this preflight; custom registrations own their capabilities. Core also validates the complete verification command plan against the frozen repository scope before creating a run or invoking providers.

For a different host workflow, use `runWorkflow()` with a LangGraph state schema and typed nodes:

```ts
import { Annotation } from '@langchain/langgraph'
import { runWorkflow } from 'specrails-core/agent-runtime'

const State = Annotation.Root({ notes: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) })
await runWorkflow<typeof State.State>({
  directory, runId, input: { change }, workflow: {
    id: 'my-host', version: '1', schema: State, entry: 'plan',
    nodes: {
      plan: { ends: ['build'], run: async () => ({ status: 'succeeded', update: { notes: ['planned'] } }) },
      build: { effect: 'write', ends: ['plan'], run: async (state, context) => {
        context.reportUsage({ costUsd: 0.1, inputTokens: 10, outputTokens: 5 })
        if (state.notes.length < 2) return { status: 'succeeded', next: 'plan' }
        context.interrupt({ kind: 'approval', reason: 'Ship it?' })
        return { status: 'succeeded', next: null }
      } },
    },
  },
})
```

Each node declares its `effect`, optional retry bounds, its possible successors (`ends`) and `run(state, context)`. A result supplies `status`, an optional graph `update` (merged through the schema's reducers), an optional ledger `output` and an optional `next` for conditional routing; `null` completes the workflow. Node names must not collide with state channel names. Nodes pause with `context.interrupt()` and report provider spend with `context.reportUsage()` as it happens. Write retries require `retrySafe: true`; interrupted writes still require explicit recovery. `readWorkflowState(directory, runId)` is read-only. Observer exceptions cannot replay a committed step. The Core nodes themselves are exported as `coreNodes(deps)` for hosts that want to reuse a phase inside another graph.

## Tools, specifications and compatibility

The OpenAI-compatible tool executor exposes scoped listing, literal text search, numbered line reads and a single-file Git diff. Developers additionally have whole-file writing and exact-match patches. It rejects traversal, symlink escapes and protected runtime metadata. It has no model-accessible shell tool; Core owns verification subprocesses, and `get_diff` runs fixed, read-only Git commands with external diff and text conversion disabled. This is a tool policy, not an operating-system sandbox for arbitrary custom executors or external CLIs.

### Code workspace verification

A frozen repository scope names the code workspaces inside its checkout. Verification command cwd must remain inside one of those scopes; repository parents, sibling packages and symlink escapes are rejected before spawning. With several scopes, agent-proposed checks require an explicit cwd per workspace. Desktop expands host checks without cwd across the selected workspaces and records the actual checkout paths.

### Efficient development and workspace tools

The programmatic developer runs focused tests while implementing. Core alone runs the complete configured verification plan after the developer returns, and feeds real failures into the correction session. The developer's self-reported checks never replace a Core receipt. This removes the instruction to run the same full suite twice; it does not weaken the final gate. The implement command enters this same runtime, for one ticket or several tickets in one aggregate run.

| Tool | Input | Behavior |
|---|---|---|
| `search_text` | `path`, literal `query`, optional `maxResults` (1–100) | Searches bounded source files; skips generated/dependency directories, protected metadata, symlinks and binary/large files. Returns numbered matches, `skipped` and `truncated`. |
| `read_lines` | `path`, optional one-based `startLine` / `endLine` | Reads up to 500 lines / 48 KiB from a file up to 1 MiB; returns the full-file SHA-256, line count and continuation information. |
| `get_diff` | One file `path` | Shows staged and unstaged changes against HEAD, up to 48 KiB. Reports untracked files without dumping their contents; inspect them with `read_lines`. Requires Git and a HEAD commit. |
| `apply_patch` | `path`, unique nonempty `oldText`, `newText`, optional `expectedHash` | Developer-only atomic replacement of one exact fragment. Rejects ambiguous, absent or stale context. Resulting files remain limited to 256 KiB. |

These operations do not silently widen a role's write permissions. Ranged reads keep original line endings, so include the original `\r\n` when matching multiline Windows text. Use the returned hash to reject changes made since a read.

### Measuring efficiency

`runtime status` and `runtime-result` include an additive `metrics` object with `schemaVersion: 1`. `runtime status --compact` also includes it under `state.metrics` for Desktop. Desktop shows **Usage and time** on saved runtime executions; older Core versions simply omit it.

The summary contains `total` and `phases` (architect, developer, verify, reviewer, archive). Each phase reports attempts, measured attempts, wall duration, agent duration, provider calls, tool calls, input/output tokens, reported dollar cost and optional uncached/cache-read/cache-write input counters. Provider and requested-model identifiers are retained per phase; absent model identifiers mean the provider selected its default.

- Agent time covers the whole executor call, including CLI startup and native tools. It is not an inference-only measurement. Verification time is the `verify` phase duration.
- A provider call means one executor invocation; an API invocation can contain multiple model/tool rounds. Tool calls count observed tool-start events, including failed/denied tools. They are not an independently billed token category.
- Cache counters are subsets of input tokens, not additional tokens. Missing counters or costs remain `null`. No pricing table or estimated discount is applied.
- Failed calls, fallback sessions, repairs and earlier correction attempts remain included. Polling or resuming without another provider call does not add spend. Run totals are cumulative; `invocationUsage` retains its existing meaning of spend in the latest CLI invocation.
- The Core host persists each completed provider call and its reported usage on the current attempt before continuing. A process killed inside an opaque provider call can still lose unreported usage; completed calls are not a hard upper bound on that provider's bill. In engine v2, the next fenced owner closes abandoned calls as interrupted and emits their unknown usage exactly once, retaining unreported budget reservations. Older attempts without invocation metadata show incomplete measurements rather than fabricated zeros.
- Total execution duration accumulates active workflow time, excluding time parked for human approval between invocations. Phase time includes phase overhead; do not add agent time to phase time. A phase without an end timestamp has unknown duration.

Role instructions are version 17 (`ROLE_INSTRUCTIONS_VERSION`). Frozen runs reject an incompatible instruction/runtime identity; finish them with their original Core version or start a new run. New metrics are additive and need no database migration.

To evaluate the first efficiency changes, select a fixed set of representative tasks and reset each task to the same base revision. Keep provider/model settings and acceptance criteria fixed. Save status JSON for every run, including failures and manual recovery, and compare:

1. Total reported spend divided by independently accepted implementations, including failed attempts/runs in the numerator. Separate cohorts with missing billing instead of counting them as free.
2. Median and p95 active execution time, provider calls, input/output tokens and verification time.
3. First-pass completion, correction attempts, acceptance-test results, reviewer defects and human changes required before acceptance.

The metrics do not themselves establish quality or savings. Compare the legacy engine and the new engine on equivalent tasks with the same independent acceptance checks, then evaluate model routing or additional parallelism separately.

Architect and reviewer responses are structured metadata. The architect authors real OpenSpec delta artifacts using the official fast-forward skill and CLI instructions. Archive uses the real OpenSpec CLI in a staging copy and publishes its merged main specifications with a durable preimage/write journal; it never replaces main specifications with delta text. The developer may update task checkboxes, but changing approved design, task descriptions or specification content invalidates the gates.

Implementation uses this runtime exclusively, including multi-ticket aggregate runs; there is no separate batch command. The installed `implement` and `retry` commands are thin entry points; they do not orchestrate provider-native role waves. Profile v1 remains available for other workflows. Desktop stores provider connections globally and role assignments per project; existing connections migrate without discarding endpoints. An admitted run remains bound to its frozen request after settings changes. See the [integration contract](../integration-contract.json) for runtime API and artifact paths, and Desktop's programmatic runtime guide for release pairing and continuation/delivery behavior.


## Official OpenSpec role workflows

Core depends on OpenSpec **1.14.3** and resolves that package's executable directly, independently of the PATH shim. It generates the official `ff`, `apply` and `verify` skills using the package's own installer in an isolated directory. Version, document hashes, project configuration and change identity are frozen in the checkpoint. The default `openspec/config.yaml` that `new change` scaffolds (`schema: spec-driven`) counts as no project configuration, so the architect's first write does not change a run's identity. Version 3 runs must finish using their original Core or start a new implementation; they are never reinterpreted as deltas.

The binding prompt answers the skills' store selection and project check: Core never selects an OpenSpec store, and the admitted repository is the project, so `new` may create its repo-local `openspec/` root. Before the plan freezes, `openspec-validate` dry-runs `archive` on a disposable copy, because delta validation does not check a MODIFIED or RENAMED header against the main specs, nor an ADDED one for duplicates.

Runs admitted under an earlier OpenSpec pin (Core 6.6.4 and older pin 1.4.1) are not resumable by this Core: their checkpoint freezes the OpenSpec version and skill hashes, and `prepareOpenSpec` refuses a saved skill marker from another version. They continue with their original Core package, which Desktop retains together with its own dependency closure, including that OpenSpec copy. The legacy v4 resume test reproduces such a retained install from a pinned 1.4.1 fixture.

The architect loads `openspec-ff-change`, calls `new`, `status` and artifact `instructions`, and writes the artifacts itself through `write_artifact`. The developer loads `openspec-apply-change`, reads the real apply context and updates task checkboxes. The reviewer loads `openspec-verify-change`, inspects code and the real apply context, then reports acceptance evidence. `verify` is not an artifact ID for `openspec instructions`. Questions map to LangGraph interruptions; progress narration replaces provider-specific TodoWrite helpers.

All current headless adapters explicitly use **official skill-document adaptation**, not a claim of native slash-command activation. The tool returns the exact generated skill; Core does not maintain copies of its templates in prompts.ts. CLI adapters use a local stdio MCP server named `specrails_openspec`; API adapters expose the same implementation as `openspec_workflow`.

| Transport | OpenSpec binding |
| --- | --- |
| Claude | Explicit per-process MCP configuration; architect/reviewer native tools remain Read/Grep/Glob plus ToolSearch for deferred discovery of the scoped workflow tool. |
| Codex | Process-local MCP configuration with approval of this first-party tool; read-only roles keep the native read-only sandbox, writer roles run with `danger-full-access`. |
| OpenAI-compatible API | The same confined OpenSpec operations alongside the existing workspace function tools. |

No global provider configuration is rewritten. Supported planning is currently **repo-local spec-driven**, without local schema overrides. Custom planning homes/schemas fail explicitly; adding one requires conformance tests. The architect's tool cannot edit application code, the developer's artifact tool changes only checkboxes, and the review tool cannot write. Native developer code tools retain their existing provider permissions.

When fast-forward reuses an existing complete change, `load_skill` returns real
`status` and `instructions tasks` results and records both prerequisites. The
architect must still reconcile the artifacts with the current request; existing
files never bypass completeness or validation. Fresh and incomplete changes keep
the normal artifact dependency order. Missing workflow diagnostics name the
specific omitted instructions in the correction message.

Apply-bound developer/correction and verify-bound reviewer turns receive the exact pinned official
skill and real status/apply instructions from Core before provider invocation.
The scoped trace marks these prerequisite queries with `origin: host`; provider
calls retain their own origin. Agents still read the returned context files and
perform the remaining skill procedure. Reviewer bootstrap retains read-only
source access and no artifact writes, including for custom review roles.
This bootstrap cannot certify tasks,
verification, review or delivery, and an unrelated failed check remains a failure.

Definition checks and native/legacy implementation feedback expose a bounded
`failureSummary` alongside command, cwd, original exit code and `evidenceId`.
Failed commands receive the shared feedback text budget before successful ones.
Compiler and runtime errors receive priority, including TypeScript diagnostics
with file/line coordinates and global compiler errors. Warning-only lint
summaries are not failure anchors. Bounded space remains reserved for failed
test names, expected values and application locations separately from source
dumps; contextual excerpts use the same classification. Full subprocess
evidence remains available through the scoped evidence tool; these facts never
waive the failed receipt.

The default fixer reproduces and classifies the reported failure before choosing
a repair. A filename absent from the current diff does not establish that a
failure is unrelated. A mandatory test inside the admitted workspace can receive
a proven minimal compatibility repair, including whitespace tolerance in a source
assertion, provided every required operand/guard and the behavior stay intact.
The fixer validates negative cases, preserves original focused test exit codes,
and reports unresolved failures with evidence instead of claiming success.

Advancement requires an observed official skill/instructions tool trace, nonempty planning artifacts, unblocked apply state and strict CLI validation. Existing code verification, frozen-candidate fingerprints and acceptance review still gate completion; a CLI exit code or checked task alone is insufficient. Traces prove tool use and outputs, not perfect semantic compliance by a model.

Deterministic tests cover the real CLI, real stdio MCP, API function calls, adapter configuration, main-spec merging and interrupted archive recovery. Native model-backed end-to-end certification is a separate check; help/argv tests alone do not establish model behavior or support every installed CLI version.

For developer and reviewer, the agent’s `load_skill` request also runs the official read-only `status` and `instructions apply` commands and returns their unmodified JSON under `planning`. Successful prerequisite queries are recorded with `via: load_skill`; failed or cancelled loading records no participation. The agent must still read the context files and implement or review according to the official skill. This avoids a redundant model correction solely for an omitted planning query; host validation does not count as role participation.

Tool activity includes untruncated target paths and an explicit working directory when the provider supplies them. Desktop uses the admitted repository map to label multi-repository actions in persisted logs and narration; unknown targets stay unattributed and role identity does not imply a fixed repository.

## Editable role definitions

Desktop Settings exposes global architect, developer and reviewer task definitions below Provider connections. `runtime prompts` returns the actual Core defaults. Desktop stores overrides in `~/.specrails/runtime-role-prompts.json` and freezes the effective `rolePrompts` map in each new job configuration. Saving or resetting a definition never changes a saved job; resume uses its existing frozen configuration. The optional map supports the three roles only, with nonblank definitions up to 20,000 characters and no null bytes.

Overrides replace the role task definition across providers. Scope, acceptance evidence, correction feedback, output contracts and the mandatory OpenSpec binding are still assembled by the runtime. Omitted definitions retain the existing factory wording for older saved jobs. Resetting a role removes its global override, so future jobs use the active Core default.

### Engineering identity and blast radius discipline

The factory definitions cast the three roles as one T-shaped principal engineer: decades across web, mobile and backend, deep in software design and testing, broad across product, UX, data, security, infrastructure and operations, fluent in hexagonal (ports and adapters) architecture, SOLID, design patterns, Clean Code, The Pragmatic Programmer, refactoring, legacy-code seams and AI-assisted development, designing for the user, the operator and the next maintainer. The wording turns that into checkable heuristics rather than book titles: dependencies point inward and follow the layering the repository already uses; a port, pattern or abstraction appears only where a real substitution or variation boundary exists; composition over inheritance; illegal states unrepresentable; understand before you change (a guard you cannot explain stays); reversible decisions and a thin vertical slice first, with rejected alternatives recorded in `design.md`; parse and validate at the boundary; explicit failure paths, idempotency, cancellation, timeouts, resource cleanup and concurrency; security hygiene (parameterized queries, escaped output, no secrets or personal data in code or logs, least privilege); errors with context and repository-conventional observability; additive, rollback-safe migrations and persisted formats; platform concerns (web state and accessibility, mobile lifecycle and offline, backend transactions and boundary validation) as far as the change touches them; every API, signature and version verified against the source instead of recalled from memory; tests as the specification (one behavior each, no logic in tests, mocks only at real boundaries); and "done" meaning every artifact the change makes stale (localized strings in every shipped locale, documentation, schemas, configuration examples) is updated inside the planned blast radius. The fixer repairs the cause, never the symptom; the reviewer additionally hunts what tests rarely catch (swallowed errors, races, partial failures, boundary inputs, time zones and Unicode, removed guards without a reason).

They also treat the size of the change as a design decision, not a side effect:

- The architect chooses the design with the smallest blast radius that fully satisfies the frozen criteria, prefers extending existing seams to new files or abstractions, keeps public contracts unless a criterion requires otherwise, and declares every file to create or modify (with its reason) under a `Blast radius` heading in `design.md`. Tasks name only files from that list.
- The developer treats the files named by `design.md` and `tasks.md` as its boundary, changes only the lines a task needs, leaves unrelated problems for the summary, and reviews its own diff (`git status`, `git diff --stat`, every hunk) before the JSON summary: a hunk no task explains is reverted.
- The fixer never grows the blast radius: after a correction the diff is the previous change plus the minimal repair.
- The reviewer compares the Core-measured change set with the planned files. A file the plan did not name, a hunk no task explains (reformatting, renames, import reordering, rewritten tests, regenerated lockfiles, new dependencies, widened signatures) or an unexplained edit to a shared module is an issue to revert, and it lowers `architectural_alignment` and `pattern_adherence`. Asking to improve pre-existing code remains out of scope; asking to revert an edit the change introduced is always in scope.

Core enforces the parts it can measure (repository scope restore, the git change set, re-review deltas); the wording makes the agents plan, implement and judge against the same boundary.

Codex output schemas use its strict transport format: every property is required and originally optional fields accept null. The adapter restores optional nulls to omitted fields before Core consumes the response. This transport adaptation does not alter frozen role contracts. Provider failures include bounded, credential-redacted diagnostics from structured errors or stderr.

## Failed archive recovery diagnostics

Archive success requires a destination and removal of the staged active change,
not only an exit code of zero. On an aborted OpenSpec validation, the failure
retains bounded CLI output so the host can identify the actual spec or prerequisite
to repair. No writes from an unsuccessful staging pass are published.

A retry of a failed archive reuses verification and review when their receipts
remain valid. Candidate/environment changes continue to invalidate those receipts
and require verification/review. Compact runtime status includes up to eight
`recentFailures` with step, status, attempt, visit, timestamp and bounded error;
it excludes agent outputs. Hosts should diagnose repeated errors and identify a
changed precondition before retrying, preserving the original worktree.

## Scoped recovery API

Capability `scopedRecovery: 1` exposes `runtime recovery --context <json> --stdin`.
The JSON actions are inspect, history (optional offset), list_files, read_file,
diff, patch and check. File actions require a repositoryId from the frozen context
and a relative path. Patch requires expectedHash, one unique oldText/newText
replacement (16 KiB fragments), operationId UUID and reason. Check accepts only
kind openspec or kind verification with an ID from inspect's registered checks;
no submitted command/argv is accepted. The CLI requires the retained runtime
identity before dispatch. Desktop maps patch to write and check to destructive.

Recovery holds the workflow lease, rejects archived/completed mutations and
requires explicit acknowledgement of interrupted writes. It reuses WorkspaceTools
for bounded UTF-8 reads/diffs and atomic writes, adds protected-plan and portable
path checks, and records bounded attempts in a separate write-ahead history.
Same operation IDs never blindly rerun; changed requests with an old ID fail.
Interrupted patches reconcile by their after-hash; uncertain checks remain
interrupted. Repeated failed checks require a stated changed precondition.

Verification checks use the frozen plan and existing scoped receipts with a
45-second deadline. OpenSpec validation reports must contain successful results,
not merely an exit code of zero. Neither operation grants acceptance or marks
workflow phases complete. Resume remains responsible for the required gates.

### Claude Opus selection

For Claude CLI roles, `model: opus` resolves to `claude-opus-5-5` (Opus 5.5).
Explicit model IDs pass through unchanged, including older generations, and other
providers are unaffected. This applies to base and escalation invocations.
Claude Code owns the native thinking and tool protocol; Core does not send
Anthropic Messages API parameters.

## Efficiency policy

Architect, developer and reviewer keep their official OpenSpec workflow: fast-forward, apply and verify. Verification remains deterministic Core execution, not a fourth AI agent. Custom role text does not replace the mandatory scope, response or OpenSpec protocol.

### Configuration

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

These defaults are normalized once at admission and frozen. `full` disables the corresponding adaptive policy. Incremental context requires a compatible session and a transport that explicitly guarantees continuation. Built-in CLI transports currently report continuation as unknown; stateless API transports cannot receive a partial packet. They receive full context. A smaller prompt in the offline continuation fixture does **not** imply the same saving on every provider.

Each role optionally accepts `effort` and one `escalation: { model, effort? }` within the same provider. Query actual installed support with `specrails-core runtime capabilities --config config.json`; this never runs inference. Unknown effort support rejects an explicit value at admission. Omitting effort leaves the provider default. No economic tier is selected automatically.

Architect escalation is limited to the existing deepen pass. Developer escalation can begin on the third permitted candidate, after two failed outcomes; it adds no attempt to the configured limit. Reviewer escalation repairs malformed responses only, never a valid code rejection. Selected tiers and role session identities persist across interruption. All calls, including repairs, consume the existing budgets.

### Checks and evidence

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

### Reproducible evaluation

Build first, then run the actual offline command:

```sh
npm run build
node bin/specrails-core.mjs runtime evaluate --output /tmp/specrails-efficiency-evaluation
```

Five fixed cases cover static Tetris-like logic, a local feature, a cross-repository contract, verification correction and review correction. Each independent oracle must accept its reference implementation and reject deliberately defective variants. Full and optimized modes use fresh repositories/sessions and identical acceptance gates. The fixed long-context correction must shrink at least 40% without extra invocations. Reports record task, oracle, repository, configuration and runtime identities, failures, sample variation and independent acceptance.

Offline tokens and zero fixture cost are synthetic. The initial offline run accepted 5/5 cases in both modes and reduced its fixed correction prompt from 4,774 to 1,777 bytes (62.8%). It did not demonstrate lower monetary cost or faster real-provider execution. Repeat after implementation changes; the report records the tested package identity.

The definition corpus uses the same independent behavioral oracles for native
implementation and implementation nested in a component. After building, run
`node scripts/evaluate-definition-corpus.mjs implementation OUTPUT` and
`node scripts/evaluate-definition-corpus.mjs implementation-component OUTPUT`
with distinct output directories. CI runs these definitions in parallel on Linux;
the platform matrix separately covers runtime and installed-package behavior.
Each definition must accept all five cases in both context modes, including
verification repair, review repair and a two-repository contract. A missing,
duplicated or failed observation fails the gate. Reports preserve failures and
runtime identity; offline results never establish monetary savings.

Real evaluation is opt-in only: `runtime evaluate --real --config EXPLICIT_MODELS.json --max-cost-usd BUDGET --output OUTPUT`. Select all models and authorize the aggregate spend first. Unsupported spend limits prevent launch; incomplete billing stops further calls. The report distinguishes same-model from configured routing experiments and evaluates the descriptive target of 20% lower aggregate cost per independently accepted output. Small samples and uncontrolled provider caches do not establish universal quality or savings.

### Compatibility and rollback

A v4 checkpoint requires its original runtime. Never rewrite checksums or substitute a newly installed package. Desktop retains an immutable package and dependency closure per admitted run. Restoring that proven package is the recovery path; an unknown original package cannot be inferred from matching workflow inputs alone. New runtime configuration or package changes affect new runs only.

This source tree is a development package. Publishing Core and updating Desktop's exact version/integrity lock are separate coordinated release steps; local assembly is not proof that a new version has been published.

## Desktop-owned workflow composition

Core exposes `workflowAgentSteps: 1` and catalog version 7 for workflow-defined
agent steps. Desktop supplies arbitrary custom roles, task schemas and explicit
artifact/verification/review/approval nodes. Core executes generic primitives
and durable evidence contracts. Legacy `implementationSteps: 1` remains available
for saved definitions and retained runs. See the
[generic agent contract](engine-v2/pieces.md#workflow-defined-agents-catalog-7).

Claude catalog aliases `sonnet` and `opus` resolve to `claude-sonnet-5-5` and `claude-opus-5-5` respectively. Explicit model IDs remain unchanged for reproducible saved requests.
