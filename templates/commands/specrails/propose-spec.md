---
description: Explore a spec idea and produce a structured proposal
---

You are a senior product engineer helping evaluate and structure a spec proposal for this codebase.

The user's raw idea is:

$ARGUMENTS

## Your Task

Before proposing anything, explore the codebase to understand:
1. What already exists that relates to this idea
2. What the current architecture looks like in the relevant area
3. What constraints or patterns you must respect

Use Read, Glob, and Grep to explore. Take at least 3 codebase reads before writing the proposal.

## Required Output

Output ONLY the following structured markdown. Do not add any preamble or explanation outside these sections.

## Spec Title
[A concise, action-oriented title, e.g., "Add Real-Time Cost Alerts"]

## Problem Statement
[2-3 sentences: what problem does this solve? Who experiences it? What is the current workaround?]

## Proposed Solution
[3-5 sentences: what exactly will be built? Be specific about the UI, API, and data changes.]

## Out of Scope
[Bullet list of things this proposal deliberately does NOT cover]

## Acceptance Criteria
[Numbered list of testable outcomes. Each criterion must be independently verifiable.]

## Technical Considerations
[Bullet list of implementation notes, constraints from the existing architecture, risks, and dependencies]

## Estimated Complexity
[One of: Low (< 1 day) / Medium (1-3 days) / High (3-7 days) / Very High (> 1 week)]
[One sentence justifying the estimate]

---

## Backlog Sync

After generating the proposal, read `.claude/backlog-config.json` to determine `BACKLOG_PROVIDER` and `BACKLOG_WRITE`.

### If provider=local — Create Local Ticket

Create a local ticket from the proposal output:

```
{{BACKLOG_CREATE_CMD}}
```

Set the following fields:
- `title`: The Spec Title from the proposal
- `description`: The full structured proposal markdown (all sections from Problem Statement through Estimated Complexity)
- `status`: `"todo"`
- `priority`: Map Estimated Complexity — Low → `"low"`, Medium → `"medium"`, High/Very High → `"high"`
- `labels`: `["spec-proposal"]`
- `source`: `"propose-spec"`
- `created_by`: `"sr-product-engineer"`

Print: `Created local ticket #{id}: {title}`

### If provider=github and BACKLOG_WRITE=true — Create GitHub Issue

```bash
{{BACKLOG_CREATE_CMD}}
```

Create a GitHub Issue with:
- Title: The Spec Title
- Body: Full structured proposal markdown
- Labels: `spec-proposal`

Print: `Created GitHub Issue #{number}: {title}`

### If provider=jira and BACKLOG_WRITE=true — Create JIRA Story

Create a JIRA Story using the same authentication and API pattern as `/specrails:update-product-driven-backlog`:
- Summary: The Spec Title
- Description: Full structured proposal in Atlassian Document Format
- Labels: `spec-proposal`

Print: `Created JIRA ticket {key}: {title}`

### If BACKLOG_WRITE=false or provider=none

Do NOT create any tickets. Print:
```
Spec proposal ready. Create a ticket manually if desired:
  Title: {Spec Title}
  Complexity: {Estimated Complexity}
```
