# Context Bundle: Formalize OSS Maintainer Persona

Everything a developer needs to implement this feature without reading the full codebase.

---

## What You're Building

When a developer runs specrails's installer on an open-source project, the setup wizard should automatically include the Maintainer persona (Kai) in the generated output. Today it doesn't — you have to manually describe "open-source maintainers" as a target user type.

The feature is simple:
1. Detect 3 OSS signals in `install.sh`, write a JSON file
2. `/setup` reads that JSON, shows status, asks for confirmation if partial
3. When OSS confirmed, copy `the-maintainer.md` to the personas output directory
4. Pass a `{{MAINTAINER_PERSONA_LINE}}` placeholder into the product-manager agent template

---

## Codebase Map (Relevant Files Only)

```
specrails/
├── install.sh                              ← Shell installer. MODIFY: add Phase 1.7 OSS detection
├── commands/
│   └── setup.md                            ← /setup wizard. MODIFY: Phases 1.4, 2.1, 4.2, 5.3
├── templates/
│   ├── agents/
│   │   └── product-manager.md              ← Agent template. MODIFY: add {{MAINTAINER_PERSONA_LINE}}
│   └── personas/
│       ├── persona.md                      ← Generic persona template (don't modify)
│       └── the-maintainer.md               ← CREATE: copy from .claude/agents/personas/
└── .claude/
    └── agents/
        └── personas/
            └── the-maintainer.md           ← SOURCE: copy this to templates/personas/
```

---

## Key Files — Annotated Excerpts

### install.sh structure

```bash
set -euo pipefail
# Phase 1: Prerequisites
# 1.1 git check
# 1.2 claude check
# 1.3 npm check
# 1.4 openspec check
# 1.5 gh check          ← INSERT 1.7 here, after the HAS_GH block
# 1.6 jira check
# Phase 2: Detect existing setup
# Phase 3: Install artifacts  ← INSERT json write here, after cp templates
# Phase 4: Summary
```

The `HAS_GH` variable is set by the end of section 1.5. It is `true` or `false`. Never `unknown` — if `gh` is not installed it's `false`.

Shell conventions in this file:
- `set -euo pipefail` — all commands must succeed or be explicitly handled
- `ok()`, `warn()`, `fail()`, `info()` — logging helpers
- Variable names: `SCREAMING_SNAKE_CASE`
- Functions use `local` for variables
- Always quote variable references: `"$VAR"` not `$VAR`
- File existence checks: `[ -f "$path" ]` and `[ -d "$path" ]`

### install.sh — gh detection block (lines 123–135, for context)

```bash
# 1.5 GitHub CLI (optional)
if command -v gh &> /dev/null; then
    if gh auth status &> /dev/null; then
        ok "GitHub CLI: authenticated"
        HAS_GH=true
    else
        warn "GitHub CLI installed but not authenticated. Run: gh auth login"
        HAS_GH=false
    fi
else
    warn "GitHub CLI (gh) not found. GitHub Issues backlog will be unavailable."
    HAS_GH=false
fi
```

Insert Phase 1.7 after line 135, before the JIRA block.

### install.sh — Phase 3 template copy (lines 208–210, for context)

```bash
# Copy templates
cp -r "$SCRIPT_DIR/templates/"* "$REPO_ROOT/.claude/setup-templates/"
ok "Installed setup templates"
```

Insert the `.oss-detection.json` write after `ok "Installed setup templates"`.

### commands/setup.md — Phase 1.4 (lines 49–77)

The codebase analysis display. Currently ends with `[Confirm] [Modify] [Rescan]`. Add the OSS detection table and conditional prompt before the confirm buttons.

### commands/setup.md — Phase 2.1 (lines 85–99)

The user persona prompt. Add a conditional notice at the top when `IS_OSS=true`.

### commands/setup.md — Phase 4.2 (lines 382–388)

Currently:
```markdown
### 4.2 Generate personas

Write each persona to `.claude/agents/personas/`:
- Use the VPC personas generated in Phase 2
- File naming: kebab-case of persona nickname
```

Add the conditional Maintainer copy step before the existing persona generation.

### commands/setup.md — Phase 5.3 (lines 534–583)

The summary table. Add a "Source" column and the Maintainer row.

### templates/agents/product-manager.md — Persona section (lines 44–48)

```markdown
You have {{PERSONA_COUNT}} primary personas defined in `.claude/agents/personas/`. **Always read these files** at the start of any exploration session:

{{PERSONA_FILE_LIST}}
```

Add `{{MAINTAINER_PERSONA_LINE}}` on a new line after `{{PERSONA_FILE_LIST}}`.

---

## The Maintainer Persona (Summary)

File: `.claude/agents/personas/the-maintainer.md`

- **Name**: "Kai" — The Maintainer
- **Role**: Open-source maintainer, often solo or with 1-3 co-maintainers
- **Critical pain**: "Eternal September" — AI floods maintainers with low-quality PRs
- **Key gain**: AI reviewer that enforces project-specific conventions
- **Key insight**: OSS maintainers don't need AI to write code — they need AI that understands their project deeply enough to review contributions and enforce conventions

Do not modify this file. Copy it verbatim.

---

## OSS Detection Logic

Three signals, all must be true:

```
public_repo  = (gh repo view --json isPrivate --jq '.isPrivate') == "false"
has_ci       = ls .github/workflows/*.yml succeeds (at least one file)
has_contributing = test -f CONTRIBUTING.md || test -f .github/CONTRIBUTING.md
```

**Why all three?** Requiring all three minimizes false positives. A private enterprise repo might have CI and CONTRIBUTING.md. A public toy project might have no CI. Only an actively maintained OSS project is likely to have all three.

**Graceful degradation**: If `gh` is unavailable or unauthenticated, skip detection entirely. Don't fail. Prompt the user manually in Phase 1.4.

---

## Template Substitution Rules

When populating `{{MAINTAINER_PERSONA_LINE}}`:

| Condition | Value |
|-----------|-------|
| `IS_OSS=true` | `- \`.claude/agents/personas/the-maintainer.md\` — "Kai" the Maintainer (open-source maintainer)` |
| `IS_OSS=false` | *(empty string — omit the line entirely)* |

When populating `{{PERSONA_COUNT}}`:
- Count = user-generated personas + (1 if `IS_OSS=true`, else 0)

---

## .oss-detection.json Schema

Written by `install.sh` to `.claude/setup-templates/.oss-detection.json`:

```json
{
  "is_oss": true,
  "signals": {
    "public_repo": true,
    "has_ci": true,
    "has_contributing": true
  }
}
```

- Booleans are lowercase (`true`/`false`), not shell strings
- This file is temporary — it is deleted by Phase 5.1 (`rm -rf .claude/setup-templates/`)
- If the file does not exist, `/setup` must prompt the user manually

---

## Things That Must NOT Change

1. The Maintainer persona file content — copy verbatim, no substitutions
2. The VPC scoring framework in the product-manager template — already handles all personas
3. The other persona templates (`the-lead-dev.md`, `the-product-founder.md`)
4. Any agent templates other than `product-manager.md`
5. The behavior of setup when `IS_OSS=false` — must be identical to today

---

## Manual Verification Steps

After implementing:

1. Run `shellcheck install.sh` — must pass with no errors
2. Check `templates/personas/the-maintainer.md` matches `.claude/agents/personas/the-maintainer.md`:
   ```bash
   diff templates/personas/the-maintainer.md .claude/agents/personas/the-maintainer.md
   ```
   Should produce no output.
3. Check for broken placeholders in product-manager template:
   ```bash
   grep '{{MAINTAINER_PERSONA_LINE}}' templates/agents/product-manager.md
   ```
   Should find exactly one match.
4. Simulate `IS_OSS=false` path by reading `commands/setup.md` Phase 4.2 — confirm no Maintainer persona is written.
5. Simulate `IS_OSS=true` path — confirm `the-maintainer.md` copy step is present in Phase 4.2.

---

## Common Pitfalls

- **Shell glob failure**: `ls .github/workflows/*.yml` will fail (exit 1) if no files match when `set -e` is active. Use `ls .github/workflows/*.yml &>/dev/null 2>&1` or redirect both stdout and stderr, and wrap in `if ... ; then`.
- **Boolean in heredoc**: Shell `true`/`false` are commands, not JSON booleans. Use the variable's string value directly in the heredoc, but set variables as strings: `IS_OSS="true"` or `IS_OSS="false"` so they interpolate correctly.
- **Empty `{{MAINTAINER_PERSONA_LINE}}`**: When the placeholder substitutes to an empty string, there should be no trailing blank line left in the generated file. The `/setup` generation logic should strip the empty line.
- **Persona count off-by-one**: Increment `PERSONA_COUNT` before using it in the template substitution, not after.
