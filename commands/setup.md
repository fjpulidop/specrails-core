# Setup: Agent Workflow System

Interactive wizard to configure the full agent workflow system for this repository. Analyzes the codebase, discovers target users, generates VPC personas, and creates all agents, commands, rules, and configuration adapted to this project.

**Prerequisites:** Run `specrails/install.sh` first to install templates.

---

## Mode Detection

Check if `$ARGUMENTS` contains `--update`:
- If yes → execute **Update Mode** (below), then stop. Do NOT continue to the full setup wizard.
- If no → skip to **Phase 1** and execute the full setup wizard.

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
   > "No `.specrails-manifest.json` found. This looks like a pre-versioning installation. Run `update.sh` first to initialize the manifest, then re-run `/setup --update`."
   Then stop.

2. Read `.specrails-version` — contains the current version string (e.g., `0.2.0`). If it does not exist, treat version as `0.1.0 (legacy)`.

3. List all template files in `.claude/setup-templates/agents/` — these are the NEW templates from the update:
   ```bash
   ls .claude/setup-templates/agents/
   ```

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

For each agent template, find its entry in the manifest's `artifacts` map (keyed as `templates/agents/<name>.md`). Compute the SHA-256 checksum of the corresponding file in `.claude/setup-templates/agents/`:

```bash
sha256sum .claude/setup-templates/agents/<name>.md
```

Build three lists:

1. **Changed agents**: agent name exists in manifest AND the current template checksum differs from the manifest checksum → mark for regeneration
2. **New agents**: template file exists in `.claude/setup-templates/agents/` but the agent name is NOT in the manifest → mark for evaluation
3. **Unchanged agents**: agent name exists in manifest AND checksum matches → skip

Display the analysis to the user:

```
## Agent Update Analysis

### Changed Templates (will be regenerated)
- architect.md (template modified)
- developer.md (template modified)

### New Templates Available
- frontend-developer.md
- backend-developer.md

### Unchanged (keeping current)
- reviewer.md
- product-manager.md
```

If there are no changed agents and no new agents, display:
```
All agents are already up to date. Nothing to regenerate.
```
Then jump to Phase U7.

### Phase U4: Regenerate Changed Agents

For each agent in the "changed" list:

1. Read the NEW template from `.claude/setup-templates/agents/<name>.md`
2. Use the codebase analysis from Phase U2 to fill in all `{{PLACEHOLDER}}` values, using the same substitution rules as Phase 4.1 of the full setup:
   - `{{PROJECT_NAME}}` → project name (from README.md or directory name)
   - `{{ARCHITECTURE_DIAGRAM}}` → detected architecture layers
   - `{{LAYER_TAGS}}` → detected layer tags (e.g., `[backend]`, `[frontend]`, `[api]`)
   - `{{CI_COMMANDS_BACKEND}}` → backend CI commands
   - `{{CI_COMMANDS_FRONTEND}}` → frontend CI commands
   - `{{LAYER_CONVENTIONS}}` → detected conventions per layer
   - `{{PERSONA_NAMES}}` → read existing persona names from `.claude/agents/personas/` filenames
   - `{{PERSONA_FILES}}` → paths to existing persona files in `.claude/agents/personas/`
   - `{{DOMAIN_EXPERTISE}}` → infer from detected stack and README
   - `{{KEY_FILE_PATHS}}` → important file paths detected in Phase U2
   - `{{WARNINGS}}` → read from existing `CLAUDE.md` if present
   - `{{MEMORY_PATH}}` → `.claude/agent-memory/<agent-name>/`
3. Write the adapted agent to `.claude/agents/<name>.md`
4. Show: `✓ Regenerated <name>`

After regenerating all changed agents, verify no unresolved placeholders remain:
```bash
grep -r '{{[A-Z_]*}}' .claude/agents/ 2>/dev/null || echo "OK: no broken placeholders"
```

### Phase U5: Evaluate New Agents

For each agent in the "new" list:

1. Read the template from `.claude/setup-templates/agents/<name>.md` to understand what stack or layer it targets (read its description and any layer-specific comments)
2. Match against the codebase detected in Phase U2:
   - If the template targets a layer/stack that IS present (e.g., `frontend-developer` and React was detected), prompt:
     > "New agent available: `<name>` — your project uses [detected tech]. Add it? [Y/n]"
   - If the template targets a layer/stack that is NOT present (e.g., `backend-developer` and no backend was detected), prompt:
     > "New agent available: `<name>` — no [layer] detected in your project. Skip? [Y/n]"
3. If the user accepts (or presses Enter on a pre-selected default):
   - Generate the agent using the same template adaptation as Phase U4
   - Create memory directory if it does not exist: `.claude/agent-memory/<name>/`
   - Show: `✓ Added <name>`
4. If the user declines:
   - Show: `→ Skipped <name>`

### Phase U6: Update Workflow Commands

If any new agents were added in Phase U5:

1. Read `.claude/commands/implement.md`
2. Check if the file references agent names in its orchestration steps (look for `architect`, `developer`, `reviewer` etc.)
3. If newly added agents belong in the implementation pipeline (i.e., they are layer-specific developers such as `frontend-developer` or `backend-developer`), add them to the appropriate step in the implement command — specifically where parallel developer agents are launched
4. Write the updated `.claude/commands/implement.md` if any changes were made
5. Show which commands were updated, or "No command updates needed" if nothing changed

This is a lightweight check — only update commands where the agent clearly belongs. Do not restructure the entire command.

### Phase U7: Summary

Display the final summary and stop. Do not continue to Phase 1 of the full setup wizard.

```
## Update Complete

specrails updated from v<previous> to v<new>.

| Action             | Count |
|--------------------|-------|
| Agents regenerated | N     |
| Agents added       | N     |
| Agents skipped     | N     |
| Commands updated   | N     |

All agents are now up to date.

### Regenerated
[list agent names, or "(none)"]

### Added
[list agent names, or "(none)"]

### Skipped
[list agent names, or "(none)"]
```

Update `.specrails-manifest.json` to reflect the new checksums for all regenerated and added agents:
- For each regenerated agent: update its checksum entry to the new template's checksum
- For each added agent: add a new entry with its checksum
- Update the `version` field to the version read from `.specrails-version`

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
| Architect | Design features, create implementation plans | Sonnet | Yes |
| Developer (full-stack) | Implement features across all layers | Sonnet | Yes |
| Reviewer | CI/CD quality gate, fix issues | Sonnet | Yes |
| Product Manager | Product discovery, ideation, VPC evaluation | Opus | Recommended |
| Product Analyst | Read-only backlog analysis | Haiku | Recommended |
| Backend Developer | Specialized backend implementation | Sonnet | If backend layer exists |
| Frontend Developer | Specialized frontend implementation | Sonnet | If frontend layer exists |

[All] [Required only] [Custom selection]
```

### 3.2 Backlog provider

Ask the user where they manage their product backlog:

```
## Backlog Provider

Where do you track your product backlog?

1. **GitHub Issues** — uses `gh` CLI to read/create issues with labels and VPC scores
2. **JIRA** — uses JIRA CLI or REST API to read/create tickets in a JIRA project
3. **None** — skip backlog commands (you can still use /implement with text descriptions)
```

Wait for the user's choice. Set `BACKLOG_PROVIDER` to `github`, `jira`, or `none`.

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

Store the full configuration in `.claude/backlog-config.json`:
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

- Skip `/product-backlog` and `/update-product-driven-backlog` commands.
- The `/implement` command will still work with text descriptions.

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
| /implement | Full pipeline: architect → develop → review → ship | Architect + Developer + Reviewer |
| /product-backlog | View prioritized backlog with VPC scores | Product Analyst + Backlog provider |
| /update-product-driven-backlog | Generate new feature ideas via product discovery | Product Manager + Backlog provider |

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

### 4.1 Generate agents

For each selected agent, read the template and generate the adapted version:

**Template → Output mapping:**
- `setup-templates/agents/architect.md` → `.claude/agents/architect.md`
- `setup-templates/agents/developer.md` → `.claude/agents/developer.md`
- `setup-templates/agents/reviewer.md` → `.claude/agents/reviewer.md`
- `setup-templates/agents/product-manager.md` → `.claude/agents/product-manager.md`
- `setup-templates/agents/product-analyst.md` → `.claude/agents/product-analyst.md`
- `setup-templates/agents/backend-developer.md` → `.claude/agents/backend-developer.md` (if backend layer)
- `setup-templates/agents/frontend-developer.md` → `.claude/agents/frontend-developer.md` (if frontend layer)

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
   - `{{MEMORY_PATH}}` → agent memory directory path
3. Write the final file

### 4.2 Generate personas

If IS_OSS=true:
1. Copy `setup-templates/personas/the-maintainer.md` to `.claude/agents/personas/the-maintainer.md`
2. Log: "Maintainer persona included"
3. Set MAINTAINER_INCLUDED=true for use in template substitution
4. Set `{{MAINTAINER_PERSONA_LINE}}` = `- \`.claude/agents/personas/the-maintainer.md\` — "Kai" the Maintainer (open-source maintainer)`
5. Increment `{{PERSONA_COUNT}}` by 1 to account for the Maintainer

If IS_OSS=false:
- Set `{{MAINTAINER_PERSONA_LINE}}` = *(empty string)*

Then for each user-defined VPC persona from Phase 2.3:

Write each persona to `.claude/agents/personas/`:
- Use the VPC personas generated in Phase 2
- File naming: kebab-case of persona nickname (e.g., `the-developer.md`, `the-admin.md`)

### 4.3 Generate commands

For each selected command, read the template and adapt:
- `setup-templates/commands/implement.md` → `.claude/commands/implement.md`
- `setup-templates/commands/product-backlog.md` → `.claude/commands/product-backlog.md` (if `BACKLOG_PROVIDER != none`)
- `setup-templates/commands/update-product-driven-backlog.md` → `.claude/commands/update-product-driven-backlog.md` (if `BACKLOG_PROVIDER != none`)

Adapt:
- CI commands to match detected stack
- Persona references to match generated personas
- File paths to match project structure
- Layer tags to match detected layers
- **Backlog provider commands** based on `BACKLOG_PROVIDER`:

#### GitHub Issues (`BACKLOG_PROVIDER=github`)
- Issue fetch: `gh issue list --label "product-driven-backlog" --state open --limit 100 --json number,title,labels,body`
- Issue create: `gh issue create --title "..." --label "..." --body "..."`
- Issue view: `gh issue view {number} --json number,title,labels,body`
- Issue label names to match project areas
- Pre-flight check: `gh auth status`

#### JIRA (`BACKLOG_PROVIDER=jira`)
- Issue fetch: `jira issue list --project {{JIRA_PROJECT_KEY}} --type Story --label product-backlog --status "To Do" --plain` or equivalent JIRA REST API call via curl:
  ```bash
  curl -s -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" \
    "{{JIRA_BASE_URL}}/rest/api/3/search?jql=project={{JIRA_PROJECT_KEY}} AND labels=product-backlog AND status='To Do'&fields=summary,description,labels,priority"
  ```
- Issue create: `jira issue create --project {{JIRA_PROJECT_KEY}} --type Story --summary "..." --label product-backlog --description "..."` or equivalent REST API call
- Issue view: `jira issue view {key}` or REST API
- VPC scores stored in the issue description body (same markdown format, parsed from description)
- Pre-flight check: `jira me` or test API connectivity
- Store JIRA config in `.claude/backlog-config.json`:
  ```json
  {
    "provider": "jira",
    "jira_base_url": "https://your-company.atlassian.net",
    "jira_project_key": "PROJ",
    "issue_type": "Story",
    "auth_method": "api_token"
  }
  ```

The command templates use `{{BACKLOG_FETCH_CMD}}`, `{{BACKLOG_CREATE_CMD}}`, `{{BACKLOG_VIEW_CMD}}`, and `{{BACKLOG_PREFLIGHT}}` placeholders that get filled with the provider-specific commands.

### 4.4 Generate rules

For each detected layer, read the layer rule template and generate a layer-specific rules file:
- `setup-templates/rules/layer.md` → `.claude/rules/{layer-name}.md`

Each rule file must:
- Have the correct `paths:` frontmatter matching the layer's directory
- Contain conventions specific to that layer (from Phase 1 analysis)
- Reference actual file paths and patterns from the codebase

### 4.5 Generate root CLAUDE.md

If no CLAUDE.md exists, generate one from the template. If one already exists, **merge** — add the agent workflow sections without removing existing content.

### 4.6 Generate settings

Create or merge `.claude/settings.json` with permissions for:
- All detected CI commands
- Git operations
- OpenSpec CLI (if installed)
- GitHub CLI (if available)
- Language-specific tools (python, npm, cargo, go, etc.)

### 4.7 Initialize agent memory

Create memory directories for each installed agent:

```bash
mkdir -p .claude/agent-memory/{agent-name}/
```

Each gets an empty `MEMORY.md` that will be populated during usage.

---

## Phase 5: Cleanup & Summary

### 5.1 Remove all scaffolding artifacts

The setup process installed temporary files that are only needed during installation. Remove them all now that the final files have been generated.

```bash
# 1. Remove setup templates (used as structural references during generation)
rm -rf .claude/setup-templates/

# 2. Remove the /setup command itself — it's a one-time installer, not a permanent command
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
# These should exist (the actual system):
ls .claude/agents/*.md
ls .claude/agents/personas/*.md
ls .claude/commands/*.md
ls .claude/rules/*.md
ls .claude/agent-memory/

# These should NOT exist (scaffolding):
# .claude/setup-templates/  — GONE
# .claude/commands/setup.md  — GONE
```

If any scaffolding artifact remains, remove it.

### 5.3 Summary

Display the complete installation summary:

```
## Setup Complete

### Agents Installed
| Agent | File | Model |
|-------|------|-------|
| architect | .claude/agents/architect.md | Sonnet |
| developer | .claude/agents/developer.md | Sonnet |
| reviewer | .claude/agents/reviewer.md | Sonnet |
| product-manager | .claude/agents/product-manager.md | Opus |

### Personas Created
| Persona | File | Source |
|---------|------|--------|
[If IS_OSS=true:]
| "Kai" — The Maintainer | .claude/agents/personas/the-maintainer.md | Auto-included (OSS) |
[For each user-generated persona:]
| "[Name]" — The [Role] | .claude/agents/personas/[name].md | Generated |

### Commands Installed
| Command | File |
|---------|------|
| /implement | .claude/commands/implement.md |
| /product-backlog | .claude/commands/product-backlog.md |
| /update-product-driven-backlog | .claude/commands/update-product-driven-backlog.md |

### Rules Created
| Layer | File |
|-------|------|
| Backend | .claude/rules/backend.md |
| Frontend | .claude/rules/frontend.md |

### Scaffolding Removed
| Artifact | Status |
|----------|--------|
| .claude/setup-templates/ | Deleted |
| .claude/commands/setup.md | Deleted |
| specrails/ | [User's choice] |

### Next Steps
1. Review the generated files in .claude/
2. Run `/product-backlog` to see your backlog (if GitHub Issues exist)
3. Run `/update-product-driven-backlog` to generate feature ideas
4. Run `/implement #issue-number` to implement a feature
5. Commit the .claude/ directory to version control

### Quick Start
- `/implement "describe a feature"` — implement something right now
- `/product-backlog` — see prioritized feature ideas
- `/update-product-driven-backlog` — discover new features using VPC
```
