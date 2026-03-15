---
agent: developer
feature: analytics-dashboard
tags: [sync, templates, running-instance]
date: 2026-03-15
---

## Decision

Template files in `templates/web-manager/` are applied first, then manually synced to `specrails/web-manager/`. When the running instance has diverged (e.g., extra features like chat panel), only the analytics additions are applied as surgical edits — the running instance is NOT overwritten wholesale from the template.

## Why This Approach

The running instance (`specrails/web-manager/`) has accumulated features beyond the template's current state (chat panel, SharedWebSocketProvider, different App.tsx structure). Overwriting it wholesale from the template would delete those features. Instead, each change is applied as a targeted edit that matches the existing structure of the running instance.

## How to Apply

For each new file: `cp template/... running-instance/...`
For each modified file: read the running instance version first, then apply only the analytics-specific diff.

## See Also

`generated-instance-gaps.md` in agent-memory documents known structural gaps between templates and running instances.
