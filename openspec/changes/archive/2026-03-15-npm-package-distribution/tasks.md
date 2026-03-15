## 1. Package Configuration

- [x] 1.1 Create `package.json` at repo root with name `specrails`, version matching `.specrails-version`, `bin` entry pointing to `bin/specrails.js`, `files` whitelist, `engines.node >= 18.0.0`, no dependencies
- [x] 1.2 Verify `files` whitelist excludes `openspec/`, `tests/`, `docs/`, `.claude/agents/`, `.claude/agent-memory/`, `.claude/rules/`, `.claude/commands/` by running `npm pack --dry-run` and inspecting output

## 2. CLI Shim

- [x] 2.1 Create `bin/specrails.js` with hashbang, subcommand parsing (`init` → `install.sh`, `update` → `update.sh`), argument forwarding, exit code propagation, and usage help for no/unknown subcommand
- [x] 2.2 Make `bin/specrails.js` executable (`chmod +x`)

## 3. Verification

- [x] 3.1 Test `node bin/specrails.js` with no args shows usage help and exits 0
- [x] 3.2 Test `node bin/specrails.js foo` shows error and exits 1
- [x] 3.3 Test `npm pack --dry-run` includes only whitelisted files
- [x] 3.4 Test `npx . init --root-dir /tmp/test-repo` runs install.sh successfully against a test repo
