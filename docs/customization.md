# Customization

Everything SpecRails generates is editable markdown. Here's how to adapt it to your project.

## What gets generated

After running `/sr:setup`, your project data lives in `.specrails/` (plugin method) or `.claude/` (scaffold method):

**Plugin method — `.specrails/`**

```
.specrails/
├── config.yaml           # Stack, CI commands, git workflow
├── personas/             # VPC user personas
├── rules/                # Per-layer conventions
├── agent-memory/         # Persistent agent memory
└── pipeline/             # In-flight feature state
```

**Scaffold method — `.claude/`**

```
.claude/
├── agents/               # Agent prompts (one per agent)
├── commands/             # Workflow commands
├── rules/                # Per-layer conventions
├── skills/               # OpenSpec skills
├── agent-memory/         # Persistent agent memory
├── settings.json         # Permissions
└── security-exemptions.yaml
```

All files are standard Markdown or YAML. Edit them directly — no special tools needed.

## Agents

Agent prompts live in `.claude/agents/<name>.md`. Each file is the full system prompt for that agent.

### Editing an agent

Open any agent file and modify it. Common customizations:

- **Add domain knowledge** — tell the architect about your microservice boundaries, or the developer about your ORM patterns
- **Change behavior** — make the reviewer stricter, or the test writer target a different coverage threshold
- **Add constraints** — "never use library X", "always use repository pattern for data access"

Example — adding a constraint to the developer:

```markdown
## Additional Rules
- Always use the repository pattern for database access
- Never import directly from internal packages — use the public API
```

### Agent model selection

Each agent specifies its model in YAML frontmatter:

```yaml
---
model: sonnet
---
```

Available models:
- `opus` — best for creative/strategic tasks (Product Manager)
- `sonnet` — balanced for implementation tasks (most agents)
- `haiku` — fast and cheap for analysis tasks (Product Analyst)

Change the model by editing the frontmatter.

### Adding a new agent

Create a new file in `.claude/agents/`:

```markdown
---
model: sonnet
---

# My Custom Agent

You are a specialized agent for [your purpose].

## Role
[What this agent does]

## Rules
[What this agent must follow]
```

Reference it from a command using the Agent tool with `subagent_type: "your-agent-name"`.

---

## Layer conventions

Convention files live in `.claude/rules/<layer>.md`. They're loaded automatically based on file paths.

### How rules are scoped

Each rule file has a `paths` field in its frontmatter:

```yaml
---
paths:
  - "backend/**"
---
```

When an agent modifies a file matching `backend/**`, this rule is automatically loaded into its context. No manual loading needed.

### Editing conventions

Add or modify rules for any layer:

```markdown
---
paths:
  - "src/api/**"
---

# API Layer Conventions

- All endpoints must return JSON with `{ data, error, meta }` envelope
- Use middleware for authentication — never check tokens in handlers
- Rate limiting is handled at the gateway level — don't implement it per-endpoint
- Error responses must include a machine-readable `code` field
```

### Adding a new layer

Create a new file in `.claude/rules/`:

```markdown
---
paths:
  - "infrastructure/**"
---

# Infrastructure Conventions

- Use Terraform for all cloud resources
- Never hardcode region or account IDs
- All resources must be tagged with `team` and `environment`
```

---

## Personas

Persona files live in `.claude/agents/` (generated during setup). Each persona is a complete VPC profile used for feature evaluation.

### Editing a persona

Personas have three key sections for feature scoring:

```markdown
### Customer Jobs
| Type | Job |
|------|-----|
| Functional | Deploy changes without downtime |
| Social | Be seen as technically competent by the team |
| Emotional | Feel confident that deploys won't break production |

### Pains
| Severity | Pain |
|----------|------|
| High | Manual deploys take 2+ hours |
| Medium | Rollback process is undocumented |

### Gains
| Impact | Gain |
|--------|------|
| High | Zero-downtime deployments |
| Medium | Automated rollback on failure |
```

Edit jobs, pains, and gains to match your actual users. The more accurate these are, the better the Product Manager's recommendations.

### Adding a persona

Create a new persona file following the template structure. Include:

1. **Profile** — name, role, age range, behaviors
2. **Customer Jobs** — functional, social, and emotional jobs
3. **Pains** — graded by severity (High/Medium/Low)
4. **Gains** — graded by impact (High/Medium/Low)
5. **Key Insight** — the single most important unmet need

---

## Confidence thresholds

The confidence gate at Phase 4b-conf is controlled by `.claude/confidence-config.json`:

```json
{
  "thresholds": {
    "overall": 80,
    "correctness": 85,
    "test_coverage": 75,
    "security": 90,
    "performance": 70,
    "maintainability": 75
  },
  "on_failure": "block"
}
```

| `on_failure` value | Behavior |
|--------------------|---------|
| `"block"` | Pipeline stops; fix required before PR creation |
| `"warn"` | Pipeline continues; warning added to PR description |
| `"override"` | Always continue regardless of score |

Adjust thresholds per aspect to match your team's quality bar. Set `"on_failure": "warn"` during initial rollout if you want visibility without blocking.

---

## Layer reviewers

The Frontend Reviewer and Backend Reviewer agents live in `.claude/agents/`:

- `.claude/agents/frontend-reviewer.md`
- `.claude/agents/backend-reviewer.md`

Customize them the same way as any other agent — add domain-specific checks, change what's flagged as a finding, or adjust severity thresholds.

Example — adding a project-specific frontend rule:

```markdown
## Additional Checks
- Flag any component that fetches data directly (use React Query hooks instead)
- Warn on inline styles with more than 3 properties (extract to CSS module)
```

Both agents run in parallel during Phase 4b and feed their findings into the generalist Reviewer's final report.

---

## Backwards compatibility baseline

Use `/sr:compat-check --save` to snapshot your current API surface as a baseline:

```
/sr:compat-check --save
```

This writes the current API surface to `.claude/compat-baseline.json`. Future runs of `/sr:compat-check` and the Architect's Phase 6 auto-check compare against this baseline to detect breaking changes. Re-run `--save` after any intentional breaking release to advance the baseline.

---

## Security exemptions

The Security Reviewer can produce false positives. Suppress known safe patterns in `.claude/security-exemptions.yaml`:

```yaml
exemptions:
  - pattern: "NEXT_PUBLIC_.*"
    reason: "Next.js public env vars are intentionally client-exposed"
  - file: "tests/fixtures/mock-keys.json"
    reason: "Test fixtures with fake keys"
  - severity_override:
      pattern: "console\\.log"
      from: "medium"
      to: "info"
      reason: "Dev-only logging, stripped in production build"
```

---

## Settings

`.claude/settings.json` controls tool permissions:

```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit",
      "Glob", "Grep", "Agent",
      "Skill", "ToolSearch"
    ]
  }
}
```

Add or remove tools to control what agents can do. The update system preserves your permission customizations when pulling new versions.

---

## Agent memory

Agent memory at `.claude/agent-memory/<agent>/MEMORY.md` is automatic but editable.

### Clearing memory

Delete entries from an agent's `MEMORY.md` to reset specific knowledge:

```bash
# Clear all architect memory
> .claude/agent-memory/architect/MEMORY.md

# Or edit selectively
code .claude/agent-memory/architect/MEMORY.md
```

### Seeding memory

Pre-populate agent memory with project knowledge:

```markdown
# Memory Index

## Architecture decisions
- [adr-001.md](adr-001.md) — We use event sourcing for the order domain

## Known gotchas
- [gotcha-db.md](gotcha-db.md) — PostgreSQL connection pool maxes at 20 in dev
```

This is useful when onboarding SpecRails to a complex project.

---

## What's next?

- [Updating](updating.md) — keep SpecRails up to date without losing your customizations

---

[← Workflows & Commands](workflows.md) · [Updating →](updating.md)
