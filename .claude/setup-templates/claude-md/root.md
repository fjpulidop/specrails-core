# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

## Stack

| Layer | Tech |
|-------|------|
{{STACK_TABLE}}

## Repo layout

```
{{REPO_LAYOUT}}
```

## Dev commands

```bash
{{DEV_COMMANDS}}
```

## Environment

{{ENVIRONMENT_NOTES}}

## Architecture

```
{{ARCHITECTURE_DIAGRAM}}
```

## Conventions

Layer-specific conventions are in `.claude/rules/` (loaded conditionally per layer).

{{GIT_CONVENTIONS}}

## Warnings

{{WARNINGS}}

## OpenSpec

- **Specs**: `openspec/specs/` is the source of truth. Read relevant specs before implementing.
- **Changes**: `openspec/changes/<name>/`. Use `/opsx:ff` -> `/opsx:apply` -> `/opsx:archive`.

## Scoped context

{{SCOPED_CONTEXT_LIST}}
