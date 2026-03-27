# Spec: Quick Start Mode in /setup

RFC: RFC-001 · Issue: SPEA-74

Defines the Quick Start mode added to `commands/setup.md`. Quick Start is the **default** path. The existing 5-phase wizard becomes the Advanced path, triggered via `--advanced`.

---

## Mode Detection

Check `$ARGUMENTS` at the top of `commands/setup.md`:

| Condition | Mode |
|-----------|------|
| `$ARGUMENTS` contains `--update` | Update Mode (existing, unchanged) |
| `$ARGUMENTS` contains `--advanced` | Advanced Mode (existing 5-phase wizard, unchanged) |
| `$ARGUMENTS` is empty or contains no recognized flag | Quick Start Mode (new default) |

Mode detection is the first action. No analysis or file reads happen before mode is determined.

---

## Quick Start Mode

### Phase QS1: Ask 3 Questions

Ask exactly **3 questions**, in order. No other questions are asked in this phase.

| # | Question | Variable set |
|---|----------|-------------|
| 1 | "What is this project? (one sentence)" | `PROJECT_DESCRIPTION` |
| 2 | "Who are the target users?" | `TARGET_USERS` |
| 3 | "Read-only or read-write git access for agents? (read-only/read-write)" | `GIT_ACCESS` |

**Validation for question 3**: Accept only `read-only` or `read-write` (case-insensitive). If the user enters anything else, re-ask once. If still invalid, default to `read-only` and continue.

No branching based on answers within Phase QS1. All three answers are collected before proceeding.

---

### Phase QS2: Apply Defaults

Set all remaining configuration using opinionated defaults. Do not ask the user about these settings.

| Setting | Default Value |
|---------|--------------|
| Agents enabled | CEO, CTO, Tech Lead, founding-engineer |
| Git mode | Value of `GIT_ACCESS` from Phase QS1 |
| CLAUDE.md template | `templates/CLAUDE-quickstart.md` |
| OpenSpec enabled | `true` if `openspec` CLI is detected (`command -v openspec` exits 0); `false` otherwise |
| Telemetry | Not included (deferred to PRD-002) |

---

### Phase QS3: Detect Codebase Type

Determine whether the target repository is a new project or an existing codebase.

**Heuristic**: Check for presence of any of these files in the repo root:
- `package.json`
- `Gemfile`
- `pyproject.toml`
- `go.mod`
- `pom.xml`

| Condition | `CODEBASE_TYPE` |
|-----------|----------------|
| At least one file found | `existing` |
| None found | `new` |

This variable is used in Phase QS5.

---

### Phase QS4: Generate Agent Files

Generate all agent files using the defaults from Phase QS2 and the answers from Phase QS1 as context. Use `PROJECT_DESCRIPTION` and `TARGET_USERS` to populate agent personas and goals.

Files generated (same set as Advanced mode):
- `agents/ceo/AGENTS.md`
- `agents/cto/AGENTS.md`
- `agents/tech-lead/AGENTS.md`
- `agents/founding-engineer/AGENTS.md`
- `CLAUDE.md` (from `templates/CLAUDE-quickstart.md`)

No prompts to the user during this phase. Generation is silent.

---

### Phase QS5: Output Completion Message

Print to stdout:

```
✅ Setup complete.

Try your first spec:
  > /specrails:product-backlog
```

If `CODEBASE_TYPE` is `existing`, replace the last two lines with:

```
Try your first spec:
  > /specrails:tech-audit
```

This is the final output of Quick Start mode. No additional prompts.

---

## Advanced Mode

Triggered by `--advanced` in `$ARGUMENTS`.

Executes the existing 5-phase wizard **without any changes**. The completion message from Phase QS5 (first-task prompt) is appended as a final step to Advanced mode output as well.

---

## Template: CLAUDE-quickstart.md

A new file `templates/CLAUDE-quickstart.md` is created. It is a minimal CLAUDE.md template.

**Required sections** (in order):

1. `# [PROJECT_DESCRIPTION]` — populated from Quick Start answer 1
2. `## Target Users` — populated from Quick Start answer 2
3. `## Git Access` — populated from Quick Start answer 3 (`read-only` or `read-write`)
4. `## Agent Team` — static comment block listing the 4 default agents (CEO, CTO, Tech Lead, founding-engineer)
5. `## Post-Setup` — static block: "Run `specrails doctor` to validate your setup."

Placeholder tokens in the template use double curly braces: `{{PROJECT_DESCRIPTION}}`, `{{TARGET_USERS}}`, `{{GIT_ACCESS}}`.

---

## Behavior Matrix

| `$ARGUMENTS` | Mode | 3 questions asked | Defaults applied | 5-phase wizard |
|-------------|------|:-----------------:|:----------------:|:--------------:|
| (empty) | Quick Start | ✓ | ✓ | ✗ |
| `--advanced` | Advanced | ✗ | ✗ | ✓ |
| `--update` | Update | ✗ | ✗ | ✗ |

---

## Constraints

- Quick Start mode asks **exactly 3** questions. Adding a 4th question is a spec violation.
- The completion message (Phase QS5) appears in **both** Quick Start and Advanced mode.
- The `--advanced` flag preserves all existing behavior. No existing phase is modified.
- Telemetry is **not** included in this implementation (deferred to PRD-002).
