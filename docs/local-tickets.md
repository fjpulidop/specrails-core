# Local Ticket Management

specrails-core ships with a built-in, file-based ticket management system. It is the **default backlog provider** — no GitHub account, CLI tool, or external service required.

---

## Overview

Tickets live in `.claude/local-tickets.json` at your project root. Because it's a plain JSON file, tickets are:

- **Version-controlled** — tracked by git, diffable in PRs
- **Offline-first** — no network calls, no rate limits
- **Tool-agnostic** — readable by any script or editor

The file is read and written by specrails-core during command execution.

---

## Storage format

`.claude/local-tickets.json`:

```json
{
  "schema_version": "1.0",
  "revision": 7,
  "last_updated": "2026-03-23T10:00:00.000Z",
  "next_id": 8,
  "tickets": {
    "1": {
      "id": 1,
      "title": "Add dark mode",
      "description": "Support system-level dark mode preference via CSS variables.",
      "status": "todo",
      "priority": "medium",
      "labels": ["area:frontend", "effort:medium"],
      "assignee": null,
      "prerequisites": [],
      "metadata": {
        "vpc_scores": { "persona-a": 4, "persona-b": 3 },
        "effort_level": "Medium",
        "user_story": "As a user working at night, I want dark mode...",
        "area": "frontend"
      },
      "comments": [],
      "created_at": "2026-03-20T09:00:00.000Z",
      "updated_at": "2026-03-20T09:00:00.000Z",
      "created_by": "sr-product-manager",
      "source": "product-backlog"
    }
  }
}
```

### Field reference

**Root fields**

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Always `"1.0"` for the current format |
| `revision` | number | Incremented on every write — used for optimistic concurrency control |
| `last_updated` | ISO-8601 | Timestamp of the most recent mutation |
| `next_id` | number | Auto-increment counter for new ticket IDs |
| `tickets` | object | Map of ticket ID (as string) → ticket object |

**Ticket fields**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `id` | number | Auto-assigned | Numeric ID, referenced as `#<id>` |
| `title` | string | — | Short title |
| `description` | string | Markdown | Full description |
| `status` | string | `todo`, `in_progress`, `done`, `cancelled` | Current state |
| `priority` | string | `critical`, `high`, `medium`, `low` | Priority level |
| `labels` | string[] | Freeform | Tag strings; convention: `area:*`, `effort:*` |
| `assignee` | string\|null | — | Agent name or user, if assigned |
| `prerequisites` | number[] | — | IDs of tickets that must be done first |
| `metadata` | object | — | VPC scores, effort level, user story, area (set by agents) |
| `comments` | array | — | Progress notes appended during implementation |
| `created_at` | ISO-8601 | — | Creation timestamp |
| `updated_at` | ISO-8601 | — | Last mutation timestamp |
| `created_by` | string | — | Agent name or `"user"` |
| `source` | string | `manual`, `product-backlog`, `propose-spec` | How the ticket was created |

---

## Setup

Local tickets become the default during `/sr:setup`. The wizard prompts:

```
## Backlog Provider

Use local ticket management or connect an external provider?

1. Local tickets (default, recommended) — lightweight JSON-based ticket management.
   No external tools or accounts required.
2. External provider — connect GitHub Issues, JIRA, or disable backlog commands
```

Pressing **Enter** or selecting **1** initializes `.claude/local-tickets.json` with an empty ticket store and writes `.claude/backlog-config.json`:

```json
{
  "provider": "local",
  "write_access": true,
  "git_auto": true
}
```

To switch providers later, re-run the setup wizard:

```bash
> /sr:setup
```

---

## Concurrency model

Multiple agents can modify `local-tickets.json` simultaneously. The system uses two complementary mechanisms:

### Advisory file lock

Before every write, the agent creates `.claude/local-tickets.json.lock`:

```json
{
  "agent": "sr-product-manager",
  "timestamp": "2026-03-23T10:00:00.000Z"
}
```

If the lock file already exists:
- **Fresh lock** (< 30 seconds old): wait 500 ms and retry, up to 5 attempts
- **Stale lock** (≥ 30 seconds old): treat as orphaned, delete it, proceed

The lock is deleted immediately after the write completes. The window is minimal: read → modify in memory → write → release.

### Revision counter

Every write increments `revision`. Readers that want to detect external changes compare the `revision` they last saw against the current value.

---

## Command integration

### `/sr:implement`

Pass local ticket IDs the same way you would GitHub issue numbers:

```bash
/sr:implement #1, #4, #7
```

The command reads each ticket from `local-tickets.json`, extracts metadata (area, effort, description), and tracks the ticket through the pipeline — updating status to `in_progress` on start and `done` on successful completion.

### `/sr:product-backlog`

```bash
/sr:product-backlog              # all areas
/sr:product-backlog UI, Backend  # filter by area
```

Reads all `todo` and `in_progress` tickets, scores them by VPC match, respects the `prerequisites` dependency graph, and recommends the top 3 for your next sprint.

### `/sr:update-product-driven-backlog`

```bash
/sr:update-product-driven-backlog            # explore all areas
/sr:update-product-driven-backlog Analytics  # focus on one area
```

Runs product discovery using your VPC personas. Creates new local tickets for discovered feature ideas, tagged with `source: "product-backlog"` and `labels: ["product-driven-backlog", "area:<area>"]`. Existing tickets are checked for duplicates before creating new ones.

### `/sr:propose-spec`

When a proposal is finalized, a local ticket is created automatically:

```
Created local ticket #12: Add analytics export
```

The ticket captures the full proposal as its description and is tagged `source: "propose-spec"` with the label `spec-proposal`.

---

## Migrating from GitHub Issues or JIRA

See the [Migration Guide](./migration-guide.md).
