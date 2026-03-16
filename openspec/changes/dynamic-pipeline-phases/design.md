## Context

The pipeline commands currently lack a standard way to declare which phases they go through. This change adds frontmatter-based phase declarations to all command `.md` files in `.claude/commands/sr/`.

## Goals / Non-Goals

**Goals:**
- Each command declares its own pipeline phases via frontmatter metadata
- Phases are co-located with the command definition (no separate registry file)

**Non-Goals:**
- Dynamic pipeline UI changes (web-manager has been extracted to its own repo)
- Server-side phase validation
- Per-phase timing/duration tracking

## Decisions

### D1: Phase declaration via command frontmatter

Commands declare phases in their `.md` frontmatter:
```yaml
---
name: "Product Backlog"
description: "..."
phases:
  - key: analyst
    label: Analyst
    description: Reads and prioritizes the product backlog
---
```

Commands without relevant phases declare an empty `phases: []` array or omit the field. The `implement.md` and `batch-implement.md` files have been updated to include frontmatter with their 4-phase definition.

**Why over a separate registry file**: Phases are metadata about the command. Keeping them co-located with the command definition means adding a new command automatically includes its pipeline definition. No separate config file to keep in sync.
