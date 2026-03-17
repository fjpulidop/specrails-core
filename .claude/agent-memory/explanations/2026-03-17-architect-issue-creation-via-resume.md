---
agent: architect
feature: feature-proposal-modal
tags: [issue-creation, gh, resume, claude-cli]
date: 2026-03-17
---

## Decision

GitHub Issue creation is performed by resuming the Claude session with a fixed prompt, not by a direct `gh issue create` shell invocation from the server.

## Why This Approach

The proposal content exists inside Claude's session context. A `--resume` turn with "Create a GitHub Issue based on the proposal above" lets Claude compose a properly formatted issue body from the proposal it already produced — without the server needing to parse and reconstruct the markdown. A direct server-side `gh issue create` call would require extracting the proposal sections, constructing the body, and managing argument escaping — all fragile compared to letting Claude do it within context.

## Alternatives Considered

- Server directly calls `gh issue create --title "..." --body "..." --label user-proposed` after extracting the proposal — rejected because parsing the structured markdown from `result_markdown` is brittle; Claude is better at using its own output
- Separate Claude invocation (new session) with the proposal markdown embedded — rejected because `--resume` is available and cleaner; the session already has the full codebase context

## See Also

- `/Users/javi/repos/specrails/openspec/changes/feature-proposal-modal/design.md` (section 2.3, Decision 2)
