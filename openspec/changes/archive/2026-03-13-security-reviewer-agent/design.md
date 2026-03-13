---
change: security-reviewer-agent
type: design
---

# Technical Design: Security & Secrets Reviewer Agent

## Architecture Overview

The security-reviewer is a pure Claude Code agent — a markdown prompt file with YAML frontmatter, identical in structure to `reviewer.md`. It requires no new runtime dependencies at launch. All scanning is performed via Claude's code analysis capabilities combined with a defined set of regex patterns and entropy heuristics embedded in the prompt.

```
Phase 4b (current):
  reviewer agent  →  CI checks + template integrity

Phase 4b (after this change):
  reviewer agent        →  CI checks + template integrity
  security-reviewer     →  secrets scan + OWASP patterns + block on Critical
```

The two agents run sequentially in Phase 4b. The reviewer runs first (quality gate), then the security-reviewer runs (security gate). If the security-reviewer finds Critical findings, Phase 4c (ship) is blocked.

---

## File Changes

### New Files

#### 1. `templates/agents/security-reviewer.md`

The canonical template. Uses `{{PLACEHOLDER}}` substitution. Key placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{MEMORY_PATH}}` | Agent memory directory path |
| `{{SECURITY_EXEMPTIONS_PATH}}` | Path to exemptions config |
| `{{MODIFIED_FILES_LIST}}` | Injected by orchestrator: files changed in this run |
| `{{PIPELINE_CONTEXT}}` | Brief description of what was implemented (injected) |

The prompt structure mirrors `reviewer.md`:
- YAML frontmatter: `name: security-reviewer`, `model: sonnet`, `color: orange`, `memory: project`
- Identity: "You are a security-focused code auditor..."
- Mission: scan for secrets and vulnerability patterns
- Scanning methodology (detailed below)
- Severity definitions
- Blocking rules
- Output format
- Exemption handling
- Memory protocol

#### 2. `.claude/agents/security-reviewer.md`

The generated (specrails-adapted) version. Created by applying specrails' own template substitution to `templates/agents/security-reviewer.md`. For specrails itself, most placeholders resolve to specrails-specific values:

- `{{MEMORY_PATH}}` → `.claude/agent-memory/security-reviewer/`
- `{{SECURITY_EXEMPTIONS_PATH}}` → `.claude/security-exemptions.yaml`
- `{{MODIFIED_FILES_LIST}}` → injected at invocation time (runtime, not substitution time)
- `{{PIPELINE_CONTEXT}}` → injected at invocation time

#### 3. `templates/security/security-exemptions.yaml`

Exemption config template for target repos. Structure:

```yaml
# Security scan exemptions
# Add entries here to suppress known false positives.
# Each entry requires a justification.
exemptions:
  secrets:
    - pattern: "EXAMPLE_API_KEY_PATTERN"
      reason: "Test fixture — not a real credential"
      added_by: "team@example.com"
      added_on: "2025-01-01"
  vulnerabilities:
    - rule: "sql-injection-pattern"
      file: "src/legacy/old-query.ts"
      reason: "Legacy code, isolated, scheduled for removal in Q3"
      added_by: "team@example.com"
      added_on: "2025-01-01"
```

#### 4. `.claude/security-exemptions.yaml`

The specrails-repo instance of the exemptions config. Initially contains only the header comment and empty `exemptions:` block. This file is checked in so teams can track exemption history via git.

#### 5. `.claude/agent-memory/security-reviewer/MEMORY.md`

Empty initial memory file, consistent with other agents.

### Modified Files

#### 6. `templates/commands/implement.md`

Phase 4b must be extended to:
- Launch the `security-reviewer` agent after the `reviewer` agent completes
- Pass `MODIFIED_FILES_LIST` and `PIPELINE_CONTEXT` as part of the agent invocation prompt
- Read the security-reviewer's output and check for blocking status
- If `SECURITY_BLOCKED=true`: halt Phase 4c (do not create branch, do not push, do not create PR)
- Report blocking findings in Phase 4e

#### 7. `.claude/commands/implement.md`

Same changes as the template version (this is the specrails-adapted generated copy).

---

## Security Scanning Methodology

The agent performs scanning entirely through Claude's analysis capabilities. The prompt instructs the agent to apply the following checks:

### Secrets Detection

**Regex patterns** (the prompt embeds these as a reference table):

| Category | Pattern Description | Severity |
|----------|---------------------|----------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` | Critical |
| AWS Secret Key | 40-char alphanumeric following `aws_secret` keyword | Critical |
| Generic API Key | `api[_-]?key\s*[:=]\s*["\'][A-Za-z0-9+/]{20,}` | Critical |
| Generic Token | `token\s*[:=]\s*["\'][A-Za-z0-9+/]{20,}` | Critical |
| Private Key Block | `-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----` | Critical |
| Database URL | `(postgres|mysql|mongodb)://[^:]+:[^@]+@` | Critical |
| JWT Secret | `jwt[_-]?secret\s*[:=]` assigned to non-env-var value | High |
| Slack Webhook | `https://hooks.slack.com/services/T[A-Z0-9]+/` | High |
| Generic Password | `password\s*[:=]\s*["\'][^"\']{8,}` not from env | High |
| GitHub Token | `gh[pousr]_[A-Za-z0-9]{36}` | Critical |
| Google API Key | `AIza[0-9A-Za-z\-_]{35}` | Critical |

**Entropy analysis**: For any string value longer than 20 characters assigned to a variable whose name contains `key`, `token`, `secret`, `password`, `credential`, or `auth`, estimate Shannon entropy. Values with entropy > 4.5 bits/char are flagged as potential high-entropy secrets (High severity if not already caught by regex).

**Safe patterns** (to avoid false positives):
- Values referencing `process.env.*` or `os.environ[*]` or `$ENV_VAR` — skip
- Values that are clearly template placeholders: `{{...}}`, `<...>`, `YOUR_KEY_HERE` — skip
- Values in files matching `*.test.*`, `*.spec.*`, `*_test.go`, `testdata/` — downgrade to Medium

### OWASP Vulnerability Patterns

The agent checks for these patterns in code files only (not markdown, YAML, JSON):

| Vulnerability | Pattern to check for | Severity |
|---------------|----------------------|----------|
| SQL Injection | String concatenation into SQL queries | High |
| XSS | Unsanitized user input rendered as HTML (innerHTML, dangerouslySetInnerHTML) | High |
| Insecure Deserialization | `eval()` on user input, `pickle.loads()`, `unserialize()` | High |
| Weak JWT | `algorithm: 'none'` or `verify: false` in JWT operations | Critical |
| CSRF absent | POST endpoints without CSRF token verification (framework-dependent) | Medium |
| Hardcoded credentials | Credentials in config files outside of `.env.example` patterns | Critical |
| Path traversal | User input used directly in file path operations | High |
| Command injection | User input in shell command execution | High |

### What the agent does NOT scan

- Binary files
- `node_modules/`, `vendor/`, `.git/`
- Files listed in `.claude/security-exemptions.yaml`
- Lock files (`package-lock.json`, `yarn.lock`, `go.sum`)

---

## Exemption Handling

When the agent finds a potential finding, it checks `.claude/security-exemptions.yaml` before reporting:

1. For a secrets finding: check `exemptions.secrets[].pattern` against the flagged pattern
2. For a vulnerability finding: check `exemptions.vulnerabilities[].rule` and `exemptions.vulnerabilities[].file`
3. If a match is found: suppress the finding and note the exemption in the report

Exemptions do not apply to Critical findings automatically — the agent notes the exemption exists but still reports Critical findings (downgraded to a "Warning: exempted Critical"). This ensures Critical exemptions are always visible even if they don't block the pipeline.

---

## Severity & Blocking Rules

| Severity | Definition | Pipeline effect |
|----------|------------|-----------------|
| Critical | Active credential, live key, private key, or OWASP critical finding | Block Phase 4c. Do not ship. |
| High | Likely vulnerability or high-entropy suspicious value | Warn. Require developer acknowledgment before Phase 4c (future: prompt user). For now: report and continue but flag in Phase 4e status. |
| Medium | Possible false positive, test fixture concern, or informational security note | Report only. No pipeline impact. |
| Info | Observations about security posture, not actionable | Report only. |

For the initial implementation: Critical blocks, all others are warnings. Future iterations can add interactive acknowledgment for High findings.

---

## Integration Points in `implement.md`

### Phase 4b addition

After the existing reviewer agent launch block, add:

```
### 4b-sec. Launch Security Reviewer agent

After the reviewer agent completes, launch a **security-reviewer** agent.

Include in the agent invocation prompt:
- `MODIFIED_FILES_LIST`: the list of all files changed in this implementation run
- `PIPELINE_CONTEXT`: brief description of what was implemented (feature names, change names)
- `EXEMPTIONS_PATH`: `.claude/security-exemptions.yaml`

Wait for the security-reviewer to complete. Read its output.

Extract `SECURITY_STATUS` from the output:
- If `SECURITY_STATUS: BLOCKED` — set `SECURITY_BLOCKED=true`
- If `SECURITY_STATUS: WARNINGS` — set `SECURITY_BLOCKED=false`, note warnings
- If `SECURITY_STATUS: CLEAN` — set `SECURITY_BLOCKED=false`
```

### Phase 4c gate

At the start of Phase 4c (Ship), add:

```
**Security gate**: If `SECURITY_BLOCKED=true`, do NOT proceed with git operations.
Instead:
1. Print the Critical findings from the security-reviewer output
2. Instruct the developer to fix the findings
3. Stop. The pipeline resumes only when the user re-runs `/implement` after fixing.
```

### Phase 4e report addition

Add a `Security` column to the pipeline report table:

```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

---

## Output Format (Security Reviewer Agent)

The agent produces a structured report ending with a machine-readable status line:

```
## Security Scan Results

### Summary
- Files scanned: N
- Findings: X Critical, Y High, Z Medium, W Info
- Exemptions applied: E

### Critical Findings (BLOCKS MERGE)
| File | Line | Finding | Pattern |
|------|------|---------|---------|

### High Findings (Warning)
| File | Line | Finding | Pattern |
|------|------|---------|---------|

### Medium Findings (Info)
| File | Line | Finding | Notes |
|------|------|---------|-------|

### Exemptions Applied
| File | Finding | Exemption reason |
|------|---------|-----------------|

---
SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN
```

The `SECURITY_STATUS:` line is always the last line and is parsed by the implement pipeline orchestrator.

---

## Template Substitution

The `install.sh` installer handles `security-reviewer.md` the same way it handles all other agent templates — the `setup` command performs substitution. No changes to `install.sh` are required for this feature; the new template files are picked up automatically by the existing template scan.

The `security-exemptions.yaml` template must be explicitly added to `install.sh`'s file-copy list since it is not under `templates/agents/`. This is the only `install.sh` touch point.

---

## Risks & Design Decisions

### Decision: Claude analysis vs. external tools

Chosen approach: Claude-native analysis (no shell tools required at agent launch time).

Rationale: External tools (truffleHog, semgrep) require installation and version management on every developer machine. This creates friction during `install.sh` setup and can cause failures in restricted environments. Claude's code analysis is available everywhere the agent runs. The tradeoff is lower precision for some patterns, but the false-negative rate for Critical patterns (regex-based) is acceptably low. External tool integration is an explicit Phase 2 enhancement.

### Decision: Sequential execution (reviewer then security-reviewer)

The security scan runs after the reviewer. Rationale: the reviewer may auto-fix some issues that would otherwise generate spurious security warnings. Running security last gives the cleanest view of what will actually be shipped.

### Decision: Critical blocks, High warns (not blocks)

Rationale: High findings can be legitimate uses (e.g., a tool that intentionally invokes eval for sandboxed scripting). Blocking on High would create excessive false-positive friction. Critical patterns (actual credential formats) have near-zero false positive rates and warrant hard blocking.
