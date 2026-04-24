## Why

specrails-core ships ~2,250 lines of POSIX shell scripts (`install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`) and a thin Node dispatcher that hard-codes `spawnSync("bash", ...)`. On Windows this fails immediately — there is no `bash` unless the user happens to have Git Bash installed, and even then the scripts depend on `python3` heredocs, GNU tool flags, and POSIX path conventions that trip over Windows realities (CRLF line endings, case-insensitive filesystems, `C:\` path prefixes).

specrails-hub just landed a Windows x64 desktop release that can spawn `claude`, but the moment a user tries the setup wizard the pipeline breaks on `npx specrails-core init` because the shell stack underneath is not Windows-compatible. Rather than ship a Git-Bash dispatcher shim (more external deps, double codebase, guaranteed drift), the better move is to retire the shell scripts entirely and make the installer native Node.

The benefit is not only Windows support: a Node installer is testable with the same `vitest` suite already used elsewhere in the project, has real error handling with stack traces instead of `set -euo pipefail` exits at obscure lines, and collapses two execution surfaces (bash + Node dispatcher) into one. Maintenance cost drops; contributor onboarding improves (no bash/python3 fluency required).

## What Changes

- **BREAKING (internal) — CLI execution surface:** `bin/specrails-core.js` no longer shells out to `install.sh` / `update.sh` / `bin/doctor.sh` / `bin/perf-check.sh`. Every subcommand is implemented as a Node module under `src/installer/**` and invoked in-process.
- **Removed dependency on `bash`, `python3`, `jq`, and GNU `sed`/`grep` flag extensions.** The installer uses Node built-ins (`fs`, `path`, `child_process`) and well-scoped deps (`js-yaml` for YAML I/O — existing transitive dep from `npx` scaffolding, already acceptable; a small list to be confirmed in `design.md`).
- **Cross-platform path handling.** All filesystem operations go through `path.join` / `path.resolve`. No POSIX assumptions (`/`, `:` as PATH separator, `~` expansion) leak into call sites.
- **Line-ending hygiene.** `.gitattributes` enforces LF in all text files published to npm so no `\r` contamination reaches user repos.
- **Delete retired shell scripts** at the end of the change: `install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`. They remain in archived history for audit.
- **Tests ported to vitest.** Any remaining `tests/*.sh` that exercised installer behaviour get paired (or replaced) Node-level tests. `tests/test-profiles.sh` (the "reserved paths" audit) becomes a vitest spec so it runs cross-platform in CI.
- **CI matrix expansion.** GitHub Actions workflow adds `windows-latest` and `ubuntu-latest` jobs alongside `macos-latest`; all three run the same vitest suite.

## Capabilities

### New Capabilities
<!-- none — scope is a reimplementation, not a new feature surface -->

### Modified Capabilities
- `npm-distribution`: the "CLI entry point" requirement no longer delegates to bash scripts — it delegates to in-process Node modules. "Zero runtime dependencies" may relax to permit a short, vetted list (tracked in design.md). Package contents change (`install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh` removed; `src/installer/**` added).

## Impact

- **Source code:** `bin/specrails-core.js` rewritten as a thin Node dispatcher that imports command handlers. New tree at `src/installer/**` (or equivalent — location fixed in design.md) containing the reimplemented logic.
- **Removed files:** `install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`, any `tests/*.sh` that duplicate coverage available via vitest.
- **Added files:** `.gitattributes` (LF enforcement), `src/installer/**/*.ts`, corresponding `src/installer/**/*.test.ts`.
- **Package footprint:** the `files` whitelist in `package.json` changes (`install.sh`/`update.sh` removed; `src/installer/dist/**` added if we compile). TypeScript output may bloat slightly; the net published tarball size remains comparable (shell scripts were large too).
- **External consumers:**
  - specrails-hub — already invokes `npx specrails-core init` via Node spawn; no hub code changes needed for the happy path. Hub's `spawnCoreInit` wrapper gains Windows support "for free" once core ships.
  - Direct `npx specrails-core init` users — CLI surface unchanged; zero migration.
  - Anyone currently running `install.sh` directly (undocumented) — break. Documented as unsupported entry point in README; removal counts as cleanup.
- **Platforms newly supported:** Windows 10 1809+ and Windows 11 (x64 + ARM64 via Node emulation). Linux support, which was technically present via bash, becomes a first-class CI-tested target.
- **Out of scope:** UX changes, new installer features, slash-command script rewrites in `commands/*.md` (those live in user projects post-install and are a separate concern tracked elsewhere).
