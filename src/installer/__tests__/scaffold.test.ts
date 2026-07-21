import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CORE_AGENTS, scaffoldInstallation } from '../phases/scaffold.js'
import { listDir, mkdirp, pathExists, writeFileLf } from '../util/fs.js'
import { initRepo } from '../util/git.js'
import { resolveArtifacts } from '../util/registry.js'

/**
 * Tests for the CORE_AGENTS constant and the default agent-selection
 * behavior in placeArtefacts.
 *
 * Key invariants under test (v5):
 *  - CORE_AGENTS = {sr-architect, sr-developer, sr-reviewer} — the COMPLETE shipped set
 *  - Fresh init (selectedAgents: undefined) places exactly the three core agents
 *  - A selection entry with no shipped template is ignored (stale v4 configs)
 *  - update places only the core trio even when a pre-v5 install-config.yaml
 *    still selects removed agents
 */


// ---------------------------------------------------------------------------
// Fake script-dir helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal fake scriptDir so scaffoldInstallation has templates
 * to copy. Mirrors the real v5 package: agent templates exist for the
 * three core agents ONLY.
 */
async function setupFakeScriptDir(scriptDir: string, version: string): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)

  const agentsSrc = path.join(scriptDir, 'templates', 'agents')
  for (const id of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
    writeFileLf(path.join(agentsSrc, `${id}.md`), `# ${id}\n`)
  }

  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
  writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
}

function placedAgentIds(repoRootArg: string, providerDir = '.claude'): string[] {
  const agentsDir = path.join(repoRootArg, providerDir, 'agents')
  if (!pathExists(agentsDir)) return []
  return listDir(agentsDir)
    .map((p) => path.basename(p))
    .filter((n) => n.endsWith('.md') && !n.startsWith('custom-'))
    .map((n) => n.replace(/\.md$/, ''))
}

// ---------------------------------------------------------------------------
// Shared test harness
// ---------------------------------------------------------------------------

describe('CORE_AGENTS constant', () => {
  it('contains exactly sr-architect, sr-developer, sr-reviewer', () => {
    expect([...CORE_AGENTS].sort()).toEqual(
      ['sr-architect', 'sr-developer', 'sr-reviewer'].sort(),
    )
  })

  it('does NOT contain sr-merge-resolver', () => {
    expect(CORE_AGENTS.has('sr-merge-resolver')).toBe(false)
  })

  it('has exactly 3 members', () => {
    expect(CORE_AGENTS.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// placeQuickTierArtefacts default behavior
// ---------------------------------------------------------------------------

describe('placeArtefacts — default agent placement', () => {
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

  it('places exactly the three core agents when selectedAgents is undefined (fresh init)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider: 'claude',
      providerDir: '.claude',
      selectedAgents: undefined,
    })

    const placed = placedAgentIds(testRepoRoot)
    expect(placed.sort()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'].sort())
  })

  it('ignores a selected agent that has no shipped template (stale v4 selection)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider: 'claude',
      providerDir: '.claude',
      // A pre-v5 config may still select removed agents — no template exists,
      // so the entries are ignored and only the core trio lands.
      selectedAgents: ['sr-test-writer', 'sr-merge-resolver'],
    })

    const placed = placedAgentIds(testRepoRoot)
    expect(placed.sort()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'].sort())
  })
})

// ---------------------------------------------------------------------------
// Update — optional-agent preservation via install-config.yaml
// ---------------------------------------------------------------------------

describe('update — stale v4 selection handling', () => {
  let tmpDir: string
  let registryHome: string
  let prevSkipPrereqs: string | undefined
  let prevSkipOpenSpecInit: string | undefined
  let prevScriptDirOverride: string | undefined
  let prevRegistryHome: string | undefined
  let prevCwd: string

  function workspaceFor(repoRoot: string): string {
    return resolveArtifacts(repoRoot, {
      allocate: true,
      home: registryHome,
      providers: ['claude'],
    }).artifactRoot
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-test-'))
    registryHome = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-home-'))
    prevCwd = process.cwd()
    prevSkipPrereqs = process.env.SPECRAILS_SKIP_PREREQS
    prevSkipOpenSpecInit = process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    prevScriptDirOverride = process.env.SPECRAILS_CORE_SCRIPT_DIR
    prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_SKIP_PREREQS = '1'
    process.env.SPECRAILS_SKIP_OPENSPEC_INIT = '1'
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevSkipPrereqs === undefined) delete process.env.SPECRAILS_SKIP_PREREQS
    else process.env.SPECRAILS_SKIP_PREREQS = prevSkipPrereqs
    if (prevSkipOpenSpecInit === undefined) delete process.env.SPECRAILS_SKIP_OPENSPEC_INIT
    else process.env.SPECRAILS_SKIP_OPENSPEC_INIT = prevSkipOpenSpecInit
    if (prevScriptDirOverride === undefined) delete process.env.SPECRAILS_CORE_SCRIPT_DIR
    else process.env.SPECRAILS_CORE_SCRIPT_DIR = prevScriptDirOverride
    if (prevRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(registryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('places only the core trio when a pre-v5 install-config still selects removed agents', async () => {
    const { runUpdate } = await import('../commands/update.js')

    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')

    await setupFakeScriptDir(scriptDir, '5.0.0')
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    // Simulate an existing relocate-always install: marker/manifest in workspace,
    // plus a stale removed-agent file left behind by a v4 install.
    const ws = workspaceFor(testRepoRoot)
    writeFileLf(path.join(ws, '.specrails', 'specrails-version'), '4.0.0\n')
    writeFileLf(
      path.join(ws, '.specrails', 'specrails-manifest.json'),
      JSON.stringify({ version: '4.0.0', installed_at: '2026-01-01T00:00:00Z', artifacts: {} }),
    )
    mkdirp(path.join(ws, '.claude', 'commands', 'specrails'))
    writeFileLf(path.join(ws, '.claude', 'agents', 'sr-test-writer.md'), '# stale v4 agent')

    // install-config.yaml is a USER file → stays in the repo (read from repoRoot).
    // It carries pre-v5 fields (tier, removed agents) that must be tolerated.
    const installConfigYaml = [
      'version: 1',
      'provider: claude',
      'tier: quick',
      'agents:',
      '  selected: [sr-architect, sr-developer, sr-reviewer, sr-test-writer]',
      '  excluded: [sr-merge-resolver, sr-product-manager, sr-product-analyst]',
      'models:',
      '  preset: balanced',
      '  defaults: { model: sonnet }',
      '  overrides: {}',
      '',
    ].join('\n')
    writeFileLf(
      path.join(testRepoRoot, '.specrails', 'install-config.yaml'),
      installConfigYaml,
    )

    await runUpdate({ 'root-dir': testRepoRoot })

    const placed = placedAgentIds(ws)
    // Core agents placed; the stale selection entry has no template and the
    // v5 migration removed the leftover file — it must NOT survive the update.
    expect(placed.sort()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'].sort())
    expect(pathExists(path.join(ws, '.claude', 'agents', 'sr-test-writer.md'))).toBe(false)
  })
})
