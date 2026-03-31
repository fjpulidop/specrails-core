# Setup: Agent Workflow System

Interactive wizard to configure the full agent workflow system for this repository. Analyzes the codebase, discovers target users, generates VPC personas, and creates all agents, commands, rules, and configuration adapted to this project.

**Prerequisites:** Run `specrails/install.sh` first to install templates.

---

## Mode Detection

Check `$ARGUMENTS` in this order:

1. If `--update` is present → execute **Update Mode** (below), then stop. Do NOT continue to Phase 1 or Lite Mode.
2. If `--lite` is present → execute **Lite Mode** (below), then stop. Do NOT execute Phase 1.
3. Otherwise (no flags) → skip directly to **Phase 1** and execute the full 5-phase wizard.

**Default is the full wizard.** Lite Mode only runs when `--lite` is explicitly passed.

---

## Update Mode

When `--update` is passed, execute this streamlined flow instead of the full wizard. Do not run any phases from the full wizard. When Phase U7 is complete, stop.

### Phase U1: Read Update Context

Read the following files to understand the current installation state:

1. Read `.specrails-manifest.json` — contains agent template checksums from the last install/update. Structure:
   ```json
   {
     "version": "0.2.0",
     "installed_at": "2025-01-15T10:00:00Z",
     "artifacts": {
       "templates/agents/architect.md": "sha256:<checksum>",
       "templates/agents/developer.md": "sha256:<checksum>",
       "templates/agents/reviewer.md": "sha256:<checksum>"
     }
   }
   ```
   If this file does not exist, inform the user:
   > "No `.specrails-manifest.json` found. This looks like a pre-versioning installation. Run `update.sh` first to initialize the manifest, then re-run `/specrails:setup --update`."
   Then stop.

2. Read `.specrails-version` — contains the current version string (e.g., `0.2.0`). If it does not exist, treat version as `0.1.0 (legacy)`.

3. Determine `$SPECRAILS_DIR` by reading `$SPECRAILS_DIR/setup-templates/.provider-detection.json` — try `.claude/setup-templates/.provider-detection.json` first, then `.codex/setup-templates/.provider-detection.json`. Extract `cli_provider` and `specrails_dir`. If not found, default to `cli_provider = "claude"`, `specrails_dir = ".claude"`.

4. List all template files in `$SPECRAILS_DIR/setup-templates/agents/` — these are the NEW agent templates from the update:
   ```bash
   ls $SPECRAILS_DIR/setup-templates/agents/
   ```
   Template files are named with `sr-` prefix (e.g., `sr-architect.md`, `sr-developer.md`).

5. List all template files in `$SPECRAILS_DIR/setup-templates/commands/specrails/` — these are the NEW command templates from the update:
   ```bash
   ls $SPECRAILS_DIR/setup-templates/commands/specrails/
   ```
   Command template files include `implement.md`, `batch-implement.md`, `compat-check.md`, `refactor-recommender.md`, `why.md`, `get-backlog-specs.md`, `auto-propose-backlog-specs.md`.
   If this directory does not exist, skip command template checking for this update.

6. Read `$SPECRAILS_DIR/backlog-config.json` if it exists — contains stored provider configuration needed for command placeholder substitution.

### Phase U2: Quick Codebase Re-Analysis

Perform the same analysis as Phase 1 of the full setup wizard, but silently — do not prompt the user and do not show the findings table. Just execute and store results internally.

Detect:
- **Languages**: Check for `*.py`, `*.ts`, `*.tsx`, `*.go`, `*.rs`, `*.java`, `*.kt`, `*.rb`, `*.cs`
- **Frameworks**: Search for imports (`fastapi`, `express`, `react`, `vue`, `angular`, `django`, `spring`, `gin`, `actix`, `rails`)
- **Directory structure**: Identify backend/frontend/core/test directories
- **Database**: Check for SQL files, ORM configs, migration directories
- **CI/CD**: Parse `.github/workflows/*.yml` for lint/test/build commands
- **Naming conventions**: Read 2-3 source files per detected layer

Read:
- `README.md` (if exists)
- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml` (detect stack)
- `.github/workflows/*.yml` (detect CI commands)

Store all results for use in Phases U4 and U5.

### Phase U3: Identify What Needs Regeneration

**Agent templates:** For each agent template, find its entry in the manifest's `artifacts` map (keyed as `templates/agents/sr-<name>.md`). Compute the SHA-256 checksum of the corresponding file in `.claude/setup-templates/agents/`:

```bash
sha256sum .claude/setup-templates/agents/sr-<name>.md
```

Build three lists for agents:

1. **Changed agents**: agent name exists in manifest AND the current template checksum differs from the manifest checksum → mark for regeneration
2. **New agents**: template file exists in `.claude/setup-templates/agents/` but the agent name is NOT in the manifest → mark for evaluation
3. **Unchanged agents**: agent name exists in manifest AND checksum matches → skip

**Command templates:** If `.claude/setup-templates/commands/specrails/` exists, for each command template file, find its entry in the manifest's `artifacts` map (keyed as `templates/commands/specrails/<name>.md`). Compute the SHA-256 checksum of the corresponding file in `.claude/setup-templates/commands/specrails/`:

```bash
sha256sum .claude/setup-templates/commands/specrails/<name>.md
```

Build three lists for commands:

1. **Changed commands**: command name exists in manifest AND the current template checksum differs from the manifest checksum → mark for update
2. **New commands**: template file exists in `.claude/setup-templates/commands/specrails/` but the command name is NOT in the manifest → mark for evaluation
3. **Unchanged commands**: command name exists in manifest AND checksum matches → skip

Display the combined analysis to the user:

```
## Update Analysis

### Agents — Changed Templates (will be regenerated)
- sr-architect.md (template modified)
- sr-developer.md (template modified)

### Agents — New Templates Available
- sr-frontend-developer.md
- sr-backend-developer.md

### Agents — Unchanged (keeping current)
- sr-reviewer.md
- sr-product-manager.md

### Commands — Changed Templates (will be updated)
- implement.md (template modified)

### Commands — New Templates Available
- refactor-recommender.md

### Commands — Unchanged (keeping current)
- compat-check.md
- why.md
```

If there are no changed agents, no new agents, no changed commands, and no new commands, display:
```
All agents and commands are already up to date. Nothing to regenerate.
```
Then jump to Phase U7.

### Phase U4: Regenerate Changed Agents

For each agent in the "changed" list:

1. Read the NEW template from `$SPECRAILS_DIR/setup-templates/agents/sr-<name>.md`
2. Use the codebase analysis from Phase U2 to fill in all `{{PLACEHOLDER}}` values, using the same substitution rules as Phase 4.1 of the full setup:
   - `{{PROJECT_NAME}}` → project name (from README.md or directory name)
   - `{{ARCHITECTURE_DIAGRAM}}` → detected architecture layers
   - `{{LAYER_TAGS}}` → detected layer tags (e.g., `[backend]`, `[frontend]`, `[api]`)
   - `{{CI_COMMANDS_BACKEND}}` → backend CI commands
   - `{{CI_COMMANDS_FRONTEND}}` → frontend CI commands
   - `{{LAYER_CONVENTIONS}}` → detected conventions per layer
   - `{{PERSONA_NAMES}}` → read existing persona names from `$SPECRAILS_DIR/agents/personas/` filenames
   - `{{PERSONA_FILES}}` → paths to existing persona files in `$SPECRAILS_DIR/agents/personas/`
   - `{{DOMAIN_EXPERTISE}}` → infer from detected stack and README
   - `{{KEY_FILE_PATHS}}` → important file paths detected in Phase U2
   - `{{WARNINGS}}` → read from existing `CLAUDE.md` if present
   - `{{MEMORY_PATH}}` → `$SPECRAILS_DIR/agent-memory/sr-<agent-name>/`
3. Write the adapted agent using the format for the active provider (same dual-format rules as Phase 4.1):
   - `cli_provider == "claude"`: write to `$SPECRAILS_DIR/agents/sr-<name>.md` (Markdown with YAML frontmatter)
   - `cli_provider == "codex"`: write to `$SPECRAILS_DIR/agents/sr-<name>.toml` (TOML format with `name`, `description`, `model`, `prompt` fields)
4. Show: `✓ Regenerated sr-<name>`

After regenerating all changed agents, verify no unresolved placeholders remain:
```bash
# Claude Code
grep -r '{{[A-Z_]*}}' .claude/agents/sr-*.md 2>/dev/null || echo "OK: no broken placeholders"
# Codex
grep -r '{{[A-Z_]*}}' .codex/agents/sr-*.toml 2>/dev/null || echo "OK: no broken placeholders"
```

### Phase U4b: Update Changed Commands

For each command in the "changed commands" list from Phase U3:

1. Read the NEW template:
   - If `cli_provider == "claude"`: from `$SPECRAILS_DIR/setup-templates/commands/specrails/<name>.md`
   - If `cli_provider == "codex"`: from `$SPECRAILS_DIR/setup-templates/skills/sr-<name>/SKILL.md`
2. Read stored backlog configuration from `$SPECRAILS_DIR/backlog-config.json` (if it exists) to resolve provider-specific placeholders:
   - `BACKLOG_PROVIDER` → `provider` field (`github`, `jira`, or `none`)
   - `BACKLOG_WRITE` → `write_access` field
   - `JIRA_BASE_URL` → `jira_base_url` field
   - `JIRA_PROJECT_KEY` → `jira_project_key` field
3. Substitute all `{{PLACEHOLDER}}` values using the same rules as Phase 4.3 of the full setup:
   - `{{CI_COMMANDS_BACKEND}}` → backend CI commands detected in Phase U2
   - `{{CI_COMMANDS_FRONTEND}}` → frontend CI commands detected in Phase U2
   - `{{DEPENDENCY_CHECK_COMMANDS}}` → stack-specific dependency check commands from Phase U2
   - `{{TEST_RUNNER_CHECK}}` → test runner commands from Phase U2
   - `{{BACKLOG_FETCH_CMD}}` → provider-specific fetch command from backlog config
   - `{{BACKLOG_CREATE_CMD}}` → provider-specific create command from backlog config
   - `{{BACKLOG_VIEW_CMD}}` → provider-specific view command from backlog config
   - `{{BACKLOG_PREFLIGHT}}` → provider-specific preflight check from backlog config
   - Any other `{{PLACEHOLDER}}` values → use Phase U2 analysis data
4. Write the updated file:
   - If `cli_provider == "claude"`: to `.claude/commands/specrails/<name>.md`
   - If `cli_provider == "codex"`: to `.agents/skills/sr-<name>/SKILL.md`
5. Show:
   - If `cli_provider == "claude"`: `✓ Updated /specrails:<name>`
   - If `cli_provider == "codex"`: `✓ Updated $sr-<name>`

After updating all changed commands/skills, verify no unresolved placeholders remain:
```bash
# If cli_provider == "claude":
grep -l '{{[A-Z_]*}}' .claude/commands/specrails/*.md 2>/dev/null || echo "OK: no broken placeholders"
# If cli_provider == "codex":
grep -rl '{{[A-Z_]*}}' .agents/skills/sr-*/SKILL.md 2>/dev/null || echo "OK: no broken placeholders"
```
If any placeholders remain unresolved, warn the user:
> "⚠ Some placeholders in `<filename>` could not be resolved automatically. Please review the file and fill them in manually."

### Phase U5: Evaluate New Agents

For each agent in the "new" list:

1. Read the template from `.claude/setup-templates/agents/sr-<name>.md` to understand what stack or layer it targets (read its description and any layer-specific comments)
2. Match against the codebase detected in Phase U2:
   - If the template targets a layer/stack that IS present (e.g., `sr-frontend-developer` and React was detected), prompt:
     > "New agent available: `sr-<name>` — your project uses [detected tech]. Add it? [Y/n]"
   - If the template targets a layer/stack that is NOT present (e.g., `sr-backend-developer` and no backend was detected), prompt:
     > "New agent available: `sr-<name>` — no [layer] detected in your project. Skip? [Y/n]"
3. If the user accepts (or presses Enter on a pre-selected default):
   - Generate the agent using the same template adaptation as Phase U4
   - Create memory directory if it does not exist: `$SPECRAILS_DIR/agent-memory/sr-<name>/`
   - Show: `✓ Added sr-<name>`
4. If the user declines:
   - Show: `→ Skipped sr-<name>`

For each command in the "new commands" list from Phase U3:

1. Read the template:
   - If `cli_provider == "claude"`: from `$SPECRAILS_DIR/setup-templates/commands/specrails/<name>.md`
   - If `cli_provider == "codex"`: from `$SPECRAILS_DIR/setup-templates/skills/sr-<name>/SKILL.md`
2. Prompt the user:
   - If `cli_provider == "claude"`: `"New command available: /specrails:<name> — [one-line description]. Install it? [Y/n]"`
   - If `cli_provider == "codex"`: `"New skill available: $sr-<name> — [one-line description]. Install it? [Y/n]"`
3. If the user accepts (or presses Enter):
   - Apply placeholder substitution using the same rules as Phase U4b (backlog config + codebase analysis)
   - If `cli_provider == "claude"`: write to `.claude/commands/specrails/<name>.md` — show `✓ Added /specrails:<name>`
   - If `cli_provider == "codex"`: write to `.agents/skills/sr-<name>/SKILL.md` — show `✓ Added $sr-<name>`
4. If the user declines:
   - If `cli_provider == "claude"`: show `→ Skipped /specrails:<name>`
   - If `cli_provider == "codex"`: show `→ Skipped $sr-<name>`

### Phase U6: Update Workflow Commands

If any new agents were added in Phase U5:

1. Read the implement command/skill:
   - If `cli_provider == "claude"`: `.claude/commands/specrails/implement.md`
   - If `cli_provider == "codex"`: `.agents/skills/sr-implement/SKILL.md`
2. Check if the file references agent names in its orchestration steps (look for `sr-architect`, `sr-developer`, `sr-reviewer` etc.)
3. If newly added agents belong in the implementation pipeline (i.e., they are layer-specific developers such as `sr-frontend-developer` or `sr-backend-developer`), add them to the appropriate step in the implement command — specifically where parallel developer agents are launched
4. Write the updated file if any changes were made:
   - If `cli_provider == "claude"`: `.claude/commands/specrails/implement.md`
   - If `cli_provider == "codex"`: `.agents/skills/sr-implement/SKILL.md`
5. Show which commands were updated, or "No command updates needed" if nothing changed

This is a lightweight check — only update commands where the sr- agent clearly belongs. Do not restructure the entire command.

### Phase U7: Summary

Display the final summary and stop. Do not continue to Phase 1 of the full setup wizard.

```
## Update Complete

specrails updated from v<previous> to v<new>.

| Action              | Count |
|---------------------|-------|
| Agents regenerated  | N     |
| Agents added        | N     |
| Agents skipped      | N     |
| Commands updated    | N     |
| Commands added      | N     |
| Commands skipped    | N     |

All agents and commands are now up to date.

### Agents Regenerated
[list agent names, or "(none)"]

### Agents Added
[list agent names, or "(none)"]

### Agents Skipped
[list agent names, or "(none)"]

### Commands Updated
[list command names, or "(none)"]

### Commands Added
[list command names, or "(none)"]

### Commands Skipped
[list command names, or "(none)"]
```

Update `.specrails-manifest.json` to reflect the new checksums for all regenerated/updated and added agents and commands:
- For each regenerated agent: update its checksum entry to the new template's checksum (keyed as `templates/agents/sr-<name>.md`)
- For each added agent: add a new entry with its checksum
- For each updated command: update its checksum entry to the new template's checksum (keyed as `templates/commands/specrails/<name>.md`)
- For each added command: add a new entry with its checksum
- Update the `version` field to the version read from `.specrails-version`

---

## Lite Mode

When `--lite` is passed, run this streamlined 3-question setup. Do NOT run Phase 1–5. When QS4 is complete, stop.

### QS1: Ask the 3 questions

Display the following prompt EXACTLY ONCE and then wait for the user's responses. Do NOT repeat the questions — output them a single time only.

Welcome to specrails! Let's get your AI agent team set up in 3 quick questions.

1. What is this project? (one sentence)
2. Who are the target users?
3. Git access for agents — read-only or read-write?
   (read-only = agents can read and suggest; read-write = agents can commit)

Store the answers as:
- `QS_PROJECT_DESCRIPTION` — answer to question 1
- `QS_TARGET_USERS` — answer to question 2
- `QS_GIT_ACCESS` — "read-only" or "read-write" (normalize if user types "ro", "rw", "readonly", etc.)

### QS2: Apply opinionated defaults

Use these defaults for all configuration not asked in QS1:

| Setting | Lite Mode Default |
|---------|------------------|
| Agents enabled | sr-architect, sr-developer, sr-reviewer, sr-product-manager |
| Git mode | Derived from QS_GIT_ACCESS |
| CLAUDE.md template | `templates/CLAUDE-quickstart.md` |
| OpenSpec enabled | Yes if `openspec` CLI is detected in PATH, No otherwise |
| Telemetry | Not configured (deferred to PRD-002) |
| Backlog provider | local (lightweight JSON-based, no external tools needed) |

Detect whether this is an existing codebase or new project:
- **Existing codebase**: `package.json`, `Gemfile`, `pyproject.toml`, `go.mod`, or `pom.xml` found in the repo root
- **New project**: none of the above found

Store as `QS_IS_EXISTING_CODEBASE=true/false`.

### QS2.5: Re-run Detection

Before generating files, check if this is a re-run:

1. Check if commands/skills already exist:
   - If `cli_provider == "claude"`: check if `.claude/commands/specrails/` directory exists with any `.md` files:
     ```bash
     ls .claude/commands/specrails/*.md 2>/dev/null
     ```
   - If `cli_provider == "codex"`: check if `.agents/skills/sr-*/SKILL.md` files exist:
     ```bash
     ls .agents/skills/sr-*/SKILL.md 2>/dev/null
     ```
2. If files are found → this is a **re-run**. Store `QS_IS_RERUN=true`.
3. If the directory does not exist or is empty → this is a **fresh install**. Store `QS_IS_RERUN=false`.

In re-run mode, QS3 executes in **gap-fill mode** for command/skill files:
- For each command in the list, check if it already exists:
  - If `cli_provider == "claude"`: at `.claude/commands/specrails/<name>.md`
  - If `cli_provider == "codex"`: at `.agents/skills/sr-<name>/SKILL.md`
- If it exists: skip it and show:
  - Claude: `✓ Already installed: /specrails:<name>`
  - Codex: `✓ Already installed: $sr-<name>`
- If it does NOT exist: install it and show:
  - Claude: `✓ Added /specrails:<name> (was missing)`
  - Codex: `✓ Added $sr-<name> (was missing)`
- Do NOT prompt the user for confirmation on missing files — install them automatically

For CLAUDE.md/AGENTS.md and agent files, the existing per-file prompts already handle re-runs (user is asked before overwriting). No change needed there.

### QS3: Generate files

Generate files using the Lite Mode defaults.

**1. CLAUDE.md**

Read `setup-templates/claude-md/CLAUDE-quickstart.md` (or fall back to `setup-templates/claude-md/default.md` if quickstart template is not found).

Replace placeholders:
- `{{PROJECT_NAME}}` → derive from directory name or README.md first heading
- `{{PROJECT_DESCRIPTION}}` → `QS_PROJECT_DESCRIPTION`
- `{{TARGET_USERS}}` → `QS_TARGET_USERS`
- `{{GIT_ACCESS}}` → `QS_GIT_ACCESS`

Write to `CLAUDE.md` in the repo root. If `CLAUDE.md` already exists, ask:
> "CLAUDE.md already exists. Overwrite? [Y/n]"
Skip if user says no.

**2. Agent files**

For each default agent (sr-architect, sr-developer, sr-reviewer, sr-product-manager), read the template from `$SPECRAILS_DIR/setup-templates/agents/<name>.md` and generate the adapted agent file using the dual-format rules from Phase 4.1:
- `cli_provider == "claude"`: write to `.claude/agents/<name>.md` (Markdown with frontmatter)
- `cli_provider == "codex"`: write to `.codex/agents/<name>.toml` (TOML format)

Fill placeholders with best-effort values from the limited context available:
- `{{PROJECT_NAME}}` → directory name or README first heading
- `{{PROJECT_DESCRIPTION}}` → `QS_PROJECT_DESCRIPTION`
- `{{TARGET_USERS}}` → `QS_TARGET_USERS`
- `{{GIT_ACCESS}}` → `QS_GIT_ACCESS`
- `{{ARCHITECTURE_DIAGRAM}}` → "(Lite Mode — run `/specrails:setup` for full architecture analysis)"
- `{{TECH_EXPERTISE}}` → "(Lite Mode — run `/specrails:setup` for codebase-specific expertise)"
- `{{LAYER_TAGS}}` → detect from package.json / Gemfile / go.mod if present; otherwise leave empty
- All other placeholders → "(not configured — run `/specrails:setup`)"

Create memory directories: `$SPECRAILS_DIR/agent-memory/sr-<name>/`

**3. Command files**

Core commands (always install if missing):
- `implement.md`
- `batch-implement.md`
- `propose-spec.md`
- `compat-check.md`
- `why.md`
- `get-backlog-specs.md`
- `auto-propose-backlog-specs.md`

**Initialize local ticket storage** (backlog provider defaults to `local`):
1. Copy `templates/local-tickets-schema.json` to `$SPECRAILS_DIR/local-tickets.json` and set `last_updated` to the current ISO-8601 timestamp. Skip if the file already exists.
2. Write `$SPECRAILS_DIR/backlog-config.json` (skip if already exists):
   ```json
   {
     "provider": "local",
     "write_access": true,
     "git_auto": true
   }
   ```

**If `cli_provider == "claude"`:**

If `QS_IS_RERUN=false` (fresh install): for each core command, read the template from `$SPECRAILS_DIR/setup-templates/commands/specrails/<name>.md`, substitute the backlog placeholders with local values (using the same table as Phase 4.3 "Local Tickets"), stub all persona placeholders with `(Lite Mode — run /specrails:setup to configure personas)`, then write to `.claude/commands/specrails/<name>.md`.

If `QS_IS_RERUN=true` (gap-fill mode): for each command in the list above, check if `.claude/commands/specrails/<name>.md` already exists:
- If it exists: skip it — show `✓ Already installed: /specrails:<name>`
- If it does NOT exist: read template, substitute placeholders as above, write to `.claude/commands/specrails/<name>.md` — show `✓ Added /specrails:<name> (was missing)`

**If `cli_provider == "codex"`:**

If `QS_IS_RERUN=false` (fresh install): for each core command, read the corresponding skill template from `$SPECRAILS_DIR/setup-templates/skills/sr-<name>/SKILL.md`, substitute the backlog placeholders with local values and stub persona placeholders with `(Lite Mode — run /specrails:setup to configure personas)`, then write to `.agents/skills/sr-<name>/SKILL.md` (create the directory first).

If `QS_IS_RERUN=true` (gap-fill mode): for each command in the list above, check if `.agents/skills/sr-<name>/SKILL.md` already exists:
- If it exists: skip it — show `✓ Already installed: $sr-<name>`
- If it does NOT exist: read template, substitute placeholders as above, write to `.agents/skills/sr-<name>/SKILL.md` — show `✓ Added $sr-<name> (was missing)`

**4. Cleanup**

Remove `setup-templates/` from `.claude/` (same as full wizard cleanup in Phase 5).

Remove `commands/setup.md` from `.claude/commands/` if it was copied there by the installer.

### QS4: First Task Prompt

After generating all files, display the setup complete message.

Then, based on `QS_IS_EXISTING_CODEBASE`:
- **Existing codebase** (`true`): recommend `/specrails:refactor-recommender`
- **New project** (`false`): recommend `/specrails:get-backlog-specs`

If `QS_IS_RERUN=false`, display:
```
✅ Setup complete.

Try your first command:
  > /specrails:get-backlog-specs
```
(Replace `/specrails:get-backlog-specs` with `/specrails:refactor-recommender` for existing codebases.)

If `QS_IS_RERUN=true`, display the gap-fill summary and stop:
```
✅ Re-run complete.

Commands status:
  ✓ Already installed: /specrails:<name>
  ✓ Added /specrails:<name> (was missing)
  [... one line per command ...]

All commands are up to date.
```
If all commands were already present, display:
```
✅ Re-run complete. All commands already installed — nothing to add.
```

Then stop. Do not execute Phase 1.

---

## Phase 1: Codebase Analysis

Analyze the repository to understand its architecture, stack, and conventions.

### 1.1 Read project structure

```bash
# Get the repo root and basic info
git rev-parse --show-toplevel
ls -la
```

Read the following to understand the project:
- `README.md` (if exists)
- `CLAUDE.md` (if exists — don't overwrite, merge later)
- `package.json` or `pyproject.toml` or `Cargo.toml` or `go.mod` or `pom.xml` (detect stack)
- `.github/workflows/*.yml` (detect CI commands)
- `docker-compose.yml` or `Dockerfile` (detect infra)

### 1.2 Detect architecture layers

Use Glob and Grep to identify:

1. **Languages**: Check for `*.py`, `*.ts`, `*.tsx`, `*.go`, `*.rs`, `*.java`, `*.kt`, `*.rb`, `*.cs`
2. **Frameworks**: Search for imports (`fastapi`, `express`, `react`, `vue`, `angular`, `django`, `spring`, `gin`, `actix`, `rails`)
3. **Directory structure**: Identify backend/frontend/core/test directories
4. **Database**: Check for SQL files, ORM configs, migration directories
5. **CI/CD**: Parse workflow files for lint/test/build commands

### 1.3 Infer conventions

Read 3-5 representative source files from each detected layer to understand:
- Naming conventions (camelCase, snake_case, PascalCase)
- Import patterns
- Error handling patterns
- Testing patterns (framework, structure, mocking approach)
- API patterns (REST, GraphQL, tRPC)

### 1.4 Present findings

Display the detected architecture to the user:

```
## Codebase Analysis

| Layer       | Tech                | Path          |
|-------------|---------------------|---------------|
| Backend     | FastAPI (Python)    | backend/      |
| Frontend    | React + TypeScript  | frontend/     |
| Core        | Python package      | src/          |
| Tests       | pytest              | tests/        |
| Database    | PostgreSQL          | migrations/   |

### CI Commands Detected
- Lint: `ruff check .`
- Format: `ruff format --check .`
- Test: `pytest tests/ -q`
- Frontend lint: `npm run lint`
- Frontend build: `npx tsc --noEmit`

### Conventions Detected
- Python: snake_case, type hints, Pydantic models
- TypeScript: strict mode, functional components
- Testing: pytest fixtures with scope="function"

### OSS Project Detection

Read `.claude/setup-templates/.oss-detection.json` if it exists.

| Signal | Status |
|--------|--------|
| Public repository | [Yes / No / Unknown] |
| CI workflows (.github/workflows/) | [Yes / No] |
| CONTRIBUTING.md | [Yes / No] |
| **Result** | **OSS detected / Not detected / Could not check** |

If `is_oss: false` but at least one signal is `true`:
> "Some OSS signals were found but not all three. Is this an open-source project? (yes/no)"

If `.oss-detection.json` does not exist:
> "Is this an open-source project? (yes/no)"

When `IS_OSS=false` and no signals are present, skip OSS output entirely to avoid cluttering the display for non-OSS projects.

Store the final OSS determination as `IS_OSS` for use throughout the rest of setup.

[Confirm] [Modify] [Rescan]
```

Wait for user confirmation. If they want to modify, ask what to change.

---

## Phase 2: User Personas & Product Discovery

### 2.1 Ask about target users

Ask the user:

> If IS_OSS=true, prepend:
> "This is an OSS project. The **Maintainer** persona (Kai) is automatically included —
> you do not need to add 'open-source maintainers' to your list.
> Describe your other target user types below."

> **Who are the target users of your software?**
>
> Describe them in natural language. Examples:
> - "Developers who manage Kubernetes clusters"
> - "Small business owners tracking inventory and sales"
> - "Gamers who collect and trade digital items"
>
> I'll research the competitive landscape and create detailed personas
> with Value Proposition Canvas profiles for each user type.
>
> **How many distinct user types do you have?** (typically 2-3)

Wait for the user's response.

### 2.2 Research competitive landscape

For each user type described, use WebSearch to research:

1. **Existing tools** they use today (competitors)
2. **Common pain points** reported in forums, Reddit, product reviews
3. **Feature gaps** in current tools
4. **Unmet needs** and workflow frustrations

Search queries to use (adapt to the domain):
- `"[domain] [user type] best tools 2025"`
- `"[domain] [user type] pain points frustrations"`
- `"[competitor name] missing features complaints"`
- `"[domain] management app feature comparison"`
- `site:reddit.com "[domain] [user type] what tool do you use"`

### 2.3 Generate VPC personas

For each user type, generate a full Value Proposition Canvas persona file following the template at `.claude/setup-templates/personas/persona.md`.

Each persona must include:
- **Profile**: Demographics, behaviors, tools used, spending patterns
- **Customer Jobs**: Functional, social, emotional (6-8 jobs)
- **Pains**: Graded by severity (Critical > High > Medium > Low) with 6-8 entries
- **Gains**: Graded by impact (High > Medium > Low) with 6-8 entries
- **Key Insight**: The #1 unmet need that this project can address
- **Sources**: Links to competitive analysis, forums, reviews used in research

### 2.4 Present personas

Display each generated persona to the user:

```
## Generated Personas

### Persona 1: "[Nickname]" — The [Role]
- Age: X-Y
- Key pain: [Critical pain]
- Key insight: [Main unmet need]

### Persona 2: "[Nickname]" — The [Role]
- Age: X-Y
- Key pain: [Critical pain]
- Key insight: [Main unmet need]

[Accept] [Edit] [Regenerate]
```

Wait for confirmation. If the user wants edits, apply them.

---

## Phase 3: Configuration

### 3.1 Agents to install

Present the available agents and let the user choose:

```
## Agent Selection

Which agents do you want to install?

| Agent | Purpose | Model | Required |
|-------|---------|-------|----------|
| sr-architect | Design features, create implementation plans | Sonnet | Yes |
| sr-developer (full-stack) | Implement features across all layers | Sonnet | Yes |
| sr-reviewer | CI/CD quality gate, fix issues | Sonnet | Yes |
| sr-test-writer | Generate unit, integration, and edge-case tests after implementation | Sonnet | Yes |
| sr-security-reviewer | Scan for secrets, OWASP vulnerabilities, hardcoded credentials | Sonnet | Yes |
| sr-product-manager | Product discovery, ideation, VPC evaluation | Opus | Recommended |
| sr-product-analyst | Read-only backlog analysis | Haiku | Recommended |
| sr-backend-developer | Specialized backend implementation | Sonnet | If backend layer exists |
| sr-frontend-developer | Specialized frontend implementation | Sonnet | If frontend layer exists |

[All] [Required only] [Custom selection]
```

### 3.2 Backlog provider

Ask the user how they want to manage their product backlog. Default is local — no external tools or accounts required:

```
## Backlog Provider

Use local ticket management or connect an external provider?

1. **Local tickets** (default, recommended) — lightweight JSON-based ticket management built into the project.
   No external tools or accounts required. Tickets stored in `.specrails/local-tickets.json`, version-controlled and diffable.
2. **External provider** — connect GitHub Issues, JIRA, or disable backlog commands
```

If the user selects **1** or presses Enter without typing anything: set `BACKLOG_PROVIDER=local` and proceed directly to **If Local Tickets** below. Do NOT ask about GitHub CLI, JIRA credentials, or any external provider configuration.

If the user selects **2**: display the secondary menu:

```
## External Backlog Provider

Which external provider?

1. **Local tickets** (recommended) — lightweight JSON-based ticket management built into the project.
   No external tools required. Tickets stored in `.specrails/local-tickets.json`, version-controlled and diffable.
2. **GitHub Issues** — uses `gh` CLI to read/create issues with labels and VPC scores
3. **JIRA** — uses JIRA CLI or REST API to read/create tickets in a JIRA project
4. **None** — skip backlog commands (you can still use /implement with text descriptions)
```

Wait for the user's choice. Set `BACKLOG_PROVIDER` to `local`, `github`, `jira`, or `none`.

#### If Local Tickets

No external tools or credentials required. Initialize the storage file:

1. Copy `templates/local-tickets-schema.json` to `$SPECRAILS_DIR/local-tickets.json`
2. Set `last_updated` to the current ISO-8601 timestamp

Store configuration in `$SPECRAILS_DIR/backlog-config.json`:
```json
{
  "provider": "local",
  "write_access": true,
  "git_auto": true
}
```

Local tickets are always read-write — there is no "read only" mode since the file is local.

**Ticket schema** — each entry in the `tickets` map has these fields:

```json
{
  "id": 1,
  "title": "Feature title",
  "description": "Markdown description",
  "status": "todo",
  "priority": "medium",
  "labels": ["area:frontend", "effort:medium"],
  "assignee": null,
  "prerequisites": [],
  "metadata": {
    "vpc_scores": {},
    "effort_level": "Medium",
    "user_story": "",
    "area": ""
  },
  "comments": [],
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "created_by": "user",
  "source": "manual"
}
```

**Status values:** `todo`, `in_progress`, `done`, `cancelled`
**Priority values:** `critical`, `high`, `medium`, `low`
**Labels:** Freeform strings following the `area:*` and `effort:*` convention
**Source values:** `manual`, `get-backlog-specs`, `propose-spec`

**Advisory file locking protocol** (CLI agents and hub server must both follow this):

The `revision` counter in the JSON root enables optimistic concurrency — increment it on **every** write. The lock file prevents concurrent corruption:

1. **Acquire lock:** Check for `$SPECRAILS_DIR/local-tickets.json.lock`
   - If the file exists and its `timestamp` is less than 30 seconds old: wait 500ms and retry (max 5 attempts before aborting with an error)
   - If the file exists and its `timestamp` is 30+ seconds old (stale): delete it and proceed
   - If no lock file exists: proceed immediately
2. **Create lock file:** Write `{"agent": "<agent-name-or-process>", "timestamp": "<ISO-8601>"}` to `$SPECRAILS_DIR/local-tickets.json.lock`
3. **Minimal lock window:** Read the JSON → modify in memory → write back → release
4. **Release lock:** Delete `$SPECRAILS_DIR/local-tickets.json.lock`
5. **Always increment `revision`** by 1 and update `last_updated` on every successful write

The hub server uses `proper-lockfile` (or equivalent) to honor the same protocol via the `.lock` file path.

#### If GitHub Issues

- Verify `gh auth status` works. If not, warn and offer to skip.
- Ask about **access mode**:

```
## GitHub Issues — Access Mode

How should we interact with GitHub Issues?

1. **Read & Write** (default) — read backlog, create new issues from product discovery,
   close resolved issues, add comments on partial progress
2. **Read only** — read backlog for prioritization, but don't create or modify issues.
   Product discovery will propose ideas as output but won't sync them to GitHub.
```

Set `BACKLOG_WRITE=true/false`.

- If write mode, ask if they want to create labels:
  - `product-driven-backlog` (purple) — product feature ideas
  - `area:*` labels for each detected layer/area
  - `enhancement`, `bug`, `tech-debt`

#### If JIRA

First, check if JIRA CLI is installed:

```bash
command -v jira &> /dev/null
```

If not installed, offer to install it:

> JIRA CLI is not installed. There are several options:
>
> 1. **go-jira** (recommended) — lightweight CLI
>    - macOS: `brew install go-jira`
>    - Linux/other: `go install github.com/go-jira/jira/cmd/jira@latest`
> 2. **Atlassian CLI** — official but heavier
>    - `npm install -g @atlassian/cli`
> 3. **Skip CLI, use REST API** — no CLI needed, uses `curl` with API token
>
> Which option? (1/2/3)

If the user chooses option 1 or 2, run the install command. If option 3, proceed with REST API mode.

Then ask for JIRA configuration:

> To connect to JIRA, I need:
>
> 1. **JIRA base URL** (e.g., `https://your-company.atlassian.net`)
> 2. **Project key** (e.g., `PROJ`, `DECK`, `MYAPP`)
> 3. **Authentication method**:
>    - **JIRA CLI** (`jira` command) — if already configured
>    - **API token** — stored in `.env` as `JIRA_API_TOKEN` and `JIRA_USER_EMAIL`
>
> Optional:
> - **Custom issue type** for backlog items (default: "Story")
> - **Custom fields** for VPC scores (or use labels/description)

Then ask about **access mode**:

```
## JIRA — Access Mode

How should we interact with JIRA?

1. **Read & Write** — read tickets for implementation context, create new tickets
   from product discovery, add a comment to tickets when implementation is complete
2. **Read only** — read tickets for implementation context, but never create or
   modify tickets. Product discovery will propose ideas as output only. After
   implementation, the pipeline will show what to update manually but won't
   touch JIRA.
```

Set `BACKLOG_WRITE=true/false`.

<!-- no separate template — this file IS the source (install.sh copies commands/setup.md directly) -->

#### Project Label

After the access mode selection, ask:

> **Project Label (optional but recommended)**
>
> JIRA teams often tag all tickets for a product with a project label
> (e.g., `PROJECT-specrails`, `PLATFORM`, `MOBILE`). This label is applied
> to every ticket the backlog pipeline creates — making it easy to filter all
> AI-generated backlog items across JIRA.
>
> Enter a project label, or press Enter to skip:

If the user enters a label: set `PROJECT_LABEL=<value>`.
If the user skips: set `PROJECT_LABEL=""`.

#### Epic Link Field

Ask:

> **Epic Link Field (optional — advanced)**
>
> JIRA Next-Gen (team-managed) projects link stories to epics using the `parent`
> field. JIRA Classic (company-managed) projects use `Epic Link` (customfield_10014).
>
> Which does your project use?
> 1. `parent` — Next-Gen / team-managed **(default)**
> 2. `customfield_10014` — Classic / company-managed

Set `EPIC_LINK_FIELD` to `parent` or `customfield_10014`. Default: `parent`.

Store the full configuration in `.specrails/backlog-config.json`:
```json
{
  "provider": "jira",
  "write_access": true,
  "jira_base_url": "https://your-company.atlassian.net",
  "jira_project_key": "PROJ",
  "issue_type": "Story",
  "auth_method": "api_token",
  "cli_installed": true,
  "project_label": "<PROJECT_LABEL or empty string>",
  "epic_link_field": "parent",
  "epic_mapping": {}
}
```

#### If None

- Skip `/specrails:get-backlog-specs` and `/specrails:auto-propose-backlog-specs` commands.
- The `/specrails:implement` command will still work with text descriptions.

### 3.3 Git & shipping workflow

Ask how the user wants to handle git operations after implementation:

```
## Git & Shipping

After implementation is complete, how should we handle shipping?

1. **Automatic** (default) — create branch, commit changes, push, and open a PR
   (requires GitHub CLI for PRs, otherwise prints a compare URL)
2. **Manual** — stop after implementation and review. You handle branching,
   committing, and PR creation yourself. The pipeline will show a summary
   of all changes but won't touch git.
```

Set `GIT_AUTO=true/false`.

If automatic, also check if `gh` is authenticated (for PR creation). If not, warn that PRs will be skipped but commits and push will still work.

### 3.4 Commands to install

```
## Command Selection

| Command | Purpose | Requires |
|---------|---------|----------|
| /specrails:implement | Full pipeline: sr-architect → sr-developer → sr-reviewer → ship | sr-architect + sr-developer + sr-reviewer |
| /specrails:batch-implement | Orchestrate multiple features in dependency-aware waves | sr-architect + sr-developer + sr-reviewer |
| /specrails:propose-spec | Interactively propose and refine a feature spec, then create a GitHub issue | GitHub CLI |
| /specrails:get-backlog-specs | View prioritized backlog with VPC scores | sr-product-analyst + Backlog provider |
| /specrails:auto-propose-backlog-specs | Generate new feature ideas via product discovery | sr-product-manager + Backlog provider |
| /specrails:compat-check | Snapshot API surface and detect breaking changes | None |
| /specrails:refactor-recommender | Scan for refactoring opportunities ranked by impact/effort | None |
| /specrails:why | Search past architectural decisions from agent memory | None |

[All] [Custom selection]
```

Note: If `BACKLOG_PROVIDER=none`, the backlog commands are not offered.

### 3.5 Confirm configuration

Display the full configuration summary including access modes:

```
## Configuration Summary

| Setting | Value |
|---------|-------|
| Backlog provider | GitHub Issues / JIRA / None |
| Backlog access | Read & Write / Read only |
| Project label (JIRA) | PROJECT-specrails / (none) |
| Epic link field (JIRA) | parent / customfield_10014 |
| Git workflow | Automatic / Manual |
| Agents | [list] |
| Commands | [list] |
| Personas | [count] personas |

Note: The `Project label (JIRA)` and `Epic link field (JIRA)` rows are only shown when `BACKLOG_PROVIDER=jira`.

[Confirm] [Modify]
```

Wait for final confirmation.

---

## Phase 4: Generate Files

Read each template from `.claude/setup-templates/` and generate the final files adapted to this project. Use the codebase analysis from Phase 1, personas from Phase 2, and configuration from Phase 3.

**Provider detection (required before any file generation):** Read `$SPECRAILS_DIR/setup-templates/.provider-detection.json` to determine `cli_provider` (`"claude"` or `"codex"`) and `specrails_dir` (`.claude` or `.codex`). All output paths in Phase 4 use `$SPECRAILS_DIR` as the base directory. If the file is missing, fall back to `cli_provider = "claude"` and `specrails_dir = ".claude"`.

### 4.1 Generate agents

For each selected agent, read the template and generate the adapted version.

**Template → Output mapping:**

**If `cli_provider == "claude"` (default):**
- `setup-templates/agents/sr-architect.md` → `.claude/agents/sr-architect.md`
- `setup-templates/agents/sr-developer.md` → `.claude/agents/sr-developer.md`
- `setup-templates/agents/sr-reviewer.md` → `.claude/agents/sr-reviewer.md`
- `setup-templates/agents/sr-test-writer.md` → `.claude/agents/sr-test-writer.md`
- `setup-templates/agents/sr-security-reviewer.md` → `.claude/agents/sr-security-reviewer.md`
- `setup-templates/agents/sr-product-manager.md` → `.claude/agents/sr-product-manager.md`
- `setup-templates/agents/sr-product-analyst.md` → `.claude/agents/sr-product-analyst.md`
- `setup-templates/agents/sr-backend-developer.md` → `.claude/agents/sr-backend-developer.md` (if backend layer)
- `setup-templates/agents/sr-frontend-developer.md` → `.claude/agents/sr-frontend-developer.md` (if frontend layer)

**If `cli_provider == "codex"`:**
- `setup-templates/agents/sr-architect.md` → `.codex/agents/sr-architect.toml`
- `setup-templates/agents/sr-developer.md` → `.codex/agents/sr-developer.toml`
- `setup-templates/agents/sr-reviewer.md` → `.codex/agents/sr-reviewer.toml`
- `setup-templates/agents/sr-test-writer.md` → `.codex/agents/sr-test-writer.toml`
- `setup-templates/agents/sr-security-reviewer.md` → `.codex/agents/sr-security-reviewer.toml`
- `setup-templates/agents/sr-product-manager.md` → `.codex/agents/sr-product-manager.toml`
- `setup-templates/agents/sr-product-analyst.md` → `.codex/agents/sr-product-analyst.toml`
- `setup-templates/agents/sr-backend-developer.md` → `.codex/agents/sr-backend-developer.toml` (if backend layer)
- `setup-templates/agents/sr-frontend-developer.md` → `.codex/agents/sr-frontend-developer.toml` (if frontend layer)

When generating each agent:
1. Read the template
2. Replace all `{{PLACEHOLDER}}` values with project-specific content:
   - `{{PROJECT_NAME}}` → project name
   - `{{ARCHITECTURE_DIAGRAM}}` → detected architecture
   - `{{LAYER_TAGS}}` → detected layer tags (e.g., `[backend]`, `[frontend]`, `[api]`, `[mobile]`)
   - `{{CI_COMMANDS_BACKEND}}` → backend CI commands from Phase 1
   - `{{CI_COMMANDS_FRONTEND}}` → frontend CI commands from Phase 1
   - `{{LAYER_CONVENTIONS}}` → detected conventions per layer
   - `{{PERSONA_NAMES}}` → names from generated personas
   - `{{PERSONA_FILES}}` → paths to persona files
   - `{{DOMAIN_EXPERTISE}}` → domain knowledge from Phase 2 research
   - `{{COMPETITIVE_LANDSCAPE}}` → competitors discovered in Phase 2
   - `{{KEY_FILE_PATHS}}` → important file paths detected in Phase 1
   - `{{WARNINGS}}` → project-specific warnings (from existing CLAUDE.md or detected)
   - `{{MEMORY_PATH}}` → agent memory directory path (e.g., `$SPECRAILS_DIR/agent-memory/sr-<agent-name>/`)
   - `{{TECH_EXPERTISE}}` → detected languages, frameworks, and test frameworks from Phase 1
   - `{{LAYER_CLAUDE_MD_PATHS}}` → comma-separated paths to per-layer rules files (e.g., `$SPECRAILS_DIR/rules/backend.md`, `$SPECRAILS_DIR/rules/frontend.md`)
   - `{{SECURITY_EXEMPTIONS_PATH}}` → `$SPECRAILS_DIR/security-exemptions.yaml`
3. Write the final file in the format for the active provider:

**If `cli_provider == "claude"`:** Write as Markdown with YAML frontmatter — the template file as-is (frontmatter preserved).

**If `cli_provider == "codex"`:** Convert to TOML format:
- Extract YAML frontmatter fields: `name`, `description`, `model`
- Extract the body content (everything after the closing `---` of the frontmatter)
- Map the `model` field: `sonnet` → `codex-mini-latest`, `opus` → `o3`, `haiku` → `codex-mini-latest`
- Write a `.toml` file with this structure:
  ```toml
  name = "<name from frontmatter>"
  description = "<description from frontmatter, escaped for TOML>"
  model = "codex-mini-latest"
  prompt = """
  <body content after placeholder substitution>
  """
  ```

### 4.2 Generate personas

If IS_OSS=true:
1. Copy `setup-templates/personas/the-maintainer.md` to `$SPECRAILS_DIR/agents/personas/the-maintainer.md`
2. Log: "Maintainer persona included"
3. Set MAINTAINER_INCLUDED=true for use in template substitution
4. Set `{{MAINTAINER_PERSONA_LINE}}` = `- \`$SPECRAILS_DIR/agents/personas/the-maintainer.md\` — "Kai" the Maintainer (open-source maintainer)`
5. Increment `{{PERSONA_COUNT}}` by 1 to account for the Maintainer

If IS_OSS=false:
- Set `{{MAINTAINER_PERSONA_LINE}}` = *(empty string)*

Then for each user-defined VPC persona from Phase 2.3:

Write each persona to `$SPECRAILS_DIR/agents/personas/`:
- Use the VPC personas generated in Phase 2
- File naming: kebab-case of persona nickname (e.g., `the-developer.md`, `the-admin.md`)

### 4.3 Generate commands / skills

For each selected command, read the template and adapt.

**If `cli_provider == "claude"` (default):**
- `setup-templates/commands/specrails/implement.md` → `.claude/commands/specrails/implement.md`
- `setup-templates/commands/specrails/batch-implement.md` → `.claude/commands/specrails/batch-implement.md`
- `setup-templates/commands/specrails/propose-spec.md` → `.claude/commands/specrails/propose-spec.md`
- `setup-templates/commands/specrails/get-backlog-specs.md` → `.claude/commands/specrails/get-backlog-specs.md` (if `BACKLOG_PROVIDER != none`)
- `setup-templates/commands/specrails/auto-propose-backlog-specs.md` → `.claude/commands/specrails/auto-propose-backlog-specs.md` (if `BACKLOG_PROVIDER != none`)
- `setup-templates/commands/specrails/compat-check.md` → `.claude/commands/specrails/compat-check.md`
- `setup-templates/commands/specrails/refactor-recommender.md` → `.claude/commands/specrails/refactor-recommender.md`
- `setup-templates/commands/specrails/why.md` → `.claude/commands/specrails/why.md`

**If `cli_provider == "codex"`:**
- `setup-templates/skills/sr-implement/SKILL.md` → `.agents/skills/sr-implement/SKILL.md`
- `setup-templates/skills/sr-batch-implement/SKILL.md` → `.agents/skills/sr-batch-implement/SKILL.md`
- `setup-templates/commands/specrails/propose-spec.md` → `.agents/skills/sr-propose-spec/SKILL.md` (wrap with YAML frontmatter if no skill template exists)
- `setup-templates/commands/specrails/get-backlog-specs.md` → `.agents/skills/sr-get-backlog-specs/SKILL.md` (if `BACKLOG_PROVIDER != none`; wrap with frontmatter)
- `setup-templates/commands/specrails/auto-propose-backlog-specs.md` → `.agents/skills/sr-auto-propose-backlog-specs/SKILL.md` (if `BACKLOG_PROVIDER != none`; wrap with frontmatter)
- `setup-templates/skills/sr-compat-check/SKILL.md` → `.agents/skills/sr-compat-check/SKILL.md`
- `setup-templates/skills/sr-refactor-recommender/SKILL.md` → `.agents/skills/sr-refactor-recommender/SKILL.md`
- `setup-templates/skills/sr-why/SKILL.md` → `.agents/skills/sr-why/SKILL.md`

**Codex skill frontmatter wrapping:** When a dedicated skill template does not exist in `setup-templates/skills/` for a command, generate the `SKILL.md` by prepending YAML frontmatter to the command content:
```yaml
---
name: sr-<name>
description: "<one-line description from the command's first heading>"
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---
```

For both providers, create the output directory before writing (`mkdir -p` for `.claude/commands/specrails/` or `.agents/skills/sr-<name>/`).

Adapt:
- CI commands to match detected stack
- **Persona references** to match generated personas (see substitution rules below)
- File paths to match project structure
- Layer tags to match detected layers
- **Backlog provider commands** based on `BACKLOG_PROVIDER`:

#### Backlog command persona placeholder substitution

When adapting `auto-propose-backlog-specs.md` and `get-backlog-specs.md`, substitute the persona placeholders based on the full persona set (user-generated personas + Maintainer if `IS_OSS=true`):

| Placeholder | Substitution rule |
|-------------|------------------|
| `{{PERSONA_FILE_READ_LIST}}` | One bullet per persona file: `- Read \`$SPECRAILS_DIR/agents/personas/{name}.md\`` |
| `{{PERSONA_SCORE_HEADERS}}` | Column headers for each persona nickname: e.g., `Alex \| Sara \| Kai` |
| `{{PERSONA_SCORE_SEPARATORS}}` | One `------` separator per persona column |
| `{{PERSONA_FIT_FORMAT}}` | Inline score display: e.g., `Alex: X/5, Sara: X/5, Kai: X/5` |
| `{{PERSONA_VPC_SECTIONS}}` | One VPC section block per persona (see format below) |
| `{{MAX_SCORE}}` | Total max score = 5 × number of personas (e.g., `15` for 3 personas) |
| `{{PERSONA_NAMES_WITH_ROLES}}` | Comma-separated: e.g., `Alex (Lead Dev), Sara (Product Founder), Kai (OSS Maintainer)` |

**`{{PERSONA_VPC_SECTIONS}}` format** — repeat for each persona in order:
```
### "{Nickname}" — The {Role} (X/5)
- **Jobs addressed**: {list}
- **Pains relieved**: {list with severity}
- **Gains created**: {list with impact}
```

**Kai inclusion rule**: When `IS_OSS=true`, Kai (`sr-the-maintainer.md`) is always the last entry in persona lists and the rightmost column in scoring tables. Kai uses the evaluation criteria defined in `.claude/agents/personas/sr-the-maintainer.md` — features score high (4-5/5) for Kai when they reduce async review burden, enforce project-specific conventions, or automate release/dependency coordination; features score low (0-1/5) when they add configuration complexity or require paid tiers.

**When `IS_OSS=false`**: All Kai-related persona references are omitted. `{{MAX_SCORE}}` reduces by 5. Tables and inline scores contain only user-generated personas.

#### Local Tickets (`BACKLOG_PROVIDER=local`)

For the local provider, backlog placeholders resolve to **inline file-operation instructions** embedded in the generated command markdown — not shell commands. Agents execute these by reading/writing `$SPECRAILS_DIR/local-tickets.json` directly using their file tools.

All write operations must follow the **advisory file locking protocol** defined in Phase 3.2. Always increment `revision` and update `last_updated` on every write.

| Placeholder | Substituted value |
|-------------|-------------------|
| `{{BACKLOG_PROVIDER_NAME}}` | `Local Tickets` |
| `{{BACKLOG_PREFLIGHT}}` | `[[ -f "$SPECRAILS_DIR/local-tickets.json" ]] && echo "Local tickets storage: OK" \|\| echo "WARNING: $SPECRAILS_DIR/local-tickets.json not found — run /specrails:setup to initialize"` |
| `{{BACKLOG_FETCH_CMD}}` | Read `$SPECRAILS_DIR/local-tickets.json`. Parse the `tickets` map and return all entries where `status` is `"todo"` or `"in_progress"`. |
| `{{BACKLOG_FETCH_ALL_CMD}}` | Read `$SPECRAILS_DIR/local-tickets.json`. Parse the `tickets` map and return all entries regardless of status. |
| `{{BACKLOG_FETCH_CLOSED_CMD}}` | Read `$SPECRAILS_DIR/local-tickets.json`. Parse the `tickets` map and return all entries where `status` is `"done"` or `"cancelled"`. |
| `{{BACKLOG_VIEW_CMD}}` | Read `$SPECRAILS_DIR/local-tickets.json`. Parse JSON and return the full ticket object at `tickets["{id}"]`, or an error if not found. |
| `{{BACKLOG_CREATE_CMD}}` | Write to `$SPECRAILS_DIR/local-tickets.json` using the advisory locking protocol: acquire lock → read file → set `id = next_id`, increment `next_id`, set all ticket fields, set `created_at` and `updated_at` to now, bump `revision`, update `last_updated` → write → release lock. |
| `{{BACKLOG_UPDATE_CMD}}` | Write to `$SPECRAILS_DIR/local-tickets.json` using the advisory locking protocol: acquire lock → read file → update fields in `tickets["{id}"]`, set `updated_at` to now, bump `revision`, update `last_updated` → write → release lock. |
| `{{BACKLOG_DELETE_CMD}}` | Write to `$SPECRAILS_DIR/local-tickets.json` using the advisory locking protocol: acquire lock → read file → delete `tickets["{id}"]`, bump `revision`, update `last_updated` → write → release lock. |
| `{{BACKLOG_COMMENT_CMD}}` | Write to `$SPECRAILS_DIR/local-tickets.json` using the advisory locking protocol: acquire lock → read file → append `{"author": "<agent-name>", "body": "<comment>", "created_at": "<ISO-8601>"}` to `tickets["{id}"].comments` (create the array if absent), set `updated_at` to now, bump `revision`, update `last_updated` → write → release lock. |
| `{{BACKLOG_PARTIAL_COMMENT_CMD}}` | Same as `{{BACKLOG_COMMENT_CMD}}` but append `{"author": "<agent-name>", "body": "<comment>", "type": "progress", "created_at": "<ISO-8601>"}`. |
| `{{BACKLOG_INIT_LABELS_CMD}}` | No label initialization required. Local tickets use freeform label strings. Standard label conventions: `area:frontend`, `area:backend`, `area:api`, `effort:low`, `effort:medium`, `effort:high`. |

#### GitHub Issues (`BACKLOG_PROVIDER=github`)
- Issue fetch: `gh issue list --label "product-driven-backlog" --state open --limit 100 --json number,title,labels,body`
- Issue create: `gh issue create --title "..." --label "..." --body "..."`
- Issue view: `gh issue view {number} --json number,title,labels,body`
- Issue label names to match project areas
- Pre-flight check: `gh auth status`

#### JIRA (`BACKLOG_PROVIDER=jira`)
- Issue fetch: `jira issue list --project {{JIRA_PROJECT_KEY}} --type Story --label get-backlog-specs --status "To Do" --plain` or equivalent JIRA REST API call via curl:
  ```bash
  curl -s -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" \
    "{{JIRA_BASE_URL}}/rest/api/3/search?jql=project={{JIRA_PROJECT_KEY}} AND labels=get-backlog-specs AND status='To Do'&fields=summary,description,labels,priority"
  ```
- Issue create: `jira issue create --project {{JIRA_PROJECT_KEY}} --type Story --summary "..." --label get-backlog-specs --description "..."` or equivalent REST API call
- Issue view: `jira issue view {key}` or REST API
- VPC scores stored in the issue description body (same markdown format, parsed from description)
- Pre-flight check: `jira me` or test API connectivity
- Store JIRA config in `$SPECRAILS_DIR/backlog-config.json`:
  ```json
  {
    "provider": "jira",
    "jira_base_url": "https://your-company.atlassian.net",
    "jira_project_key": "PROJ",
    "issue_type": "Story",
    "auth_method": "api_token"
  }
  ```

The command templates use `{{BACKLOG_FETCH_CMD}}`, `{{BACKLOG_CREATE_CMD}}`, `{{BACKLOG_VIEW_CMD}}`, `{{BACKLOG_PREFLIGHT}}`, and related placeholders that get filled with the provider-specific commands (for `local`) or instructions (for `github`, `jira`). The `{{BACKLOG_PROVIDER_NAME}}` placeholder is substituted with a human-readable provider label in all three cases.

### 4.4 Generate rules

For each detected layer, read the layer rule template and generate a layer-specific rules file:
- `setup-templates/rules/layer.md` → `$SPECRAILS_DIR/rules/{layer-name}.md`

Each rule file must:
- Have the correct `paths:` frontmatter matching the layer's directory
- Contain conventions specific to that layer (from Phase 1 analysis)
- Reference actual file paths and patterns from the codebase

### 4.5 Generate root instructions file

**If `cli_provider == "claude"`:** If no `CLAUDE.md` exists, generate one from the template. If one already exists, **merge** — add the agent workflow sections without removing existing content.

**If `cli_provider == "codex"`:** If no `AGENTS.md` exists, generate one from the template. If one already exists, **merge** — add the agent workflow sections without removing existing content.

### 4.6 Generate settings

Read `.claude/setup-templates/.provider-detection.json` (written by `install.sh`) to determine `cli_provider` (`"claude"` or `"codex"`).

**If `cli_provider == "claude"` (default):**

Create or merge `.claude/settings.json` with permissions for:
- All detected CI commands
- Git operations
- OpenSpec CLI (if installed)
- GitHub CLI (if available)
- Language-specific tools (python, npm, cargo, go, etc.)

**If `cli_provider == "codex"`:**

1. Read `setup-templates/settings/codex-config.toml`. Write it to `.codex/config.toml` as-is (no substitutions needed — the TOML is static).

2. Read `setup-templates/settings/codex-rules.star`. Replace `{{CODEX_SHELL_RULES}}` with Starlark `prefix_rule(...)` lines for each detected tool allowance:

   | Detected tool/command | Starlark rule |
   |----------------------|---------------|
   | OpenSpec CLI (`openspec`) | `prefix_rule(pattern=["openspec"], decision="allow")` |
   | Python (`python`, `pip`) | `prefix_rule(pattern=["python"], decision="allow")`<br>`prefix_rule(pattern=["pip"], decision="allow")` |
   | npm (`npm`) | `prefix_rule(pattern=["npm"], decision="allow")` |
   | Cargo (`cargo`) | `prefix_rule(pattern=["cargo"], decision="allow")` |
   | Go (`go`) | `prefix_rule(pattern=["go"], decision="allow")` |
   | Any detected CI command | `prefix_rule(pattern=["<cmd>"], decision="allow")` |

   Write the rendered file to `.codex/rules/default.rules`.

   ```bash
   mkdir -p .codex/rules
   ```

   If `cli_provider` cannot be determined (file missing), fall back to `"claude"` behavior.

### 4.7 Initialize agent memory

Create memory directories for each installed agent using the provider-aware base directory:

```bash
mkdir -p $SPECRAILS_DIR/agent-memory/sr-{agent-name}/
```

Each gets an empty `MEMORY.md` that will be populated during usage.

---

## Phase 5: Cleanup & Summary

### 5.1 Remove all scaffolding artifacts

The setup process installed temporary files that are only needed during installation. Remove them all now that the final files have been generated.

```bash
# 1. Remove setup templates (used as structural references during generation)
rm -rf .claude/setup-templates/

# 2. Remove the /specrails:setup command itself — it's a one-time installer, not a permanent command
rm -f .claude/commands/setup.md

# 3. Remove the specrails/ directory from the repo if it exists at the root
#    (it was only needed for install.sh and templates — everything is now in .claude/)
#    NOTE: Only remove if it's inside this repo. Ask the user if unsure.
```

**What gets removed:**
| Artifact | Why |
|----------|-----|
| `.claude/setup-templates/` | Temporary — templates already rendered into final files |
| `.claude/commands/setup.md` | One-time installer — running it again would overwrite customized agents |

**What to do with `specrails/`:**

The `specrails/` directory should NOT be committed to the target repo — it's an installer tool, not part of the project. Always add it to `.gitignore`:

```bash
# Add specrails/ to .gitignore if not already there
if ! grep -q '^specrails/' .gitignore 2>/dev/null; then
  echo '' >> .gitignore
  echo '# specrails installer (one-time setup tool, not part of the project)' >> .gitignore
  echo 'specrails/' >> .gitignore
fi
```

Then ask the user:

> `specrails/` has been added to `.gitignore`. Do you also want to delete it?
>
> 1. **Keep it** (default) — stays locally in case you want to re-run setup or install in other repos
> 2. **Delete it** — everything is installed, you don't need it anymore

Apply the user's choice.

### 5.2 Verify clean state

After cleanup, verify that only the intended files remain:

```bash
# These should exist (the actual system) — use $SPECRAILS_DIR from .provider-detection.json:
# If cli_provider == "claude":
ls .claude/agents/sr-*.md
ls .claude/agents/personas/*.md
ls .claude/commands/specrails/*.md
ls .claude/rules/*.md
ls .claude/agent-memory/

# If cli_provider == "codex":
ls .codex/agents/sr-*.toml
ls .codex/agents/personas/*.md
ls .agents/skills/sr-*/SKILL.md
ls .codex/rules/*.md
ls .codex/agent-memory/

# These should NOT exist (scaffolding):
# $SPECRAILS_DIR/setup-templates/  — GONE
# If cli_provider == "claude": $SPECRAILS_DIR/commands/setup.md  — GONE
# If cli_provider == "codex": .agents/skills/setup/  — GONE (installer scaffold, not a generated sr-skill)
```

If any scaffolding artifact remains, remove it.

### 5.3 Summary

Display the complete installation summary:

```
## Setup Complete

### Agents Installed
| Agent | File | Model |
|-------|------|-------|
[If cli_provider == "claude":]
| sr-architect | .claude/agents/sr-architect.md | Sonnet |
| sr-developer | .claude/agents/sr-developer.md | Sonnet |
| sr-reviewer | .claude/agents/sr-reviewer.md | Sonnet |
| sr-test-writer | .claude/agents/sr-test-writer.md | Sonnet |
| sr-security-reviewer | .claude/agents/sr-security-reviewer.md | Sonnet |
| sr-product-manager | .claude/agents/sr-product-manager.md | Opus |
[If cli_provider == "codex":]
| sr-architect | .codex/agents/sr-architect.toml | codex-mini-latest |
| sr-developer | .codex/agents/sr-developer.toml | codex-mini-latest |
| sr-reviewer | .codex/agents/sr-reviewer.toml | codex-mini-latest |
| sr-test-writer | .codex/agents/sr-test-writer.toml | codex-mini-latest |
| sr-security-reviewer | .codex/agents/sr-security-reviewer.toml | codex-mini-latest |
| sr-product-manager | .codex/agents/sr-product-manager.toml | o3 |

### Personas Created
| Persona | File | Source |
|---------|------|--------|
[If IS_OSS=true:]
| "Kai" — The Maintainer | $SPECRAILS_DIR/agents/personas/sr-the-maintainer.md | Auto-included (OSS) |
[For each user-generated persona:]
| "[Name]" — The [Role] | $SPECRAILS_DIR/agents/personas/[name].md | Generated |

### Commands / Skills Installed
[If cli_provider == "claude":]
| Command | File |
|---------|------|
| /specrails:implement | .claude/commands/specrails/implement.md |
| /specrails:batch-implement | .claude/commands/specrails/batch-implement.md |
| /specrails:propose-spec | .claude/commands/specrails/propose-spec.md |
| /specrails:get-backlog-specs | .claude/commands/specrails/get-backlog-specs.md |
| /specrails:auto-propose-backlog-specs | .claude/commands/specrails/auto-propose-backlog-specs.md |
| /specrails:compat-check | .claude/commands/specrails/compat-check.md |
| /specrails:refactor-recommender | .claude/commands/specrails/refactor-recommender.md |
| /specrails:why | .claude/commands/specrails/why.md |
[If cli_provider == "codex":]
| Skill | File |
|-------|------|
| $sr-implement | .agents/skills/sr-implement/SKILL.md |
| $sr-batch-implement | .agents/skills/sr-batch-implement/SKILL.md |
| $sr-propose-spec | .agents/skills/sr-propose-spec/SKILL.md |
| $sr-get-backlog-specs | .agents/skills/sr-get-backlog-specs/SKILL.md |
| $sr-auto-propose-backlog-specs | .agents/skills/sr-auto-propose-backlog-specs/SKILL.md |
| $sr-compat-check | .agents/skills/sr-compat-check/SKILL.md |
| $sr-refactor-recommender | .agents/skills/sr-refactor-recommender/SKILL.md |
| $sr-why | .agents/skills/sr-why/SKILL.md |

Note: Only commands/skills selected during setup are shown. Backlog commands are excluded if no backlog provider was configured.

### Rules Created
| Layer | File |
|-------|------|
| Backend | $SPECRAILS_DIR/rules/backend.md |
| Frontend | $SPECRAILS_DIR/rules/frontend.md |

### Scaffolding Removed
| Artifact | Status |
|----------|--------|
| $SPECRAILS_DIR/setup-templates/ | Deleted |
[If cli_provider == "claude":] | .claude/commands/setup.md | Deleted |
[If cli_provider == "codex":] | .agents/skills/setup/ | Deleted |
| specrails/ | [User's choice] |

### Next Steps
[If cli_provider == "claude":]
1. Review the generated files in .claude/
2. Run `/specrails:get-backlog-specs` to see your backlog (if GitHub Issues exist)
3. Run `/specrails:auto-propose-backlog-specs` to generate feature ideas
4. Run `/specrails:implement #issue-number` to implement a feature
5. Commit the .claude/ directory to version control
[If cli_provider == "codex":]
1. Review the generated files in .codex/ and .agents/skills/
2. Run `$sr-get-backlog-specs` to see your backlog (if GitHub Issues exist)
3. Run `$sr-auto-propose-backlog-specs` to generate feature ideas
4. Run `$sr-implement #issue-number` to implement a feature
5. Commit the .codex/ and .agents/ directories to version control

### Quick Start
[If cli_provider == "claude":]
- `/specrails:implement "describe a feature"` — implement something right now
- `/specrails:get-backlog-specs` — see prioritized feature ideas
- `/specrails:auto-propose-backlog-specs` — discover new features using VPC
[If cli_provider == "codex":]
- `$sr-implement "describe a feature"` — implement something right now
- `$sr-get-backlog-specs` — see prioritized feature ideas
- `$sr-auto-propose-backlog-specs` — discover new features using VPC
```

## First Task Prompt (Full Wizard)

After displaying the setup complete summary above, detect the project type and output:

**New project** (no `package.json`, `Gemfile`, `pyproject.toml`, `go.mod`, or `pom.xml` in root):
```
✅ Setup complete.

Try your first spec:
[If cli_provider == "claude":]
  > /specrails:get-backlog-specs
[If cli_provider == "codex":]
  > $sr-get-backlog-specs
```

**Existing codebase** (one or more of the above files found in root):
```
✅ Setup complete.

Try your first spec:
[If cli_provider == "claude":]
  > /specrails:refactor-recommender
[If cli_provider == "codex":]
  > $sr-refactor-recommender
```

Then stop.
