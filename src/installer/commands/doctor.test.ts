import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  copyFile,
  isFile,
  mkdirp,
  readTextFile,
  writeFileLf,
} from '../util/fs.js'
import { runCommand } from '../util/exec.js'
import { initRepo } from '../util/git.js'
import {
  buildManifest,
  writeManifestFiles,
} from '../phases/manifest.js'
import { KIMI_REQUIRED_OPENSPEC_SKILLS } from './init.js'
import {
  KIMI_MANAGED_WORKFLOW_SKILLS,
  runDoctor,
} from './doctor.js'

describe('runDoctor', () => {
  let tmpDir: string
  let prevCwd: string
  let prevPath: string | undefined
  let prevKimiHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-doctor-test-'))
    prevCwd = process.cwd()
    prevPath = process.env.PATH
    prevKimiHome = process.env.KIMI_CODE_HOME
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevKimiHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = prevKimiHome
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('reports failures for an empty directory', async () => {
    const result = await runDoctor({ 'root-dir': tmpDir })
    expect(result.failed).toBeGreaterThan(0)
    // Must mention missing provider agents dir and missing CLAUDE.md.
    const messages = result.results.map((r) => r.message).join('\n')
    expect(messages).toMatch(/\.claude\/agents directory not found/)
    expect(messages).toMatch(/CLAUDE\.md: missing/)
  })

  it('passes agent + CLAUDE.md + git checks when they are present', async () => {
    const repoRoot = path.join(tmpDir, 'repo')
    mkdirp(repoRoot)
    await initRepo(repoRoot)
    writeFileLf(path.join(repoRoot, 'CLAUDE.md'), '# project')
    writeFileLf(path.join(repoRoot, '.claude', 'agents', 'sr-architect.md'), 'arch agent')
    writeFileLf(path.join(repoRoot, '.claude', 'agents', 'sr-developer.md'), 'dev agent')

    const result = await runDoctor({ 'root-dir': repoRoot })
    const passes = result.results.filter((r) => r.kind === 'pass').map((r) => r.message).join('\n')
    expect(passes).toContain('Git: initialized')
    expect(passes).toContain('CLAUDE.md: present')
    expect(passes).toMatch(/Agent files: 2 agent\(s\) found in \.claude\/agents/)
  })

  async function setupHealthyKimiRepo(
    repoRoot = path.join(tmpDir, 'repo-kimi'),
  ): Promise<string> {
    const binDir = path.join(tmpDir, 'bin')
    const kimiHome = path.join(tmpDir, 'kimi-home')
    mkdirp(repoRoot)
    mkdirp(binDir)
    await initRepo(repoRoot)
    const kimi = path.join(binDir, 'kimi')
    writeFileLf(
      kimi,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "kimi-code 0.27.0"; exit 0; fi',
        'if [ "$1" = "doctor" ]; then exit 0; fi',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(kimi, 0o755)
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`
    process.env.KIMI_CODE_HOME = kimiHome
    writeFileLf(
      path.join(kimiHome, 'credentials', 'kimi-code.json'),
      '{"credential":"never-read"}\n',
    )

    writeFileLf(path.join(repoRoot, '.kimi-code', 'AGENTS.md'), '# Kimi')
    writeFileLf(path.join(repoRoot, '.kimi-code', 'mcp.json'), '{"mcpServers":{}}\n')
    for (const relative of [
      'run-skill.mjs',
      path.join('vendor', 'js-yaml', 'js-yaml.mjs'),
      path.join('vendor', 'js-yaml', 'LICENSE'),
      path.join('vendor', 'js-yaml', 'NOTICE.md'),
    ]) {
      copyFile(
        path.join(process.cwd(), 'templates', 'kimi', 'specrails', relative),
        path.join(repoRoot, '.kimi-code', 'specrails', relative),
      )
    }
    for (const role of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      writeFileLf(
        path.join(repoRoot, '.kimi-code', 'skills', role, 'SKILL.md'),
        `---\nname: ${role}\ndescription: role\n---\n`,
      )
    }
    for (const workflow of KIMI_MANAGED_WORKFLOW_SKILLS) {
      writeFileLf(
        path.join(repoRoot, '.kimi-code', 'skills', workflow, 'SKILL.md'),
        `---\nname: ${workflow}\ndescription: workflow\n---\n`,
      )
    }
    for (const skill of KIMI_REQUIRED_OPENSPEC_SKILLS) {
      writeFileLf(
        path.join(repoRoot, '.kimi-code', 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: openspec\n---\n`,
      )
    }
    const packageJson = JSON.parse(
      readTextFile(path.join(process.cwd(), 'package.json')),
    ) as { version: string }
    writeManifestFiles(
      repoRoot,
      buildManifest({
        scriptDir: process.cwd(),
        repoRoot,
        version: packageJson.version,
        installedAt: '2026-07-20T00:00:00Z',
        providers: ['kimi'],
        primaryProvider: 'kimi',
      }),
    )
    return repoRoot
  }

  it.skipIf(process.platform === 'win32')(
    'checks a healthy Kimi install without requiring Claude',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const messages = result.results.map((entry) => entry.message).join('\n')
      expect(result.failed).toBe(0)
      expect(messages).toContain('Kimi Code CLI: found')
      expect(messages).toContain('Kimi Code version: kimi-code 0.27.0')
      expect(messages).toContain('Kimi: authentication evidence found')
      expect(messages).toContain('Role skills: 3 agent(s)')
      expect(messages).toContain(
        'Kimi headless skill runner: complete managed bundle integrity verified',
      )
      expect(messages).toContain(
        `Kimi workflow skills: all ${KIMI_MANAGED_WORKFLOW_SKILLS.length} managed workflows present`,
      )
      expect(messages).toContain('Kimi OpenSpec skills: all 11 present')
      expect(messages).toContain('.kimi-code/mcp.json: valid (0 server(s))')
      expect(messages).toContain('SpecRails manifest: valid for Core')
      expect(messages).not.toContain('Claude Code CLI')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'honours the manifest primary provider in a mixed-provider workspace',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(path.join(repoRoot, '.gemini', 'GEMINI.md'), '# Gemini')

      const result = await runDoctor({ 'root-dir': repoRoot })
      const messages = result.results.map((entry) => entry.message).join('\n')
      expect(messages).toContain('Kimi Code CLI: found')
      expect(messages).not.toContain('Gemini CLI')
      expect(messages).not.toContain('Claude Code CLI')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'preserves Gemini before Codex, Kimi, and Claude in directory fallback',
    async () => {
      const repoRoot = path.join(tmpDir, 'mixed-provider-repo')
      const binDir = path.join(tmpDir, 'mixed-provider-bin')
      mkdirp(binDir)
      for (const providerDir of [
        '.claude',
        '.codex',
        '.gemini',
        '.kimi-code',
      ]) {
        mkdirp(path.join(repoRoot, providerDir))
      }
      const gemini = path.join(binDir, 'gemini')
      writeFileLf(gemini, '#!/bin/sh\nexit 0\n')
      chmodSync(gemini, 0o755)
      process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`

      const result = await runDoctor({ 'root-dir': repoRoot })
      const messages = result.results.map((entry) => entry.message).join('\n')
      expect(messages).toContain('Gemini CLI: found')
      expect(messages).not.toContain('Claude Code CLI')
      expect(messages).not.toContain('Kimi Code CLI')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'reports a missing managed Kimi headless skill runner',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      rmSync(
        path.join(repoRoot, '.kimi-code', 'specrails', 'run-skill.mjs'),
        { force: true },
      )
      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const missing = result.results.find((entry) =>
        entry.message.includes('headless skill runner'),
      )
      expect(missing?.kind).toBe('fail')
      expect(missing?.fix).toContain('update --provider kimi')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'reports an incomplete managed Kimi runner vendor bundle',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      rmSync(
        path.join(
          repoRoot,
          '.kimi-code',
          'specrails',
          'vendor',
          'js-yaml',
          'js-yaml.mjs',
        ),
        { force: true },
      )
      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const missing = result.results.find((entry) =>
        entry.message.includes('headless skill runner'),
      )
      expect(missing?.kind).toBe('fail')
      expect(missing?.message).toContain('vendor/js-yaml/js-yaml.mjs')
      expect(missing?.fix).toContain('update --provider kimi')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'reports a managed Kimi runner whose installed bytes were modified',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(
        path.join(repoRoot, '.kimi-code', 'specrails', 'run-skill.mjs'),
        '// tampered managed runner\n',
      )

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const mismatch = result.results.find((entry) =>
        entry.message.includes('headless skill runner'),
      )
      expect(mismatch?.kind).toBe('fail')
      expect(mismatch?.message).toContain('content mismatch')
      expect(mismatch?.message).toContain('run-skill.mjs')
      expect(mismatch?.fix).toContain('update --provider kimi')
    },
  )

  it('rejects an explicit unsupported provider instead of auto-detecting', async () => {
    await expect(
      runDoctor({ 'root-dir': tmpDir, provider: 'unsupported' }),
    ).rejects.toThrow(
      "--provider value must be 'claude', 'codex', 'gemini', or 'kimi'",
    )
    await expect(
      runDoctor({ 'root-dir': tmpDir, provider: true }),
    ).rejects.toThrow(
      "--provider value must be 'claude', 'codex', 'gemini', or 'kimi'",
    )
  })

  it.skipIf(process.platform === 'win32')(
    'reports stale legacy OpenSpec output with update remediation',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(
        path.join(repoRoot, '.kimi', 'skills', 'openspec-apply-change', 'SKILL.md'),
        'legacy\n',
      )
      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const stale = result.results.find((entry) => entry.message.includes('stale generated'))
      expect(stale?.kind).toBe('fail')
      expect(stale?.fix).toContain('update --provider kimi')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'reports nested Kimi roles that the direct-child skill loader cannot discover',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(
        path.join(
          repoRoot,
          '.kimi-code',
          'skills',
          'rails',
          'custom-conflict',
          'SKILL.md',
        ),
        'legacy nested role\n',
      )
      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const stale = result.results.find((entry) =>
        entry.message.includes('stale nested skills/rails layout'),
      )
      expect(stale?.kind).toBe('fail')
      expect(stale?.fix).toContain('update --provider kimi')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'checks every managed Kimi workflow, not only the execution happy path',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      expect(KIMI_MANAGED_WORKFLOW_SKILLS.length).toBeGreaterThan(4)
      const workflow = 'specrails-why'
      expect(KIMI_MANAGED_WORKFLOW_SKILLS).toContain(workflow)
      rmSync(
        path.join(repoRoot, '.kimi-code', 'skills', workflow, 'SKILL.md'),
        { force: true },
      )

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const catalog = result.results.find((entry) =>
        entry.message.includes('Kimi workflow skills'),
      )
      expect(catalog?.kind).toBe('fail')
      expect(catalog?.message).toContain(workflow)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects malformed Kimi MCP JSON',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(path.join(repoRoot, '.kimi-code', 'mcp.json'), '{not json}\n')

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const mcp = result.results.find((entry) =>
        entry.message.includes('.kimi-code/mcp.json'),
      )
      expect(mcp?.kind).toBe('fail')
      expect(mcp?.message).toContain('not valid JSON')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects invalid Kimi MCP container and server shapes',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      const mcpPath = path.join(repoRoot, '.kimi-code', 'mcp.json')
      writeFileLf(mcpPath, '{"mcpServers":[]}\n')

      let result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      let mcp = result.results.find((entry) =>
        entry.message.includes('.kimi-code/mcp.json'),
      )
      expect(mcp?.kind).toBe('fail')
      expect(mcp?.message).toContain('mcpServers must be an object')

      writeFileLf(
        mcpPath,
        '{"mcpServers":{"broken":{"transport":"stdio","command":"","args":[1]}}}\n',
      )
      result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      mcp = result.results.find((entry) =>
        entry.message.includes('.kimi-code/mcp.json'),
      )
      expect(mcp?.kind).toBe('fail')
      expect(mcp?.message).toContain('command must be a non-empty string')
      expect(mcp?.message).toContain('args must be an array of strings')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a manifest whose version marker does not match',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      writeFileLf(
        path.join(repoRoot, '.specrails', 'specrails-version'),
        'different-version\n',
      )

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const manifest = result.results.find((entry) =>
        entry.message.includes('SpecRails manifest'),
      )
      expect(manifest?.kind).toBe('fail')
      expect(manifest?.message).toContain(
        'specrails-version marker does not match manifest version',
      )
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a self-consistent manifest from a different Core version',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      const manifestPath = path.join(
        repoRoot,
        '.specrails',
        'specrails-manifest.json',
      )
      const manifest = JSON.parse(readTextFile(manifestPath)) as {
        version: string
      }
      manifest.version = '0.0.1'
      writeFileLf(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      writeFileLf(
        path.join(repoRoot, '.specrails', 'specrails-version'),
        '0.0.1\n',
      )

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const validation = result.results.find((entry) =>
        entry.message.includes('SpecRails manifest'),
      )
      expect(validation?.kind).toBe('fail')
      expect(validation?.message).toContain(
        'version 0.0.1 does not match running Core',
      )
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects tampered manifest checksums and inconsistent provider metadata',
    async () => {
      const repoRoot = await setupHealthyKimiRepo()
      const manifestPath = path.join(
        repoRoot,
        '.specrails',
        'specrails-manifest.json',
      )
      const manifest = JSON.parse(readTextFile(manifestPath)) as {
        providers: string[]
        primary_provider: string
        artifacts: Record<string, string>
      }
      const firstArtifact = Object.keys(manifest.artifacts)[0]!
      manifest.artifacts[firstArtifact] = `sha256:${'0'.repeat(64)}`
      manifest.providers = ['kimi']
      manifest.primary_provider = 'claude'
      writeFileLf(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const result = await runDoctor({ 'root-dir': repoRoot, provider: 'kimi' })
      const validation = result.results.find((entry) =>
        entry.message.includes('SpecRails manifest'),
      )
      expect(validation?.kind).toBe('fail')
      expect(validation?.message).toContain('artifacts checksum mismatch')
      expect(validation?.message).toContain(
        'primary_provider must also appear in providers',
      )
    },
  )

  it('recognizes a linked Git worktree whose .git entry is a file', async () => {
    const mainRepo = path.join(tmpDir, 'main-repo')
    const worktree = path.join(tmpDir, 'linked-worktree')
    mkdirp(mainRepo)
    await initRepo(mainRepo)
    await runCommand(
      'git',
      [
        '-c',
        'user.name=SpecRails Test',
        '-c',
        'user.email=specrails@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: mainRepo, inherit: false },
    )
    await runCommand(
      'git',
      ['worktree', 'add', '--detach', worktree],
      { cwd: mainRepo, inherit: false },
    )
    expect(isFile(path.join(worktree, '.git'))).toBe(true)
    writeFileLf(path.join(worktree, 'CLAUDE.md'), '# linked worktree')
    writeFileLf(
      path.join(worktree, '.claude', 'agents', 'sr-architect.md'),
      'agent\n',
    )

    const result = await runDoctor({
      'root-dir': worktree,
      provider: 'claude',
    })
    const git = result.results.find((entry) => entry.message.startsWith('Git:'))
    expect(git).toEqual({ kind: 'pass', message: 'Git: initialized' })
  })
})
