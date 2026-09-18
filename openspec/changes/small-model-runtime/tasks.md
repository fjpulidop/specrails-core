## 1. Configuration

- [ ] 1.1 Add `agentLoop`/`contextWindowTokens` to config parsing, types, JSON schema, capabilities and the runtime API capabilities; test defaults and validation.

## 2. Guardrails and compact pipelines

- [ ] 2.1 Implement the guarded loop (repetition guard, argument repair, empty-final nudge, `content: ''`, compaction) shared by free and compact modes.
- [ ] 2.2 Implement the compact architect, developer and reviewer pipelines with host-driven OpenSpec calls and structured outputs; wire executor selection.

## 3. Tests and docs

- [ ] 3.1 Extend openai-executor tests and add compact-runtime tests (artifacts + post-checks, guard, repair, nudge, compaction, developer budget, reviewer schema) plus a Claude prompt snapshot regression.
- [ ] 3.2 Document the new fields in docs/agent-runtime.md; run typecheck, tests and build.

## 9. Field hardening (from real qwen3.5-9b runs)

- [x] 9.1 Architect `tasks` step rejects targets under `openspec/` and retries once with the reason
- [x] 9.2 Developer refuses `write_file`/`apply_patch` under `openspec/` with a tool error
- [x] 9.3 Developer closes only the looping task group on `tool_loop`; graph retries then parks `blocked`
- [x] 9.4 `read_verification_evidence` exempt from the workspace path rule in argument repair
- [x] 9.5 Developer correction pass: when every task is ticked, review/verify feedback becomes a synthetic "Review corrections" group (never ticked into tasks.md) so the model edits instead of reporting "already checked"
- [x] 9.6 Graph: compact developer passes that only continue unchecked tasks do not consume correction attempts (`developerCorrectionsSinceResume`); transition budget widened accordingly. CLI developers unchanged.
- [x] 9.7 `validateTaskPlan` (exported): openspec targets in any path shape (absolute, leading slash, backslashes) + document-only plans rejected; tasks prompt states greenfield builds the app from scratch
- [x] 9.8 `compact/environment.ts`: environment-failure signatures (exit 127, command not found, Cannot find module, ModuleNotFoundError…) + per-ecosystem installers (npm/pnpm/yarn, pip, go mod, cargo). Compact developer installs after a group that writes a manifest; the verify node (ALL developers, no prompt/argv change) installs once and re-verifies before handing an environment failure to the model.
- [x] 9.9 Developer group without a structured final reply (after the retry): result reconstructed from successful write/patch calls (`writtenFiles`), tasks left open — never a failed step
- [x] 9.10 Generic generation controls: `supportsReasoningEffort` on openai-compatible providers (config/schema/capabilities) → `reasoning_effort` forwarded per call (role effort default, `high` on Compact planning steps); planning steps send `temperature 0.2` + `max_tokens 8192`; tasks plan validated for requirement coverage, breadth (≥4 tasks / ≥2 groups for ≥3 requirements) and real task sentences
- [x] 9.11 Compact chat client streams (`stream: true` + `stream_options.include_usage`) and reassembles text / indexed tool_calls / trailing usage into the classic completion shape; plain-JSON bodies still accepted. Removes the undici headers timeout (`UND_ERR_HEADERS_TIMEOUT`) that killed high-effort planning calls before their first byte.
- [x] 9.12 Planning output budget 16384; a `finish_reason: length` on a planning step (hidden reasoning ate the budget) retries once at the next lower reasoning effort (high→medium→low) instead of failing the step
- [x] 9.13 Frozen acceptance criteria are the source of truth for the Compact architect: each criterion becomes a spec requirement (no "two to five" cap), and the task plan is validated for coverage against the criteria (identifier/number tokens) instead of the model's own summary
- [x] 9.14 Compact role timeout default 45 min (explicit timeouts respected; free loop unchanged); the criteria→requirements specs step runs at `medium` effort (long and mechanical), proposal/design/tasks stay `high`
- [x] 9.15 Evidence-gated ticking (a task naming files is done only when they exist) and deterministic diagnosis of unresolved imports (`Cannot find module '<rel>' from '<file>'` → the host locates the real file and states the exact import; bare packages / Python modules named) fed as concrete correction items
- [x] 9.16 A group surrendered with an excuse the disk contradicts ("no source files…" while application files exist) is retried once with the real repository inventory in the prompt; a second surrender stands
- [x] 9.17 Compaction also shrinks executed `write_file`/`apply_patch` arguments (whole files ride in tool-call args; the disk has them) — the developer's context stops growing by the size of every file it wrote; the chat client retries once after a 5xx or a network error
- [x] 9.18 Evidence gate also rejects stub files (placeholder imports, TODO-only, < 15 real lines; tests < 5 lines); the plan validator splits any task covering more than three requirements at once
- [x] 9.19 Environment repair installs the packages a failure names explicitly (`Try \`npm i --save-dev @types/jest\``, TS2582) before re-verifying
- [x] 9.20 `criterionTokens` (backticked identifiers, camel/snake ids, calls, numbers, hyphenated terms) drives plan coverage and the overload rule: a task touching more than two criteria is split
- [x] 9.21 Compact client dispatches through an undici Agent with headers/body timeouts off (built from the global dispatcher, no dependency) — the step's AbortSignal is the deadline; fixes `UND_ERR_BODY_TIMEOUT` when a model reasons > 5 min before its first token
- [x] 9.22 Tool turns carry an 8192 output budget; a cut-off turn (`length`) is retried once at 16384 and one effort notch lower (from the client's default effort) before failing
- [x] 9.23 A per-model 400 rejecting `reasoning_effort` ("does not support thinking") disables the field for the session and resends once, so a connection-level declaration never blocks a non-reasoning model
- [x] 9.24 `blockingQuestion` counts only when it is a real question ("?" and not the prompt's own placeholder echoed back); the tasks example no longer contains instruction text a non-reasoning model could copy
- [x] 9.25 Environment repair recognises a missing Jest transform/preset module (`Module ts-jest in the transform option was not found`, `Preset X not found`) and installs it
