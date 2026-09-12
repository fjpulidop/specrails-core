# Programmatic agent runtime

Core can execute implementation as a local TypeScript workflow:

```text
architect → developer → verify → reviewer → archive
    │           ↑          │         │
    │           └──────────┴─────────┘  bounded corrections
    └─ investigate once, then ask (or proceed on stated assumptions)
```

The workflow is a [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) state graph. LangGraph owns the traversal, the typed state and its reducers, the checkpoint history, dynamic interrupts (approvals and questions) and time travel; Core owns the role instructions, the structured artifacts, the verification subprocesses, the acceptance evidence, the receipts, budgets, leases and interrupted-write recovery. Provider adapters execute one role; they do not invoke a platform's implementation prompt or skill.

The developer role has the same autonomy the legacy Implement step had: it edits files and runs commands inside its CLI's own sandbox (Claude `--tools default --dangerously-skip-permissions` with nested agents and skills disallowed, Codex `workspace-write`, Gemini `--yolo`, Kimi print mode), so it can run the project's tests before handing off. Architect and reviewer roles stay read-only. Claude roles load only project settings (`--setting-sources project,local`), so `CLAUDE.md` and `.claude/rules` apply while the user's global memory and plugins do not.

This page describes the current source implementation, **runtime API 1**, workflow version 3, checkpoint envelope format 2. An older published Core package can have the same major version and lack this export. Build the paired checkout when developing this feature; do not assume `@latest` contains unreleased changes.

## Requirements and ownership

- Node.js **20.19.0+** and Git on macOS or Windows. Individual provider CLIs may require a newer Node release.
- Installed and authenticated Claude, Codex, Gemini or Kimi CLIs for whichever roles use them; alternatively, a reachable OpenAI-compatible endpoint with tool support.
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
    { "id": "gemini", "kind": "cli", "cli": "gemini" },
    { "id": "kimi", "kind": "cli", "cli": "kimi" },
    {
      "id": "local",
      "kind": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1"
    }
  ],
  "agents": {
    "architect": { "provider": "claude", "maxTurns": 24 },
    "developer": { "provider": "codex", "maxTurns": 24 },
    "reviewer": { "provider": "gemini", "maxTurns": 24 }
  },
  "limits": { "maxAttempts": 3, "timeoutMs": 900000 },
  "verification": [
    { "repositoryId": "app", "command": "node", "args": ["--test"] }
  ],
  "review": { "minScore": 80, "aspects": { "security": 85 } },
  "architect": { "onLowConfidence": "ask" },
  "approvalBeforeArchive": false
}
```

`verification` may be an empty array. At run time Core builds the effective plan from the configured commands plus the architect's proposals for uncovered repositories; the plan is frozen in the graph state and reused by every verification and resume. When the plan covers no repository at all, the run still passes through task completion and review, and the receipt lists those repositories under `unverifiedRepositories`.

`review` tightens the review gate. Core's own gate is the floor: overall score at least 70, `security` at least 75, every other aspect at least 60. A lower value is rejected by validation, because the pipeline journal enforces the floor regardless of configuration. The reviewer is told the effective thresholds.

`architect.onLowConfidence` decides what happens when the architect still reports low confidence after its investigation pass (see [Questions and approvals](#questions-and-approvals)): `ask` (default) pauses the run with the architect's question; `proceed` continues on the assumptions the architect stated, recording `design-confidence.json` as `medium` with `assumed: true` and the original `reportedConfidence`.

Set any role's `provider` to `kimi` to use Kimi. A CLI role's optional `model` is passed to that provider; omitting it uses the CLI's default. Provider IDs are aliases, so you can configure several endpoints or replace an executor without changing workflow code.

To use the local endpoint, set the desired role to `{"provider":"local","model":"your-installed-model-id","maxTurns":24}`. The endpoint must support `POST <baseUrl>/chat/completions`, OpenAI-style function tool calls and a final assistant result. Its model must actually be able to use these tools; a chat-only endpoint is insufficient for the developer role. The example port is a placeholder for your own running server.

For an authenticated endpoint, add `"apiKeyEnv":"MY_MODEL_API_KEY"` to its provider configuration and set that variable in the process launching Core. Omit `apiKeyEnv` when no key is required. URLs cannot contain credentials, query parameters or fragments. Verification commands inherit process credentials; do not put secrets into their persisted `env` overrides.

The configuration schema is [agent-runtime.schema.json](../schemas/agent-runtime.schema.json). `validateRuntimeConfig()` also checks relationships such as role-to-provider references and the review floors. Runtime configuration is separate from the existing [profile v1 schema](../schemas/profile.v1.json); it does not translate legacy profile routing into programmatic phases.

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

`runtime api` returns `{type:"runtime-api",apiVersion:1,coreVersion:"..."}` without invoking providers. Hosts can send a JSON configuration through stdin to `runtime validate --stdin` (maximum 2 MiB), avoiding temporary files and platform-specific shell quoting. It is mutually exclusive with `--config`. Use `runtime status --context <file> --compact` for process/UI integration: it retains the run and trace identities, phase status and visits, `pendingApproval`, `pendingQuestion`, usage, the completion verdict and the acceptance summary while omitting accumulated outputs, history and frozen context. Omit `--compact` for full inspection.

## Questions and approvals

The graph pauses through LangGraph interrupts; the host resumes it with the matching answer.

- **Low design confidence.** When the architect reports `low`, Core first asks the same architect session to investigate the code once more and decide from evidence. If confidence is still low, the run pauses with the architect's single blocking question (`pendingQuestion`), the draft proposal is left on disk for inspection, and `resume --answer <text>` re-runs the architect with the answer as authoritative input. With `architect.onLowConfidence: "proceed"` the run continues on the stated assumptions instead of pausing.
- **Archive approval.** With `approvalBeforeArchive: true` the run pauses before archive (`pendingApproval`); `resume --approve archive` grants it. The default is no approval, so a fully autonomous run implements, verifies, reviews and archives without a human in the loop.

A resumed node collects its answer before doing any work, so the pass that asked the question is never repeated. Approvals and answers are persisted; a granted approval survives interruption, but invalidated candidate evidence clears it.

## Recovery and durable state

State lives below `<backlogRoot>/.specrails/pipeline/<runId>/`:

| File | Purpose |
| --- | --- |
| `state.json` and `receipts/` | Authoritative Core gates, verification and acceptance evidence |
| `agent-runtime-request.json` | Frozen CLI change name and runtime configuration |
| `agent-workflow/<runId>/checkpoint.json` | One atomic envelope: the host ledger (attempts, receipts, usage, ordered events, pending interrupts) and the complete LangGraph checkpoint history |
| `agent-workflow/<runId>/.lease/` | Exclusive runtime process ownership |

Resume uses the saved configuration and change. It rejects a different frozen input, Core/instruction identity or workflow definition. Valid completed phases are retained; stale evidence invalidates the affected phase and everything declared after it, and the graph travels back in time to the checkpoint taken right before that phase last ran, so its predecessors' state is exactly what it saw then. The ledger is authoritative for which node runs next: if LangGraph's own position disagrees after a crash, traversal follows the ledger. Once archived, changed evidence requires a new run.

Correction loops stay cheap: when verification or review sends work back, the developer's previous provider session is resumed with a short correction prompt (Claude `--resume`, Codex `exec resume`, Gemini `--resume`, Kimi `--session`), so the code it wrote and the reasons behind it are already in context. If the session is gone the developer starts a fresh full turn with the same feedback. Unchecked tasks in `tasks.md` are returned to the developer as feedback, not treated as a workflow failure. A run blocked at `limits.maxAttempts` can be resumed explicitly: the resume grants a fresh attempt budget and transition ceiling; visits and history keep the complete record.

Architect and reviewer replies are validated against a JSON Schema (Claude `--json-schema`, Codex `--output-schema`; other providers are parsed leniently, accepting fenced or prefixed objects). The developer finishes with a structured summary (files, tests, verification run, incomplete tasks) validated the same way; a provider that returns prose instead is recorded as such rather than repaired. An unusable architect or reviewer reply gets one repair turn inside the same session before the phase fails.

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

## Budgets and provider capability differences

| Setting | Behavior |
| --- | --- |
| `agents.<role>.maxTurns` | Bounded role/tool interaction, default 24; provider transports enforce their available turn/tool events |
| `limits.maxAttempts` | Maximum development visits per invocation, including correction cycles, default 3; an explicit resume starts a fresh budget |
| `limits.timeoutMs` | Workflow duration limit and provider timeout; default provider timeout is 15 minutes when omitted |
| `limits.maxTokens` | Rejects missing required usage or an observed overrun; CLI accounting may arrive only after a call |
| `limits.maxCostUsd` | Accepted by the built-in Claude executor through its native dollar limit; rejected by built-in Codex, Gemini, Kimi and OpenAI-compatible executors |

Do not configure `maxCostUsd` for a mixed-provider run unless every selected custom executor can enforce the requested cap. An observed token limit cannot guarantee that an opaque CLI stops before spending those tokens. Provider spend is accounted the moment each call returns, so a pause or failure after a call never loses it. Unknown usage stays `null`; known spend is tracked as a lower bound, never fabricated as zero. Local endpoints can report zero cost, but absent billing data remains unknown.

Kimi read-only roles use an enforced custom agent when the CLI exposes `--agent-file`; the Kimi 0.27 fallback uses ACP plan mode with scoped reads and denied writes/terminal operations. Unsupported ACP modes or multi-repository capabilities fail explicitly. Kimi lacks authoritative token accounting, so its built-in executor rejects token and dollar caps. Configure another provider for a role when its installed Kimi version cannot expose the required repository scope.

Gemini architect/reviewer roles require a CLI that advertises `--admin-policy` (verified with Gemini 0.49). Core supplies a temporary admin policy allowing only file reads, listing, glob and grep; all other tools are denied, including shell, writes and mode changes. This policy applies even if user settings disable plan mode or previously approve write tools. Gemini ignores per-run admin policies when system policy files exist, so Core rejects those managed environments before invoking a read-only role; select another provider for these roles or arrange a compatible environment with the system administrator. Older Gemini versions without this policy capability also fail explicitly. Gemini developer roles retain their existing `auto_edit` execution.

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

The OpenAI-compatible tool executor exposes scoped file listing/reading and developer-only writing. It rejects traversal, symlink escapes and protected runtime metadata. It has no model-accessible shell tool; only the host's configured verification commands run as subprocesses. This is a tool policy, not an operating-system sandbox for arbitrary custom executors or external CLIs.

Architect and reviewer responses are structured JSON. The architect's `specs[].content` is the **complete intended main specification**, including unchanged requirements. Archive replaces `openspec/specs/<name>/spec.md` with that reviewed document. It does not interpret a partial OpenSpec delta as a merge instruction. The developer may update task checkboxes, but changing approved design, task descriptions or specification content invalidates the gates.

Legacy provider workflows and profile v1 remain available. Missing/disabled runtime configuration keeps Desktop's legacy path; an admitted programmatic run remains bound to its frozen runtime request even if the project's settings are later disabled. See the [integration contract](../integration-contract.json) for runtime API and artifact paths, and Desktop's programmatic runtime guide for release pairing and continuation/delivery behavior.
