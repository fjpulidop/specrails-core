# Deployment

SpecRails runs locally — no cloud infrastructure required. Choose the setup that fits your workflow.

## Options at a glance

| Option | Best for | Setup time |
|--------|----------|------------|
| [Plugin](#plugin-recommended) | Quick start, individual developers | ~1 minute |
| [Local (npx)](#local-npx) | Scaffold/Codex, full offline control | ~2 minutes |
| [Local (git clone)](#local-git-clone) | Customization, contributing | ~5 minutes |
| [Docker](#docker) | Reproducible environments, teams | ~5 minutes |
| [CI/CD](#cicd-github-actions) | Automated workflows, GitHub Actions | ~10 minutes |

---

## Plugin (recommended)

The fastest way to get started. No Node.js required.

```bash
claude plugin install sr
/specrails:setup
```

**Requirements:** Claude Code, git

---

## Local — npx

For Codex users or when you need full control over agent files.

```bash
npx specrails-core@latest init --root-dir .
```

This will:
1. Scaffold a `.claude/` directory in your project
2. Install agent templates and the `/specrails:setup` wizard

After install, open Claude Code or Codex and run `/specrails:setup` to configure.

**Requirements:** Node.js ≥18, Claude Code or Codex CLI

---

## Local — git clone

Clone the repository for full control and the ability to customize agents.

```bash
git clone https://github.com/fjpulidop/specrails-core
cd specrails-core
npm install
./install.sh --root-dir <your-project>
```

### Updating

```bash
git pull origin main
npm install
```

See [Updating](./updating.md) for details on preserving local customizations during updates.

---

## Docker

Run SpecRails in a container for portable, reproducible environments.

### Quick start

```bash
docker run -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v $(pwd):/workspace \
  ghcr.io/specrails-ai/specrails:latest \
  setup
```

### docker-compose

Create a `docker-compose.yml` in your project root:

```yaml
services:
  specrails:
    image: ghcr.io/specrails-ai/specrails:latest
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - .:/workspace
    working_dir: /workspace
```

Then run:

```bash
docker compose run specrails setup
```

### Building locally

```bash
git clone https://github.com/fjpulidop/specrails-core
cd specrails-core
docker build -t specrails:local .
docker run -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v $(pwd):/workspace \
  specrails:local setup
```

---

## CI/CD — GitHub Actions

Automate SpecRails workflows in your GitHub Actions pipeline.

### Prerequisites

1. Add `ANTHROPIC_API_KEY` to your repository secrets
2. (Optional) Add `GITHUB_TOKEN` with write access for PR creation

### Basic workflow

```yaml
# .github/workflows/specrails.yml
name: SpecRails AI Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install SpecRails
        run: npm install -g specrails

      - name: Run AI review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: specrails review --pr ${{ github.event.pull_request.number }}
```

### Scheduled batch implementation

```yaml
name: SpecRails Batch Implement

on:
  schedule:
    - cron: '0 9 * * 1-5'   # Weekdays at 9am UTC
  workflow_dispatch:

jobs:
  implement:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install SpecRails
        run: npm install -g specrails

      - name: Run batch implementation
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: specrails sr:batch-implement --max 3
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Claude API key |
| `GITHUB_TOKEN` | For PR creation | GitHub personal access token or Actions token |
| `SPECRAILS_LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |
| `SPECRAILS_MODEL` | No | Override default model (e.g. `claude-opus-4-6`) |

---

## Troubleshooting

### Permission errors on macOS

```bash
sudo npm install -g specrails
# or use a node version manager (nvm, volta) to avoid sudo
```

### Docker volume permissions

If agents cannot write files inside the container:

```bash
docker run -it \
  --user $(id -u):$(id -g) \
  -v $(pwd):/workspace \
  ghcr.io/specrails-ai/specrails:latest
```

### API key not found

Ensure `ANTHROPIC_API_KEY` is exported in your shell:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Add to ~/.zshrc or ~/.bashrc to persist
```
