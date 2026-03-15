---
agent: developer
feature: dynamic-pipeline-phases
tags: [config, frontmatter, yaml-parsing, parsefrontmatter]
date: 2026-03-15
---

## Decision

`parseFrontmatter` was changed from returning `Record<string, string>` to a `ParsedFrontmatter` interface with separate `scalars` and `phases` fields, rather than trying to encode arrays inside the flat string map.

## Why This Approach

The `phases` YAML field is an array of objects — it cannot be cleanly represented in `Record<string, string>`. Encoding it as a JSON string value and decoding it later would be fragile. A structured return type makes the parser output explicit and type-safe.

The `scalars` sub-object preserves the existing flat key-value behavior for `name`, `description`, and any future string fields. All call sites were updated to access `fm.scalars.name` / `fm.scalars.description` instead of `fm.name` / `fm.description`.

## Alternatives Considered

- **`Record<string, string | PhaseDefinition[]>`**: Uglier types at call sites, forces callers to narrow the type for every field access.
- **Keep the old signature, add a separate `parsePhases` function**: Two parsing passes over the same frontmatter block — redundant and fragile for edge cases where phases are interleaved with scalar keys.
