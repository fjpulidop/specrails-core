# Doctor: specrails Health Check

Run the specrails health check to validate that all prerequisites are correctly configured for this repository.

---

## What it checks

| Check | Pass condition |
|-------|---------------|
| Claude Code CLI | `claude` binary found in PATH |
| Claude API key | `claude config list` shows a key OR `ANTHROPIC_API_KEY` env var set |
| Agent files | `agents/` directory exists with at least 1 `AGENTS.md` file |
| CLAUDE.md | `CLAUDE.md` present in the repo root |
| Git initialized | `.git/` directory present |
| npm | `npm` binary found in PATH |

## How to run

This command delegates to the standalone health check script installed at `.specrails/bin/doctor.sh`. Run it directly:

```
Bash tool: bash .specrails/bin/doctor.sh
```

Or via the npm CLI wrapper:

```
npx specrails-core@latest doctor
```

## Output

Each check is displayed as ✅ (pass) or ❌ (fail with fix instruction).

On all checks passed:
```
All 6 checks passed. Run /specrails:get-backlog-specs to get started.
```

On failure:
```
❌ API key: not configured
   Fix: Run: claude config set api_key <your-key>  |  Get a key: https://console.anthropic.com/

1 check(s) failed.
```

## Exit codes

- `0` — all checks passed
- `1` — one or more checks failed

## Log file

Each run appends a timestamped summary to `~/.specrails/doctor.log`:

```
2026-03-20T10:00:00Z  checks=6 passed=6 failed=0
```

The `~/.specrails/` directory is created automatically if it does not exist.
