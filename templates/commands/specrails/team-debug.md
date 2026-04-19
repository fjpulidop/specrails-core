---
name: "Team Debug"
description: "Collaborative debugging using Claude Code Agent Teams. Multiple investigators pursue competing hypotheses independently, challenge each other's findings, and produce a root cause analysis ranked by confidence."
category: Workflow
tags: [workflow, debugging, agent-teams, investigation]
---

Collaborative debugging for **{{PROJECT_NAME}}** using Claude Code Agent Teams. Multiple investigators pursue competing hypotheses about a bug, challenge each other's findings, and produce a confidence-ranked root cause analysis.

**Input:** $ARGUMENTS — required: a bug description in one of these forms:
- `"Login fails silently when email has uppercase letters"` — free text bug description
- `tests/auth.test.ts` — a failing test file path
- `"TypeError: Cannot read property 'id' of undefined"` — an error message or stack trace
- `#42` — a GitHub issue number

Optional flags:
- `--scope <paths>` — comma-separated file/directory paths to constrain investigation (default: entire repo)
- `--depth <level>` — investigation depth: `shallow`, `normal` (default), `deep`

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

## Phase 1: Bug Context Gathering

Parse `$ARGUMENTS` to determine the bug context and flags.

**Variables to set:**

- `BUG_DESCRIPTION` — the user's description of the bug
- `INPUT_TYPE` — `"text"`, `"test"`, `"error"`, or `"issue"`
- `SCOPE_PATHS` — from `--scope` flag or `["."]` (entire repo)
- `INVESTIGATION_DEPTH` — from `--depth` flag or `"normal"`

**Detection rules:**

1. If input starts with `#` or is a bare integer -> `INPUT_TYPE="issue"`, fetch issue body via `gh issue view <number> --json title,body`
2. If input is a file path that exists and contains `test` or `spec` -> `INPUT_TYPE="test"`, run the test to capture failure output
3. If input contains common error patterns (stack trace, `Error:`, `Exception`, `FATAL`) -> `INPUT_TYPE="error"`
4. Otherwise -> `INPUT_TYPE="text"`

If `$ARGUMENTS` is empty, print usage and stop:
```
Usage: {{COMMAND_PREFIX}}team-debug <bug-description> [--scope <paths>] [--depth <level>]

Examples:
  {{COMMAND_PREFIX}}team-debug "Login fails silently when email has uppercase letters"
  {{COMMAND_PREFIX}}team-debug tests/auth.test.ts --depth deep
  {{COMMAND_PREFIX}}team-debug "TypeError: Cannot read property 'id' of undefined" --scope src/api
  {{COMMAND_PREFIX}}team-debug #42
```

---

## Phase 2: Hypothesis Generation

Analyze the bug context and generate competing hypotheses:

1. **Analyze symptoms**: Read relevant source files within `SCOPE_PATHS`, examine recent git changes (`git log --oneline -20` for the relevant paths), check related tests
2. **Generate hypotheses**: Produce 2-3 distinct, testable hypotheses about the root cause. Each must target a different subsystem, mechanism, or failure mode.
3. **Rank hypotheses**: Order by initial likelihood based on available evidence

Each hypothesis MUST include:
- **Title**: One-line description of the proposed cause
- **Rationale**: Why this is plausible given the symptoms
- **Investigation plan**: Specific files to examine, commands to run, patterns to search for
- **Expected evidence**: What would confirm or refute this hypothesis

Decide whether to launch 2 or 3 investigators:
- Default: 2 investigators (Hypothesis A and B)
- Launch 3 when: `--depth deep` is set, OR the bug description is ambiguous enough to warrant three genuinely distinct hypotheses

Print the hypothesis summary:
```
## Bug Analysis

**Input type:** <text / test / error / issue>
**Scope:** <SCOPE_PATHS>
**Depth:** <INVESTIGATION_DEPTH>

### Hypotheses

1. **<Hypothesis A title>** (initial confidence: X%)
   <one-line rationale>

2. **<Hypothesis B title>** (initial confidence: Y%)
   <one-line rationale>

3. **<Hypothesis C title>** (initial confidence: Z%) [if applicable]
   <one-line rationale>

Launching <N> investigators...
```

---

## Phase 3: Launch Investigation Team

Create 2-3 investigator teammates using Agent Teams. Each teammate receives the bug context and their assigned hypothesis.

**IMPORTANT:** Use the Agent Teams teammate mechanism — NOT the Agent tool's `subagent_type`. Teammates share a task list and can message each other via mailbox.

### Investigator A: Primary Hypothesis

**Prompt:**
```
You are Investigator A on a debugging team. Your job is to prove or disprove your assigned hypothesis through systematic investigation.

## Bug Context
<BUG_DESCRIPTION>
<additional context gathered in Phase 1: test output, error details, issue body>

## Your Hypothesis
**<Hypothesis A title>**
<Hypothesis A rationale>

## Investigation Plan
<Hypothesis A investigation plan>

## Scope
Limit your investigation to: <SCOPE_PATHS>

## Instructions
1. Follow your investigation plan systematically
2. Read source files, search for patterns, examine git history within scope
3. Collect concrete evidence — file paths, line numbers, code snippets, command output
4. Determine a confidence level (0-100%) that your hypothesis is the root cause
5. After completing your investigation, read the other investigators' findings from the task list
6. If you find evidence that supports or contradicts another investigator's hypothesis, send a mailbox message challenging or endorsing their findings
7. Do NOT modify any files — this is a read-only investigation

## Report Format
Post your findings as a task list update:

### Investigator A: <Hypothesis Title>

#### Evidence Found
| # | Type | Location | Finding |
|---|------|----------|---------|
| 1 | code/git/test/config | file:line | What was found |

#### Evidence Against
<any evidence that contradicts this hypothesis>

#### Confidence: X%
<explanation of confidence level>

#### Verdict
<CONFIRMED / REFUTED / INCONCLUSIVE>
<brief explanation>
```

### Investigator B: Alternative Hypothesis

Same structure as Investigator A, with Hypothesis B title, rationale, investigation plan, and expected evidence.

### Investigator C: Contrarian Hypothesis (when applicable)

Same structure as Investigator A, with Hypothesis C title, rationale, investigation plan, and expected evidence. Only launched when 3 hypotheses are generated.

### Team Coordination

After launching all investigators:

1. Wait for all investigators to complete their independent investigations (posted to the shared task list)
2. Allow one round of cross-investigation challenge via mailbox — each investigator may respond to findings from the others
3. Collect all findings and challenge outcomes

If any teammate fails to respond, proceed with available findings and note the gap in the final report.

---

## Phase 4: Root Cause Synthesis

After all investigations and challenges are complete, the team lead produces the root cause analysis.

### Step 1: Evidence Aggregation

1. Read all investigator reports from the task list
2. Identify converging evidence (multiple investigators pointing to the same cause)
3. Identify conflicting evidence and note unresolved disagreements
4. Read any mailbox challenge messages for cross-investigator insights

### Step 2: Confidence Recalibration

Adjust hypothesis confidence levels based on cross-investigation challenges:
- A hypothesis endorsed by evidence from another investigator: confidence boost (+10-20%)
- A hypothesis contradicted by another investigator's evidence: confidence reduction (-10-30%)
- A hypothesis with no cross-investigation interaction: confidence unchanged
- Converging evidence from multiple investigators: strongest signal for root cause

### Step 3: Render Report

```markdown
## Root Cause Analysis

**Bug:** <one-line bug description>
**Scope:** <SCOPE_PATHS>
**Depth:** <INVESTIGATION_DEPTH>
**Investigators:** <N>

---

### Most Likely Root Cause

**<Winning hypothesis title>** — Confidence: X%

<2-3 sentence explanation of the root cause with specific file and line references>

#### Key Evidence
| # | Location | Finding |
|---|----------|---------|
| 1 | file:line | Evidence supporting this conclusion |

#### Suggested Fix
<specific, actionable fix recommendation with file and line references>

---

### Alternative Hypotheses

| # | Hypothesis | Initial | Final | Verdict | Key Evidence |
|---|-----------|---------|-------|---------|-------------|
| 1 | <title> | X% | Y% | CONFIRMED/REFUTED/INCONCLUSIVE | <one-line> |
| 2 | <title> | X% | Y% | CONFIRMED/REFUTED/INCONCLUSIVE | <one-line> |

### Investigation Trail

<for each investigator, a 2-3 line summary of what they investigated and what they found>

### Cross-Investigation Notes

<any points of challenge or agreement between investigators, with resolution>

---

### Recommended Next Steps

1. <most important action — typically the fix>
2. <verification step — test to confirm the fix>
3. <preventive step — how to avoid this class of bug>
```

### Step 4: Cost Notice

Print a brief cost notice after the report:

```
Note: Team debug used ~<N>x the tokens of a single-agent investigation (<N> parallel investigators + challenge round).
```

---

## Rules

- This command is **read-only** — it MUST NOT create, modify, or delete any files
- All investigators run as Agent Teams teammates, not as Agent tool subagents
- If Agent Teams is unavailable at runtime (API error, version mismatch), fall back to running 2-3 sequential Agent tool subagents and skip the challenge phase. Print a warning about the fallback.
- The challenge phase is limited to one round per investigator to control token costs
- Findings MUST include file paths and line numbers — vague findings are not acceptable
- Investigation MUST stay within `SCOPE_PATHS` if specified
- This command is Claude Code only — it is NOT installed when the provider is `codex`
