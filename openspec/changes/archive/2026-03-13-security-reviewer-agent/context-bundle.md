---
change: security-reviewer-agent
type: context-bundle
---

# Context Bundle: Security & Secrets Reviewer Agent

This document contains everything a developer needs to implement this change without reading any other file. It bundles the key context from the design, delta-spec, and codebase exploration.

---

## What You Are Building

A new Claude Code agent called `security-reviewer` that:
1. Scans modified files for hardcoded secrets and OWASP vulnerability patterns
2. Reports findings by severity (Critical/High/Medium/Info)
3. Produces a structured report ending with a machine-readable `SECURITY_STATUS:` line
4. Integrates into Phase 4b of the implement pipeline and **blocks Phase 4c if Critical findings exist**
5. Supports per-project exemptions via `.claude/security-exemptions.yaml`

The agent is a **markdown prompt file** — no shell scripts, no external tool dependencies. All scanning happens through Claude's code analysis.

---

## Codebase Patterns to Follow

### Agent file structure

All agents follow this pattern. Study `templates/agents/reviewer.md` for the template version and `.claude/agents/reviewer.md` for the generated version.

**Template file** (`templates/agents/*.md`): Uses `{{PLACEHOLDER}}` for values that vary per target repo.

**Generated file** (`.claude/agents/*.md`): Same content with placeholders substituted. For specrails' own use.

YAML frontmatter required fields:
```yaml
---
name: <kebab-case-name>
description: "Multi-line string with usage examples"
model: sonnet
color: <color-name>
memory: project
---
```

Colors used by existing agents: `red` (reviewer), `purple` (developer), `orange` is available and appropriate for security.

### Memory pattern

Every agent has a memory directory. Create an initial empty `MEMORY.md` file at:
```
.claude/agent-memory/<agent-name>/MEMORY.md
```

Header content:
```markdown
# Security Reviewer Agent Memory

No memories recorded yet.
```

### Template placeholder convention

- Only `{{UPPER_SNAKE_CASE}}` style — never lowercase, never single braces
- All placeholders documented
- Runtime-injected values (like file lists passed at invocation time) are described in prose as what the orchestrator will inject — they are NOT substituted by `install.sh`

---

## Files to Create

| File | Type | Note |
|------|------|------|
| `templates/security/security-exemptions.yaml` | New | Template for target repos |
| `.claude/security-exemptions.yaml` | New | specrails instance (empty exemptions) |
| `templates/agents/security-reviewer.md` | New | Agent template |
| `.claude/agents/security-reviewer.md` | New | Generated (substituted) agent |
| `.claude/agent-memory/security-reviewer/MEMORY.md` | New | Initial memory file |

## Files to Modify

| File | Change summary |
|------|----------------|
| `templates/commands/implement.md` | Add Phase 4b-sec block, security gate in 4c, Security column in 4e |
| `.claude/commands/implement.md` | Same changes (generated copy) |
| `install.sh` | Copy security-exemptions template to target repo (skip if exists) |

---

## The Security Reviewer Agent Prompt

Write `templates/agents/security-reviewer.md` with this exact structure:

### Frontmatter
```yaml
---
name: security-reviewer
description: "Use this agent to scan all modified files for secrets, hardcoded credentials, and security vulnerability patterns after implementation. Runs as part of Phase 4 in the implement pipeline. Do NOT use this agent to fix issues — it scans and reports only.

Examples:

- Example 1:
  user: (orchestrator) Reviewer completed. Now run the security scan.
  assistant: \"Launching the security-reviewer agent to scan modified files for secrets and vulnerabilities.\"

- Example 2:
  user: (orchestrator) Implementation complete. Run security gate before shipping.
  assistant: \"I'll launch the security-reviewer agent to perform the security scan.\""
model: sonnet
color: orange
memory: project
---
```

### Prompt body structure

1. **Identity** (2-3 sentences): You are a security-focused code auditor. You scan code for secrets and vulnerabilities. You report findings — you never fix them.

2. **Your Mission** (4 bullet points):
   - Scan every file in MODIFIED_FILES_LIST
   - Detect secrets using the patterns below
   - Detect OWASP vulnerability patterns
   - Produce a structured report and set SECURITY_STATUS

3. **What You Receive** — explain the three inputs:
   - `MODIFIED_FILES_LIST`: the list of files changed in this implementation run (injected into your invocation prompt by the orchestrator)
   - `PIPELINE_CONTEXT`: what was implemented (feature names/change names)
   - The exemptions config at `{{SECURITY_EXEMPTIONS_PATH}}`

4. **Files to Skip**:
   - Binary files
   - `node_modules/`, `vendor/`, `.git/`
   - Lock files: `package-lock.json`, `yarn.lock`, `go.sum`, `Cargo.lock`
   - Files listed under exemptions in `{{SECURITY_EXEMPTIONS_PATH}}`

5. **Secrets Detection** — include this full table:

| Category | Pattern | Severity |
|----------|---------|----------|
| AWS Access Key ID | `AKIA[0-9A-Z]{16}` | Critical |
| AWS Secret Access Key | 40-char alphanumeric after `aws_secret` keyword | Critical |
| GitHub Token | `gh[pousr]_[A-Za-z0-9]{36}` | Critical |
| Google API Key | `AIza[0-9A-Za-z\-_]{35}` | Critical |
| Private Key Block | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH) PRIVATE KEY-----` | Critical |
| Database URL with credentials | `(postgres\|mysql\|mongodb)://[^:]+:[^@]+@` | Critical |
| Generic API Key (20+ chars) | `api[_-]?key\s*[:=]\s*["'][A-Za-z0-9+/]{20,}` | Critical |
| Generic Token (20+ chars) | `token\s*[:=]\s*["'][A-Za-z0-9+/]{20,}` | Critical |
| Slack Webhook | `https://hooks.slack.com/services/T[A-Z0-9]+/` | High |
| JWT Secret literal | `jwt[_-]?secret\s*[:=]` with non-env-var value | High |
| Generic Password literal | `password\s*[:=]\s*["'][^"']{8,}` not from env | High |

Safe patterns (skip these — not secrets):
- Values referencing `process.env.*`, `os.environ[...]`, or shell `$VAR` syntax
- Template placeholders: `{{...}}`, `<YOUR_KEY_HERE>`, `PLACEHOLDER`
- Values in test files (`*.test.*`, `*.spec.*`, `*_test.go`, paths under `testdata/`) — downgrade to Medium

Entropy heuristic: For any string > 20 chars assigned to a variable whose name contains `key`, `token`, `secret`, `password`, `credential`, or `auth` — if Shannon entropy > 4.5 bits/char AND it doesn't match a safe pattern — flag as High.

6. **OWASP Vulnerability Patterns** (code files only — skip markdown, YAML, JSON, config):

| Vulnerability | What to look for | Severity |
|---------------|-----------------|----------|
| SQL Injection | String concatenation into SQL queries | High |
| XSS | Unsanitized user input in `innerHTML`, `dangerouslySetInnerHTML`, `document.write` | High |
| Insecure Deserialization | `eval()` on user-controlled input, `pickle.loads()`, PHP `unserialize()` | High |
| Weak JWT | `algorithm: 'none'` or `verify: false` in JWT operations | Critical |
| Hardcoded credentials | Credentials in config files outside `.env.example` patterns | Critical |
| Path traversal | User input directly in `path.join()`, `open()`, `fs.readFile()` | High |
| Command injection | User input in `exec()`, `spawn()`, `subprocess.run()`, `os.system()` | High |

7. **Exemption Handling**:
   - Read `{{SECURITY_EXEMPTIONS_PATH}}`
   - For each finding: check if it matches an exemption entry
   - Suppressed findings: omit from Critical/High/Medium tables, add to Exemptions Applied table
   - Exception: Critical findings with an exemption are listed as "Warning: exempted Critical" — never fully suppressed

8. **Severity Definitions**:
   - **Critical**: Active credential format or critical OWASP pattern (blocks pipeline)
   - **High**: Likely vulnerability or high-entropy suspicious value (warning)
   - **Medium**: Possible false positive or test context concern (info only)
   - **Info**: Observations about security posture

9. **Output Format** — produce EXACTLY this structure:

```
## Security Scan Results

### Summary
- Files scanned: N
- Findings: X Critical, Y High, Z Medium, W Info
- Exemptions applied: E

### Critical Findings (BLOCKS MERGE)
| File | Line | Finding | Pattern |
|------|------|---------|---------|
(rows or "None")

### High Findings (Warning)
| File | Line | Finding | Pattern |
|------|------|---------|---------|
(rows or "None")

### Medium Findings (Info)
| File | Line | Finding | Notes |
|------|------|---------|-------|
(rows or "None")

### Exemptions Applied
| File | Finding | Exemption reason |
|------|---------|-----------------|
(rows or "None")

---
SECURITY_STATUS: BLOCKED
```

The `SECURITY_STATUS:` line MUST be the last line of the report. Values:
- `BLOCKED` if any Critical findings exist (after exemptions)
- `WARNINGS` if no Critical but one or more High findings
- `CLEAN` if no Critical or High findings

10. **Rules**:
    - Never fix code. Never suggest code changes. Scan and report only.
    - Never ask for clarification. Complete the scan with available information.
    - Always scan every file in MODIFIED_FILES_LIST — never skip a file without noting why.
    - Always emit the `SECURITY_STATUS:` line as the very last line of output.

11. **Memory protocol** — standard section using `{{MEMORY_PATH}}`:
    - Memory path: `{{MEMORY_PATH}}`
    - MEMORY.md under 200 lines
    - Save: false positive patterns discovered, file types that commonly trigger false positives in this repo, recurring true-positive patterns
    - Standard empty MEMORY.md section

---

## Implement Pipeline Changes

### Where to insert in `implement.md`

Find the section:
```
### 4b. Launch Reviewer agent
```

After the reviewer agent block ends, insert:

```markdown
### 4b-sec. Launch Security Reviewer agent

After the reviewer agent completes, launch a **security-reviewer** agent (`subagent_type: security-reviewer`).

Construct the agent invocation prompt to include:
- **MODIFIED_FILES_LIST**: the complete list of files created or modified during this implementation run
- **PIPELINE_CONTEXT**: brief description — feature names and change names implemented
- The exemptions config path: `.claude/security-exemptions.yaml`

Wait for the security-reviewer to complete. Parse the final line of its output:
- `SECURITY_STATUS: BLOCKED` → set `SECURITY_BLOCKED=true`
- `SECURITY_STATUS: WARNINGS` → set `SECURITY_BLOCKED=false`, capture warning summary
- `SECURITY_STATUS: CLEAN` → set `SECURITY_BLOCKED=false`
```

Find the section:
```
### 4c. Ship — Git & backlog updates
```

At the very beginning of 4c (before any git operations), insert:

```markdown
**Security gate:** If `SECURITY_BLOCKED=true`:
1. Print all Critical findings from the security-reviewer output
2. Do NOT create a branch, commit, push, or PR
3. Print: "Pipeline blocked by security findings. Fix the Critical issues listed above and re-run /implement."
4. Skip to Phase 4e.
```

Find the Phase 4e report table:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Tests | CI | Status |
```

Replace with:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

---

## The Exemptions YAML File

`templates/security/security-exemptions.yaml` content:

```yaml
# Security scan exemptions for specrails
#
# Add entries here to suppress known false positives from the security-reviewer agent.
# This file is tracked in git — all exemptions are auditable.
#
# Fields:
#   secrets.pattern   - Description of the pattern being exempted (for documentation)
#   secrets.reason    - Required: why this is a known false positive
#   secrets.added_by  - Required: who added this exemption
#   secrets.added_on  - Required: ISO 8601 date (YYYY-MM-DD)
#
#   vulnerabilities.rule    - The vulnerability rule name being exempted
#   vulnerabilities.file    - Optional: scope exemption to a specific file path
#   vulnerabilities.reason  - Required: justification
#   vulnerabilities.added_by - Required
#   vulnerabilities.added_on - Required

exemptions:
  secrets: []
  vulnerabilities: []
```

`.claude/security-exemptions.yaml` is identical to the template (since specrails has no exemptions to start with).

---

## The install.sh Change

Find the section in `install.sh` where template files are copied to the target repo (look for calls to `cp` that copy files from `templates/` to `$TARGET/.claude/`).

Add after that block:

```bash
# Copy security exemptions config (skip if already exists — preserve user exemptions)
if [ ! -f "${TARGET}/.claude/security-exemptions.yaml" ]; then
    cp "${SPECRAILS_DIR}/templates/security/security-exemptions.yaml" "${TARGET}/.claude/security-exemptions.yaml"
fi
```

Replace `${TARGET}` and `${SPECRAILS_DIR}` with whatever variable names `install.sh` already uses. Read `install.sh` first to find the correct variable names.

---

## Key Design Decisions (Do Not Second-Guess)

1. **Claude-native scanning, no external tools**: The agent uses Claude's analysis, not truffleHog or semgrep. This avoids installation friction. External tools are a Phase 2 enhancement. See design.md for full rationale.

2. **Critical blocks, High warns**: Only Critical findings block the pipeline. High findings are warnings. This prevents excessive false-positive friction.

3. **Sequential, not parallel with reviewer**: Security scan runs after the reviewer agent, not in parallel. This gives the reviewer a chance to fix issues first, reducing noise in the security report.

4. **Exemptions never fully suppress Critical**: Even exempted Critical findings appear as "Warning: exempted Critical" in the report. This is intentional — Critical exemptions should always be visible.

5. **`SECURITY_STATUS:` must be the very last line**: The orchestrator parses only the last line of the agent's output. If anything follows it, the pipeline cannot detect the status correctly.

---

## Verification Checklist

Before declaring implementation complete:

- [ ] `templates/security/security-exemptions.yaml` exists and is valid YAML
- [ ] `.claude/security-exemptions.yaml` exists with empty exemptions arrays
- [ ] `templates/agents/security-reviewer.md` exists with valid YAML frontmatter
- [ ] `.claude/agents/security-reviewer.md` exists with no unresolved `{{PLACEHOLDER}}` strings (except runtime reference mentions in prose)
- [ ] `.claude/agent-memory/security-reviewer/MEMORY.md` exists
- [ ] `templates/commands/implement.md` has `### 4b-sec` section
- [ ] `templates/commands/implement.md` has security gate at start of `### 4c`
- [ ] `templates/commands/implement.md` Phase 4e table has `Security` column
- [ ] `.claude/commands/implement.md` has all three of the above
- [ ] `install.sh` copies the exemptions template (skip-if-exists)
- [ ] `shellcheck install.sh` passes
- [ ] `grep -r '{{[A-Z_]*}}' .claude/agents/security-reviewer.md` returns no matches
