# Spec: Prerequisite Detection in install.sh

RFC: RFC-001 · Issue: SPEA-74

Defines the prerequisite detection gate added to `install.sh`. All checks run before any files are written to the target repository. The gate validates the environment in a fixed order and exits early on the first unrecoverable failure.

---

## Check Order

Checks execute in this fixed sequence:

1. Claude Code CLI
2. Claude API key
3. git
4. npm

All checks complete before any file system writes occur.

---

## Variables Set at Gate Entry

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLAUDE_BIN` | string | `""` | Path to `claude` binary if found |
| `GIT_PRESENT` | boolean | `false` | Whether `git` is detected |
| `NPM_PRESENT` | boolean | `false` | Whether `npm` is detected |

---

## Check 1: Claude Code CLI

| Attribute | Value |
|-----------|-------|
| Detection | `command -v claude` exits 0 |
| On success | Set `CLAUDE_BIN` to the resolved path; continue to Check 2 |
| On failure | Print error message (see below); `exit 1` |

**Failure output** (printed to stderr):
```
✗ Claude Code CLI not found.
  Install it: https://claude.ai/download
```

No stack trace. No additional output. Exit immediately after printing.

---

## Check 2: Claude API Key

| Attribute | Value |
|-----------|-------|
| Precondition | Check 1 passed (`CLAUDE_BIN` is set) |
| Detection | `claude config list` exits 0 AND output contains a non-empty `api_key` value, OR `ANTHROPIC_API_KEY` env var is non-empty |
| On success | Continue to Check 3 |
| On failure | Print error message (see below); `exit 1` |

**Failure output** (printed to stderr):
```
✗ No Claude API key configured.
  Set it: claude config set api_key <your-key>
  Get one: https://console.anthropic.com/
```

If `claude config list` itself fails (non-zero exit), treat as key not configured (same failure path).

---

## Check 3: git

| Attribute | Value |
|-----------|-------|
| Detection | `command -v git` exits 0 |
| On success | Set `GIT_PRESENT=true`; continue to Check 4 |
| On failure | Print warning; continue (non-fatal) |

**Warning output** (printed to stderr):
```
⚠  git not found. Some specrails features require git.
   Install it: https://git-scm.com/downloads
```

git absence is a **warning**, not a hard failure. Installation proceeds.

---

## Check 4: npm

| Attribute | Value |
|-----------|-------|
| Detection | `command -v npm` exits 0 |
| On success | Set `NPM_PRESENT=true`; gate complete, proceed to installation |
| On failure | Print message; continue (non-fatal) |

**npm absent output** (printed to stderr):
```
⚠  npm not found.
   Install Node.js + npm: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm
```

npm absence is a **warning**, not a hard failure. The nvm silent-install path is **not** attempted (see decision: fall-through to manual message is more reliable across custom shell configs). Installation proceeds.

---

## Behavior Matrix

| Claude CLI | API Key | git | npm | Outcome |
|-----------|---------|-----|-----|---------|
| ✓ | ✓ | ✓ | ✓ | All green; install proceeds |
| ✓ | ✓ | ✗ | ✓ | Warning for git; install proceeds |
| ✓ | ✓ | ✓ | ✗ | Warning for npm; install proceeds |
| ✓ | ✗ | — | — | Error + exit 1; nothing written |
| ✗ | — | — | — | Error + exit 1; nothing written |

Check order is strictly sequential. If Claude CLI check fails, API key check is skipped (marked `—`).

---

## Output Format Constraints

- Failure messages use `✗` prefix.
- Warning messages use `⚠` prefix.
- No ANSI color codes in failure/warning messages (they may be piped or logged).
- Error output goes to stderr (`>&2`).
- No stack traces, no internal variable dumps.

---

## Exit Codes

| Condition | Exit Code |
|-----------|-----------|
| All checks pass (warnings allowed) | `0` (implicit; installation continues) |
| Claude CLI missing | `1` |
| API key not configured | `1` |
