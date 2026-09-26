# Piece catalog

A piece is a node kind the engine knows how to execute. The catalog is closed: `createPieceRegistry(dependencies)` (`src/agent-runtime/engine/pieces/index.ts`) binds the reviewed pieces to one execution, and `validationPieceRegistry()` returns the same descriptors and parameter validators without initializing providers, a journal or a project store. A definition selects kinds from this catalog by name; it cannot register code, callbacks or expressions that execute JavaScript.

`specrails-core runtime workflows list` emits `{ type: 'runtime-workflows', nodeKindsVersion, nodeKinds: PieceDescriptor[], definitionSchema, builtins }`. The current catalog is `nodeKindsVersion` 1 with 16 kinds (`NODE_KINDS_VERSION` in `src/agent-runtime/engine/piece-registry.ts`). This branch advertises engine 2 and the same catalog through `runtime api` and `integration-contract.json`. Required integration and package/platform gates must pass before publication.

## Descriptor model

Every piece publishes a `PieceDescriptor` (`src/agent-runtime/engine/contracts.ts`):

| Field | Meaning |
| --- | --- |
| `kind` | The `kind` value used in a definition node. |
| `paramsSchema` | A closed JSON Schema (Ajv 2020, strict, `additionalProperties: false`) validated by `workflows validate` and again at run admission. |
| `outcomes` | The declared edge labels. A node's `ends` must contain exactly the labels the piece resolves for its parameters (`invalid_outcomes` otherwise). |
| `effect` | `read`, `write` or `derived`. A write piece takes the exclusive repository gate, invalidates `$verified` at admission and refreshes `$candidate` at settlement. `derived` means the effect is resolved per node: `prompt` from `params.access`, `role-turn` from the configured role's `access`, `component`/`map` from the referenced body (write if any child writes). |
| `requiresAI` | The piece performs provider inference: it takes a shared AI permit (`policies.concurrency` plus map limits), defaults to two physical attempts, counts toward `policies.failFast` and, for `prompt` and `role-turn`, claims pending operator steering at admission. |
| `storeAccess` | Project-memory namespaces the piece may touch (`roles/<id>/sessions`, `review/notes`, `verification/known-commands`). Absent means no access. |

Some pieces resolve their labels from parameters: `prompt` by `sentinel`, `role-turn` by `structuredOutput`, `component` by the body's `outputs`. The compiler owns `component`, `map`, `join` and `implementation`: their descriptors exist for authoring validation, but execution always builds real LangGraph child graphs on the parent's SQLite saver (`composition_required` if called as an ordinary piece).

Every piece result passes through the same compiler and ledger rules. `$outputs[nodeId]` receives the bounded output (262,144 bytes, strings capped at 32,000 characters). `$lastOutcome[nodeId]`, `$attempts[nodeId]` (highest physical attempt ordinal seen for that node) and `$transitions` are engine-owned. `$usage` is projected from the ledger; a piece never adds usage itself. Only an admitted `verify` or `implementation` piece can install `$verified`, and only with a valid full receipt for the committed candidate; any other write leaves `$verified` null.

## Semantics by kind

### `prompt`

A free provider turn without role instructions or OpenSpec binding (`instructions: 'none'`, `artifacts: 'none'`). Exactly one of `text` or `nativeCommand { id, args? }` is supplied; native commands are rendered per provider by the executor layer. `access` is required and becomes the node effect.

- Outcomes: `sentinel: 'none'` (default) → `next`, `failed`; `sentinel: 'verification'` → `pass`, `fail`, `failed`; `sentinel: 'blocked'` → `next`, `blocked`, `failed`. The `blocked` label must be wired but is not emitted by the current implementation: a `LOOP_BLOCKED: <question>` line pauses the run with a `question` interrupt inside the same node, and after the answer the node continues and ends with `next`. At most 32 human continuation rounds are admitted per visit (`recursion_limit` afterwards).
- Verification sentinel: the last `VERIFICATION: PASS|FAIL` in the provider text decides `pass`/`fail`; a missing sentinel is `fail` with `reasons: ['missing_sentinel']` in the output.
- Context: the prompt receives the bounded `$history` (`policies.historyMaxChars`, default 1500) unless `appendHistory: false`, claimed operator steering unless `appendSteering: false`, and the host input when present. `sessionContinuity: 'run'` (default) reuses `$sessions[nodeId]` when the provider supports continuation and the session identity (engine, instructions version, text/command, access, scope, node, provider configuration, repository roots) is unchanged; `session_not_found`/`session_expired`/`session_unsupported` fall back to a fresh session once.
- Accounting: each physical call is admitted through the durable invocation port before inference (`budget_exhausted` when no bounded headroom remains) and settled with its response memo in one transaction, so a crash or human pause never repeats a billed call.
- Writes: `$outputs[nodeId] = { text, sessionId?, sentinel?, reasons?, vars }`, `$vars` from `captureVars` (regex ≤ 200 characters, 50 ms VM timeout, 32,000 input characters), one `$history` entry, `$sessions[nodeId]`, and `$answers` for blocked-question replies. Emits `agent-event` with `role: 'prompt'`.

### `role-turn`

One turn of a configured role through Core's role invoker: role instructions, OpenSpec binding when the role declares `openspecSkill` (`openspec_binding_required` if the binding is missing), repository context, routing and exactly one in-session structured repair.

- Outcomes: `next`, `failed`; with `structuredOutput` also `invalid` (returned after the single failed repair, `error.code: 'invalid_role_output'`). Provider errors with a classified code are rethrown for retry classification; other role failures return `failed` with `error.code: 'role_failed'`.
- Effect: the role's configured `access`. `requiresAI`. `storeAccess: 'write'`: a read role without a live session receives a bounded prior review note (≤ 4,000 characters) keyed by role, tier, candidate, scope and repositories; the piece stores session metadata and, for read roles, its note. Memory failures are advisory and never repeat a provider call.
- Writes: `$outputs[nodeId] = { text, structured? }`, one `$history` entry, `$sessions[nodeId]` when `sessionContinuity` is not `'none'`.

### `decider`

Desktop's evidence-oriented loop decider adapted to a declared read-only role (`invalid_role_access` otherwise). It receives the bounded `$history`, the frozen specs (each bounded to 4,000 characters) and `goal`, and must answer `{ verdict: 'continue' | 'stop', reason }` as structured output with no session continuity.

- Outcomes: `continue`, `stop`, `failed`.
- No-progress: consecutive `continue` verdicts with an unchanged candidate hash are counted; when the count reaches `params.noProgress ?? policies.noProgress` the engine forces `stop` with `stalled: true` and `completion: { ok: false, reasons: ['no_progress'] }`. If neither value is declared, no stall limit applies.
- Writes: `$outputs[nodeId] = { verdict, reason, candidateHash, continueCount, stalled? }` and one `$history` entry.

### `condition`

Evaluates `expr` (1–4096 characters) with the closed expression grammar in `src/agent-runtime/engine/expressions.ts`: paths over `$outputs`, `$vars`, `$verified`, `$attempts` and `$item`; JSON literals; `== != < <= > >= && || !`; `exists(x)`; `matches(x, /pattern/)`. Comparisons other than equality require two numbers or two strings. No user functions, no eval.

- Outcomes: `true`, `false`. An evaluation error yields `false` with `output: { error }` and `completion.reasons: ['condition_error:<nodePath>']`.
- Effect: read. Writes only `$outputs[nodeId]`.

### `verify`

Runs verification commands through the real Core command runner and evidence adapter, without a journal (`state.json` is never created for ledger-only runs).

- Parameters: `commands: 'configured'` uses `config.verification`; an explicit array (≤ 100) supplies `VerificationCommand` objects. `unverified: true` admits repositories without a check as an explicit exception. `maxConcurrency` (1–4) bounds parallel commands.
- Outcomes: `pass` when the receipt is valid, `fail` when a command failed, `failed` only for infrastructure failure (a command could not complete, `error.code: 'verification_execution_error'`).
- Effect: write. The receipt kind is `full` when the commands cover every frozen repository or `unverified` is set, otherwise `scoped`. Certification (`$verified`) is installed only for a valid full receipt with at least one command, no unverified repositories and a candidate hash equal to the committed candidate; the ledger rejects anything else (`receipt_invalid`) and the execution adapter downgrades a receipt whose candidate changed before terminal commit to `fail`.
- `storeAccess: 'write'`: known-command observations under `verification/known-commands` are advisory and never skip a check.
- Writes: `$outputs[nodeId] = { receiptId, valid, reason?, commands: [{ repositoryId, command, exitCode }] }`, the receipt evidence and `$verified`. Emits `verification-output` and `runtime-efficiency-event`.

### `shell`

A bounded command inside one frozen repository. `argv` runs the program directly; `commandLine` uses `/bin/sh -c` or `%ComSpec% /d /s /c` on Windows. Commands outside the frozen scope are rejected before execution.

- Outcomes: `ok` (exit 0), `fail` (non-zero exit), `failed` (could not start, timed out, cancelled or interrupted; `error.code` is `timeout`, `aborted` or `shell_execution_error`).
- Effect: write, no AI. `timeoutMs` defaults to 600,000 (maximum 7,200,000); `outputCapBytes` defaults to 262,144 (128–1,048,576). `evidence: true` runs the command through the verification runner and records a scoped receipt as evidence; shell evidence never installs `$verified`.
- Writes: `$outputs[nodeId] = { exitCode, stdout, stderr, vars, outputTruncated }`, `$vars` from `captureVars` over stdout and stderr, one `$history` entry.

### `openspec-validate`

Runs Core's pinned OpenSpec CLI with `validate <change> --strict --json` in the artifact root. `change` must be a kebab-case identifier of at most 64 characters (`invalid_arguments`).

- Outcomes: `pass` when the CLI exited successfully and reports the change valid, `fail` when it reports it invalid, `failed` on infrastructure errors. An unparsable or incomplete report raises `openspec_invalid_output`.
- Effect: read. Writes the parsed report to `$outputs[nodeId]`.

### `openspec-archive`

Archives a change with the pinned CLI through Core's recoverable write set, prepared in a scoped adapter directory and published only after every preimage check. If the candidate hash changes while the archive is being prepared the piece fails with `candidate_changed`.

- Outcomes: `next`, `failed`.
- Effect: write. Writes `$outputs[nodeId] = { change, archived: true }` and one `$history` entry.

### `approval`

Pauses the run with a human interrupt `{ kind: 'approval', prompt: reason, nodePath, scopeId, attemptId }`. The process exits with code 2 and `runtime-result.status = 'paused'`; the attempt stays `paused` and is reused on resume. Resume with `runtime resume --approve <nodePath|interruptId>`.

- Outcomes: `next`. Effect: read. Writes `$outputs[nodeId] = { response }`.

### `question`

Pauses the run with a `question` interrupt whose prompt is `text`. Resume with `runtime resume --answer <text> [--interrupt-id <id>]`; the answer must be a nonempty string.

- Outcomes: `next`. Effect: read. Writes `$outputs[nodeId] = { response }` and appends the reply to `$answers`.

### `gate`

Pauses with a `gate` interrupt whose prompt is `reason`. In the current implementation a gate behaves exactly like `approval` (it is resolved by `--approve`); it is not compiled as `interruptBefore` on the following node.

- Outcomes: `next`. Effect: read. Writes `$outputs[nodeId] = { response }`.

### `map`

Fans out one component body over a frozen collection. `over` is `'tickets'` (the frozen `context.specs`), `'repositories'` (the frozen `context.repositories`) or `{ outputsOf: nodeId, path }` (a dotted path inside `$outputs[nodeId]` that must resolve to an array, `map_input_missing` otherwise). At most 10,000 items are admitted (`map_input_limit`); `ends.next` must target a `join`.

- Each item runs the body as a child graph with scope `<parentScope>/<mapVisitId>/<index>`, branch ID `<mapVisitId>:<index>`, `$item = { index, value }`, `$vars.item` and `$vars.index`, and the parent's candidate, verification and usage. `concurrency` (default `policies.concurrency`, maximum 8) bounds physical AI work inside the branches through a per-visit permit group; a limit cannot change within a run (`scope_conflict`).
- The map coordinator holds no repository or AI permit while branches run. An empty collection proceeds directly to the join.
- Outcomes: `next`. Effect: derived from the body for authoring; the coordinator itself is admitted read-only. Writes `$outputs[nodeId] = { total }` and seeds `$branches[nodeId]`; each branch adds `{ index, outcome: 'next' | 'failed', output: { outputs, completion } }`.

### `join`

The deferred node after a `map` (`defer: true`): it runs only after every branch has settled (`join_incomplete` otherwise) and must have exactly one map predecessor.

- `reduce: 'collect'` always continues; `'all-ok'` continues only when every branch succeeded; `'any-ok'` when at least one did. A failed reduction routes to `fail`.
- Outcomes: `next`, `fail`. Effect: read. Writes `$outputs[nodeId] = { total, ok, failed, results: [{ index, outcome, output }] }` and clears the stored item vector of the map plan.

### `component`

Invokes a reusable body from `components` as an inspectable child graph with its own state, scope `<parentScope>/<visitId>` and node paths prefixed by the component node ID. Child `$vars` start from the body's `inputs` names copied out of the parent's `$vars`, plus `params.inputs`, whose values are literal strings or channel paths beginning with `$vars`, `$outputs`, `$history`, `$answers`, `$candidate`, `$verified` or `$item` (`invalid_component_input`/`run_var_missing` otherwise). The child inherits the parent's candidate, verification and usage.

- Outcomes: the body's `outputs` (default `next`, `failed`). The body ends through an `end`; `end.exit` selects a declared output, otherwise `next` for a successful completion and `failed` for anything else (`component_exit_missing` if no exit was produced).
- Effect: derived from the body. Nesting is limited to three levels and recursion is rejected. Writes `$outputs[nodeId] = { outputs: <child $outputs>, completion }` and propagates the child's candidate, `$verified` and usage; a local component completion never settles the parent run.

### `implementation`

Core's native implementation (architect → developer → fixer/verify → reviewer → archive) compiled as a child graph whose six nodes register individually on the parent's SQLite saver; no legacy JSON workflow host runs. It requires `journal: 'implementation'`, a `change` other than `'none'` and a frozen change name (`--change`).

- Parameters: `attempts` (default `config.limits.maxAttempts ?? 3`), `approvalBeforeArchive` (raises an archive approval interrupt), `reviewPolicy { minScore, aspects }` (may only tighten Core's floors).
- Journal binding: a standalone root implementation keeps the run's journal and change identity; component or map instances derive `<runId>-impl-<digest>` journals and `<change>-<digest>` changes as sibling pipeline directories, and ticket/repository items narrow the frozen context (`implementation_item_scope` for anything else).
- Outcomes: `next` when the change is archived, the implementation is complete and verification/acceptance are valid; `rejected` when the review rejected the work or verification failed; `failed` otherwise (`implementation_failed`, `implementation_blocked`).
- Effect: write; `requiresAI`. Certification is installed only from a valid full receipt with commands and no unverified repositories; scoped instances keep their receipts as evidence without certifying the parent candidate. Every child terminal publishes `childUpdate.journal`, a content-addressed manifest of journal, verification, change and main-spec bytes (≤ 1 MiB, 8192 files, 256 MiB referenced; child state ≤ 1,750,000 bytes) that fork reads at a historical cut.
- Writes: `$outputs[nodeId] = { completion, review, archived }`, receipt evidence and `$verified`.

### `end`

Terminates the current body. `completion.ok` is `outcome === 'success'`; `completion.verified` is whether the ledger's current `$verified` matches the current candidate hash; `requiresVerified: true` (or the root `delivery.requiresVerified: true`, combined by the compiler at execution time) turns an unverified success into `ok: false` with `reasons: ['unverified']`. `reason` is appended to the reasons. `exit` is valid only inside a component body and must name a declared output.

- Outcomes: none. Effect: read. At the root the compiler marks `completesRun` and the ledger records the durable completion; inside a component it sets the private `$exit`.

## Descriptor reference (generated)

<!-- piece-catalog:generated:start -->
Generated from `validationPieceRegistry().catalog()`: `nodeKindsVersion` 1, 16 kinds, in registration order.
Do not edit this section by hand; regenerate it with `SPECRAILS_UPDATE_DOCS=1 npx vitest run src/agent-runtime/engine/docs-examples.test.ts`.

### Descriptor: `prompt`

| Field | Value |
| --- | --- |
| Effect | `derived` |
| Requires AI | yes |
| Store access | `none` |
| Declared outcomes | `next`, `pass`, `fail`, `blocked`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `engine` | yes | object { `provider`: string (1–128 chars), `model`: string (1–256 chars), `effort`: string (1–64 chars), `thinking`: `"on"` / `"off"` } (required: `provider`) |
| `text` | no | string (1–32000 chars) |
| `nativeCommand` | no | object { `id`: string matching `^[a-z][a-z0-9:_-]{0,63}$`, `args`: string (≤ 32000 chars) } (required: `id`) |
| `access` | yes | `"read"` / `"write"` |
| `sentinel` | no | `"verification"` / `"blocked"` / `"none"` |
| `captureVars` | no | array of object { `name`: string matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, `pattern`: string (≤ 200 chars), `group`: integer (0–200) } (required: `name`, `pattern`) (≤ 64 items) |
| `sessionContinuity` | no | `"run"` / `"none"` |
| `idleTimeoutMs` | no | integer (1–2147483647) |
| `timeoutMs` | no | integer (1–2147483647) |
| `appendHistory` | no | boolean |
| `appendSteering` | no | boolean |

Exactly one of: `text`, `nativeCommand`.

### Descriptor: `role-turn`

| Field | Value |
| --- | --- |
| Effect | `derived` |
| Requires AI | yes |
| Store access | `write` |
| Declared outcomes | `next`, `invalid`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `roleId` | yes | string matching `^[a-z][a-z0-9-]{0,63}$` |
| `prompt` | yes | string (1–32000 chars) |
| `structuredOutput` | no | object |
| `sessionContinuity` | no | `"run"` / `"none"` |

### Descriptor: `decider`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | yes |
| Store access | `none` |
| Declared outcomes | `continue`, `stop`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `roleId` | yes | string matching `^[a-z][a-z0-9-]{0,63}$` |
| `goal` | yes | string (1–32000 chars) |
| `noProgress` | no | integer (1–100000) |

### Descriptor: `verify`

| Field | Value |
| --- | --- |
| Effect | `write` |
| Requires AI | no |
| Store access | `write` |
| Declared outcomes | `pass`, `fail`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `commands` | yes | `"configured"` / array of object { `repositoryId`: string (1–128 chars), `command`: string (1–4096 chars), `args`: array of string (≤ 32000 chars) (≤ 1024 items), `cwd`: string (≤ 4096 chars), `env`: object of string (≤ 32000 chars), `timeoutMs`: integer (1–7200000), `key`: string (≤ 128 chars), `label`: string (1–256 chars), `policy`: object } (required: `repositoryId`, `command`, `args`) (≤ 100 items) |
| `unverified` | no | boolean |
| `maxConcurrency` | no | integer (1–4) |

### Descriptor: `shell`

| Field | Value |
| --- | --- |
| Effect | `write` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `ok`, `fail`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `argv` | no | array of string (≤ 32000 chars) (1–1024 items) |
| `commandLine` | no | string (1–32000 chars) |
| `repositoryId` | yes | string (1–128 chars) |
| `cwd` | no | string (≤ 4096 chars) |
| `env` | no | object of string (≤ 32000 chars) |
| `timeoutMs` | no | integer (1–7200000) |
| `captureVars` | no | array of object { `name`: string matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, `pattern`: string (≤ 200 chars), `group`: integer (0–200) } (required: `name`, `pattern`) (≤ 64 items) |
| `evidence` | no | boolean |
| `outputCapBytes` | no | integer (128–1048576) |

Exactly one of: `argv`, `commandLine`.

### Descriptor: `openspec-validate`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `pass`, `fail`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `change` | yes | string (1–128 chars) |

### Descriptor: `openspec-archive`

| Field | Value |
| --- | --- |
| Effect | `write` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `change` | yes | string (1–128 chars) |

### Descriptor: `condition`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `true`, `false` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `expr` | yes | string (1–4096 chars) |

### Descriptor: `end`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | (none: terminal) |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `outcome` | yes | `"success"` / `"failure"` |
| `requiresVerified` | no | boolean |
| `reason` | no | string (≤ 32000 chars) |
| `exit` | no | string matching `^[a-z][a-z0-9-]{0,63}$` |

### Descriptor: `approval`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `reason` | yes | string (1–32000 chars) |

### Descriptor: `question`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `text` | yes | string (1–32000 chars) |

### Descriptor: `gate`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `reason` | yes | string (1–32000 chars) |

### Descriptor: `component`

| Field | Value |
| --- | --- |
| Effect | `derived` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `ref` | yes | string matching `^[a-z][a-z0-9-]{0,63}$` |
| `inputs` | no | object of string (≤ 32000 chars) |

### Descriptor: `map`

| Field | Value |
| --- | --- |
| Effect | `derived` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `over` | yes | `"tickets"` / `"repositories"` / object { `outputsOf`: string matching `^[a-z][a-z0-9-]{0,63}$`, `path`: string (≤ 32000 chars) } (required: `outputsOf`, `path`) |
| `body` | yes | string matching `^[a-z][a-z0-9-]{0,63}$` |
| `concurrency` | no | integer (1–8) |

### Descriptor: `implementation`

| Field | Value |
| --- | --- |
| Effect | `write` |
| Requires AI | yes |
| Store access | `none` |
| Declared outcomes | `next`, `rejected`, `failed` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `attempts` | no | integer (1–100) |
| `approvalBeforeArchive` | no | boolean |
| `reviewPolicy` | no | object { `minScore`: number (0–100), `aspects`: object of number (0–100) } |

### Descriptor: `join`

| Field | Value |
| --- | --- |
| Effect | `read` |
| Requires AI | no |
| Store access | `none` |
| Declared outcomes | `next`, `fail` |
| Additional parameters | rejected |

| Parameter | Required | Type |
| --- | --- | --- |
| `reduce` | yes | `"collect"` / `"all-ok"` / `"any-ok"` |
<!-- piece-catalog:generated:end -->
