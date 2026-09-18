## Why

The programmatic agent runtime runs every role as one monolithic agentic loop: a ~8k-token prompt, eight tools, unbounded growing context and free-form artifact writing. Frontier CLI providers cope, but small local models (7–14B, 20–64k context, served through `kind: 'openai-compatible'` endpoints such as llama.cpp or Ollama) collapse: 60–80 tool calls per attempt, `search_text` called dozens of times with placeholder queries, `openspec_workflow` called with a file path as the action, identical calls repeated, no artifact ever written, then "Provider returned an empty final result" and the OpenSpec post-checks fail. Local models are the cheapest way to run the pipeline, so they must work.

## What Changes

- `openai-compatible` providers gain two optional fields: `agentLoop: 'compact' | 'free'` (default `compact`) and `contextWindowTokens` (integer ≥ 4096, default 32768). CLI providers gain nothing.
- `agentLoop: 'compact'` replaces the single agentic loop with **host-driven pipelines of small structured calls** per role: architect = inventory → proposal → design → specs → tasks (the host renders the OpenSpec markdown from JSON with the official `openspec instructions` templates and drives `openspec_workflow` itself); developer = one bounded mini-loop per task group with a tool-call budget and per-task context compaction, the host ticking `tasks.md` and saving progress; reviewer = read-only inspection with the git diff supplied as input and the verdict forced into `REVIEW_OUTPUT_SCHEMA`.
- Guardrails inside the OpenAI executor for BOTH loops (only for `openai-compatible`): repetition guard, tool-argument repair with one correct example, one nudge before failing an empty final result, `content: ''` instead of `null` on assistant tool-call messages, chars/4 context compaction against `contextWindowTokens`, and one-call few-shot examples in the compact step prompts.
- `agentLoop: 'free'` keeps the existing loop plus the guardrails.
- The runtime API advertises `compactAgentLoop: 1` so hosts can strip the new fields before handing a config to an older Core.

## Capabilities

### New Capabilities
- `small-model-runtime`: compact host-driven role pipelines and executor guardrails for OpenAI-compatible providers.

### Modified Capabilities
- (none — the CLI executors and the graph post-checks are byte-identical.)

## Impact

- `src/agent-runtime/config.ts`, `executor-types.ts`, `schemas/agent-runtime.schema.json`, `capabilities.ts`, `cli.ts` (API capabilities).
- `src/agent-runtime/openai-executor.ts` (guardrails + dispatch) and new `src/agent-runtime/compact/*` modules.
- Tests: `openai-executor.test.ts`, new `compact-runtime.test.ts`, `config.test.ts`, a CLI prompt snapshot regression test.
- `docs/agent-runtime.md`.
