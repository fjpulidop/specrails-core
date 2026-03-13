---
change: security-reviewer-agent
type: tasks
---

# Tasks: Security & Secrets Reviewer Agent

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create the security-exemptions template [templates]

**Description:** Create the `templates/security/security-exemptions.yaml` file. This is the source template that `install.sh` copies into target repos. Must be a valid YAML file with clear comments explaining every field.

**Files:**
- Create: `templates/security/security-exemptions.yaml`

**Acceptance criteria:**
- File exists at `templates/security/security-exemptions.yaml`
- Valid YAML (no parse errors)
- Contains an `exemptions:` root key with `secrets:` and `vulnerabilities:` sub-keys, each as empty arrays
- Contains inline comments documenting every field (`pattern`, `reason`, `added_by`, `added_on`, `rule`, `file`)
- Contains a header comment explaining the purpose of the file and that changes are tracked in git

**Dependencies:** None

---

## Task 2 — Create the specrails-instance exemptions config [agents]

**Description:** Create `.claude/security-exemptions.yaml` — the specrails repo's own exemption config. This is what the `security-reviewer` agent reads when scanning specrails' own modified files. Initially empty exemptions.

**Files:**
- Create: `.claude/security-exemptions.yaml`

**Acceptance criteria:**
- File exists at `.claude/security-exemptions.yaml`
- Valid YAML
- Has `exemptions.secrets: []` and `exemptions.vulnerabilities: []`
- Contains the same header comment as the template (adapted for specrails context)
- No placeholder strings left in the file — this is the live instance, not the template

**Dependencies:** Task 1 (content pattern established)

---

## Task 3 — Create the security-reviewer agent template [templates]

**Description:** Write `templates/agents/security-reviewer.md`. This is the canonical agent prompt template. It follows the same structure as `templates/agents/reviewer.md` but has a security mandate instead of a CI mandate.

**Files:**
- Create: `templates/agents/security-reviewer.md`

**Content requirements:**

YAML frontmatter:
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

Prompt body MUST include:
1. Identity section: "You are a security-focused code auditor..."
2. Mission: scan only, do not fix
3. "What you receive" section explaining `MODIFIED_FILES_LIST`, `PIPELINE_CONTEXT`, `{{SECURITY_EXEMPTIONS_PATH}}`
4. Scanning methodology with the full secrets pattern table, entropy heuristic, and OWASP pattern table (from design.md)
5. What to skip (binaries, lock files, node_modules, vendor, .git, files in exemptions)
6. Severity definitions table (Critical / High / Medium / Info)
7. Exemption handling procedure
8. Output format (exactly as defined in design.md, including `SECURITY_STATUS:` as last line)
9. Rules section: "Never fix. Never suggest code changes. Report only. Never ask for clarification."
10. Memory protocol section using `{{MEMORY_PATH}}`

**Acceptance criteria:**
- File exists at `templates/agents/security-reviewer.md`
- Valid YAML frontmatter (no parse errors in the `---` block)
- All required placeholders present: `{{MEMORY_PATH}}`, `{{SECURITY_EXEMPTIONS_PATH}}`
- `{{MODIFIED_FILES_LIST}}` and `{{PIPELINE_CONTEXT}}` appear as instructional references in the prompt body (not as substitution targets — they are runtime values)
- Output format section ends with `SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN` exactly as specified
- Scanning methodology section includes the full secrets pattern table and OWASP pattern table
- File follows kebab-case naming: `security-reviewer.md`

**Dependencies:** None (can be done in parallel with Tasks 1 and 2)

---

## Task 4 — Generate the specrails-instance security-reviewer agent [agents]

**Description:** Create `.claude/agents/security-reviewer.md` by applying the template. For specrails, the substitutions are:
- `{{MEMORY_PATH}}` → `.claude/agent-memory/security-reviewer/`
- `{{SECURITY_EXEMPTIONS_PATH}}` → `.claude/security-exemptions.yaml`

This is the file that Claude Code will use when running the security-reviewer in the specrails repo.

**Files:**
- Create: `.claude/agents/security-reviewer.md`

**Acceptance criteria:**
- File exists at `.claude/agents/security-reviewer.md`
- No unresolved `{{PLACEHOLDER}}` strings remain (except `{{MODIFIED_FILES_LIST}}` and `{{PIPELINE_CONTEXT}}` which are runtime references in prose, not substitution targets)
- Memory path is `.claude/agent-memory/security-reviewer/`
- Exemptions path is `.claude/security-exemptions.yaml`
- YAML frontmatter is valid
- Content matches the template with substitutions applied

**Dependencies:** Task 3

---

## Task 5 — Create security-reviewer agent memory directory [agents]

**Description:** Create `.claude/agent-memory/security-reviewer/MEMORY.md` — the initial (empty) memory file for the agent. Follows the same pattern as other agents.

**Files:**
- Create: `.claude/agent-memory/security-reviewer/MEMORY.md`

**Content:**
```markdown
# Security Reviewer Agent Memory

No memories recorded yet.
```

**Acceptance criteria:**
- File exists at `.claude/agent-memory/security-reviewer/MEMORY.md`
- Contains the standard empty-memory header
- No other content

**Dependencies:** None

---

## Task 6 — Update `templates/commands/implement.md`: add Phase 4b-sec [templates]

**Description:** Modify `templates/commands/implement.md` to integrate the security-reviewer agent into Phase 4. This is a surgical edit — do NOT restructure existing phases.

**Files:**
- Modify: `templates/commands/implement.md`

**Specific changes:**

After the existing "### 4b. Launch Reviewer agent" block, insert a new block:

```
### 4b-sec. Launch Security Reviewer agent

After the reviewer agent completes, launch a **security-reviewer** agent (`subagent_type: security-reviewer`).

Construct the agent invocation prompt to include:
- The list of all modified files in this run (`MODIFIED_FILES_LIST`)
- A brief description of what was implemented: feature names and change names (`PIPELINE_CONTEXT`)
- The exemptions file path: `.claude/security-exemptions.yaml`

Wait for the security-reviewer to complete. Parse the last line of its output:
- `SECURITY_STATUS: BLOCKED` → set `SECURITY_BLOCKED=true`
- `SECURITY_STATUS: WARNINGS` → set `SECURITY_BLOCKED=false`, note warnings for report
- `SECURITY_STATUS: CLEAN` → set `SECURITY_BLOCKED=false`
```

At the start of "### 4c. Ship", insert a security gate block:

```
**Security gate:** If `SECURITY_BLOCKED=true`:
1. Print the Critical findings from the security-reviewer output
2. Do NOT create a branch, commit, push, or PR
3. Print: "Pipeline blocked by security findings. Fix the Critical issues listed above and re-run /implement."
4. Proceed directly to Phase 4e (report only).
```

In Phase 4e report table, change the table header from:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Tests | CI | Status |
```
to:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

**Acceptance criteria:**
- `### 4b-sec` block exists in the file, positioned after `### 4b`
- Security gate block exists at the start of `### 4c`
- Phase 4e table includes the `Security` column
- All existing content is preserved unchanged
- No `{{PLACEHOLDER}}` strings are broken by the edit

**Dependencies:** None (can be done in parallel with agent tasks)

---

## Task 7 — Update `.claude/commands/implement.md`: same changes [commands]

**Description:** Apply the same changes from Task 6 to `.claude/commands/implement.md` (the specrails-adapted generated copy). The generated copy has had its template placeholders resolved, so the edit targets the same logical sections but in the resolved content.

**Files:**
- Modify: `.claude/commands/implement.md`

**Acceptance criteria:**
- Same as Task 6, applied to the generated copy
- No template placeholders are introduced (this file has already been through substitution)
- The `### 4b-sec` section references `security-reviewer` (not a placeholder)

**Dependencies:** Task 6 (content pattern established by template edit)

---

## Task 8 — Update `install.sh`: copy security-exemptions template [templates]

**Description:** Add a single line to `install.sh` to copy `templates/security/security-exemptions.yaml` to `.claude/security-exemptions.yaml` in the target repo during setup. Must use an "only if not exists" pattern to avoid overwriting existing exemption configs on re-installs.

**Files:**
- Modify: `install.sh`

**Specific change:** In the section of `install.sh` that copies template files, add:

```bash
# Copy security exemptions config (do not overwrite existing)
if [ ! -f "$TARGET/.claude/security-exemptions.yaml" ]; then
  cp "$SPECRAILS_DIR/templates/security/security-exemptions.yaml" "$TARGET/.claude/security-exemptions.yaml"
  log "Created .claude/security-exemptions.yaml"
fi
```

Where `$TARGET` and `$SPECRAILS_DIR` are whatever variable names `install.sh` already uses for those paths.

**Acceptance criteria:**
- `install.sh` copies `templates/security/security-exemptions.yaml` to `.claude/security-exemptions.yaml` in the target
- Copy is skipped if `.claude/security-exemptions.yaml` already exists (idempotent)
- `shellcheck install.sh` passes after the edit
- The bash snippet uses `local` variables if inside a function, consistent with existing `install.sh` style
- `set -euo pipefail` is not broken by the change

**Dependencies:** Task 1

---

## Task 9 — Verify no broken placeholders [agents]

**Description:** After all files are created, run the placeholder integrity check on the new agent files to ensure no unresolved `{{PLACEHOLDER}}` strings exist in `.claude/agents/security-reviewer.md`.

**Files:** Read-only verification

**Command:**
```bash
grep -r '{{[A-Z_]*}}' .claude/agents/security-reviewer.md 2>/dev/null || echo "OK: no broken placeholders"
```

Expected output: `OK: no broken placeholders`

**Acceptance criteria:**
- The grep command returns no matches (or echoes "OK")
- If matches are found, fix them in `.claude/agents/security-reviewer.md` before considering this task done

**Dependencies:** Task 4

---

## Task 10 — Verify shellcheck on install.sh [templates]

**Description:** Run `shellcheck install.sh` after Task 8's edit to verify no shell script errors were introduced.

**Command:**
```bash
shellcheck install.sh
```

**Acceptance criteria:**
- `shellcheck install.sh` exits 0 (no errors)
- If errors exist: fix them, then re-verify

**Dependencies:** Task 8

---

## Execution Order

```
Task 1  ──┬──> Task 2 (instance config)
           └──> Task 8 ──> Task 10 (install.sh)

Task 3  ──> Task 4 ──> Task 9 (verification)

Task 5  (independent)

Task 6  ──> Task 7 (implement.md)
```

Tasks 1, 3, 5, and 6 can be started in parallel. Tasks 2 and 8 wait for Task 1. Task 4 and 9 follow Task 3. Task 7 follows Task 6. Task 10 follows Task 8.
