import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Test safety net: NEVER let a test write the relocation registry (or scaffold
 * a workspace) into the developer's real `$HOME/.specrails`.
 *
 * `resolveArtifacts({ allocate: true })` — reached via `runInit`/`runUpdate` —
 * resolves the registry + workspace base from `resolveHome()`, which falls back
 * to `os.homedir()` when neither a `home` arg nor `SPECRAILS_REGISTRY_HOME` is
 * set. A test that drives init/update without pinning a tmp home would then
 * pollute the real `~/.specrails/registry.json`. This setup file (run once per
 * test file by vitest `setupFiles`) points `SPECRAILS_REGISTRY_HOME` at a
 * throwaway tmp dir unless the test has already set its own, so the real home
 * is unreachable from tests by construction.
 */
if (!process.env.SPECRAILS_REGISTRY_HOME) {
  process.env.SPECRAILS_REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'specrails-test-home-'))
}
