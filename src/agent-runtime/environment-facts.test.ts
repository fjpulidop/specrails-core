import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentFacts, renderEnvironmentFacts, setEnvironmentProbe, toolchainTargets, type ProbeRunner } from './environment-facts.js'
import { repositoryContext } from './repository-context.js'
import type { PipelineContext } from '../pipeline/pipeline-state.js'

const roots: string[] = []
afterEach(() => { setEnvironmentProbe(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'environment-facts-')); roots.push(root)
  for (const [name, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), content) }
  return root
}
const host = (answers: Record<string, { status: number | null; stdout?: string; stderr?: string }>): ProbeRunner & { calls: string[] } => {
  const calls: string[] = []
  const probe: ProbeRunner = (command, args) => { calls.push([command, ...args].join(' ')); const answer = answers[command] ?? { status: null }; return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' } }
  return Object.assign(probe, { calls })
}

describe('environment facts', () => {
  // The deckdex-mtg shape: the image pins Python 3.11, the host's python3 is 3.14, Docker answers.
  const deckdex = { 'backend/Dockerfile': 'FROM python:3.11-slim\nRUN pip install -r requirements.txt\n', 'docker-compose.yml': 'services: {}\n', 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n', 'requirements.txt': 'sqlalchemy>=2.0\n' }

  it('reads pinned targets from images and version files, and ranges as unpinned', () => {
    const root = repo({ ...deckdex, '.nvmrc': 'v20.11.0\n', '.tool-versions': 'nodejs 20.11\n' })
    expect(toolchainTargets(root)).toEqual([
      { tool: 'python', version: '3.11', source: 'backend/Dockerfile FROM python:3.11-slim', pinned: true },
      { tool: 'python', version: '3.11', source: 'pyproject.toml requires-python >=3.11', pinned: false },
      { tool: 'node', version: '20.11', source: '.nvmrc 20.11.0', pinned: true },
      { tool: 'node', version: '20.11', source: '.tool-versions nodejs 20.11', pinned: true },
    ])
  })

  it('tells roles the interpreter mismatch, the missing venv and that Docker answers on the host', () => {
    const runner = host({ python3: { status: 0, stdout: 'Python 3.14.3' }, 'python3.11': { status: 0, stdout: 'Python 3.11.9' }, docker: { status: 0, stdout: '24.0.6\n' } })
    setEnvironmentProbe(runner)
    const text = renderEnvironmentFacts(environmentFacts(repo(deckdex))).join('\n')
    expect(text).toContain('Python target: 3.11')
    expect(text).toContain('On the host PATH: python3 3.14.3, python3.11 3.11.9')
    expect(text).toContain('Bare python3 (3.14.3) does not match the target 3.11: run Python checks in a virtual environment built from python3.11')
    expect(text).toContain('No project virtual environment (.venv) exists')
    expect(text).toContain('Docker: reachable from the host (server 24.0.6)')
    expect(text).toContain('that is a sandbox limit, not a host blocker')
    expect(runner.calls).toEqual(['python3 --version', 'python3.11 --version', 'docker info --format {{.ServerVersion}}'])
  })

  it('treats a docker info that prints only a socket error as unreachable, and caches the probe', () => {
    const runner = host({ python3: { status: 0, stdout: 'Python 3.11.2' }, docker: { status: 0, stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///x/docker.sock' } })
    setEnvironmentProbe(runner)
    const root = repo({ ...deckdex, '.venv/bin/python': '' })
    const text = renderEnvironmentFacts(environmentFacts(root)).join('\n')
    expect(text).toContain('Docker: not reachable from the host (permission denied while trying to connect')
    expect(text).toContain('Project virtual environment: .venv')
    expect(text).not.toContain('does not match')
    environmentFacts(root)
    expect(runner.calls.filter(call => call.startsWith('docker'))).toHaveLength(1)
  })

  it('does not claim a mismatch from a version range, and probes nothing for an unrelated repository', () => {
    const runner = host({ python3: { status: 0, stdout: 'Python 3.14.0' } })
    setEnvironmentProbe(runner)
    expect(renderEnvironmentFacts(environmentFacts(repo({ 'pyproject.toml': 'requires-python = ">=3.11"\n' }))).join('\n')).not.toContain('does not match')
    expect(renderEnvironmentFacts(environmentFacts(repo({ 'README.md': '# Docs\n' })))).toEqual([])
    expect(runner.calls).toEqual(['python3 --version'])
  })

  it('reaches every role through the repository reference', () => {
    setEnvironmentProbe(host({ python3: { status: 0, stdout: 'Python 3.14.3' }, docker: { status: 0, stdout: '24.0.6' } }))
    const root = repo(deckdex)
    const text = repositoryContext({ repositories: [{ id: 'app', name: 'App', path: root }] } as PipelineContext)
    expect(text).toContain('Environment facts (measured by the host')
    expect(text).toContain('Docker: reachable from the host')
  })
})
