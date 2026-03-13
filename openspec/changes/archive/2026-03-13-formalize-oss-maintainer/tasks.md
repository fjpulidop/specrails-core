# Tasks: Formalize OSS Maintainer Persona

All tasks are ordered by dependency. A task may only begin when all tasks it depends on are complete.

Estimated total effort: **Low** (2-3 hours)

---

## Task 1: Copy Maintainer persona to templates/ [templates]

**Title**: Add `the-maintainer.md` as a source template

**Description**:
The Maintainer persona currently exists at `.claude/agents/personas/the-maintainer.md` (specrails's own generated persona). It needs to also exist at `templates/personas/the-maintainer.md` so that `install.sh` can copy it to target repos.

Create `templates/personas/the-maintainer.md` with identical content to `.claude/agents/personas/the-maintainer.md`. This is not a template with `{{PLACEHOLDER}}` syntax — it is a pre-authored file.

**Files involved:**
- `templates/personas/the-maintainer.md` — create (copy from `.claude/agents/personas/the-maintainer.md`)

**Acceptance criteria:**
- `templates/personas/the-maintainer.md` exists
- Content is byte-for-byte identical to `.claude/agents/personas/the-maintainer.md`
- No `{{PLACEHOLDER}}` markers present (it is not a parameterized template)
- `grep -r '{{' templates/personas/the-maintainer.md` returns nothing

**Dependencies:** None

---

## Task 2: Add `{{MAINTAINER_PERSONA_LINE}}` to product-manager template [templates]

**Title**: Make Maintainer persona line conditional in product-manager template

**Description**:
The `templates/agents/product-manager.md` template has a `{{PERSONA_FILE_LIST}}` placeholder that gets populated with the user-generated personas. Add a `{{MAINTAINER_PERSONA_LINE}}` placeholder immediately after it so `/setup` can conditionally append the Maintainer persona reference.

**Files involved:**
- `templates/agents/product-manager.md` — modify (add placeholder)

**Change**:

Find this block:
```
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
```

Replace with:
```
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
{{MAINTAINER_PERSONA_LINE}}
```

Also update both occurrences of `{{PERSONA_SCORE_FORMAT}}` in the VPC evaluation sections to include "Kai" as a named slot comment. The existing format `PersonaName: X/5` already works — no change to format string needed.

**Acceptance criteria:**
- `{{MAINTAINER_PERSONA_LINE}}` appears exactly once in the template, after `{{PERSONA_FILE_LIST}}`
- No other content changes are made to the template
- Template still renders correctly when `{{MAINTAINER_PERSONA_LINE}}` is substituted with an empty string

**Dependencies:** None (parallel with Task 1)

---

## Task 3: Add OSS detection block to `install.sh` [shell]

**Title**: Detect OSS signals in installer and write detection results

**Description**:
Add Phase 1.7 to `install.sh` after the GitHub CLI check (section 1.5, around line 135). The block detects three OSS signals and writes a `.oss-detection.json` file to the setup-templates directory.

**Files involved:**
- `install.sh` — modify

**New code to add** (after the `HAS_GH` block, before the JIRA CLI check at line 137):

```bash
# 1.7 OSS detection (requires gh auth; degrades gracefully)
IS_OSS=false
HAS_PUBLIC_REPO=false
HAS_CI=false
HAS_CONTRIBUTING=false

if [ "$HAS_GH" = true ]; then
    _REPO_PRIVATE=$(gh repo view --json isPrivate --jq '.isPrivate' 2>/dev/null || echo "unknown")
    if [ "$_REPO_PRIVATE" = "false" ]; then
        HAS_PUBLIC_REPO=true
    fi
    if ls "$REPO_ROOT/.github/workflows/"*.yml &>/dev/null 2>&1; then
        HAS_CI=true
    fi
    if [ -f "$REPO_ROOT/CONTRIBUTING.md" ] || [ -f "$REPO_ROOT/.github/CONTRIBUTING.md" ]; then
        HAS_CONTRIBUTING=true
    fi
    if [ "$HAS_PUBLIC_REPO" = true ] && [ "$HAS_CI" = true ] && [ "$HAS_CONTRIBUTING" = true ]; then
        IS_OSS=true
        ok "OSS project detected (public repo + CI + CONTRIBUTING.md)"
    fi
fi
```

Then write the detection results to `.oss-detection.json` at the end of Phase 3 (after the templates are copied, so the directory exists):

```bash
# Write OSS detection results for /setup
cat > "$REPO_ROOT/.claude/setup-templates/.oss-detection.json" << EOF
{
  "is_oss": $IS_OSS,
  "signals": {
    "public_repo": $HAS_PUBLIC_REPO,
    "has_ci": $HAS_CI,
    "has_contributing": $HAS_CONTRIBUTING
  }
}
EOF
```

Add this write block right after the `cp -r "$SCRIPT_DIR/templates/"*` line (around line 209) with an `ok` log:

```bash
ok "OSS detection results written"
```

**Acceptance criteria:**
- `set -euo pipefail` is still respected — all variable references are quoted, all commands degrade gracefully
- When `HAS_GH=false`, block is skipped entirely, `IS_OSS=false`
- When `gh repo view` fails (e.g., not in a remote repo), `IS_OSS` stays `false` (no `set -e` failure)
- When all three signals detected: `ok "OSS project detected..."` is printed
- `.oss-detection.json` is written with correct boolean values (lowercase `true`/`false`, not shell `true`/`false`)
- `shellcheck install.sh` passes with no errors

**Dependencies:** None (parallel with Tasks 1 and 2)

---

## Task 4: Update `/setup` Phase 1.4 — display OSS detection results [templates]

**Title**: Show OSS detection status in codebase analysis output

**Description**:
Update `commands/setup.md` Phase 1.4 to read `.oss-detection.json` and display a detection status table alongside the codebase analysis. Add a manual confirmation prompt for edge cases where detection was incomplete.

**Files involved:**
- `commands/setup.md` — modify Phase 1.4

**Changes to Phase 1.4 display block:**

After the existing architecture table and before `[Confirm] [Modify] [Rescan]`, add:

```
### OSS Project Detection

Read `.claude/setup-templates/.oss-detection.json` if it exists.

| Signal | Status |
|--------|--------|
| Public repository | [Yes / No / Unknown] |
| CI workflows (.github/workflows/) | [Yes / No] |
| CONTRIBUTING.md | [Yes / No] |
| **Result** | **OSS detected / Not detected / Could not check** |
```

If `is_oss: false` but at least one signal is `true`:
> "Some OSS signals were found but not all three. Is this an open-source project? (yes/no)"

If `.oss-detection.json` does not exist:
> "Is this an open-source project? (yes/no)"

Store the final OSS determination as `IS_OSS` for use throughout the rest of setup.

**Acceptance criteria:**
- Detection results are shown in Phase 1.4 output
- Manual confirmation prompt appears when detection is partial or unavailable
- `IS_OSS` is set correctly before Phase 2 begins
- When `IS_OSS=false` and no signals present, no OSS-related output is shown (don't clutter the output for non-OSS projects)

**Dependencies:** Task 3 (needs the .json file format to be defined)

---

## Task 5: Update `/setup` Phase 2.1 — conditional Maintainer mention [templates]

**Title**: Inform user that Maintainer persona is auto-included for OSS projects

**Description**:
Update `commands/setup.md` Phase 2.1 to prepend a notice when `IS_OSS=true`, telling the user they do not need to describe open-source maintainers as a persona.

**Files involved:**
- `commands/setup.md` — modify Phase 2.1

**Change**: At the beginning of the Phase 2.1 user prompt, add:

```
> If IS_OSS=true, prepend:
> "This is an OSS project. The **Maintainer** persona (Kai) is automatically included —
> you do not need to add 'open-source maintainers' to your list.
> Describe your other target user types below."
```

**Acceptance criteria:**
- Notice only appears when `IS_OSS=true`
- No change to Phase 2.1 when `IS_OSS=false`
- The phrase "Maintainer persona (Kai) is automatically included" appears in the output

**Dependencies:** Task 4 (needs `IS_OSS` to be defined)

---

## Task 6: Update `/setup` Phase 4.2 — copy Maintainer persona file [templates]

**Title**: Conditionally include Maintainer persona in generated output

**Description**:
Update `commands/setup.md` Phase 4.2 to copy `the-maintainer.md` from setup-templates to `.claude/agents/personas/` when `IS_OSS=true`. This step must run before user-defined personas are written so the count is correct.

**Files involved:**
- `commands/setup.md` — modify Phase 4.2

**Add the following step at the start of Phase 4.2:**

```
### 4.2 Generate personas

If IS_OSS=true:
1. Copy `setup-templates/personas/the-maintainer.md` to `.claude/agents/personas/the-maintainer.md`
2. Log: "Maintainer persona included"
3. Set MAINTAINER_INCLUDED=true for use in template substitution

Then for each user-defined VPC persona from Phase 2.3:
[existing persona generation logic unchanged]
```

**Template substitution values to set:**
- `IS_OSS=true`: `{{MAINTAINER_PERSONA_LINE}}` = `- \`.claude/agents/personas/the-maintainer.md\` — "Kai" the Maintainer (open-source maintainer)`
- `IS_OSS=true`: `{{PERSONA_COUNT}}` += 1

**Acceptance criteria:**
- When `IS_OSS=true`: `.claude/agents/personas/the-maintainer.md` exists after Phase 4.2
- File content matches `setup-templates/personas/the-maintainer.md` exactly (no substitution)
- `{{MAINTAINER_PERSONA_LINE}}` in product-manager agent output contains the Maintainer file path
- `{{PERSONA_COUNT}}` reflects the correct total (user personas + 1 for Maintainer)
- When `IS_OSS=false`: no `the-maintainer.md` is written, `{{MAINTAINER_PERSONA_LINE}}` is empty string

**Dependencies:** Tasks 1, 2, 5

---

## Task 7: Update `/setup` Phase 5.3 — summary table [templates]

**Title**: Include Maintainer in the setup completion summary

**Description**:
Update the summary table in Phase 5.3 to show the Maintainer persona as "Auto-included (OSS)" when present, distinguishing it from user-generated personas.

**Files involved:**
- `commands/setup.md` — modify Phase 5.3 summary section

**Change**: Modify the Personas Created table:

```
### Personas Created
| Persona | File | Source |
|---------|------|--------|
[If IS_OSS=true:]
| "Kai" — The Maintainer | .claude/agents/personas/the-maintainer.md | Auto-included (OSS) |
[For each user-generated persona:]
| "[Name]" — The [Role] | .claude/agents/personas/[name].md | Generated |
```

**Acceptance criteria:**
- Maintainer row appears at the top of the table when `IS_OSS=true`
- "Auto-included (OSS)" appears in the Source column for the Maintainer
- When `IS_OSS=false`, table is unchanged from today
- Persona count in summary header is correct

**Dependencies:** Task 6

---

## Task Order Summary

```
Task 1 (templates/personas/the-maintainer.md) ─┐
Task 2 (product-manager template placeholder)  ─┼─→ Task 6 → Task 7
Task 3 (install.sh detection) ─────────────────┘
                               └─→ Task 4 → Task 5 ─┘
```

Tasks 1, 2, 3 can be done in parallel. Tasks 4, 5, 6, 7 must be sequential.
