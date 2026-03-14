---
change: specialized-layer-reviewers
type: feature
status: proposed
github_issue: 40
vpc_fit: 78%
---

# Proposal: Specialized Layer Reviewers

## Problem

The current reviewer agent (`templates/agents/reviewer.md`) is a generalist. It runs CI checks, applies broad code quality rules, and produces a pass/fail decision — but it reviews all code through a single lens. This works well for catching CI failures and obvious quality issues, but it systematically misses problems that require deep domain expertise.

Three categories of issues consistently escape generalist review:

**Security:** Subtle vulnerabilities — SQL injection through ORM misuse, JWT algorithm confusion, path traversal in utility functions — require pattern-matching knowledge that goes beyond checking for hardcoded secrets. The existing `security-reviewer` agent covers secrets and basic OWASP patterns, but it is positioned as an add-on rather than an integrated gate.

**Frontend:** Bundle size regressions, accessibility failures (missing ARIA roles, insufficient color contrast), and render-blocking resource patterns are invisible to a reviewer that runs the same CI checks as the backend. Frontend code quality is defined by metrics the generalist cannot compute.

**Backend:** N+1 query patterns, connection pool exhaustion, missing database indexes, and unbounded pagination are architectural problems that appear in perfectly CI-passing code. A generalist reviewer has no framework for recognizing these patterns specifically.

The result: code ships that is green in CI, passes the generalist reviewer, and later causes a production incident or accessibility audit failure.

## Solution

Extend the `/implement` pipeline to dispatch specialized layer reviews in parallel before the generalist reviewer makes its pass/fail decision.

Three new agent templates are introduced:

- `templates/agents/frontend-reviewer.md` — reviews frontend-layer changes for bundle size, accessibility (WCAG 2.1 AA), and render performance.
- `templates/agents/backend-reviewer.md` — reviews backend-layer changes for N+1 query patterns, connection pool usage, pagination safety, and missing indexes.
- `templates/agents/security-reviewer.md` — the existing agent is promoted and standardized to integrate as a first-class parallel reviewer rather than a sequential afterthought.

The generalist reviewer (`reviewer.md`) is updated to receive and synthesize the outputs from all three layer reviewers before making its final pass/fail decision. This synthesis step is purely additive — the generalist still runs CI and applies its own checks, but now has specialist findings as input.

Layer classification is the key design decision. Each file in the modified set is classified by file extension and directory path. Classification is heuristic-based and runs inside the generalist reviewer's dispatch step — no separate classification agent is needed.

## Non-Goals

- This does not add a new `/review` command. Layer reviews are integrated into the existing `/implement` pipeline only.
- This does not require agents to fix issues they find. Frontend and backend reviewers are scan-and-report only (matching the security-reviewer pattern). Only the generalist reviewer fixes issues.
- This does not introduce per-layer pass/fail gates that can independently block the pipeline. Only the generalist reviewer sets the final pass/fail. Layer reviewer findings are advisory inputs.
- This does not change the security-reviewer's SECURITY_STATUS protocol. Its output contract is unchanged.
- This does not add configuration for which layers to enable. All three run whenever relevant files are detected. If no files match a layer, the reviewer is skipped.

## Scope

Files created:

1. `templates/agents/frontend-reviewer.md` — new agent template
2. `templates/agents/backend-reviewer.md` — new agent template

Files modified:

3. `templates/agents/reviewer.md` — adds a dispatch section for layer reviewers and a synthesis section for their reports
4. `templates/commands/implement.md` — Phase 4b updated to launch layer reviewers in parallel before the generalist reviewer
5. `.claude/commands/implement.md` — synchronized with template change (resolved version in specrails' own installation)

## Success Criteria

- After a frontend-only change, the frontend-reviewer runs and its findings appear in the reviewer's final report.
- After a backend-only change, the backend-reviewer runs; frontend-reviewer is skipped with a "no frontend files" notice.
- After a mixed change, all three layer reviewers run in parallel.
- The generalist reviewer's final report includes a "Layer Review Findings" section summarizing each specialist's output.
- The generalist reviewer's pass/fail decision is informed by layer findings: a Critical frontend or backend finding causes the reviewer to flag the issue prominently (but the generalist still decides whether to block).
- No `{{PLACEHOLDER}}` tokens remain unresolved in installed agent files after `/setup` runs.
- The change is backward-compatible: target repos with no frontend or backend files continue to work correctly (layer reviewers are skipped, not errored).
