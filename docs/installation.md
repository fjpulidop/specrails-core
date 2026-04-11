# Installation & Setup

This guide covers the complete installation process in detail. For the quick version, see [Getting Started](getting-started.md).

## Installation methods

SpecRails supports three distribution channels:

| Method | Command | Best for |
|--------|---------|----------|
| **Claude Code plugin** (recommended) | `claude plugin install sr` | Most projects — no Node.js required, auto-updates |
| **Claude Code scaffold** | `npx specrails-core@latest init` | Full offline control, Codex users, custom agent edits |
| **Codex project** | `npx specrails-core@latest init` | OpenAI Codex CLI users |

---

## Method 1: Claude Code plugin (recommended)

### Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| **Claude Code** | The AI CLI that runs the agents | `npm install -g @anthropic-ai/claude-code` |
| **Git** | SpecRails operates on git repositories | [git-scm.com](https://git-scm.com/) |

### Recommended

| Tool | Why | Install |
|------|-----|---------|
| **GitHub CLI** | Auto-create PRs, manage issues | `brew install gh` or [cli.github.com](https://cli.github.com/) |

### Install

```bash
claude plugin install sr
```

That's it. No cloning, no npm, no Node.js required.

To update the plugin later:

```bash
claude plugin update sr
```

### What the plugin contains

The plugin bundles the logic layer — agents, skills, commands, hooks, and references. It does **not** touch your project files.

---

## Method 2: Scaffold (npx)

### Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 18+** | Required for the installer | [nodejs.org](https://nodejs.org/) or via [nvm](https://github.com/nvm-sh/nvm) |
| **Git** | SpecRails operates on git repositories | [git-scm.com](https://git-scm.com/) |
| **Claude Code** or **Codex CLI** | The AI CLI that runs the agents | See [codex-vs-claude-code.md](user-docs/codex-vs-claude-code.md) |

### Install

```bash
npx specrails-core@latest init --root-dir <your-project>
```

No cloning required. Downloads the latest version and runs the installer automatically.

### From a local clone

```bash
git clone https://github.com/fjpulidop/specrails-core.git
./specrails-core/install.sh --root-dir <your-project>
```

> **Important:** Always run the installer from the **target repository** — the project where you want SpecRails installed.

### What the scaffold installer does

The `npx specrails-core@latest init` command now includes a **TUI installer** that runs before copying files:

1. **TUI agent selection** — Interactive terminal UI lets you select which agents to install and choose a model preset (balanced/budget/max). Writes `.specrails/install-config.yaml`.
2. **Checks prerequisites** — validates Git, Claude Code; optionally installs npm and gh
3. **Detects existing setup** — warns if SpecRails artifacts already exist
4. **Installs artifacts:**
   - `.claude/commands/specrails/enrich.md` — the `/specrails:enrich` wizard
   - `.specrails/setup-templates/` — agent and command templates (temporary, removed after `/specrails:enrich`)
   - `.claude/security-exemptions.yaml` — security scanner config
5. **Tracks version** — writes `.specrails/specrails-version` and `.specrails/specrails-manifest.json`

To skip the TUI and use an existing config: `npx specrails-core@latest init --from-config`
To skip the TUI and use all defaults: `npx specrails-core@latest init --yes`

The scaffold installer only copies files. It does not modify your existing code, create commits, or push to any remote.

---

## The Enrich Wizard

After either installation method, open Claude Code (or Codex) in your project and run:

```
/specrails:enrich
```

There are three modes:

| Mode | Command | When to use |
|------|---------|-------------|
| **Full wizard** (default) | `/specrails:enrich` | Deep stack analysis, researched personas, fully adapted agents — takes 5–10 min |
| **Quick** | `/specrails:enrich --quick` | Fastest path — 3 questions, sensible defaults, done in under a minute |
| **From-config** | `/specrails:enrich --from-config` | Non-interactive — reads `.specrails/install-config.yaml` from TUI installer |

---

### Full Wizard (default)

The full 5-phase wizard — takes 5–10 minutes and produces deeply adapted agents.

> **Note:** If the TUI installer already captured agent and model preferences, use `/specrails:enrich --from-config` to apply them non-interactively.

### Phase 1: Codebase Analysis

The wizard scans your project to detect:

- **Languages & frameworks** — from file extensions, dependency files, imports
- **Architecture layers** — name, path, tech stack, tags (e.g., `backend/` → Python/FastAPI)
- **CI/CD commands** — lint, format, test, build, type-check commands
- **Conventions** — naming, imports, error handling, testing patterns
- **Warnings** — concurrency issues, auth patterns, state management

**Output:** A YAML analysis used by all subsequent phases.

### Phase 2: User Personas

The wizard researches your project's domain and generates **user personas** with complete VPC profiles. It:

1. Identifies your target user segments
2. Researches competitors and alternatives via web search
3. Creates 2–4 personas with jobs, pains, and gains
4. Extracts a key insight per persona

You can edit these later (see [Customization → Personas](customization.md#personas)).

### Phase 3: Configuration

Interactive prompts for:

| Setting | Options |
|---------|---------|
| **Backlog provider** | Local tickets (default), GitHub Issues, JIRA, or none |
| **Access mode** | Read-write or read-only |
| **Git workflow** | Trunk-based, Git Flow, or custom |
| **Agents** | Which agents to enable (up to 14) |
| **Commands** | Which commands to install |

### Phase 4: File Generation

The wizard fills all templates with your project-specific context:

- `{{STACK_OVERVIEW}}` → your detected tech stack
- `{{CI_COMMANDS}}` → your actual CI command list
- `{{LAYER_CONVENTIONS}}` → conventions per layer
- `{{BACKEND_TECH_LIST}}` → your backend technologies
- Every `{{PLACEHOLDER}}` resolved with real data

**Generated files (full set, plugin method):**

```
.specrails/
├── config.yaml               # Stack, CI commands, git workflow
├── personas/
│   ├── [persona-1].md        # Your user personas (VPC profiles)
│   └── [persona-2].md
├── rules/
│   ├── backend.md            # Per-layer coding conventions
│   ├── frontend.md
│   └── ...
├── agent-memory/             # Persistent agent knowledge
└── pipeline/                 # In-flight feature state
```

**Generated files (full set, scaffold method):**

```
.claude/
├── agents/
│   ├── sr-architect.md          # Adapted to your stack
│   ├── sr-developer.md          # Knows your CI commands
│   ├── sr-reviewer.md           # Runs your specific checks
│   ├── sr-product-manager.md    # Knows your domain
│   ├── sr-product-analyst.md    # Reads your backlog
│   ├── sr-test-writer.md        # Uses your test framework
│   ├── sr-security-reviewer.md  # Scans your patterns
│   ├── sr-doc-sync.md           # Updates your doc format
│   ├── sr-backend-developer.md  # Backend-specialized
│   ├── sr-frontend-developer.md # Frontend-specialized
│   ├── sr-backend-reviewer.md   # Backend quality audit
│   ├── sr-frontend-reviewer.md  # Frontend quality audit
│   ├── sr-merge-resolver.md     # AI-powered conflict resolution
│   ├── sr-performance-reviewer.md # Performance regression detection
│   └── [personas].md            # Your user personas
├── commands/
│   └── sr/
│       ├── implement.md
│       ├── get-backlog-specs.md
│       ├── batch-implement.md
│       └── ...                  # 17 commands total
├── rules/
│   ├── backend.md
│   ├── frontend.md
│   └── ...
└── settings.json
```

### Phase 5: Cleanup

The wizard removes itself:

- Deletes `.claude/commands/specrails/enrich.md`
- Deletes `.specrails/setup-templates/`
- Leaves only the final generated files

After this phase, `/specrails:enrich` is no longer available until re-run — your workflow is ready.

---

### Quick Install (TUI → `tier: quick`)

The quick path — select agents in the TUI, answer two context questions, done in seconds. No AI interaction required.

1. Select which agents to install (from 14 available)
2. Choose a model preset (balanced, budget, or max)
3. Provide a short product description and target users

**What gets installed:**

| Item | Detail |
|------|--------|
| Selected agents | Placed directly in `.claude/agents/` with template defaults |
| Workflow commands | `/specrails:implement`, `/specrails:doctor`, and more (18 commands) |
| Rules & settings | Layer conventions, settings.json, security exemptions |
| Agent memory | `.claude/agent-memory/<agent>/` directories |
| Skills | OpenSpec skills in `.claude/skills/` |

**What is NOT installed (requires full enrichment):**

| Item | Reason |
|------|--------|
| VPC personas | Require competitive research and AI analysis |
| sr-product-manager | Drives VPC persona creation — needs enrichment |
| sr-product-analyst | Analyzes personas — needs enrichment |
| `/specrails:auto-propose-backlog-specs` | Depends on personas |
| `/specrails:vpc-drift` | Depends on personas |
| `/specrails:get-backlog-specs` | References personas for prioritization |

Agents work immediately with template defaults. Run `/specrails:enrich` later to add personas, competitive analysis, and codebase-specific customization.

---

### From-Config Mode (`/specrails:enrich --from-config`)

Runs a fully automated installation using `.specrails/install-config.yaml`. No interactive prompts — all decisions come from the config file written by the TUI installer.

**Config schema** (`.specrails/install-config.yaml`):

```yaml
version: 1
provider: claude        # claude | codex | auto
tier: full              # full (requires /specrails:enrich) | quick (agents placed directly)
agents:
  selected:             # list of agent names to install
    - sr-architect
    - sr-developer
    - sr-reviewer
    - sr-test-writer
    - sr-product-manager
  excluded: []          # agent names to skip
models:
  preset: balanced      # balanced | budget | max
  overrides: {}         # per-agent overrides: { sr-architect: opus }
quick_context:
  product_description: ""   # product description seed
  target_users: ""          # target users seed
agent_teams: false      # install team-review/team-debug commands
```

**Model presets:**

| Preset | Description |
|--------|-------------|
| `balanced` (default) | Opus for architect + PM, Sonnet for all others |
| `budget` | Haiku for all agents |
| `max` | Opus for all agents |

---

## Verify installation

After setup, verify everything is in place:

```bash
# Plugin method: check generated project data
ls .specrails/

# Scaffold method: check generated agents
ls .claude/agents/

# Scaffold method: check for unresolved placeholders (should return nothing)
grep -r '{{[A-Z_]*}}' .claude/agents/ .claude/commands/ .claude/rules/

# Scaffold method: check version
cat .specrails/specrails-version
```

---

## Troubleshooting

### Claude Code authentication: OAuth vs API key

Claude Code supports two authentication modes:

- **OAuth** — the default for new installs (`claude auth login`). No API key in `claude config`.
- **API key** — explicit key set via `claude config set api_key <key>` or the `ANTHROPIC_API_KEY` environment variable.

The installer checks for an API key in `claude config` or `ANTHROPIC_API_KEY`. If you are using OAuth (the default), this check fails even though Claude Code is fully authenticated.

**Workaround:** pass `SPECRAILS_SKIP_PREREQS=1` to bypass the prerequisite gate:

```bash
SPECRAILS_SKIP_PREREQS=1 npx specrails-core@latest init --root-dir .
```

Or, if you prefer to authenticate with an API key explicitly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx specrails-core@latest init --root-dir .
```

`SPECRAILS_SKIP_PREREQS=1` skips all hard-exit prerequisite checks (Claude Code presence, API key, and tool availability). Use it only when you know the prerequisites are met.

### "This appears to be the specrails source repository"

You're running the installer from inside the SpecRails repo. Run it from your target project instead:

```bash
cd /path/to/your-project
bash /path/to/specrails/install.sh
```

### Existing `.claude/` directory detected

The installer warns if SpecRails artifacts already exist. You can:

- **Merge** — install alongside existing files (may overwrite conflicts)
- **Abort** — cancel and review manually

### Placeholders not resolved

If you see `{{PLACEHOLDER}}` in generated files (scaffold method), the `/specrails:enrich` wizard didn't complete. Re-run `/specrails:enrich` or manually fill the values.

---

## What's next?

- [Core Concepts](concepts.md) — understand the pipeline and agent architecture
- [Getting Started](getting-started.md) — run your first feature implementation

---

[← Getting Started](getting-started.md) · [Core Concepts →](concepts.md)
