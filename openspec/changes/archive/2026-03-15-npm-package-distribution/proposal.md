## Why

specrails currently distributes via curl-pipe (`curl | bash`) and requires a local clone for updates. This works but limits discoverability and makes updates friction-heavy. Publishing to npm as a thin wrapper adds a second distribution channel — `npx specrails init` / `npx specrails update` — without rewriting any logic. npm handles versioning, caching, and always-latest fetching via npx.

## What Changes

- Add `package.json` at repo root with `bin` entry pointing to a CLI shim
- Add `bin/specrails.js` — minimal Node script (~30 lines) that delegates to `install.sh` and `update.sh` via `execSync`
- Add `.npmignore` to exclude dev/docs files from the published package
- No changes to `install.sh` or `update.sh` — they remain the single source of truth
- No JS dependencies — zero `node_modules`
- Curl-pipe channel remains fully functional and independent

## Capabilities

### New Capabilities
- `npm-distribution`: npm package that wraps existing bash scripts as `npx specrails init|update`, with proper `package.json`, CLI shim, and `.npmignore`

### Modified Capabilities
<!-- No existing spec requirements change. The bash scripts are untouched. -->

## Impact

- New files: `package.json`, `bin/specrails.js`, `.npmignore`
- No changes to existing installation or update logic
- Requires an npmjs.com account to publish
- Users with Node can use `npx specrails init` as alternative to curl-pipe
- Users without Node continue using curl-pipe unchanged
