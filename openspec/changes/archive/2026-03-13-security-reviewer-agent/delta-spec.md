---
change: security-reviewer-agent
type: delta-spec
---

# Delta Spec: Security & Secrets Reviewer Agent

This document describes the spec-level changes this feature introduces. It defines what the system should do after this change is applied, framed as additions and modifications to the existing conceptual specification.

---

## 1. New Capability: Security Scanning Agent

**Spec statement:** The specrails agent system SHALL include a `security-reviewer` agent that scans modified code for secrets and vulnerability patterns.

### 1.1 Agent identity

The `security-reviewer` agent:
- Has name `security-reviewer`
- Runs on model `sonnet`
- Color `orange`
- Has persistent memory at `.claude/agent-memory/security-reviewer/`
- Is self-contained — requires no external binaries to perform its core function

### 1.2 Scanning scope

When invoked, the agent MUST:
- Receive a list of modified files via its invocation prompt (`MODIFIED_FILES_LIST`)
- Scan only those files (not the entire repository)
- Skip binary files, lock files, `node_modules/`, `vendor/`, `.git/`
- Apply exemptions from `.claude/security-exemptions.yaml` before reporting

### 1.3 Detection categories

The agent MUST check for:
- **Secrets**: credentials matching known high-confidence regex patterns (AWS keys, GitHub tokens, private key blocks, database URLs, generic API keys/tokens of 20+ chars)
- **High-entropy strings**: values assigned to security-sensitive variable names with Shannon entropy > 4.5 bits/char
- **OWASP patterns**: SQL injection, XSS, insecure deserialization, weak JWT configuration, path traversal, command injection

### 1.4 Severity classification

Every finding MUST be classified as one of: `Critical`, `High`, `Medium`, `Info`.

Critical findings:
- Active credential formats (AWS, GitHub, Google API keys, private key blocks, database URLs with credentials)
- `algorithm: 'none'` in JWT operations
- Hardcoded credentials in non-example config files

### 1.5 Output format

The agent MUST produce a structured report ending with a machine-readable status line:
```
SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN
```
- `BLOCKED`: one or more Critical findings exist (after exemptions)
- `WARNINGS`: no Critical findings but one or more High findings exist
- `CLEAN`: no Critical or High findings

---

## 2. Modified Capability: Implementation Pipeline (Phase 4)

**Spec statement:** Phase 4b of the implementation pipeline SHALL run the `security-reviewer` agent after the `reviewer` agent, and SHALL block Phase 4c if the security scan result is `BLOCKED`.

### 2.1 Phase 4b execution order

Phase 4b executes in this order:
1. Reviewer agent (CI/quality gate) — unchanged
2. Security reviewer agent (security gate) — new

### 2.2 Security reviewer invocation

The orchestrator MUST pass to the security-reviewer agent:
- `MODIFIED_FILES_LIST`: all files changed during the implementation run
- `PIPELINE_CONTEXT`: feature names and change names implemented
- The path to `.claude/security-exemptions.yaml`

### 2.3 Blocking behavior

If `SECURITY_STATUS: BLOCKED`:
- The orchestrator MUST NOT execute Phase 4c (git operations, PR creation)
- The orchestrator MUST print the Critical findings clearly
- The orchestrator MUST instruct the developer to fix the findings before re-running
- The pipeline terminates after producing the Phase 4e report with status `BLOCKED`

If `SECURITY_STATUS: WARNINGS` or `CLEAN`:
- Phase 4c proceeds normally

### 2.4 Phase 4e report

The pipeline report table MUST include a `Security` column showing: `BLOCKED`, `WARNINGS`, or `CLEAN`.

---

## 3. New Artifact: Exemption Configuration

**Spec statement:** Each target repo SHALL be able to define security scan exemptions in `.claude/security-exemptions.yaml`.

### 3.1 Exemption config location

- Template: `templates/security/security-exemptions.yaml`
- Generated (per repo): `.claude/security-exemptions.yaml`
- The file is created by `install.sh` as part of normal setup

### 3.2 Exemption schema

```yaml
exemptions:
  secrets:
    - pattern: string          # The regex pattern or descriptive name being exempted
      reason: string           # Required: justification
      added_by: string         # Required: who added it
      added_on: string         # Required: ISO date
  vulnerabilities:
    - rule: string             # The rule name being exempted
      file: string             # Optional: limit exemption to a specific file
      reason: string           # Required
      added_by: string         # Required
      added_on: string         # Required
```

### 3.3 Exemption behavior

- Secrets exemptions: suppress findings matching the described pattern
- Vulnerability exemptions: suppress findings for the named rule, optionally scoped to a file
- Critical findings matching an exemption: reported as "Warning: exempted Critical" — not suppressed entirely
- All applied exemptions appear in the `Exemptions Applied` section of the scan report

---

## 4. New Artifact: Agent Template

**Spec statement:** `templates/agents/security-reviewer.md` SHALL exist as a canonical template following the `{{PLACEHOLDER}}` convention used by all other agent templates.

### 4.1 Required placeholders

| Placeholder | Resolved to |
|-------------|-------------|
| `{{MEMORY_PATH}}` | `.claude/agent-memory/security-reviewer/` |
| `{{SECURITY_EXEMPTIONS_PATH}}` | `.claude/security-exemptions.yaml` |
| `{{MODIFIED_FILES_LIST}}` | Injected at agent invocation time (runtime) |
| `{{PIPELINE_CONTEXT}}` | Injected at agent invocation time (runtime) |

Note: `{{MODIFIED_FILES_LIST}}` and `{{PIPELINE_CONTEXT}}` are runtime-injected values, not static substitutions performed by `install.sh`. The template uses them as prompt instructions.

### 4.2 Template conventions

The template MUST follow all conventions in `.claude/rules/agents.md`:
- YAML frontmatter with `name`, `description`, `model`, `color`, `memory`
- `description` field includes usage examples
- Agent is self-contained
- Output format is specified
- Memory protocol section matches other agents

---

## 5. Install.sh Addition

**Spec statement:** `install.sh` SHALL copy `templates/security/security-exemptions.yaml` to `.claude/security-exemptions.yaml` in the target repo during setup (only if the file does not already exist — do not overwrite existing exemptions).

This is the only change to `install.sh`.
