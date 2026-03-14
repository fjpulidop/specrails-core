---
change: in-context-help
type: feature
status: proposed
github_issue: 45
vpc_fit: 70%
---

# Proposal: AI-Powered In-Context Help System

## Problem

New developers joining a project that uses specrails face a steep learning curve. The agent pipeline (architect, developer, reviewer) produces correct code and artifacts, but produces no explanation of *why* it made the decisions it did. Design choices, convention selections, and architectural constraints are embedded in agent prompts and OpenSpec artifacts — but are never surfaced in plain language at the moment the decision is made.

Concretely, a developer who sees the reviewer add a `set -euo pipefail` header to a script has no quick way to find out: "Is this a project convention? Who decided this? Where is it documented? Does it apply to all scripts or just this type?" They must grep CLAUDE.md files, hunt through `.claude/rules/`, and read multiple agent prompt templates to piece together the answer.

The result: onboarding takes longer than necessary, the same questions get asked repeatedly, and the rationale behind conventions erodes from institutional memory as it remains unwritten.

## Solution

Introduce an explanation recording system that captures, in Markdown, the reasoning behind each significant agent decision — and a `/why` command that lets any developer quickly search those explanations by keyword or tag.

Three changes work together:

1. **Explanation recording in agent prompts**: Architect, developer, and reviewer templates gain a lightweight "Explain Your Work" section. When an agent makes a non-trivial decision (applies a convention, chooses an approach, rejects an alternative), it writes a Markdown explanation record to `.claude/agent-memory/explanations/`.

2. **Explanation record format**: A simple, human-readable Markdown file with YAML frontmatter (agent, feature, tags, date). The body answers three questions: *What was decided*, *Why this approach*, *What alternatives were considered*. Files are stored under `.claude/agent-memory/explanations/` with dated, kebab-case filenames.

3. **`/why` command**: A new Claude Code slash command that searches explanation records. It accepts a keyword or tag, globs the explanations directory, and surfaces relevant records in a readable format.

## Success Criteria

- An agent (architect, developer, or reviewer) produces at least one explanation record per run when it makes a non-trivial decision
- Explanation records are valid Markdown with required frontmatter fields (agent, feature, tags, date)
- `/why <query>` returns matching explanation records ranked by relevance
- `/why set -euo pipefail` surfaces the shell conventions explanation (or indicates none exists yet)
- No external dependencies introduced — grep/glob only, no search index
- New developers can self-serve answers to "why does this code do X?" without asking the team

## Non-Goals

- Full semantic search or vector embeddings — text search is sufficient for this phase
- Explanation records are not mandatory — agents should use judgment (avoid noise)
- This does not replace CLAUDE.md or `.claude/rules/` as the authoritative convention source
- No UI — purely CLI via the `/why` command
