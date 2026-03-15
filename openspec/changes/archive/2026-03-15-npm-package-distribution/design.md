## Context

specrails distributes via curl-pipe (`curl | bash`) and local clone. The core logic lives in `install.sh` (scaffolding + template copy) and `update.sh` (selective sync). Both are pure bash, detect `SCRIPT_DIR` relative to themselves, and operate on any git repo.

Adding npm as a second channel means wrapping these scripts in a minimal Node CLI — no rewriting, no JS dependencies.

## Goals / Non-Goals

**Goals:**
- Publish `specrails` to npmjs.com so `npx specrails init` and `npx specrails update` work
- Zero JS dependencies — the npm package is a thin shim over existing bash
- Curl-pipe channel remains fully independent and unchanged
- Published package contains only what's needed (templates, scripts, shim)

**Non-Goals:**
- Rewriting install/update logic in JavaScript
- Making npm the primary or only channel
- Adding CLI features beyond `init` and `update` (can be added later)
- Windows support (bash required)

## Decisions

### 1. CLI shim delegates to bash via `execSync`

`bin/specrails.js` parses `process.argv` for the subcommand and calls the corresponding bash script with `child_process.execSync`. Inherits stdio so the user sees the same output as curl-pipe.

**Why not rewrite in JS?** The bash scripts are battle-tested, handle edge cases (pipe detection, migration, checksums), and are the single source of truth. Wrapping is simpler and eliminates divergence risk.

### 2. Zero dependencies

No commander, no chalk, no yargs. `process.argv[2]` gives the subcommand. `execSync` runs it. Error handling is a try/catch that forwards the exit code.

**Why?** specrails installs into any repo. Adding `node_modules` to the published package would be wasteful for a 30-line shim. Also keeps install via npx fast.

### 3. Package `files` whitelist

`package.json` uses `files` array to include only: `bin/`, `install.sh`, `update.sh`, `templates/`, `prompts/`, `.claude/skills/`, `commands/`. Everything else (docs, tests, openspec, `.claude/agents/`) is excluded.

**Why `files` over `.npmignore`?** Whitelist is safer — new files are excluded by default. `.npmignore` is a blacklist that can accidentally publish sensitive content.

### 4. Subcommand: `init` wraps `install.sh`, `update` wraps `update.sh`

```
npx specrails init [--root-dir <path>]   →  bash install.sh [--root-dir <path>]
npx specrails update [--only <component>] →  bash update.sh [--only <component>]
```

All arguments after the subcommand are forwarded to the bash script.

### 5. Package name: `specrails` (unscoped)

Verified available on npmjs.com. Shorter than `@specrails/cli`, easier to type with `npx`.

## Risks / Trade-offs

- **[bash required]** → npm users without bash (Windows without WSL) can't use it. Acceptable: specrails already requires bash, git, and a Unix shell. Document in package README.
- **[npx cache staleness]** → npx caches packages; users might get a stale version. Mitigated: `npx specrails@latest` forces fresh fetch. Document this for updates.
- **[name squatting]** → Someone could take the `specrails` name. Mitigated: publish promptly after implementation.
