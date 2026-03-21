# Quick Start

Get SpecRails running in your project in under 10 minutes.

> **Using OpenAI Codex?** See the [Codex getting started guide](getting-started-codex.md) — setup is slightly different.

## Before you begin

You need:
- **Node.js 18+** — check with `node --version`
- **Claude Code** — install from [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- **A git repository** — your project must have a `.git` directory

Optional:
- **GitHub CLI** (`gh`) — enables automatic PR creation

## Step 1: Install

From inside your project directory:

```bash
npx specrails-core@latest init --root-dir .
```

Expected output:

```
✓ Prerequisites checked
✓ Templates installed → .claude/
✓ Version tracked → .specrails-version
```

This copies agent templates and commands into `.claude/`. Your existing code is not touched.

## Step 2: Run the setup wizard

Open Claude Code in your project:

```bash
claude
```

Then run:

```
/setup
```

The wizard runs automatically and takes about 5 minutes. It analyzes your codebase and configures SpecRails for your specific project:

```
Phase 1/5  Analyzing codebase...
           → Detected: TypeScript, Express, PostgreSQL
           → Found 3 architecture layers
           → Identified CI commands: npm test, npm run lint

Phase 2/5  Generating user personas...
           → Researching your domain
           → Created 3 VPC profiles

Phase 3/5  Configuration...
           → Backlog provider: GitHub Issues
           → Git workflow: trunk-based

Phase 4/5  Generating files...
           → sr-architect.md (adapted to your stack)
           → sr-developer.md (knows your CI commands)
           → sr-reviewer.md (runs your specific checks)
           → 9 more agents

Phase 5/5  Cleanup complete. /setup removed.

✓ SpecRails is ready. Run /sr:implement to start building.
```

After setup, the `/setup` command is gone — it's a one-time wizard.

## Step 3: Implement your first feature

Pick something small. Either reference a GitHub Issue or describe it in plain text:

```
/sr:implement #42
```

or:

```
/sr:implement "add a health check endpoint to the API"
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
/sr:product-backlog
```

See your GitHub Issues ranked by persona fit and effort. The top 3 are safe to implement next.

**Generate new feature ideas:**

```
/sr:update-product-driven-backlog
```

The Product Manager researches your competitive landscape and creates well-formed GitHub Issues for new features.

**Run multiple features in parallel:**

```
/sr:implement #42, #43, #44
```

Each feature gets its own git worktree. Pipelines run concurrently and merge automatically.

**Ask why a decision was made:**

```
/sr:why "why did we choose this database schema"
```

Agents record their reasoning as they work. `/sr:why` searches those records in plain language.

---

[← Installation](installation.md) · [CLI Reference →](cli-reference.md) · [FAQ →](faq.md)
