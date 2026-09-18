## Context

`OpenAICompatibleExecutor.execute` (145 lines) is the whole runtime for local models: it sends the role prompt (roleInstructions + frozen obligations + repository map) with every workspace tool plus `openspec_workflow`, and loops until the model returns text. The graph nodes (`graph/nodes.ts`) then assert OpenSpec participation (`load_skill` + `instructions tasks|apply` logged by `OpenSpecTools`), completeness (`assertReady`: proposal/design/tasks/specs non-empty + `validate --strict`) and parse the role's JSON. Small models cannot hold the whole procedure in one context.

## Goals / Non-Goals

**Goals:**
- Small local models produce valid OpenSpec artifacts, implement tasks and review, passing the UNCHANGED graph post-checks.
- Every change gated on `provider.kind === 'openai-compatible'`; CLI executors byte-identical (prompts, tools, graph).
- Existing loop stays available as `agentLoop: 'free'`.
- Desktop keeps working: same `AgentEvent`s (tool-start/tool-end/text/usage), same usage aggregation.

**Non-Goals:**
- Streaming (`stream:false` stays).
- Changing `roleInstructions`, output schemas or the post-checks.
- Native structured output on CLI providers.

## Decisions

- **D1 Config** — additive fields on the openai-compatible provider only, parsed in `config.ts` (`keys(provider, [...,'agentLoop','contextWindowTokens'])`), mirrored in the JSON schema, echoed in `capabilities()` (`agentLoop`, `contextWindowTokens`) and advertised as `compactAgentLoop: 1` in `runtime api`. Defaults resolved at use time (`agentLoop ?? 'compact'`, `contextWindowTokens ?? 32768`) so a saved document stays lossless.
- **D2 Compact architect** — the executor, not the model, drives `OpenSpecTools` (`load_skill → new → instructions <artifact> → write_artifact → validate`) so the participation log and `assertReady` pass unchanged. Steps: bounded `inventory` mini-loop (list_files/read_file/search_text only, 12 calls) → JSON; `proposal`, `design`, `specs`, `tasks` are tool-less structured calls with `response_format: json_schema` (fallback to instruction + tolerant parse when the endpoint rejects it — detected by an HTTP 4xx on the first structured call, then remembered). The host renders markdown from the JSON with the templates `openspec instructions <artifact>` returns. Greenfield is explicit input (inventory `greenfield: true` renders "the repository has no application code; the spec means building it from scratch") so the low-confidence question does not fire for that reason; `confidence` is `high` for greenfield and `medium` otherwise unless the tasks step reports `blockingQuestion`, keeping the onLowConfidence plumbing.
- **D3 Compact developer** — read `tasks.md` through `openspec_workflow(load_skill)` (which also logs `instructions apply`), split by `## N.` groups; per group run a bounded mini-loop (budget 25 tool calls) with the developer tool set, compaction per task, then the host ticks the group's checkboxes through `write_artifact tasks.md` and saves `write_progress`. The final `DEVELOPER_OUTPUT_SCHEMA` JSON is assembled by the host from per-task results.
- **D4 Compact reviewer** — `load_skill` (logs `instructions apply`), git diff per allowed root (`git diff HEAD` + untracked list, bounded), mini-loop with read_file/list_files (budget 15), final call forced to `REVIEW_OUTPUT_SCHEMA`; the criteria to certify are parsed from the frozen-obligations JSON the invoker appends to the prompt. `confidence-score.json` stays written by the graph from the parsed verdict (unchanged path).
- **D5 Guardrails** — implemented once in `compact/guarded-loop.ts` and used by both loops: consecutive identical call ≥3 → tool error "identical call repeated; move on"; ≥5 total identical → `AgentExecutionError('tool_loop')`; argument repair (non-empty non-placeholder `search_text.query`, `openspec_workflow.action` in enum, paths as strings) answered with an error carrying ONE correct example; empty final → one nudge; `content: ''` on assistant tool-call messages; compaction replaces oldest tool results (never system/user/last 4) with `[compacted: tool args → 120 chars]` when chars/4 > 70% of `contextWindowTokens`.
- **D6** — `stream:false`, usage aggregated exactly as today (per response, `usage` event after each).
- **D7 Selection** — inside `OpenAICompatibleExecutor.execute`: `(provider.agentLoop ?? 'compact') === 'compact'` → `runCompactRole`, else the guarded free loop. `createExecutorRegistry` unchanged; CLI untouched.
- **Input extraction** — the executor has no `PipelineContext`; the compact pipelines parse the deterministic sections of `request.prompt` (`## Frozen scope`, `## Answers from the requester`, `Current frozen acceptance obligations` JSON, the repository map header) so the graph and prompts stay unchanged.

## Risks / Trade-offs

- [A repair/deepen pass re-runs the whole compact pipeline] → acceptable: artifacts are overwritten idempotently; `new` is a no-op on an existing change.
- [Endpoints without `response_format` support] → fallback to instruction + tolerant parse, remembered per executor instance.
- [Host-rendered markdown drifts from OpenSpec templates] → the renderer follows the exact headings the CLI templates return (`## Why`, `## ADDED Requirements`, `- [ ] N.M`), and `validate --strict` runs before the step succeeds.

## Field findings (qwen3.5-9b, llama.cpp, 2026-09-15)

Two real implement runs against a 9B model shaped three guardrails that the
scripted tests alone did not surface:

- **Plan-as-code.** The `tasks` step named `openspec/changes/<change>/*.yaml`
  as the files to "implement"; the developer obeyed and `verify` failed with
  "Architecture artifacts changed after design approval". The tasks step now
  rejects any task targeting `openspec/` (one explanatory retry through the
  existing `validate` hook) and the developer's `write_file`/`apply_patch`
  refuse paths under `openspec/` with a tool error. The next run wrote real
  `src/**` and tests.
- **Loop in one group must not sink the step.** The third developer pass
  re-read the same file five times on the last task; the `tool_loop` abort
  discarded a step that had already passed verify twice. The developer now
  catches `tool_loop` per task group, marks that group's tasks incomplete with
  the reason and continues; the graph then retries once and parks the run as
  `blocked` on the open task — honest, resumable, nothing lost.
- **Host-driven OpenSpec calls look like agent tool calls in the log**
  (`openspec_workflow tasks.md`, `write_progress`) — expected; they are the
  host ticking tasks and saving progress, not the model editing the plan.
- **Environment is the host's, not the model's.** A greenfield build added
  `package.json` with jest but nothing installed it; `npm test` exited 127
  (`jest: command not found`) and the graph handed that to the developer as
  feedback, which a small model tried to "fix" in code for every attempt.
  `compact/environment.ts` recognises environment signatures and installs per
  ecosystem. The compact developer installs after any group that writes a
  manifest; the verify node installs once and re-verifies for EVERY developer
  (a fresh worktree has no `node_modules` whoever wrote the code) — prompts
  and argv of the CLI executors are untouched.
