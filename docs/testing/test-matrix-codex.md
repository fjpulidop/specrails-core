# Test Matrix — specrails Cross-Platform (Claude Code + Codex)

Last updated: 2026-03-21
Epic: [SPEA-505](/SPEA/issues/SPEA-505) — Codex Compatibility Approach B

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Works / tested |
| ❌ | Not supported |
| 🔄 | In progress (implementation pending) |
| ⚠️ | Partial / with caveats |
| — | Not applicable |

---

## Feature Coverage by CLI

### Installation & Provider Detection (SPEA-506)

| Feature | Claude Code only | Codex only | Both CLIs | Neither CLI |
|---------|:-:|:-:|:-:|:-:|
| Auto-detect `claude` binary | ✅ | — | ✅ | — |
| Auto-detect `codex` binary | — | ✅ | ✅ | — |
| Prompt user to choose CLI (dual) | — | — | 🔄 | — |
| Exit with clear error message | — | — | — | 🔄 |
| Output dir `.claude/` created | ✅ | ❌ | 🔄 | — |
| Output dir `.codex/` created | ❌ | 🔄 | 🔄 | — |
| `CLAUDE.md` instruction file | ✅ | ❌ | 🔄 | — |
| `AGENTS.md` instruction file | ❌ | 🔄 | 🔄 | — |
| `--provider claude` flag override | ✅ | — | 🔄 | — |
| `--provider codex` flag override | — | ✅ | 🔄 | — |

### Skills & Commands (SPEA-507)

| Feature | Claude Code | Codex |
|---------|:-:|:-:|
| Legacy slash commands `.claude/commands/sr/` | ✅ | ❌ |
| SKILL.md format `.claude/skills/sr-*/` | ✅ | ✅ |
| `sr:implement` skill | ✅ | ✅ |
| `sr:product-backlog` skill | ✅ | ✅ |
| `sr:health-check` skill | ✅ | ✅ |
| `sr:compat-check` skill | ✅ | ✅ |
| `sr:why` skill | ✅ | ✅ |
| `sr:refactor-recommender` skill | ✅ | ✅ |
| `sr:batch-implement` skill | ✅ | ✅ |
| `sr:update-product-driven-backlog` skill | ✅ | ✅ |
| Backward compat: slash commands still invoke correctly | ✅ | — |

### Permissions Configuration (SPEA-508)

| Feature | Claude Code | Codex |
|---------|:-:|:-:|
| `.claude/settings.json` generated | ✅ | ❌ |
| `.codex/config.toml` generated | ❌ | 🔄 |
| `.codex/rules/default.rules` (Starlark) generated | ❌ | 🔄 |
| Git permission granted | ✅ | 🔄 |
| GitHub CLI (gh) permission granted | ✅ | 🔄 |
| Read/Write filesystem permission | ✅ | 🔄 |
| Bash tool allowed | ✅ | 🔄 |

### Agent Definitions (SPEA-509)

| Agent | Claude Code (`.md`) | Codex (`.toml`) |
|-------|:-:|:-:|
| `sr-architect` | ✅ | 🔄 |
| `sr-developer` | ✅ | 🔄 |
| `sr-reviewer` | ✅ | 🔄 |
| `sr-product-manager` | ✅ | 🔄 |
| Prompt content identical across formats | ✅ | 🔄 |
| YAML frontmatter valid (Claude Code) | ✅ | — |
| TOML frontmatter valid (Codex) | — | 🔄 |

### Hub Integration (SPEA-510, SPEA-511)

| Feature | Claude Code | Codex |
|---------|:-:|:-:|
| Hub detects claude binary | ✅ | — |
| Hub detects codex binary | — | ✅ |
| `integration-contract.json` v2 schema valid | ✅ | ✅ |
| Hub invokes CLI with correct args | ✅ | ✅ |
| Hub dashboard shows CLI badge | ✅ | ✅ |
| Hub handles "no CLI detected" state | ✅ | ✅ |

---

## Edge Case Coverage

| Scenario | Test Coverage | Notes |
|----------|:-:|-------|
| User has both CLIs, picks Claude Code | 🔄 | Interactive prompt or `--provider` flag |
| User has both CLIs, picks Codex | 🔄 | Interactive prompt or `--provider` flag |
| User has neither CLI | 🔄 | Must print install instructions |
| Re-install after switch from claude → codex | 🔄 | Old `.claude/` must not corrupt `.codex/` |
| Re-install after switch from codex → claude | 🔄 | Old `.codex/` must not corrupt `.claude/` |
| Version upgrade: CLI format unchanged | ✅ | Existing regression suite covers this |
| Version upgrade: provider mismatch | 🔄 | New behavior in SPEA-506 |

---

## Test Files

| File | Suite | Covers |
|------|-------|--------|
| `tests/test-install.sh` | Install | Existing install flow (Claude Code only) |
| `tests/test-update.sh` | Update | Update flow (existing) |
| `tests/test-cli.sh` | CLI | Argument validation, injection safety |
| `tests/test-codex-compat.sh` | Codex compat | Provider detection, dual-output structure, edge cases |

---

## Acceptance Criteria

Before SPEA-505 can be merged and released:

1. `tests/test-codex-compat.sh` — all tests green
2. `tests/test-install.sh` — all existing tests still green (regression)
3. `tests/test-update.sh` — all existing tests still green (regression)
4. `tests/test-cli.sh` — all existing tests still green (regression)
5. No broken placeholders: `grep -r '{{[A-Z_]*}}' .claude/agents/ .codex/agents/ 2>/dev/null` returns empty
6. Skills valid: every `SKILL.md` in `.claude/skills/` has required frontmatter
7. Agent TOML valid: every `.toml` in `.codex/agents/` is parseable TOML
