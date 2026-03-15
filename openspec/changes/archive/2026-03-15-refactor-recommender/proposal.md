---
change: refactor-recommender
type: feature
status: shipped
github_issue: 11
vpc_fit: 75%
---

# Proposal: Refactor Priority Recommender

## Problem

Technical debt accumulates silently in every codebase. The current specrails workflow excels at shipping new features but has no mechanism for an architect to systematically identify and prioritize refactoring work. The result is predictable:

- **Debt is invisible**: There is no structured way to surface duplicate code, long functions, circular dependencies, or dead code across a codebase. Individual engineers notice issues locally but there is no shared, ranked view.
- **Prioritization is intuitive, not data-driven**: When an architect decides to "pay down debt", the selection criteria are informal. High-impact, low-effort refactors get buried under high-noise, low-value ones.
- **No artifact trail**: Refactoring ideas live in individual notes or Slack threads, never becoming actionable backlog items with code evidence (before/after snippets) attached.

The consequence is a growing gap between product feature velocity and codebase health — a gap that compounds over time until it forces a disruptive "cleanup sprint" rather than a continuous improvement cadence.

## Solution

Add a `/refactor-recommender` slash command that analyzes the codebase for refactoring opportunities and creates ranked GitHub Issues. The command:

1. Scans for six categories of refactoring opportunity: duplicate code, long functions, large files, circular dependencies, outdated patterns, and dead code.
2. For each opportunity found, produces: a current code snippet, a proposed refactored code snippet, a rationale explaining the improvement, and an impact/effort score.
3. Ranks all findings by impact/effort score.
4. Creates a GitHub Issue per finding with label `refactor-opportunity`, containing the full analysis.
5. Presents a ranked summary table at the end.

This is implemented as a Claude Code slash command — no new agent. Claude's analysis capabilities handle the codebase scanning. The command file is a template that install.sh copies into target repos as part of the standard setup-templates mechanism.

## Scope

**In scope:**
- New command template: `templates/commands/refactor-recommender.md`
- Six analysis categories: duplicate code, long functions, large files, circular dependencies, outdated patterns, dead code
- Impact/effort scoring (1-5 scale, integer values)
- Before/after code snippets in each finding
- GitHub Issues creation with `refactor-opportunity` label
- Ranked summary table output
- `$ARGUMENTS` support: optional comma-separated file/directory paths to scope the analysis
- `--dry-run` flag: output findings to console without creating GitHub Issues
- Placeholder substitution compatible with install.sh (`{{PROJECT_NAME}}`, `{{BACKLOG_PROVIDER_NAME}}`)

**Out of scope:**
- Automated code transformation or PR creation (the command identifies opportunities; humans decide whether to implement them)
- JIRA integration (the existing product-backlog command supports JIRA; refactor-recommender targets GitHub Issues only in this iteration)
- AST-based static analysis tooling (Claude's code reading is sufficient and keeps the implementation tool-agnostic)
- CI integration or scheduled runs
- Custom scoring thresholds via config (fixed 1-5 scale for simplicity in v1)

## Non-goals

- The command does NOT implement refactors. It creates backlog items for the `/implement` command to pick up.
- The command does NOT modify any source files.
- The command does NOT block shipping: refactoring issues are advisory, not gates.

## Acceptance Criteria

1. `templates/commands/refactor-recommender.md` exists with valid frontmatter and correct `{{PLACEHOLDER}}` syntax.
2. Running `/refactor-recommender` on any repository produces findings in at least three of the six analysis categories (or a clear "none found" message per category).
3. Each finding includes: category, file path, current snippet, proposed snippet, rationale, impact score (1-5), effort score (1-5), and composite score.
4. Without `--dry-run`, each finding results in exactly one GitHub Issue labeled `refactor-opportunity`.
5. With `--dry-run`, no GitHub Issues are created; output goes to console only.
6. The final output is a ranked table of all findings ordered by composite score (highest first).
7. The command respects `$ARGUMENTS` path scoping: when paths are provided, analysis is restricted to those paths.
8. Duplicate detection: the command checks for existing open issues with label `refactor-opportunity` and skips creating duplicates (same file + same category).
9. `install.sh` does not need modification — it already copies all files from `templates/commands/` into `.claude/setup-templates/commands/`, and `/setup` installs them into `.claude/commands/`.

## Motivation

VPC fit score: 75%. Alex (Lead Dev, 5/5) gives this the highest possible weight — surfacing refactoring opportunities with code evidence is a direct force multiplier for an architect role. Kai (DevOps/Platform, 4/5) values the reduction in unplanned "surprise cleanup" work. Sara (Product Owner, 2/5) scores lower, as expected: this is an engineering-health concern that affects product velocity indirectly, not product discovery directly.
