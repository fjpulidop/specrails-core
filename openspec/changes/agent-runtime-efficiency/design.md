## Context

Core uses a durable five-phase LangGraph workflow; CLI agents provide rich native tools, while the API executor exposes only whole-file operations. Desktop reads compact Core status. Both repositories start from freshly pulled main on codex/agent-runtime-efficiency.

## Goals / Non-Goals

Goals: avoid the instructed duplicate full test run; provide bounded search/range/diff/patch operations; report per-phase cost, tokens, cache usage, provider calls, tool calls and durations across corrections and resumes.

Non-goals: new models, adaptive routing, relaxed review gates, parallel verification, verification result caching, hard spending guarantees unsupported by providers, a benchmark claim without real runs.

## Decisions

- The developer runs focused tests; Core alone owns the final complete check and authoritative receipt. Bump the instruction version to preserve frozen run identity. No shell-output claim is accepted as evidence.
- Keep workspace tools cross-platform and synchronous, without a new dependency. Search literal text within bounded files/directories; range reads return numbered lines; exact-match patches reject absent/ambiguous text and optionally stale content hashes. Reuse root, metadata and symlink checks. Diff is read-only Git with external diff/textconv disabled, scoped paths and bounded output; it does not execute repository code.
- Add optional cache token counters without changing input token totals or existing budgets. Unknown counters remain unknown; provider-native billing remains the cost source.
- Record each provider invocation (including repair/fallback failures) with requested provider/model, duration and tool-call count on its attempt, and persist after reporting usage. Agent duration includes CLI-internal tool work; it is not labelled inference time. Old checkpoints without measurements remain readable.
- Derive a bounded per-phase summary from the durable attempt ledger on status/result. Count all attempts including failed/superseded ones; polling and resumes do not add spend. Desktop displays available totals and phase data; older Core versions omit the panel. No transcript or credentials are added to reports.

## Risks / Trade-offs

- Search can consume resources → bound traversal, file bytes, match count and output; indicate truncation and skip protected paths.
- Stale patch context → require one exact match and support a content fingerprint; atomic replacement preserves permissions.
- Provider usage varies → keep missing values null and expose coverage of invocation measurements.
- Timing cannot separate native CLI tools from inference → report agent wall time separately from deterministic verification time.
- Frozen prompt identity changes → existing runs retain compatibility protection and require their original runtime to resume; document this.

## Migration Plan

Ship additive Core fields and optional Desktop rendering independently. Retain configuration defaults and API version. Revert this branch to roll back; no database migration.
