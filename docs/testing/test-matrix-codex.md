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
| Legacy slash commands `.claude/commands/specrails/` | ✅ | ❌ |
| SKILL.md format `.claude/skills/sr-*/` | ✅ | ✅ |
| `sr:implement` skill | ✅ | ✅ |
| `sr:get-backlog-specs` skill | ✅ | ✅ |
| `sr:compat-check` skill | ✅ | ✅ |
| `sr:why` skill | ✅ | ✅ |
| `sr:refactor-recommender` skill | ✅ | ✅ |
| `sr:batch-implement` skill | ✅ | ✅ |
| `sr:auto-propose-backlog-specs` skill | ✅ | ✅ |
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

The shell-based test suite was retired in v4.2.0 when the installer
moved to native Node. Coverage is now provided by vitest specs
co-located with the installer source:

| File | Suite | Covers |
|------|-------|--------|
| `src/installer/commands/init.test.ts` | Install | init flow end-to-end (Claude + Codex) |
| `src/installer/commands/update.test.ts` | Update | update flow + reserved paths + --only |
| `src/installer/commands/doctor.test.ts` | Doctor | health checks against fixture repos |
| `src/installer/cli.test.ts` | CLI | Argument parsing, dispatch, exit codes |
| `src/installer/phases/scaffold.test.ts` | Scaffold | template placement, VPC exclusion, agent-teams gate |
| `src/installer/phases/manifest.test.ts` | Manifest | sha256 stability, sorted output, exclusions |
| `src/installer/phases/install-config.test.ts` | Config validation | YAML round-trip + validation errors |
| `src/installer/phases/provider-detect.test.ts` | Provider | claude vs codex resolution + Codex coming-soon error |
| `src/installer/phases/prereqs.test.ts` | Prereqs | OSS detection + provider auth |
| `src/installer/__tests__/reserved-paths.test.ts` | Reserved paths | profile + custom-* survival across init/update |

---

## Acceptance Criteria

Before SPEA-505 can be merged and released:

1. `npm run test` — full vitest suite green (currently 168 specs).
2. CI matrix `[ubuntu, macos, windows] × [node 20, 22]` all green.
3. No broken placeholders: `grep -r '{{[A-Z_]*}}' .claude/agents/ .codex/agents/ 2>/dev/null` returns empty.
4. Skills valid: every `SKILL.md` in `.claude/skills/` has required frontmatter.
5. Agent TOML valid: every `.toml` in `.codex/agents/` is parseable TOML.
