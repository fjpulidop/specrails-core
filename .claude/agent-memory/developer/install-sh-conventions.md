# install.sh Conventions

install.sh uses `$REPO_ROOT` (not `$TARGET` or `${TARGET}`) for the target repo path.

Per-agent `agent-memory/` directories are created by the `/setup` command (see `commands/setup.md` Phase U5), not by install.sh. Shared/cross-agent directories (like `explanations/`) should be added to the Phase 3 "Create directory structure" block in install.sh alongside other `.claude/` infrastructure dirs.

The mkdir block at line ~332:
```bash
mkdir -p "$REPO_ROOT/.claude/commands"
mkdir -p "$REPO_ROOT/.claude/setup-templates/..."
mkdir -p "$REPO_ROOT/.claude/agent-memory/explanations"
```

The context-bundle.md for the in-context-help change describes a `${TARGET}` variable pattern that does not match the actual codebase — always verify against the actual install.sh.
