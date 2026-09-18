## ADDED Requirements

### Requirement: Compact agent loop configuration
OpenAI-compatible runtime providers SHALL accept optional `agentLoop` (`compact` | `free`, default `compact`) and `contextWindowTokens` (integer ≥ 4096, default 32768). CLI providers SHALL reject these fields. The runtime API SHALL advertise `compactAgentLoop: 1`.

#### Scenario: Defaults
- **WHEN** an openai-compatible provider omits both fields
- **THEN** validation succeeds and the executor behaves as `compact` with a 32768-token window

#### Scenario: Invalid values
- **WHEN** `agentLoop` is not `compact`/`free` or `contextWindowTokens` is below 4096 or not an integer
- **THEN** `validateRuntimeConfig` fails naming the field

### Requirement: Compact architect pipeline
In compact mode the architect role SHALL run a host-driven pipeline (inventory → proposal → design → specs → tasks) whose OpenSpec artifacts are rendered by the host and written through `openspec_workflow`, so the unchanged graph post-checks pass.

#### Scenario: Scripted small model
- **WHEN** a fake endpoint answers each step with the step's JSON
- **THEN** proposal.md, design.md, specs/<cap>/spec.md and tasks.md exist, `validate --strict` passes, participation is logged and the final result matches `ARCHITECT_OUTPUT_SCHEMA`

### Requirement: Executor guardrails
For openai-compatible providers the executor SHALL apply a repetition guard, argument repair with one correct example, an empty-final nudge, `content: ''` on tool-call messages and chars/4 context compaction, in both loops.

#### Scenario: Repetition
- **WHEN** the model repeats an identical tool call three times consecutively
- **THEN** the third receives an error result; a fifth identical call aborts the step with code `tool_loop`

#### Scenario: Compaction
- **WHEN** estimated tokens exceed 70% of `contextWindowTokens`
- **THEN** the oldest tool results are replaced by one-line summaries while system, user and the last four messages stay intact

### Requirement: CLI executors unchanged
CLI provider prompts and invocations SHALL be byte-identical to before this change.

#### Scenario: Claude prompt snapshot
- **WHEN** `buildCliInvocation('claude', request)` runs
- **THEN** the stdin prompt equals the recorded snapshot
