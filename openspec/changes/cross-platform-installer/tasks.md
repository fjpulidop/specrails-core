## 1. Phase 1 — TypeScript infrastructure + utilities

- [ ] 1.1 Add `typescript`, `vitest`, `@types/node`, `@types/js-yaml` as devDependencies. Add `js-yaml`, `@inquirer/prompts`, `picocolors` as runtime dependencies.
- [ ] 1.2 Create `tsconfig.json` targeting ESM Node 20+, `outDir: "dist"`, `rootDir: "src"`, `strict: true`, `noEmitOnError: true`.
- [ ] 1.3 Create `vitest.config.ts` with default Node env, `src/installer/**/*.test.ts` pattern, coverage thresholds matching repo conventions.
- [ ] 1.4 Add npm scripts: `build` (tsc), `build:watch` (tsc --watch), `test` (vitest run), `test:watch` (vitest), `typecheck` (tsc --noEmit), `prepack` (build).
- [ ] 1.5 Create `.gitattributes` enforcing `text eol=lf` for all `*.ts`, `*.js`, `*.md`, `*.json`, `*.yaml`, `*.yml`, `*.sh` files.
- [ ] 1.6 Implement `src/installer/util/logger.ts` with `step`, `ok`, `warn`, `fail`, `info` functions that emit the same emoji prefixes the bash scripts use (`✓ ⚠ ✗ →`). Use `picocolors` for ANSI output. Add unit tests.
- [ ] 1.7 Implement `src/installer/util/exec.ts` exporting `runCommand(cmd, args, opts)` that sets `shell: process.platform === 'win32'`, streams stdio by default, throws typed `ExecError` on non-zero exit. Add unit tests covering happy path, non-zero exit, stderr capture.
- [ ] 1.8 Implement `src/installer/util/fs.ts` with `mkdirp`, `copyFile`, `copyDir`, `writeFileLf` (forces LF on write), `pathExists`. Unit test with a `tmpdir` fixture.
- [ ] 1.9 Implement `src/installer/util/git.ts` wrapping `git init`, `git add`, `git commit`, `git rev-parse --show-toplevel`, `git status --porcelain`. Each function returns typed results; each throws `GitError` on shell failure. Unit tests mock `exec.ts`.
- [ ] 1.10 Implement `src/installer/util/prompts.ts` wrapping `@inquirer/prompts` with non-TTY detection that throws `PromptAbortError`. Unit tests simulate TTY and non-TTY.
- [ ] 1.11 Implement `src/installer/util/paths.ts` with reserved-path constants (`RESERVED_SPECRAILS_PATHS`, `RESERVED_CLAUDE_AGENT_PATHS`) and `isReservedPath(relPath)` helper. Unit tests.
- [ ] 1.12 Implement `src/installer/util/errors.ts` with typed error hierarchy: `InstallerError` (base), `PrerequisiteError`, `FilesystemError`, `GitError`, `ProviderError`, `ExecError`, `PromptAbortError`. Each carries an exit code used by the CLI dispatcher.
- [ ] 1.13 Implement `src/installer/cli.ts` skeleton: parse `process.argv`, route to placeholder handlers that currently just `console.log("TODO")` and exit 0. Wire in the typed error catch that translates to exit codes.
- [ ] 1.14 Update `bin/specrails-core.js` to conditionally dispatch: if `dist/installer/cli.js` exists, `require` it and call; otherwise fall through to the existing bash dispatch. This keeps the published binary working throughout Phases 1–4.
- [ ] 1.15 Expand `.github/workflows/ci.yml` to a matrix of `[macos-latest, ubuntu-latest, windows-latest]` × `[node-20, node-22]`. Each cell runs `npm ci && npm run typecheck && npm run build && npm test`.
- [ ] 1.16 Phase-1 smoke test: `npx specrails-core` (no args) on all three OSes prints usage and exits 0 via the new Node path. Confirm the bash scripts still handle every real subcommand unchanged.

## 2. Phase 2 — `init` command port

- [ ] 2.1 Implement `src/installer/phases/prereqs.ts` covering all 1.1–1.8 phases from the bash script: git repo check, provider detection (Claude / Codex), optional gum, agent-teams opt-in, API-key/authentication, npm, OpenSpec CLI, optional gh, OSS detection, optional JIRA CLI. Each check is its own exported function with a typed return. Unit-tested with mocked `exec` + `fs`.
- [ ] 2.2 Implement `src/installer/phases/provider-detect.ts` resolving Claude Code vs Codex from environment, CLI availability, and user prompt fallback.
- [ ] 2.3 Implement `src/installer/phases/install-config.ts` for read/merge/write of `.specrails/install-config.yaml` using `js-yaml`. Preserve comment-less round-trip shape matching the current bash output byte-for-byte where possible.
- [ ] 2.4 Implement `src/installer/phases/scaffold.ts` covering Phase 3 of the bash script: directory creation (`.specrails/`, `.claude/`, `.claude/agents/`, `.claude/commands/`), copying templates via the in-house renderer, writing per-provider instruction files.
- [ ] 2.5 Implement `src/installer/phases/manifest.ts` generating `specrails-manifest.json` and `specrails-version` files. Ensure JSON output is stable-sorted to produce deterministic byte output for the CI diff fixture.
- [ ] 2.6 Implement the in-house template renderer at `src/installer/util/template.ts`: `${VAR}` substitution + `{{#if VAR}}...{{/if}}` conditionals. Full unit-test coverage on every template feature used by the bash heredocs.
- [ ] 2.7 Wire all phase modules into `src/installer/commands/init.ts`. Map CLI flags (`--root-dir`, `--from-config`, `--provider`, `--tier`, `--yes`, `--skip-prereqs`) to the phase inputs. Delegate Quick-tier direct placement (Phase 3c in bash) to a branch inside `scaffold.ts`.
- [ ] 2.8 Pivot `bin/specrails-core.js` so that `init` dispatches to the Node handler unconditionally while `update`/`doctor`/`perf-check` still route to bash.
- [ ] 2.9 CI fixture: generate a reference `.specrails/` tree by running the bash `install.sh` on a scratch repo inside an `ubuntu-latest` job, upload as an artefact. Second job runs the Node `init` on the same scratch repo and diffs against the artefact; any delta fails the build. Repeat per `(provider, tier)` pair (4 fixtures total).
- [ ] 2.10 End-to-end smoke test on `windows-latest`: `npx specrails-core init --yes --provider claude --tier quick` in a temp git repo completes with exit 0 and produces the expected `.specrails/specrails-version` + `.claude/commands/specrails/*.md`.

## 3. Phase 3 — `update` command port

- [ ] 3.1 Implement `src/installer/commands/update.ts` covering `update.sh` logic: read existing `specrails-manifest.json`, identify changed templates, regenerate only those files while preserving reserved paths.
- [ ] 3.2 Reuse `phases/scaffold.ts`, `phases/manifest.ts`, and `phases/install-config.ts` wherever behaviour overlaps with `init`. Extract shared helpers rather than duplicating.
- [ ] 3.3 Map flags: `--only <section>`, `--dry-run` (new — cheap to add once modules exist), `--yes`, `--root-dir`.
- [ ] 3.4 Reserved-path audit: vitest spec that runs `update` on a fixture repo with pre-existing `.specrails/profiles/custom.json` and `.claude/agents/custom-foo.md` and asserts those files are byte-identical after update completes.
- [ ] 3.5 Pivot `bin/specrails-core.js` so `update` also dispatches to Node.
- [ ] 3.6 CI fixture: mirror the `init` byte-diff check for `update` starting from an already-installed repo.

## 4. Phase 4 — `doctor` + `perf-check` ports

- [ ] 4.1 Implement `src/installer/commands/doctor.ts` covering `bin/doctor.sh` diagnostics: check `.specrails/` structure, `.claude/` structure, manifest consistency, reserved-path integrity. Emit the same stdout format as the bash script (CI diff fixture enforces parity).
- [ ] 4.2 Implement `src/installer/commands/perf-check.ts` — trivial ~30-line port of `bin/perf-check.sh`.
- [ ] 4.3 Pivot `bin/specrails-core.js` so all subcommands dispatch to Node; the `exists(dist/installer/cli.js)` guard can be replaced with unconditional Node import.
- [ ] 4.4 Vitest spec: run `doctor` on a healthy install, assert exit 0 and the expected OK/WARN/FAIL tree. Run on a deliberately-broken install, assert exit code 1 and the expected warning lines.

## 5. Phase 5 — Shell script deletion

- [ ] 5.1 Delete `install.sh`, `update.sh`, `bin/doctor.sh`, `bin/perf-check.sh`.
- [ ] 5.2 Simplify `bin/specrails-core.js` to a plain `import` of `dist/installer/cli.js` — no conditional dispatch, no `require('child_process').spawnSync("bash", …)` anywhere.
- [ ] 5.3 Update `package.json#files` to drop the removed `.sh` paths and include `dist/installer/**`.
- [ ] 5.4 Update `README.md` to remove any `install.sh` / `update.sh` references.
- [ ] 5.5 Final canary: fresh `npx specrails-core@<next-version> init` in a temp repo on a clean `macos-14`, `ubuntu-22`, and `windows-11` VM (or CI ephemeral runner). Every run completes cleanly before the Phase 5 PR lands.
- [ ] 5.6 Release via release-please. Tag triggers a minor version bump (`feat(installer): port to node`).

## 6. Phase 6 — Test suite paridad + vitest consolidation

- [ ] 6.1 Port `tests/test-profiles.sh` (reserved-paths audit) to `src/installer/__tests__/reserved-paths.test.ts`. Cover the same matrix of install + update scenarios the bash test covered.
- [ ] 6.2 Port or replace any remaining `tests/*.sh` that exercise installer behaviour. Anything that only exercises user-project content (unrelated to the Node port) stays as-is and is tracked separately.
- [ ] 6.3 Remove the bash-test CI job. The vitest matrix becomes the sole gate.
- [ ] 6.4 Update `CONTRIBUTING.md` with the new dev flow: `npm run build:watch` + `npm test` instead of running `.sh` scripts directly.

## 7. Post-port verification

- [ ] 7.1 specrails-hub Windows setup wizard smoke test: install `specrails-hub` Windows x64 .exe, create a new project, run setup wizard end-to-end, verify project reaches "ready" state without falling back to any bash dependency.
- [ ] 7.2 Documentation pass: `docs/` under specrails-core drops every `install.sh` / `update.sh` / `bash` reference; `docs/windows.md` (new) describes Windows-specific expectations (Node ≥ 20, git ≥ 2.25, Claude Code CLI on PATH, WebView2 runtime for hub).
- [ ] 7.3 Announce in release notes + README: "specrails-core now runs natively on macOS, Linux, and Windows — no bash or python required."
