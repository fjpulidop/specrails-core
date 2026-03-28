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
- `/specrails:implement` — Full pipeline: architect → developer → reviewer → PR
- `/specrails:batch-implement` — Multi-feature parallel implementation
- `/specrails:retry` — Resume a failed pipeline from the last successful phase
- `/specrails:setup` — Initialize a project with the specrails workflow

#### Product Discovery
- `/specrails:get-backlog-specs` — View and prioritize the product-driven backlog
- `/specrails:auto-propose-backlog-specs` — Generate new feature ideas via product discovery
- `/specrails:propose-spec` — Explore a spec idea and produce a structured proposal

#### Code Quality
- `/specrails:health-check` — Full codebase health check with regression detection
- `/specrails:compat-check` — API surface snapshot and breaking change detection
- `/specrails:refactor-recommender` — Find refactoring opportunities by impact/effort ratio
- `/specrails:test` — Generate tests for specific files
- `/specrails:doctor` — Diagnose the sr plugin installation

#### Utilities
- `/specrails:why` — Search agent explanation records
- `/specrails:telemetry` — Agent cost and performance dashboard
- `/specrails:memory-inspect` — Inspect agent memory directories
- `/specrails:merge-resolve` — Resolve git conflict markers with AI
- `/specrails:vpc-drift` — Detect persona drift in the product backlog
- `/specrails:opsx-diff` — Show before/after diff of an OpenSpec change

#### OpenSpec Workflow
- `/specrails:opsx-explore` — Explore and ideate before creating a spec
- `/specrails:opsx-new` — Start a new OpenSpec change
- `/specrails:opsx-ff` — Fast-forward through artifact creation
- `/specrails:opsx-continue` — Continue an in-progress change
- `/specrails:opsx-apply` — Implement tasks from a change
- `/specrails:opsx-verify` — Verify implementation before archiving
- `/specrails:opsx-archive` — Archive a completed change
- `/specrails:opsx-bulk-archive` — Archive multiple completed changes
- `/specrails:opsx-sync` — Sync delta specs to main specs
- `/specrails:opsx-onboard` — Guided OpenSpec workflow walkthrough

## Getting Started

1. Run `/specrails:setup` to initialize your project
2. Edit `.specrails/config.yaml` and `.specrails/personas/` to describe your project
3. Run `/specrails:get-backlog-specs` to see generated feature ideas
4. Run `/specrails:implement #123` to implement a GitHub Issue
