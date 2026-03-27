# Installation & Setup

This guide covers the complete installation process in detail. For the quick version, see [Getting Started](getting-started.md).

## Prerequisites

### Required

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 18+** | Required for the installer | [nodejs.org](https://nodejs.org/) or via [nvm](https://github.com/nvm-sh/nvm) |
| **Git** | SpecRails operates on git repositories | [git-scm.com](https://git-scm.com/) |
| **Claude Code** | The AI CLI that runs the agents | `npm install -g @anthropic-ai/claude-code` |

### Recommended

| Tool | Why | Install |
|------|-----|---------|
| **GitHub CLI** | Auto-create PRs, manage issues | `brew install gh` or [cli.github.com](https://cli.github.com/) |

### Optional

| Tool | Why |
|------|-----|
| **JIRA CLI** | If using JIRA for backlog instead of GitHub Issues |

The installer checks for all of these and offers to install missing tools.

## Installation

### From npx (recommended)

```bash
npx specrails-core@latest init --root-dir <your-project>
```

No cloning required. Downloads the latest version and runs the installer automatically.

### From a local clone

If you prefer to clone the repo first:

```bash
git clone https://github.com/fjpulidop/specrails-core.git
./specrails-core/install.sh --root-dir <your-project>
```

### From curl

Alternatively, pipe the installer directly:

```bash
curl -sL https://raw.githubusercontent.com/fjpulidop/specrails-core/main/install.sh | bash
```

> **Important:** Always run the installer from the **target repository** — the project where you want SpecRails installed. If you run it from inside the SpecRails source repo, the installer will detect this and prompt you for the correct target path.

### What the installer does

1. **Checks prerequisites** — validates Git, Claude Code; optionally installs npm, gh, OpenSpec
2. **Detects existing setup** — warns if `.claude/agents/`, `.claude/commands/`, or `openspec/` already exist
3. **Installs artifacts:**
   - `.claude/commands/setup.md` — the `/setup` wizard
   - `.claude/setup-templates/` — agent and command templates (temporary, removed after `/setup`)
   - `.claude/security-exemptions.yaml` — security scanner config
   - OpenSpec initialization (if CLI available)
4. **Tracks version** — writes `.specrails-version` and `.specrails-manifest.json`

### What it does NOT do

The installer only copies files. It does not:

- Modify your existing code
- Create commits
- Push to any remote

---

## The Setup Wizard

After installation, open Claude Code in your project and run:

```
/setup
```

There are two modes:

| Mode | Command | When to use |
|------|---------|-------------|
| **Full wizard** (default) | `/setup` | Deep stack analysis, researched personas, fully adapted agents — takes 5–10 min |
| **Lite** | `/setup --lite` | Fastest path — 3 questions, sensible defaults, done in under a minute |

---

### Full Wizard (default)

The full 5-phase wizard — takes 5–10 minutes and produces deeply adapted agents.

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

**Generated files (full set):**

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
│       ├── product-backlog.md
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

- Deletes `.claude/commands/setup.md`
- Deletes `.claude/setup-templates/`
- Leaves only the final generated files

After this phase, `/setup` is no longer available — your workflow is ready.

---

### Lite Mode (`/setup --lite`)

The quick path — three questions, sensible defaults, done in under a minute.

1. What is this project? (one sentence)
2. Who are the target users?
3. Git access for agents — read-only or read-write?

**What gets installed:**

| Item | Detail |
|------|--------|
| Core agents | sr-architect, sr-developer, sr-reviewer, sr-product-manager |
| All workflow commands | `/sr:implement`, `/sr:product-backlog`, and 14 more |
| Backlog storage | Local tickets (`.claude/local-tickets.json`) — no GitHub or JIRA required |
| CLAUDE.md | Project-level context for agents |

You can run the full wizard later to deepen configuration: personas, stack analysis, layer-specific conventions.

---

## Verify installation

After setup, verify everything is in place:

```bash
# Check generated agents
ls .claude/agents/

# Check for unresolved placeholders (should return nothing)
grep -r '{{[A-Z_]*}}' .claude/agents/ .claude/commands/ .claude/rules/

# Check version
cat .specrails-version
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

If you see `{{PLACEHOLDER}}` in generated files, the `/setup` wizard didn't complete. Re-run `/setup` or manually fill the values.

---

## What's next?

- [Core Concepts](concepts.md) — understand the pipeline and agent architecture
- [Getting Started](getting-started.md) — run your first feature implementation

---

[← Getting Started](getting-started.md) · [Core Concepts →](concepts.md)
