# Developer Agent Memory

- [Agent template pattern](agent-template-pattern.md) — how to create new agent templates and generated instances
- [Implement command structure](implement-command-structure.md) — phase ordering and insertion points in the pipeline command
- [install-sh-conventions.md](install-sh-conventions.md) — install.sh uses $REPO_ROOT (not $TARGET); shared dirs added to Phase 3 mkdir block
- [placeholder-false-positives.md](placeholder-false-positives.md) — prose `{{PLACEHOLDER}}` in backtick code spans is documentation, not an unresolved token
- [Generated instance gaps](generated-instance-gaps.md) — known differences between templates and generated instances (e.g., missing CLAUDE.md bullet in developer.md)
- [vitest-spy-type-errors.md](vitest-spy-type-errors.md) — pre-existing MockInstance TS2322 errors in Vitest spy declarations; use `as any` for readdirSync mocks
