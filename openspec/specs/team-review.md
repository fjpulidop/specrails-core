# Spec: /sr:team-review Command

The `/sr:team-review` command orchestrates a multi-perspective code review using Claude Code Agent Teams (experimental). Three specialized reviewers work as teammates — security, performance, and correctness — debating findings via mailbox before a team lead synthesizes a consolidated report.

---

## Prerequisites

- Claude Code v2.1.32+ with Agent Teams support
- Environment variable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` must be set

---

## Flags

### Input (required, positional)

Accepts one of:
- **PR number**: `#123` — reviews the diff for that pull request
- **Branch name**: `feat/my-feature` — reviews the diff between the branch and its base (typically `main`)
- **Commit range**: `abc1234..def5678` — reviews the diff across that commit range

### `--base <branch>`

Override the base branch for comparison. Default: repository's default branch (usually `main`).

### `--focus <areas>`

Comma-separated focus areas to weight more heavily. Valid values: `security`, `performance`, `correctness`, `tests`, `types`. Default: all areas equally weighted.

---

## Feature Flag Guard

Before any work begins, the command MUST check:

```bash
echo "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}"
```

If the variable is unset or not equal to `1`, print:

```
Error: Agent Teams is an experimental feature that requires opt-in.

To enable it, set the environment variable before starting Claude Code:

  export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

Agent Teams requires Claude Code v2.1.32 or later.
```

Then stop. Do not proceed with any review work.

---

## Team Composition

The team lead (the orchestrator running this command) coordinates three reviewer teammates:

| Teammate | Persona | Focus |
|----------|---------|-------|
| Security Reviewer | sr-security-reviewer | Authentication, authorization, injection, secrets, OWASP top 10 |
| Performance Reviewer | sr-performance-reviewer | Query complexity, memory usage, caching, algorithmic efficiency |
| Correctness Reviewer | sr-reviewer | Logic errors, edge cases, test coverage, type safety |

Each teammate runs as a Claude Code Agent Teams teammate — not as a subagent via the Agent tool.

---

## Workflow

### Phase 0: Input Parsing

Parse `$ARGUMENTS` to determine the review target.

**Variables to set:**
- `REVIEW_TARGET` — the PR number, branch name, or commit range
- `REVIEW_TYPE` — `"pr"`, `"branch"`, or `"range"`
- `BASE_BRANCH` — from `--base` flag or default branch
- `FOCUS_AREAS` — array from `--focus` flag or `["all"]`

**Detection rules:**
1. If input starts with `#` or is a bare integer: `REVIEW_TYPE="pr"`, strip `#` prefix
2. If input contains `..`: `REVIEW_TYPE="range"`
3. Otherwise: `REVIEW_TYPE="branch"`

### Phase 1: Gather Diff

Collect the code changes to review based on `REVIEW_TYPE`:

- **PR**: `gh pr diff <number>`
- **Branch**: `git diff <BASE_BRANCH>...<REVIEW_TARGET>`
- **Range**: `git diff <REVIEW_TARGET>`

Also collect:
- List of changed files: `git diff --name-only <appropriate-range>`
- File-level stats: `git diff --stat <appropriate-range>`

If the diff is empty, print `No changes found for the given target.` and stop.

Store the diff and file list for distribution to teammates.

### Phase 2: Assign Review Areas

The team lead creates a shared task list for the three teammates:

1. **Task: Security Review** — assigned to Security Reviewer
   - Review all changed files for security concerns
   - Focus areas: authentication, authorization, input validation, injection, secrets exposure, OWASP top 10
   - Report findings with severity (Critical / High / Medium / Low / Info)

2. **Task: Performance Review** — assigned to Performance Reviewer
   - Review all changed files for performance concerns
   - Focus areas: query complexity, N+1 queries, memory leaks, missing caching, algorithmic complexity
   - Report findings with severity

3. **Task: Correctness Review** — assigned to Correctness Reviewer
   - Review all changed files for correctness and test coverage
   - Focus areas: logic errors, edge cases, missing tests, type mismatches, error handling gaps
   - Report findings with severity

Each task includes the full diff and the list of changed files.

### Phase 3: Independent Review

All three teammates review independently and in parallel. Each teammate:

1. Reads the diff and changed files
2. Analyzes code changes through their specialized lens
3. Posts their findings to the shared task list as a structured report

Each reviewer's report MUST follow this format:

```markdown
## <Reviewer Name> Findings

### Summary
<1-2 sentence overview>

### Findings

| # | Severity | File | Line(s) | Finding | Recommendation |
|---|----------|------|---------|---------|----------------|
| 1 | Critical/High/Medium/Low/Info | path/to/file | L42-L50 | Description | Fix suggestion |

### Verdict
<APPROVE / REQUEST_CHANGES / COMMENT>
```

### Phase 4: Cross-Review Debate

After all three reviewers complete their independent reviews, they debate findings via the mailbox:

1. Each reviewer reads the other two reviewers' findings
2. Reviewers may challenge or endorse each other's findings via mailbox messages
3. The debate round is time-boxed — each reviewer gets one round of responses

Debate triggers (a reviewer SHOULD respond when):
- Another reviewer flagged something in the same file they reviewed
- They disagree with a severity classification
- They have additional context that strengthens or weakens a finding
- A finding overlaps with their domain (e.g., a security fix that has performance implications)

### Phase 5: Synthesize Report

The team lead collects all findings and debate outcomes, then produces the consolidated report:

```markdown
## Team Review Report

**Target:** <PR #N / branch-name / commit-range>
**Reviewers:** Security, Performance, Correctness
**Changed files:** N files (+X/-Y lines)

---

### Critical Findings (require action before merge)
<sorted by severity, then by file>

| # | Severity | Domain | File | Line(s) | Finding | Recommendation | Consensus |
|---|----------|--------|------|---------|---------|----------------|-----------|
| 1 | Critical | Security | ... | ... | ... | ... | Unanimous / Debated |

### Non-Critical Findings (recommended improvements)

| # | Severity | Domain | File | Line(s) | Finding | Recommendation |
|---|----------|--------|------|---------|---------|----------------|

### Praise (things done well)
<any positive findings from reviewers>

---

### Reviewer Verdicts

| Reviewer | Verdict | Critical | High | Medium | Low |
|----------|---------|----------|------|--------|-----|
| Security | APPROVE/REQUEST_CHANGES | N | N | N | N |
| Performance | APPROVE/REQUEST_CHANGES | N | N | N | N |
| Correctness | APPROVE/REQUEST_CHANGES | N | N | N | N |

### Overall Verdict: <APPROVE / REQUEST_CHANGES>

<one-paragraph summary of the review outcome and key action items>
```

---

## Constraints

- Teammates cannot create sub-teams (Agent Teams does not support nesting)
- No worktree isolation needed — review is read-only
- Token cost will be ~3x a single-reviewer run due to three parallel reviewers plus debate
- The command does NOT modify any files — it is purely advisory
- If any teammate fails to respond, the team lead proceeds with available reviews and notes the gap

---

### Requirement: Command namespace
The `/team-review` command SHALL be invoked as `/sr:team-review`. The command file SHALL be located at `.claude/commands/sr/team-review.md`.

### Requirement: Agent Teams experimental guard
The command MUST check `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` before proceeding. If not set, it MUST print setup instructions and exit gracefully.

### Requirement: No file modifications
The command MUST NOT create, modify, or delete any files in the repository. It is a read-only review tool.

### Requirement: Structured output
All findings MUST include severity, file, line numbers, description, and recommendation in a tabular format.
