---
name: "Team Review"
description: "Multi-perspective code review using Claude Code Agent Teams. Three specialized reviewers (security, performance, correctness) independently review changes, debate findings, and produce a consolidated report."
category: Workflow
tags: [workflow, review, agent-teams, security, performance]
---

Multi-perspective code review for **{{PROJECT_NAME}}** using Claude Code Agent Teams. Three specialized reviewers analyze changes independently, debate cross-cutting findings, and produce a consolidated report.

**Input:** $ARGUMENTS — required: a review target in one of these forms:
- `#123` — review a pull request by number
- `feat/my-feature` — review a branch diff against base
- `abc1234..def5678` — review a commit range

Optional flags:
- `--base <branch>` — override base branch for comparison (default: repository default branch)
- `--focus <areas>` — comma-separated focus areas to weight: `security`, `performance`, `correctness`, `tests`, `types`

---

## Phase 0: Feature Flag Guard

**This check is mandatory and runs before anything else.**

Check whether Agent Teams is enabled:

```bash
echo "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}"
```

If the variable is unset or not equal to `1`, print this message and **stop immediately**:

```
Error: Agent Teams is an experimental feature that requires opt-in.

To enable it, set the environment variable before starting Claude Code:

  export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

Agent Teams requires Claude Code v2.1.32 or later.
```

Do NOT proceed past this point if the guard fails.

---

## Phase 1: Input Parsing

Parse `$ARGUMENTS` to determine the review target and flags.

**Variables to set:**

- `REVIEW_TARGET` — the PR number, branch name, or commit range
- `REVIEW_TYPE` — `"pr"`, `"branch"`, or `"range"`
- `BASE_BRANCH` — from `--base` flag or detect via `gh repo view --json defaultBranchRef -q '.defaultBranchRef.name'` or fall back to `main`
- `FOCUS_AREAS` — array from `--focus` flag or `["all"]`

**Detection rules:**

1. If input starts with `#` or is a bare integer → `REVIEW_TYPE="pr"`, strip `#` prefix
2. If input contains `..` → `REVIEW_TYPE="range"`
3. Otherwise → `REVIEW_TYPE="branch"`

If `$ARGUMENTS` is empty, print usage and stop:
```
Usage: {{COMMAND_PREFIX}}team-review <target> [--base <branch>] [--focus <areas>]

Examples:
  {{COMMAND_PREFIX}}team-review #42
  {{COMMAND_PREFIX}}team-review feat/new-auth --focus security
  {{COMMAND_PREFIX}}team-review abc123..def456
```

---

## Phase 2: Gather Diff

Collect the code changes based on `REVIEW_TYPE`:

- **PR**: Run `gh pr diff <REVIEW_TARGET>` and `gh pr diff <REVIEW_TARGET> --name-only`
- **Branch**: Run `git diff ${BASE_BRANCH}...${REVIEW_TARGET}` and `git diff --name-only ${BASE_BRANCH}...${REVIEW_TARGET}`
- **Range**: Run `git diff ${REVIEW_TARGET}` and `git diff --name-only ${REVIEW_TARGET}`

Also collect file-level stats: `git diff --stat <appropriate-range>`

**Store these variables for Phase 3:**
- `DIFF_CONTENT` — full unified diff
- `CHANGED_FILES` — list of changed file paths
- `DIFF_STATS` — file-level line count changes

If the diff is empty, print `No changes found for the given review target.` and stop.

Print a summary:
```
## Review Target
Type: <PR / Branch / Range>
Target: <REVIEW_TARGET>
Base: <BASE_BRANCH>
Changed files: <N>
Focus: <FOCUS_AREAS or "all areas">

<DIFF_STATS output>
```

---

## Phase 3: Launch Team Review

Create three reviewer teammates using Agent Teams. Each teammate receives the full diff and file list.

**IMPORTANT:** Use the Agent Teams teammate mechanism — NOT the Agent tool's `subagent_type`. Teammates share a task list and can message each other via mailbox.

### Teammate 1: Security Reviewer

**Persona:** sr-security-reviewer (or sr-reviewer with security focus if persona not available)

**Prompt:**
```
You are the Security Reviewer on a team code review.

## Your Focus Areas
- Authentication and authorization flaws
- Input validation and injection vulnerabilities (SQL, XSS, command injection)
- Secrets or credentials in code
- OWASP Top 10 vulnerabilities
- Insecure dependencies or configurations
- Missing rate limiting or access controls

## Changed Files
<CHANGED_FILES>

## Diff
<DIFF_CONTENT>

## Instructions
1. Review every changed file through a security lens
2. Report findings using the format below — be specific about file, line, and fix
3. After completing your review, read the other reviewers' findings from the task list
4. If you have security-relevant context on their findings, send a mailbox message

## Report Format
Post your findings as a task list update:

### Security Review Findings

#### Summary
<1-2 sentences>

#### Findings
| # | Severity | File | Line(s) | Finding | Recommendation |
|---|----------|------|---------|---------|----------------|

#### Verdict
<APPROVE / REQUEST_CHANGES / COMMENT>
```

### Teammate 2: Performance Reviewer

**Persona:** sr-performance-reviewer (or sr-reviewer with performance focus if persona not available)

**Prompt:**
```
You are the Performance Reviewer on a team code review.

## Your Focus Areas
- Database query complexity and N+1 queries
- Missing or broken caching
- Memory leaks and excessive allocations
- Algorithmic complexity (O(n^2) or worse in hot paths)
- Bundle size and lazy loading concerns (frontend)
- Missing pagination or unbounded data fetching

## Changed Files
<CHANGED_FILES>

## Diff
<DIFF_CONTENT>

## Instructions
1. Review every changed file through a performance lens
2. Report findings using the format below — be specific about file, line, and fix
3. After completing your review, read the other reviewers' findings from the task list
4. If you have performance-relevant context on their findings, send a mailbox message

## Report Format
Post your findings as a task list update:

### Performance Review Findings

#### Summary
<1-2 sentences>

#### Findings
| # | Severity | File | Line(s) | Finding | Recommendation |
|---|----------|------|---------|---------|----------------|

#### Verdict
<APPROVE / REQUEST_CHANGES / COMMENT>
```

### Teammate 3: Correctness Reviewer

**Persona:** sr-reviewer

**Prompt:**
```
You are the Correctness Reviewer on a team code review.

## Your Focus Areas
- Logic errors and edge cases
- Missing or inadequate test coverage
- Type safety violations
- Error handling gaps (uncaught exceptions, missing error paths)
- API contract mismatches
- Race conditions and concurrency issues

## Changed Files
<CHANGED_FILES>

## Diff
<DIFF_CONTENT>

## Instructions
1. Review every changed file through a correctness and test coverage lens
2. Report findings using the format below — be specific about file, line, and fix
3. After completing your review, read the other reviewers' findings from the task list
4. If you have correctness-relevant context on their findings, send a mailbox message

## Report Format
Post your findings as a task list update:

### Correctness Review Findings

#### Summary
<1-2 sentences>

#### Findings
| # | Severity | File | Line(s) | Finding | Recommendation |
|---|----------|------|---------|---------|----------------|

#### Verdict
<APPROVE / REQUEST_CHANGES / COMMENT>
```

### Team Coordination

After launching all three teammates:

1. Wait for all three to complete their independent reviews (posted to the shared task list)
2. Allow one round of cross-review debate via mailbox — each reviewer may respond to findings from the other two
3. Collect all findings and debate outcomes

If any teammate fails to respond, proceed with available reviews and note the gap in the final report.

---

## Phase 4: Synthesize Consolidated Report

After all reviews and debate are complete, the team lead produces the final report.

### Step 1: Collect and Deduplicate

1. Read all three reviewer reports from the task list
2. Identify duplicate findings (same file + overlapping lines + similar issue)
3. For duplicates: keep the highest-severity version, note which reviewers flagged it

### Step 2: Apply Focus Weighting

If `FOCUS_AREAS` is not `["all"]`:
- Findings in focus areas get their severity preserved
- Findings outside focus areas: Critical stays Critical, but High→Medium, Medium→Low for display purposes
- Note the weighting in the report header

### Step 3: Render Report

```markdown
## Team Review Report

**Target:** <PR #N / branch-name / commit-range>
**Base:** <BASE_BRANCH>
**Reviewers:** Security, Performance, Correctness
**Changed files:** N files (+X/-Y lines)
**Focus:** <FOCUS_AREAS or "all areas equally weighted">

---

### Critical Findings (action required before merge)

| # | Severity | Domain | File | Line(s) | Finding | Recommendation | Flagged By |
|---|----------|--------|------|---------|---------|----------------|------------|

### High-Priority Findings

| # | Severity | Domain | File | Line(s) | Finding | Recommendation | Flagged By |
|---|----------|--------|------|---------|---------|----------------|------------|

### Medium & Low Findings

| # | Severity | Domain | File | Line(s) | Finding | Recommendation |
|---|----------|--------|------|---------|---------|----------------|

### Praise (things done well)
<positive observations from reviewers>

---

### Cross-Review Notes
<any points of debate or disagreement between reviewers, with resolution>

---

### Reviewer Verdicts

| Reviewer | Verdict | Critical | High | Medium | Low | Info |
|----------|---------|----------|------|--------|-----|------|
| Security | APPROVE/REQUEST_CHANGES | N | N | N | N | N |
| Performance | APPROVE/REQUEST_CHANGES | N | N | N | N | N |
| Correctness | APPROVE/REQUEST_CHANGES | N | N | N | N | N |

### Overall Verdict: <APPROVE / REQUEST_CHANGES>

<one-paragraph summary: key risks, recommended actions, and overall assessment>
```

### Step 4: Cost Notice

Print a brief cost notice after the report:

```
Note: Team review used ~3x the tokens of a single-reviewer run (3 parallel reviewers + debate round).
```

---

## Rules

- This command is **read-only** — it MUST NOT create, modify, or delete any files
- All three reviewers run as Agent Teams teammates, not as Agent tool subagents
- If Agent Teams is unavailable at runtime (API error, version mismatch), fall back to running three sequential Agent tool subagents with `subagent_type: sr-reviewer` and skip the debate phase. Print a warning about the fallback.
- The debate phase is limited to one round per reviewer to control token costs
- Findings MUST include file paths and line numbers — vague findings are not acceptable
