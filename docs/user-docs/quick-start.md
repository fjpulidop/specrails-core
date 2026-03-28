# Quick Start

Get SpecRails running in your project in under 10 minutes.

> **Using OpenAI Codex?** See the [Codex getting started guide](getting-started-codex.md) — setup is slightly different.

## Before you begin

You need:
- **Claude Code** — install from [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- **A git repository** — your project must have a `.git` directory

Optional:
- **GitHub CLI** (`gh`) — enables automatic PR creation

## Step 1: Install

### Plugin method (recommended — no Node.js required)

```bash
claude plugin install sr
```

### Scaffold method (if you need Node.js / Codex)

```bash
npx specrails-core@latest init --root-dir .
```

Your existing code is not touched by either method.

## Step 2: Run the setup wizard

Open Claude Code in your project:

```bash
claude
```

Then run:

```
/specrails:setup
```

The wizard runs the full 5-phase setup (about 5 minutes). It analyzes your codebase and configures SpecRails for your specific project:

```
Phase 1/5  Analyzing codebase...
           → Detected: TypeScript, Express, PostgreSQL
           → Found 3 architecture layers
           → Identified CI commands: npm test, npm run lint

Phase 2/5  Generating user personas...
           → Researching your domain
           → Created 3 VPC profiles

Phase 3/5  Configuration...
           → Backlog provider: local
           → Git workflow: trunk-based

Phase 4/5  Generating files...
           → .specrails/config.yaml
           → .specrails/personas/ (3 VPC profiles)
           → .specrails/rules/ (per-layer conventions)

Phase 5/5  Cleanup complete.

✓ SpecRails is ready. Run /specrails:implement to start building.
```

**In a hurry?** Use `/specrails:setup --lite` for a 3-question quick setup (under a minute). You can always run the full wizard later.

## Step 3: Implement your first feature

Pick something small. Either reference a GitHub Issue or describe it in plain text:

```
/specrails:implement #42
```

or:

```
/specrails:implement "add a health check endpoint to the API"
```

The pipeline runs automatically:

```
Phase 3a  Architect designing...
          → Design: GET /health endpoint + middleware
          → Tasks: 3 steps

Phase 3b  Developer implementing...
          → src/routes/health.ts (created)
          → src/middleware/health.ts (created)
          → src/app.ts (modified)

Phase 3c  Test Writer generating...
          → tests/routes/health.test.ts (created)
          → 5 tests, all passing

Phase 3d  Doc Sync updating...
          → CHANGELOG.md updated

Phase 4   Security Reviewer scanning...
          → No critical findings

Phase 4b  Reviewer running CI...
          → ✓ lint   ✓ typecheck   ✓ tests

Phase 4b-conf  Confidence: 91% — threshold met

PR #43 created: feat: add health check endpoint
```

One command. The PR is ready for human review.

## What's next?

**Explore the backlog:**

```
/specrails:get-backlog-specs
```

See your tickets ranked by persona fit and effort. The top 3 are safe to implement next. Uses local tickets by default.

**Generate new feature ideas:**

```
/specrails:auto-propose-backlog-specs
```

The Product Manager researches your competitive landscape and creates new tickets (local by default, or GitHub Issues if configured).

**Run multiple features in parallel:**

```
/specrails:implement #42, #43, #44
```

Each feature gets its own git worktree. Pipelines run concurrently and merge automatically.

**Ask why a decision was made:**

```
/specrails:why "why did we choose this database schema"
```

Agents record their reasoning as they work. `/specrails:why` searches those records in plain language.

---

[← Getting Started](../getting-started.md) · [← Installation](installation.md) · [CLI Reference →](cli-reference.md) · [FAQ →](faq.md)
