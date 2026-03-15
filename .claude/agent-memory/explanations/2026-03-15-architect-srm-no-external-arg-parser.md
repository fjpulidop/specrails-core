---
agent: architect
feature: cli-wrapper-srm
tags: [cli, dependencies, arg-parsing]
date: 2026-03-15
---

## Decision

Hand-roll the argument parser in `cli/srm.ts` rather than using a library such as `yargs` or `commander`.

## Why This Approach

The `srm` CLI surface is small and stable: four modes (command, raw, --status, --jobs), one optional flag (--port), and a short list of known verbs. A full CLI library would add a transitive dependency tree to a binary that is meant to be lightweight and globally installable. Keeping the parser in the same file as the rest of `srm.ts` means zero new dependencies and easier auditability for users who inspect `npm ls`.

## Alternatives Considered

- `commander`: well-known, but adds ~50kB and pulls in devDependencies that don't belong in the distributed binary.
- `yargs`: similar concern; its validation and type coercion are valuable for large CLIs but overkill here.

## See Also

- `design.md` § CLI Argument Parsing
