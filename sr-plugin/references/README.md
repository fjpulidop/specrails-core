# sr Plugin References

This directory contains reference documentation for the sr plugin agents and skills.

## Plugin Overview

The `sr` plugin provides a complete AI agent workflow system for product-driven software development.

### Agents

| Agent | Model | Description |
|-------|-------|-------------|
| `sr:architect` | sonnet | Analyzes spec changes, designs implementations, breaks tasks |
| `sr:developer` | sonnet | Implements OpenSpec changes with full-stack expertise |
| `sr:reviewer` | sonnet | CI/CD quality gate — runs checks, fixes failures |
| `sr:backend-developer` | sonnet | Specialized backend implementation |
| `sr:frontend-developer` | sonnet | Specialized frontend implementation |
| `sr:backend-reviewer` | sonnet | Scans backend files for N+1, connection pool issues |
| `sr:frontend-reviewer` | sonnet | Scans frontend files for bundle, accessibility, render issues |
| `sr:security-reviewer` | sonnet | Scans for secrets, credentials, OWASP vulnerabilities |
| `sr:performance-reviewer` | sonnet | Detects performance regressions |
| `sr:test-writer` | sonnet | Generates comprehensive tests for implemented code |
| `sr:doc-sync` | sonnet | Detects documentation drift and updates docs |
| `sr:merge-resolver` | sonnet | AI-powered merge conflict resolution |
| `sr:product-manager` | opus | Product ideation, exploration, VPC evaluation |
| `sr:product-analyst` | haiku | Read-only backlog analysis and reporting |

### Skills (Slash Commands)

#### Core Workflow
- `/sr:implement` — Full pipeline: architect → developer → reviewer → PR
- `/sr:batch-implement` — Multi-feature parallel implementation
- `/sr:retry` — Resume a failed pipeline from the last successful phase
- `/sr:setup` — Initialize a project with the specrails workflow

#### Product Discovery
- `/sr:product-backlog` — View and prioritize the product-driven backlog
- `/sr:update-product-driven-backlog` — Generate new feature ideas via product discovery
- `/sr:propose-spec` — Explore a spec idea and produce a structured proposal

#### Code Quality
- `/sr:health-check` — Full codebase health check with regression detection
- `/sr:compat-check` — API surface snapshot and breaking change detection
- `/sr:refactor-recommender` — Find refactoring opportunities by impact/effort ratio
- `/sr:test` — Generate tests for specific files
- `/sr:doctor` — Diagnose the sr plugin installation

#### Utilities
- `/sr:why` — Search agent explanation records
- `/sr:telemetry` — Agent cost and performance dashboard
- `/sr:memory-inspect` — Inspect agent memory directories
- `/sr:merge-resolve` — Resolve git conflict markers with AI
- `/sr:vpc-drift` — Detect persona drift in the product backlog
- `/sr:opsx-diff` — Show before/after diff of an OpenSpec change

#### OpenSpec Workflow
- `/sr:opsx-explore` — Explore and ideate before creating a spec
- `/sr:opsx-new` — Start a new OpenSpec change
- `/sr:opsx-ff` — Fast-forward through artifact creation
- `/sr:opsx-continue` — Continue an in-progress change
- `/sr:opsx-apply` — Implement tasks from a change
- `/sr:opsx-verify` — Verify implementation before archiving
- `/sr:opsx-archive` — Archive a completed change
- `/sr:opsx-bulk-archive` — Archive multiple completed changes
- `/sr:opsx-sync` — Sync delta specs to main specs
- `/sr:opsx-onboard` — Guided OpenSpec workflow walkthrough

## Getting Started

1. Run `/sr:setup` to initialize your project
2. Edit `.specrails/config.yaml` and `.specrails/personas/` to describe your project
3. Run `/sr:product-backlog` to see generated feature ideas
4. Run `/sr:implement #123` to implement a GitHub Issue
