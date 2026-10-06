import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scaffoldInstallation } from '../phases/scaffold.js'
import { isDir, listDir, pathExists, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'

/**
 * Fresh-workspace invariant for every provider: the installer places commands,
 * workflow skills, provider settings and the runtime, and NO role artifact.
 * Roles (architect, developer, reviewer) are defined only by the programmatic
 * runtime (`src/agent-runtime/prompts.ts`); nothing about them is templated.
 */

/** Minimal fake package: the two runtime entry points, settings and the Kimi runner. */
async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'implement.md'), '/specrails:implement for {{PROJECT_NAME}}\n')
  writeFileLf(path.join(scriptDir, 'templates', 'commands', 'specrails', 'retry.md'), '/specrails:retry\n')
  writeFileLf(path.join(scriptDir, 'templates', 'settings', 'codex-config.toml'), 'model = "{{MODEL_NAME}}"\n')
  writeFileLf(path.join(scriptDir, 'templates', 'settings', 'gemini-settings.json'), '{\n  "experimental": { "enableAgents": true }\n}\n')
  writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'run-skill.mjs'), '// runner\n')
  for (const vendored of ['js-yaml.mjs', 'LICENSE', 'NOTICE.md']) {
    writeFileLf(path.join(scriptDir, 'templates', 'kimi', 'specrails', 'vendor', 'js-yaml', vendored), '// vendored\n')
  }
}

const PROVIDERS = [
  { provider: 'claude', providerDir: '.claude', workflow: path.join('commands', 'specrails', 'implement.md'), retired: ['agents', path.join('skills', 'rails')] },
  { provider: 'codex', providerDir: '.codex', workflow: path.join('skills', 'implement', 'SKILL.md'), retired: ['agents', path.join('skills', 'rails')] },
  { provider: 'gemini', providerDir: '.gemini', workflow: path.join('commands', 'specrails', 'implement.toml'), retired: ['agents', path.join('skills', 'rails')] },
  { provider: 'kimi', providerDir: '.kimi-code', workflow: path.join('skills', 'specrails-implement', 'SKILL.md'), retired: ['agents', 'commands', path.join('skills', 'rails')] },
] as const

describe('scaffoldInstallation — fresh workspace has no role artifact', () => {
  let tmpDir: string
  let prevSkipPrereqs: string | undefined
  let prevSkipOpenSpecInit: string | undefined
  let prevScriptDirOverride: string | undefined
  let prevCwd: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-scaffold-test-'))
    prevCwd = process.cwd()
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevSkipOpenSpecInit = process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    process.env.SPECRAILS_SKIP_PREREQS = '1'
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '1'
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevSkipPrereqs === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkipPrereqs
    if (prevSkipOpenSpecInit === undefined) delete process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    else process.env.SPECRAILS_SKIP_OPENSPEC_INIT = prevSkipOpenSpecInit
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it.each(PROVIDERS)('$provider receives its workflow and settings but no sr-* file, agents/ dir or agent-memory', async ({ provider, providerDir, workflow, retired }) => {
    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '6.3.0')
    writeFileLf(path.join(testRepoRoot, '.keep'), '')
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider,
      providerDir,
    })

    const providerRoot = path.join(testRepoRoot, providerDir)
    expect(pathExists(path.join(providerRoot, workflow)), workflow).toBe(true)
    for (const relative of retired) {
      expect(pathExists(path.join(providerRoot, relative)), `${providerDir}/${relative} must not exist`).toBe(false)
    }
    expect(pathExists(path.join(providerRoot, 'agent-memory'))).toBe(false)
    expect(pathExists(path.join(testRepoRoot, '.specrails', 'setup-templates', 'agents'))).toBe(false)

    // No `sr-*` role artifact anywhere under the provider dir.
    const roleArtifacts: string[] = []
    const walk = (dir: string): void => {
      for (const entry of listDir(dir)) {
        if (/^sr-(?!implement$)[a-z0-9-]+(\.md)?$/.test(path.basename(entry))) roleArtifacts.push(path.relative(testRepoRoot, entry))
        if (isDir(entry)) walk(entry)
      }
    }
    walk(providerRoot)
    expect(roleArtifacts).toEqual([])
  })
})
