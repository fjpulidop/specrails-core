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
 * behavior in placeQuickTierArtefacts.
 *
 * Key invariants under test:
 *  - CORE_AGENTS = {sr-architect, sr-developer, sr-reviewer} — NOT sr-merge-resolver
 *  - Fresh init (selectedAgents: undefined) places exactly the three core agents
 *  - Explicit selectedAgents list places that list PLUS the three core agents
 *  - update preserves previously-selected optional agents via install-config.yaml
 */


// ---------------------------------------------------------------------------
// Fake script-dir helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal fake scriptDir so scaffoldInstallation has templates
 * to copy. Includes agent templates for the three core agents plus any
 * extras passed in `extraAgents`.
 */
async function setupFakeScriptDir(
  scriptDir: string,
  version: string,
  extraAgents: string[] = [],
): Promise<void> {
  writeFileLf(path.join(scriptDir, 'VERSION'), `${version}\n`)

  const agentsSrc = path.join(scriptDir, 'templates', 'agents')
  const coreIds = ['sr-architect', 'sr-developer', 'sr-reviewer']
  for (const id of [...coreIds, ...extraAgents]) {
    writeFileLf(path.join(agentsSrc, `${id}.md`), `# ${id}\n`)
  }

  writeFileLf(path.join(scriptDir, 'templates', 'rules', 'general.md'), 'rules')
  writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
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

describe('placeQuickTierArtefacts — default agent placement', () => {
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
    // Include sr-merge-resolver and sr-test-writer in the template dir so
    // we can verify they are NOT placed when selectedAgents is undefined.
    await setupFakeScriptDir(scriptDir, '5.0.0', ['sr-merge-resolver', 'sr-test-writer'])
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider: 'claude',
      providerDir: '.claude',
      tier: 'quick',
      selectedAgents: undefined,
    })

    const placed = placedAgentIds(testRepoRoot)
    expect(placed.sort()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'].sort())
    expect(placed).not.toContain('sr-merge-resolver')
    expect(placed).not.toContain('sr-test-writer')
  })

  it('places sr-test-writer in addition to the three core agents when explicitly selected (opt-in works)', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0', ['sr-merge-resolver', 'sr-test-writer'])
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider: 'claude',
      providerDir: '.claude',
      tier: 'quick',
      selectedAgents: ['sr-test-writer'],
    })

    const placed = placedAgentIds(testRepoRoot)
    expect(placed).toContain('sr-architect')
    expect(placed).toContain('sr-developer')
    expect(placed).toContain('sr-reviewer')
    expect(placed).toContain('sr-test-writer')
    // sr-merge-resolver was not selected — should not appear
    expect(placed).not.toContain('sr-merge-resolver')
  })

  it('does NOT place sr-merge-resolver when selectedAgents is undefined', async () => {
    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')
    await setupFakeScriptDir(scriptDir, '5.0.0', ['sr-merge-resolver'])
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    scaffoldInstallation({
      scriptDir,
      artifactRoot: testRepoRoot,
      codeRoot: testRepoRoot,
      provider: 'claude',
      providerDir: '.claude',
      tier: 'quick',
      selectedAgents: undefined,
    })

    const placed = placedAgentIds(testRepoRoot)
    expect(placed).not.toContain('sr-merge-resolver')
  })
})

// ---------------------------------------------------------------------------
// Update — optional-agent preservation via install-config.yaml
// ---------------------------------------------------------------------------

describe('update — optional-agent preservation', () => {
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

  it('re-places a previously-selected optional agent (sr-test-writer) on update', async () => {
    const { runUpdate } = await import('../commands/update.js')

    const scriptDir = path.join(tmpDir, 'core')
    const testRepoRoot = path.join(tmpDir, 'repo')

    // Install-config declares sr-test-writer as selected (simulates prior install)
    await setupFakeScriptDir(scriptDir, '5.0.0', ['sr-test-writer', 'sr-merge-resolver'])
    mkdirp(testRepoRoot)
    await initRepo(testRepoRoot)
    process.env.SPECRAILS_CORE_SCRIPT_DIR = scriptDir

    // Simulate an existing relocate-always install: marker/manifest in workspace.
    const ws = workspaceFor(testRepoRoot)
    writeFileLf(path.join(ws, '.specrails', 'specrails-version'), '4.0.0\n')
    writeFileLf(
      path.join(ws, '.specrails', 'specrails-manifest.json'),
      JSON.stringify({ version: '4.0.0', installed_at: '2026-01-01T00:00:00Z', artifacts: {} }),
    )
    mkdirp(path.join(ws, '.claude', 'commands', 'specrails'))

    // install-config.yaml is a USER file → stays in the repo (read from repoRoot).
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
    // Optional agent that was in install-config must be re-placed
    expect(placed).toContain('sr-test-writer')
    // Core agents always placed
    expect(placed).toContain('sr-architect')
    expect(placed).toContain('sr-developer')
    expect(placed).toContain('sr-reviewer')
    // sr-merge-resolver was not in selected — should not appear
    expect(placed).not.toContain('sr-merge-resolver')
  })
})
