# Spec: /specrails:team-debug Command

The `/specrails:team-debug` command orchestrates collaborative debugging using Claude Code Agent Teams (experimental). Multiple investigators work as teammates — each pursuing a different hypothesis about a bug's root cause — then challenge each other's findings via mailbox before the team lead synthesizes a root cause analysis ranked by confidence.

---

## Prerequisites

- Claude Code v2.1.32+ with Agent Teams support
- Environment variable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` must be set

---

## Flags

### Input (required, positional)

Accepts a bug description in one of these forms:
- **Free text**: a description of the bug, symptom, or unexpected behavior
- **Test reference**: a failing test name or file path (e.g., `tests/auth.test.ts`)
- **Error message**: an error string or stack trace excerpt
- **Issue reference**: `#123` — a GitHub issue number to pull context from

### `--scope <paths>`

Comma-separated file or directory paths to constrain the investigation. Default: entire repository.

### `--depth <level>`

Investigation depth: `shallow` (quick scan), `normal` (default), `deep` (thorough with execution traces).

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

Then stop. Do not proceed with any debugging work.

---

## Team Composition

The team lead (the orchestrator running this command) coordinates 2-3 hypothesis investigators as teammates:

| Teammate | Role | Strategy |
|----------|------|----------|
| Investigator A | Primary hypothesis | Most likely root cause based on symptoms |
| Investigator B | Alternative hypothesis | Second most likely cause or different subsystem |
| Investigator C (optional) | Contrarian hypothesis | Edge case, environment, or systemic cause |

Investigator C is launched only when:
- The bug description is ambiguous enough to warrant three hypotheses
- The `--depth deep` flag is set
- The team lead identifies three genuinely distinct hypotheses

Each teammate runs as a Claude Code Agent Teams teammate — not as a subagent via the Agent tool.

---

## Workflow

### Phase 0: Feature Flag Guard

**This check is mandatory and runs before anything else.**

Check whether Agent Teams is enabled (see Feature Flag Guard section above). If not enabled, print the error message and stop immediately.

### Phase 1: Bug Context Gathering

Parse `$ARGUMENTS` to determine the bug context.

**Variables to set:**
- `BUG_DESCRIPTION` — the user's description of the bug
- `INPUT_TYPE` — `"text"`, `"test"`, `"error"`, or `"issue"`
- `SCOPE_PATHS` — from `--scope` flag or `["."]` (entire repo)
- `INVESTIGATION_DEPTH` — from `--depth` flag or `"normal"`

**Detection rules:**
1. If input starts with `#` or is a bare integer: `INPUT_TYPE="issue"`, fetch issue body via `gh issue view <number> --json title,body`
2. If input is a file path that exists and contains `test` or `spec`: `INPUT_TYPE="test"`, run the test to capture output
3. If input contains common error patterns (stack trace, `Error:`, `Exception`, `FATAL`): `INPUT_TYPE="error"`
4. Otherwise: `INPUT_TYPE="text"`

If `$ARGUMENTS` is empty, print usage and stop:
```
Usage: /specrails:team-debug <bug-description> [--scope <paths>] [--depth <level>]

Examples:
  /specrails:team-debug "Login fails silently when email has uppercase letters"
  /specrails:team-debug tests/auth.test.ts --depth deep
  /specrails:team-debug "TypeError: Cannot read property 'id' of undefined" --scope src/api
  /specrails:team-debug #42
```

### Phase 2: Hypothesis Generation

The team lead analyzes the bug context and generates competing hypotheses:

1. **Analyze symptoms**: Read relevant source files within `SCOPE_PATHS`, examine recent git changes, check related tests
2. **Generate hypotheses**: Produce 2-3 distinct, testable hypotheses about the root cause
3. **Rank hypotheses**: Order by initial likelihood based on available evidence

Each hypothesis MUST include:
- **Title**: One-line description of the proposed cause
- **Rationale**: Why this is plausible given the symptoms
- **Investigation plan**: Specific files to examine, commands to run, patterns to search for
- **Expected evidence**: What would confirm or refute this hypothesis

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

### Phase 3: Launch Investigation Team

Create 2-3 investigator teammates using Agent Teams. Each teammate receives the bug context and their assigned hypothesis.

**IMPORTANT:** Use the Agent Teams teammate mechanism — NOT the Agent tool's `subagent_type`. Teammates share a task list and can message each other via mailbox.

#### Investigator A

**Prompt:**
```
You are Investigator A on a debugging team. Your job is to prove or disprove your assigned hypothesis.

## Bug Context
<BUG_DESCRIPTION>
<additional context from Phase 1>

## Your Hypothesis
<Hypothesis A title and rationale>

## Investigation Plan
<Hypothesis A investigation plan>

## Scope
<SCOPE_PATHS>

## Instructions
1. Follow your investigation plan systematically
2. Read source files, search for patterns, examine git history
3. Collect concrete evidence — file paths, line numbers, code snippets, log output
4. Determine a confidence level (0-100%) that your hypothesis is the root cause
5. After completing your investigation, read the other investigators' findings from the task list
6. If you find evidence that supports or contradicts another investigator's hypothesis, send a mailbox message challenging or endorsing their findings

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

#### Investigator B

Same structure as Investigator A, with Hypothesis B details.

#### Investigator C (when applicable)

Same structure as Investigator A, with Hypothesis C details.

### Phase 4: Cross-Investigation Challenge

After all investigators complete their independent work, they challenge each other via the mailbox:

1. Each investigator reads the other investigators' findings from the task list
2. Investigators challenge findings that conflict with their own evidence
3. Investigators may endorse findings that align with evidence they discovered
4. The challenge round is limited to one round per investigator to control token costs

Challenge triggers (an investigator SHOULD respond when):
- Another investigator found evidence in the same file or subsystem
- They discovered evidence that directly contradicts another hypothesis
- They found a connection between two hypotheses (e.g., both point to the same root cause)
- Their investigation uncovered something that changes the likelihood of another hypothesis

### Phase 5: Root Cause Synthesis

The team lead collects all findings and challenge outcomes, then produces the root cause analysis:

#### Step 1: Evidence Aggregation

1. Collect all evidence from each investigator
2. Identify converging evidence (multiple investigators pointing to the same cause)
3. Identify conflicting evidence and note unresolved disagreements

#### Step 2: Confidence Recalibration

After cross-investigation challenges:
- Adjust hypothesis confidence levels based on challenges and endorsements
- A hypothesis endorsed by evidence from another investigator gets a confidence boost
- A hypothesis contradicted by another investigator's evidence gets a confidence reduction

#### Step 3: Render Report

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

| # | Hypothesis | Final Confidence | Verdict | Key Evidence |
|---|-----------|-----------------|---------|-------------|
| 1 | <title> | X% | CONFIRMED/REFUTED/INCONCLUSIVE | <one-line> |
| 2 | <title> | Y% | CONFIRMED/REFUTED/INCONCLUSIVE | <one-line> |

### Investigation Trail

<for each investigator, a brief summary of what they found and how it contributed to the conclusion>

### Cross-Investigation Notes

<any points of debate between investigators, with resolution>

---

### Recommended Next Steps

1. <most important action>
2. <second action>
3. <third action if applicable>
```

#### Step 4: Cost Notice

Print a brief cost notice after the report:

```
Note: Team debug used ~<N>x the tokens of a single-agent investigation (<N> parallel investigators + challenge round).
```

---

## Constraints

- Teammates cannot create sub-teams (Agent Teams does not support nesting)
- No worktree isolation needed — debugging investigation is read-only
- Token cost will be ~2-3x a single-investigator run depending on hypothesis count
- The command does NOT modify any files — it is purely investigative
- If any teammate fails to respond, the team lead proceeds with available findings and notes the gap
- Investigation MUST stay within `SCOPE_PATHS` if specified — do not explore outside the scope

---

### Requirement: Command namespace
The `/team-debug` command SHALL be invoked as `/specrails:team-debug`. The command file SHALL be located at `.claude/commands/specrails/team-debug.md`.

### Requirement: Agent Teams experimental guard
The command MUST check `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` before proceeding. If not set, it MUST print setup instructions and exit gracefully.

### Requirement: No file modifications
The command MUST NOT create, modify, or delete any files in the repository. It is a read-only debugging tool.

### Requirement: Structured output
All findings MUST include evidence type, file location, and description. Confidence levels MUST be numeric percentages.

### Requirement: Provider restriction
This command is Claude Code only — it MUST NOT be installed when the provider is `codex`.
