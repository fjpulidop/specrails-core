---
change: auto-doc-sync-agent
type: feature
status: shipped
github_issue: 7
vpc_fit: 65%
---

# Proposal: Auto-Doc Sync Agent

## Problem

Documentation is the most reliably neglected output of AI-driven development pipelines. The current specrails implement pipeline (architect → developer → test-writer → reviewer) produces working, tested code but leaves documentation entirely to human judgment after the fact.

The symptoms compound quickly:

- **API docs drift**: Docstrings and function-level comments are added inconsistently or not at all. Without a dedicated pass, an AI developer agent prioritizes working code over documentation.
- **Changelogs go unwritten**: Conventional commit messages exist in git history but are never aggregated into a changelog. Maintainers either skip releases or write changelogs manually under deadline pressure.
- **READMEs become stale**: New features ship without being listed anywhere a user would discover them. The README describes a version of the software that no longer exists.
- **Breaking changes are silent**: When an implementation modifies a public API or schema, downstream consumers are not warned unless someone manually writes a migration guide. In AI-assisted codebases this happens more frequently and is caught less reliably.

The net effect is a trust deficit: even when the code is correct and tested, a maintainer who reads the repository cannot understand what it does or how it has changed. Documentation staleness is a compounding problem — the further behind it falls, the harder it becomes to recover.

## Solution

Add a `doc-sync` agent that runs as **Phase 3d** in the implement pipeline, immediately after the test-writer (Phase 3c) and before the reviewer (Phase 4). The agent:

1. Reads the list of files created or modified by the developer for this feature.
2. Reads existing documentation to detect the project's documentation style, format, and conventions.
3. Detects whether docstrings, a changelog, a README feature listing, or migration guides are present in the project, and which conventions govern each.
4. Generates only the documentation types that the project already uses — it does not introduce new documentation conventions.
5. Writes all generated documentation directly to the correct files alongside the implementation.
6. Is non-blocking: if the agent fails or detects no documentation conventions, the pipeline continues without documentation. The reviewer notes the gap.

The agent does not invent a documentation system from scratch. It reads what exists and extends it consistently.

## Scope

**In scope:**

- New agent template: `templates/agents/doc-sync.md`
- Generated specrails instance: `.claude/agents/doc-sync.md`
- New pipeline phase: Phase 3d (Doc Sync) inserted between Phase 3c (Write Tests) and Phase 4 (Merge & Review) in `templates/commands/implement.md` and `.claude/commands/implement.md`
- Agent memory directory: `.claude/agent-memory/doc-sync/MEMORY.md`
- Update to the Phase 4e report table: add `Docs` column between `Tests` and `Reviewer`

**Out of scope:**

- Generating a full documentation site or static site (Docusaurus, MkDocs, etc.)
- Writing tests for documentation correctness
- Auto-publishing changelogs to GitHub Releases
- Enforcing documentation coverage thresholds via CI
- Adding documentation conventions to repos that have none (agent detects and skips gracefully, does not impose)
- Translating documentation into other languages

## Non-goals

- The doc-sync agent does NOT modify implementation code to make it more documentable.
- The doc-sync agent does NOT run CI checks.
- The doc-sync agent does NOT create a new documentation convention if none exists.
- The doc-sync agent does NOT close issues or create PRs.

## Acceptance Criteria

1. `templates/agents/doc-sync.md` exists with correct `{{PLACEHOLDER}}` syntax and YAML frontmatter.
2. `.claude/agents/doc-sync.md` exists with all placeholders resolved for the specrails repo.
3. Phase 3d is present in `templates/commands/implement.md`, positioned after Phase 3c and before Phase 4.
4. Phase 3d is present in `.claude/commands/implement.md` with all placeholders resolved.
5. The doc-sync agent launches after each test-writer completes (or after all test-writers complete in multi-feature mode).
6. Documentation style detection covers: inline docstrings, CHANGELOG.md, README.md feature sections, migration guides.
7. The agent generates only documentation types it detects as already present in the project.
8. The Phase 4e report table includes a `Docs` column between `Tests` and `Reviewer` in both implement files.
9. Failure is non-blocking — if the agent fails or detects nothing, the pipeline proceeds.
10. `.claude/agent-memory/doc-sync/MEMORY.md` exists with a valid empty-memory header.

## Motivation

VPC fit score: 65%. The feature directly addresses the documentation debt that accumulates in every sprint. Documentation staleness is a known maintenance cost: maintainers spend time catching up docs after features ship. This agent turns doc writing from a trailing manual task into a built-in pipeline output, consistent with how the test-writer turned test writing from a trailing task into Phase 3c.

The feature is additive and non-blocking. Its worst-case behavior is a clean no-op: if the agent cannot determine the project's documentation style, it outputs `SKIPPED` and the reviewer notes the gap. Its best-case behavior is automatic, style-consistent documentation that ships alongside every feature.
