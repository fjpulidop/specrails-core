# Delta Spec: Formalize OSS Maintainer Persona

This document describes the precise spec changes required to implement the OSS Maintainer auto-detection feature. It is written as a diff against current behavior — "before" describes what exists today, "after" describes the target state.

---

## 1. install.sh — OSS Detection Phase

### Before

`install.sh` has five prerequisite checks (git, claude, npm, openspec, gh) and two main phases (detect existing setup, install artifacts). No OSS detection.

### After

Add a new detection block between the GitHub CLI check (1.5) and the JIRA CLI check (1.6). The block is skipped gracefully if `HAS_GH=false`.

**New variables set by this block:**

```
IS_OSS: bool        — true if all three signals detected
HAS_PUBLIC_REPO: bool — repo is not private (via gh)
HAS_CI: bool         — .github/workflows/*.yml exists
HAS_CONTRIBUTING: bool — CONTRIBUTING.md exists at root or .github/
```

**New output file written:**

```
$REPO_ROOT/.claude/setup-templates/.oss-detection.json
```

Schema:
```json
{
  "is_oss": true | false,
  "signals": {
    "public_repo": true | false,
    "has_ci": true | false,
    "has_contributing": true | false
  }
}
```

**New console output (when detected):**

```
  ✓ OSS project detected (public repo + CI + CONTRIBUTING.md)
```

**New console output (when not detected, gh available):**

```
  → OSS signals: public_repo=false ci=true contributing=true — not auto-detected
```

**New console output (when gh unavailable):**

No output — detection is silently skipped.

---

## 2. commands/setup.md — Phase 1.4 Additions

### Before

Phase 1.4 displays codebase analysis (layers, CI commands, conventions) and waits for `[Confirm] [Modify] [Rescan]`.

### After

Phase 1.4 additionally reads `.claude/setup-templates/.oss-detection.json` (if it exists) and appends an OSS status section to the codebase analysis display:

```
### OSS Project Detection
| Signal | Status |
|--------|--------|
| Public repository | Yes / No / Unknown |
| CI workflows (.github/workflows/) | Yes / No |
| CONTRIBUTING.md | Yes / No |
| **Auto-detected as OSS** | **Yes / No** |
```

If `is_oss: false` but at least one signal is `true`, add a prompt:

> "OSS signals were found but not all three are present. Is this an open-source project? (yes/no)"
> If yes, set `IS_OSS=true` for the rest of setup.

If `.oss-detection.json` does not exist (installer did not run or gh was unavailable), add a prompt:

> "Is this an open-source project? (yes/no)"

---

## 3. commands/setup.md — Phase 2 Additions

### Before

Phase 2.1 asks: "Who are the target users of your software?" and the user lists all personas to generate.

### After

If `IS_OSS=true`, prepend the following to the Phase 2.1 prompt:

> "This is an OSS project. The **Maintainer** persona (Kai) is automatically included — you do not need to add 'open-source maintainers' to your list. Describe your other target user types."

If `IS_OSS=false`, behavior is unchanged.

---

## 4. commands/setup.md — Phase 4.2 Additions

### Before

Phase 4.2 generates persona files from the VPC personas created in Phase 2.3.

### After

If `IS_OSS=true`, add a step before generating user-defined personas:

1. Copy `setup-templates/personas/the-maintainer.md` to `.claude/agents/personas/the-maintainer.md`
2. Log: `ok "Maintainer persona included (the-maintainer.md)"`
3. Increment persona count for the summary table

This copy step uses the pre-authored persona file — no template substitution is performed on it.

---

## 5. commands/setup.md — Phase 5.3 Summary Table

### Before

Summary table for Personas:
```
### Personas Created
| Persona | File |
|---------|------|
| "[Name]" — The [Role] | .claude/agents/personas/[name].md |
```

### After

If `IS_OSS=true`, add the Maintainer row (always at the top, before user-generated personas):
```
### Personas Created
| Persona | File | Source |
|---------|------|--------|
| "Kai" — The Maintainer | .claude/agents/personas/the-maintainer.md | Auto-included (OSS) |
| "[Name]" — The [Role] | .claude/agents/personas/[name].md | Generated |
```

---

## 6. templates/agents/product-manager.md — Placeholder Addition

### Before

```markdown
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
```

### After

```markdown
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
{{MAINTAINER_PERSONA_LINE}}
```

**Substitution rules:**

| Condition | `{{MAINTAINER_PERSONA_LINE}}` value |
|-----------|-------------------------------------|
| `IS_OSS=true` | `- \`.claude/agents/personas/the-maintainer.md\` — "Kai" the Maintainer (open-source maintainer)` |
| `IS_OSS=false` | *(empty string — line omitted)* |

`{{PERSONA_COUNT}}` increments by 1 when `IS_OSS=true`.

---

## 7. templates/personas/the-maintainer.md — New Template Source File

### Before

The Maintainer persona exists only at `.claude/agents/personas/the-maintainer.md` (specrails's own setup, not a template source).

### After

A copy of the persona is placed at `templates/personas/the-maintainer.md`. This is the authoritative source that `install.sh` copies to target repos during setup.

The file content is identical to `.claude/agents/personas/the-maintainer.md` — it is a pre-authored file, not a template with `{{PLACEHOLDER}}` syntax.

**Note**: The existing `.claude/agents/personas/the-maintainer.md` remains as specrails's own generated persona (specrails is its own OSS project and will auto-detect itself).

---

## Invariants

These things must remain true after the change:

1. If `IS_OSS=false`, setup behavior is identical to today
2. The Maintainer persona file content is never modified by setup — it is always copied verbatim
3. The `.oss-detection.json` file is always cleaned up by Phase 5.1
4. No new required prerequisites — OSS detection degrades gracefully when `gh` is unavailable
5. A user who manually adds `the-maintainer.md` after setup gets no errors — the agent reads all files in the directory dynamically
