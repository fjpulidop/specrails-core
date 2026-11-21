import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { admitVerificationProposals, packageScriptOf, runsRepositoryScript } from './verification-proposals.js'
import type { PipelineContext } from '../pipeline/pipeline-state.js'

describe('packageScriptOf', () => {
  it('names the one script a package-manager command runs', () => {
    expect(packageScriptOf({ command: 'npm', args: ['test'] })).toBe('test')
    expect(packageScriptOf({ command: 'npm', args: ['run', 'test:e2e'] })).toBe('test:e2e')
    expect(packageScriptOf({ command: 'npm', args: ['run-script', 'build'] })).toBe('build')
    expect(packageScriptOf({ command: 'pnpm', args: ['run', 'e2e'] })).toBe('e2e')
    expect(packageScriptOf({ command: 'pnpm', args: ['e2e'] })).toBe('e2e')
    expect(packageScriptOf({ command: 'yarn', args: ['test:e2e'] })).toBe('test:e2e')
  })
  it('rejects anything else: extra arguments, other tools, flags, bare installs', () => {
    expect(packageScriptOf({ command: 'npm', args: ['run', 'e2e', '--', '--grep', 'x'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npm', args: ['install'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npm', args: ['test', '--watch'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npx', args: ['playwright', 'test'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'yarn', args: ['--version'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'sh', args: ['-c', 'npm test'] })).toBeUndefined()
  })
})

describe('repository script proposals next to configured checks', () => {
  // The deckdex-mtg shape: pytest is configured, the change adds a real-container startup check.
  const repo = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'proposals-'))
    mkdirSync(path.join(root, 'scripts'))
    writeFileSync(path.join(root, 'scripts/check_backend_startup.py'), 'print("ok")\n')
    return root
  }
  const configured = (root: string) => [{ repositoryId: 'app', command: '.venv/bin/python', args: ['-m', 'pytest'], cwd: root }]
  const context = (root: string) => ({ repositories: [{ id: 'app', name: 'App', path: root }] }) as unknown as PipelineContext

  it('admits a file the repository holds, run by a plain interpreter', () => {
    const root = repo()
    try {
      const proposals = [
        { repositoryId: 'app', command: 'python3.11', args: ['scripts/check_backend_startup.py', '--diagnose-baseline'] },
        { repositoryId: 'app', command: 'python3.11', args: ['scripts/check_backend_startup.py'] },
      ]
      // Acceptance scripts get the 60-minute limit; the configured tests keep the ordinary default.
      expect(admitVerificationProposals(context(root), configured(root), proposals, command => command)).toEqual(proposals.map(proposal => ({ ...proposal, timeoutMs: 60 * 60_000 })))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('still refuses arbitrary commands, inline code, missing files and paths outside the repository', () => {
    const root = repo()
    try {
      const refused = [
        { repositoryId: 'app', command: 'docker', args: ['compose', 'up'] },
        { repositoryId: 'app', command: 'python3', args: ['-c', 'import os'] },
        { repositoryId: 'app', command: 'bash', args: ['scripts/missing.sh'] },
        { repositoryId: 'app', command: 'python3', args: ['../outside.py'] },
        { repositoryId: 'app', command: 'python3', args: ['/etc/passwd'] },
        { repositoryId: 'app', command: 'curl', args: ['scripts/check_backend_startup.py'] },
      ]
      expect(admitVerificationProposals(context(root), configured(root), refused, command => command)).toEqual([])
      expect(runsRepositoryScript(root, { command: '.venv/bin/python', args: ['scripts/check_backend_startup.py'] })).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

it('keeps the ordinary limit for package scripts and an explicit timeout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proposals-'))
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }))
    writeFileSync(path.join(root, 'check.sh'), 'exit 0\n')
    const context = { repositories: [{ id: 'app', name: 'App', path: root }] } as unknown as PipelineContext
    const configured = [{ repositoryId: 'app', command: 'npm', args: ['test'] }]
    expect(admitVerificationProposals(context, configured, [{ repositoryId: 'app', command: 'npm', args: ['run', 'test:e2e'] }, { repositoryId: 'app', command: 'bash', args: ['check.sh'], timeoutMs: 120_000 }], command => command))
      .toEqual([{ repositoryId: 'app', command: 'npm', args: ['run', 'test:e2e'] }, { repositoryId: 'app', command: 'bash', args: ['check.sh'], timeoutMs: 120_000 }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

describe('toolchain checks next to configured checks', () => {
  // The shapes that stalled real runs: a Swift package whose acceptance needs the iOS Simulator
  // build, a Tauri app whose Rust core is tested with cargo next to `npm test`, and the
  // `node --check` of browser-only code no test imports.
  const repo = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'toolchain-'))
    mkdirSync(path.join(root, 'src-tauri'))
    mkdirSync(path.join(root, 'web'))
    writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "x"\n')
    writeFileSync(path.join(root, 'web/main.js'), 'export {}\n')
    writeFileSync(path.join(root, 'compose.yaml'), 'services: {}\n')
    return root
  }
  const configured = (root: string) => [{ repositoryId: 'app', command: 'npm', args: ['test'], cwd: root }]
  const context = (root: string) => ({ repositories: [{ id: 'app', name: 'App', path: root }] }) as unknown as PipelineContext

  it('admits build and test verbs of the repository toolchain', () => {
    const root = repo()
    try {
      const proposals = [
        { repositoryId: 'app', command: 'xcodebuild', args: ['-scheme', 'Habits', '-destination', 'generic/platform=iOS Simulator', 'build'] },
        { repositoryId: 'app', command: 'cargo', args: ['test', '--manifest-path', 'src-tauri/Cargo.toml'] },
        { repositoryId: 'app', command: 'swift', args: ['build'] },
        { repositoryId: 'app', command: 'go', args: ['vet', './...'] },
        { repositoryId: 'app', command: 'node', args: ['--check', 'web/main.js'] },
        { repositoryId: 'app', command: 'docker', args: ['compose', '-f', 'compose.yaml', 'config'] },
      ]
      expect(admitVerificationProposals(context(root), configured(root), proposals, command => command)).toEqual(proposals)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses publishing, archiving, running, output redirection and paths outside the repository', () => {
    const root = repo()
    try {
      const refused = [
        { repositoryId: 'app', command: 'cargo', args: ['publish'] },
        { repositoryId: 'app', command: 'cargo', args: ['run'] },
        { repositoryId: 'app', command: 'cargo', args: ['fmt'] },
        { repositoryId: 'app', command: 'cargo', args: ['+nightly', 'test'] },
        { repositoryId: 'app', command: 'cargo', args: ['test', '--manifest-path', '../other/Cargo.toml'] },
        { repositoryId: 'app', command: 'xcodebuild', args: ['-scheme', 'Habits', 'archive'] },
        { repositoryId: 'app', command: 'xcodebuild', args: ['-exportArchive', '-archivePath', 'x'] },
        { repositoryId: 'app', command: 'go', args: ['build', '-o', '/usr/local/bin/x'] },
        { repositoryId: 'app', command: 'go', args: ['run', '.'] },
        { repositoryId: 'app', command: 'node', args: ['--check', '../outside.js'] },
        { repositoryId: 'app', command: 'node', args: ['-e', 'process.exit(0)'] },
        { repositoryId: 'app', command: 'docker', args: ['compose', 'up'] },
        { repositoryId: 'app', command: 'docker', args: ['run', 'alpine'] },
        { repositoryId: 'app', command: 'swift', args: ['package', 'update'] },
      ]
      expect(admitVerificationProposals(context(root), configured(root), refused, command => command)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
