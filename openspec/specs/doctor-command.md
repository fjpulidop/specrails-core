# Spec: specrails doctor Command

RFC: RFC-001 · Issue: SPEA-74

Defines the `specrails doctor` command: a standalone health check that validates the local environment for specrails usage.

**Implementation has two surfaces:**
- `bin/doctor.sh` — authoritative shell implementation, callable without Claude Code active
- `commands/doctor.md` — Claude Code slash command `/doctor` that delegates to `bin/doctor.sh`
- `bin/specrails-core.js` — wires the `doctor` subcommand to `bin/doctor.sh`

---

## Invocation

| Surface | Invocation |
|---------|-----------|
| CLI (npx) | `npx specrails-core@latest doctor` |
| CLI (local) | `specrails-core doctor` |
| Shell direct | `bash bin/doctor.sh` |
| Claude Code | `/doctor` |

---

## Checks (Performed in Order)

| # | Check | Pass Condition | Failure Message |
|---|-------|---------------|-----------------|
| 1 | Claude Code CLI present | `command -v claude` exits 0 | `Install Claude Code: https://claude.ai/download` |
| 2 | Claude API key configured | `claude config list` shows non-empty `api_key` OR `ANTHROPIC_API_KEY` env var set | `Run: claude config set api_key <key>` |
| 3 | Agent files present | `agents/` dir exists AND contains ≥1 file named `AGENTS.md` (any depth) | `Run specrails-core init to set up agents` |
| 4 | CLAUDE.md exists | `CLAUDE.md` file present in repo root (CWD) | `CLAUDE.md missing — run /setup to regenerate` |
| 5 | Git initialized | `.git/` directory present in repo root (CWD) | `Not a git repo — initialize with: git init` |
| 6 | npm present | `command -v npm` exits 0 | `Install npm: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm` |

All 6 checks run regardless of individual failures (no early exit on check failure). All results are collected before output is printed.

---

## Variables

| Variable | Type | Description |
|----------|------|-------------|
| `CHECKS_TOTAL` | integer | Always `6` |
| `CHECKS_PASSED` | integer | Count of checks that passed |
| `CHECKS_FAILED` | integer | `CHECKS_TOTAL - CHECKS_PASSED` |
| `EXIT_CODE` | integer | `0` if all passed, `1` if any failed |

---

## Output Format

### All Checks Pass

```
specrails doctor

✅ Claude Code CLI: found (/usr/local/bin/claude)
✅ API key: configured
✅ Agent files: 4 agents found (ceo, cto, tech-lead, founding-engineer)
✅ CLAUDE.md: present
✅ Git: initialized
✅ npm: found (v10.2.3)

All checks passed. Run /specrails:get-backlog-specs to get started.
```

**Check 3 detail**: When agent files are found, print the count and a parenthetical list of agent directory names (derived from directories containing `AGENTS.md`). Example: `4 agents found (ceo, cto, tech-lead, founding-engineer)`.

**Check 1 detail**: When Claude Code CLI is found, print the resolved path. Example: `found (/usr/local/bin/claude)`.

**Check 6 detail**: When npm is found, print the version. Example: `found (v10.2.3)` (obtained via `npm --version`).

### One or More Checks Fail

```
specrails doctor

✅ Claude Code CLI: found
❌ API key: not configured
   Fix: claude config set api_key <your-key>
   Get a key: https://console.anthropic.com/
✅ Agent files: 3 agents found (ceo, cto, founding-engineer)
✅ CLAUDE.md: present
✅ Git: initialized
✅ npm: found (v10.2.3)

1 check failed.
```

- Failed checks use `❌` prefix.
- Failed checks include a `Fix:` line and optionally a reference URL, indented 3 spaces.
- Summary line: `N check failed.` (singular) or `N checks failed.` (plural).

---

## Behavior Matrix

| All checks pass | Exit Code | Summary line |
|:--------------:|-----------|-------------|
| Yes | `0` | `All checks passed. Run /specrails:get-backlog-specs to get started.` |
| No | `1` | `N check(s) failed.` |

---

## Logging

Each run appends one line to `~/.specrails/doctor.log`.

**Format:**
```
2026-03-20T10:00:00Z  checks=6 passed=6 failed=0
```

- Timestamp is UTC ISO 8601.
- `~/.specrails/` directory is created if it does not exist.
- No PII is logged. No file contents. No paths beyond the summary counts.
- Log write failure is silent (does not affect exit code).

---

## specrails-core.js Wiring

Add `doctor` to the `COMMANDS` map in `bin/specrails-core.js`:

```js
const COMMANDS = {
  init: "install.sh",
  update: "update.sh",
  doctor: "bin/doctor.sh",  // new
};
```

Update the help text to include the new subcommand:

```
specrails-core doctor                      Check environment health
```

---

## commands/doctor.md (Claude Code slash command)

The file `commands/doctor.md` contains a single instruction:

> Run `bash bin/doctor.sh` from the repo root and display the output.

The Claude Code command `/doctor` does not re-implement the checks — it delegates entirely to `bin/doctor.sh`. This ensures the shell and Claude Code surfaces stay in sync.

---

## Constraints

- All 6 checks run every time. No short-circuit on failure.
- Exit code `0` requires all 6 checks to pass.
- Log write errors are silent.
- The `/doctor` Claude Code command is the only Claude Code surface. No separate Claude Code check logic.
- Telemetry stub is **not** included (deferred to PRD-002).
