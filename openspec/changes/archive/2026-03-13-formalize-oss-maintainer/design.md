# Design: Formalize OSS Maintainer Persona

## Overview

This change adds OSS auto-detection to the specrails setup flow, resulting in the Maintainer persona (`the-maintainer.md`) being automatically included when OSS signals are detected. The change touches three layers: the shell installer (`install.sh`), the setup command (`commands/setup.md`), and the product-manager agent template (`templates/agents/product-manager.md`).

---

## Detection Architecture

### Signal Set

Three boolean signals constitute "OSS project":

| Signal | How to detect | Fallback if unavailable |
|--------|---------------|------------------------|
| Public repo | `gh repo view --json isPrivate --jq '.isPrivate'` returns `false` | Ask user |
| CI present | `ls .github/workflows/*.yml 2>/dev/null` has results | Check for `.travis.yml`, `circle.yml`, `Makefile` with `test:` target |
| CONTRIBUTING.md | `test -f CONTRIBUTING.md || test -f .github/CONTRIBUTING.md` | None — absence is meaningful |

All three signals must be `true` for auto-detection to trigger. Partial signal sets prompt the user instead of auto-detecting. This avoids false positives (e.g., a private enterprise repo that happens to have CONTRIBUTING.md).

### Detection in `install.sh`

`install.sh` already checks for `gh` CLI (Phase 1.5). Extend Phase 1 with a new **Phase 1.7: OSS Detection** block that runs after the `gh` check:

```bash
# 1.7 OSS detection (best-effort, requires gh auth)
IS_OSS=false

if [ "$HAS_GH" = true ]; then
    REPO_PRIVATE=$(gh repo view --json isPrivate --jq '.isPrivate' 2>/dev/null || echo "unknown")
    HAS_CI=false
    if ls "$REPO_ROOT/.github/workflows/"*.yml &>/dev/null; then
        HAS_CI=true
    fi
    HAS_CONTRIBUTING=false
    if [ -f "$REPO_ROOT/CONTRIBUTING.md" ] || [ -f "$REPO_ROOT/.github/CONTRIBUTING.md" ]; then
        HAS_CONTRIBUTING=true
    fi

    if [ "$REPO_PRIVATE" = "false" ] && [ "$HAS_CI" = true ] && [ "$HAS_CONTRIBUTING" = true ]; then
        IS_OSS=true
        ok "OSS project detected (public repo + CI + CONTRIBUTING.md)"
    fi
fi
```

Then write a detection results file that `/setup` reads later:

```bash
# Write OSS detection results for /setup to consume
cat > "$REPO_ROOT/.claude/setup-templates/.oss-detection.json" <<EOF
{
  "is_oss": $IS_OSS,
  "signals": {
    "public_repo": $([ "$REPO_PRIVATE" = "false" ] && echo "true" || echo "false"),
    "has_ci": $HAS_CI,
    "has_contributing": $HAS_CONTRIBUTING
  }
}
EOF
```

The file is written to `setup-templates/` because that directory is already treated as temporary scaffolding — it gets cleaned up in Phase 5 of `/setup`.

### Detection in `commands/setup.md`

In Phase 1.4 (Present findings), after displaying the codebase analysis, the wizard reads `.claude/setup-templates/.oss-detection.json` and reports the OSS status:

```
### OSS Project Detection
- Public repo: Yes / No / Unknown (gh not available)
- CI workflows: Yes / No
- CONTRIBUTING.md: Yes / No
- **Result: OSS project detected — Maintainer persona will be included**
```

If not auto-detected but the user believes this is an OSS project, they can confirm during the "Confirm / Modify" step.

In Phase 2 (User Personas), after the user describes their target users:

> If `is_oss: true` (from detection or user confirmation), prepend the following instruction before persona generation:
> "This is an OSS project. The Maintainer persona (`the-maintainer.md`) will be included automatically. You do not need to describe 'OSS maintainers' as a user type — Kai is already included."

In Phase 4.2 (Generate personas), add a conditional step:

> If `IS_OSS=true`, copy `setup-templates/personas/the-maintainer.md` to `.claude/agents/personas/the-maintainer.md` without modification. This is not a generated file — it is a pre-authored persona that ships with specrails.

---

## Template Changes

### `templates/agents/product-manager.md`

The `{{PERSONA_FILE_LIST}}` placeholder currently gets populated during `/setup` with whatever personas were generated. The Maintainer is already listed in the specrails-specific product-manager agent (`.claude/agents/product-manager.md`), but this is hardcoded rather than driven by the template.

**Change**: Add a `{{MAINTAINER_PERSONA_LINE}}` placeholder that is conditionally included when `IS_OSS=true`.

Current section in template:
```
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
```

Updated section:
```
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
{{MAINTAINER_PERSONA_LINE}}
```

When `IS_OSS=true`, `{{MAINTAINER_PERSONA_LINE}}` resolves to:
```
- `.claude/agents/personas/the-maintainer.md` — "Kai" the Maintainer (open-source maintainer)
```

When `IS_OSS=false`, `{{MAINTAINER_PERSONA_LINE}}` resolves to an empty string.

`{{PERSONA_COUNT}}` is incremented by 1 when the Maintainer is included.

`{{PERSONA_SCORE_FORMAT}}` (used in VPC scoring lines) is already `PersonaName: X/5` format — no change needed. When the Maintainer persona is present, the agent will naturally include "Kai: X/5" because the agent reads all files in `.claude/agents/personas/`.

---

## File Change Summary

| File | Change type | Description |
|------|-------------|-------------|
| `install.sh` | Modify | Add Phase 1.7 OSS detection block; write `.oss-detection.json` |
| `commands/setup.md` | Modify | Read detection results in Phase 1.4; conditional persona inclusion in Phase 2 and 4.2 |
| `templates/agents/product-manager.md` | Modify | Add `{{MAINTAINER_PERSONA_LINE}}` placeholder |
| `templates/personas/the-maintainer.md` | New file | Copy of `.claude/agents/personas/the-maintainer.md` for use as a template source |

Note: `.claude/agents/personas/the-maintainer.md` is the persona in specrails's own generated setup. It must also exist as a source template at `templates/personas/the-maintainer.md` so that install.sh can copy it to target repos.

---

## Integration Points

### install.sh → /setup handoff

The `.oss-detection.json` file is the handoff mechanism. `install.sh` writes it; `/setup` reads it. This avoids running `gh` commands twice and keeps the detection logic in one place (the shell script).

### /setup → product-manager agent

The product-manager agent does not need to change at runtime — it reads all persona files from `.claude/agents/personas/` dynamically. The presence of `the-maintainer.md` in that directory is sufficient for the agent to include Kai in VPC scoring.

### Cleanup

`.oss-detection.json` is inside `setup-templates/` which is already deleted in Phase 5.1 (`rm -rf .claude/setup-templates/`). No additional cleanup needed.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| `gh` not available | OSS detection skipped; user can manually confirm OSS during Phase 1.4 |
| `gh` available but not authenticated | Same as above — `gh repo view` will fail, `is_oss` stays `false` |
| Public repo but no CI | Partial signal — not auto-detected; user prompted |
| Public repo + CI but no CONTRIBUTING.md | Partial signal — not auto-detected; user prompted |
| Private repo that happens to have CONTRIBUTING.md | Not detected as OSS (public repo signal is false) |
| User manually adds Maintainer persona after setup | Works fine — the agent reads all files in the directory |

---

## What Does NOT Change

- The Maintainer persona content (`the-maintainer.md`) — it is already complete and well-sourced
- The VPC scoring framework in the product-manager agent — it already covers all personas present
- The `PERSONA_SCORE_FORMAT` placeholder — it already produces per-persona scores
- Any other agent (architect, developer, reviewer) — they don't reference personas directly
