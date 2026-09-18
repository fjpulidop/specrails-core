import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectCheckCommand, installEnvironment, isEnvironmentFailure, missingNodeDependencies, plannedInstalls, runGroupCheck, suggestedPackages } from './environment.js'

const temporary: string[] = []
function root(files: Record<string, string> = {}, dirs: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'))
  temporary.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  for (const name of dirs) mkdirSync(path.join(dir, name), { recursive: true })
  return dir
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('isEnvironmentFailure', () => {
  it('recognises missing tools and modules, not ordinary test failures', () => {
    expect(isEnvironmentFailure(127, '')).toBe(true)
    expect(isEnvironmentFailure(1, '> jest\n\nsh: jest: command not found\n')).toBe(true)
    expect(isEnvironmentFailure(1, "Error: Cannot find module 'ts-jest'")).toBe(true)
    expect(isEnvironmentFailure(1, 'ModuleNotFoundError: No module named pytest')).toBe(true)
    expect(isEnvironmentFailure(1, "Error: Cannot find module './board' — relative imports are code, not environment")).toBe(false)
    expect(isEnvironmentFailure(1, 'FAIL src/game.spec.ts\n  ● clears lines\n    expect(received).toBe(expected)')).toBe(false)
    expect(isEnvironmentFailure(0, 'sh: jest: command not found')).toBe(true)
  })
})

describe('plannedInstalls', () => {
  it('plans one install per ecosystem whose output is absent', () => {
    const node = root({ 'package.json': '{}' })
    expect(plannedInstalls(node)).toMatchObject([{ ecosystem: 'node', command: 'npm' }])
    expect(plannedInstalls(root({ 'package.json': '{}' }, ['node_modules']))).toEqual([])
    expect(plannedInstalls(root({ 'package.json': '{}', 'pnpm-lock.yaml': '' }))).toMatchObject([{ command: 'pnpm', args: ['install'] }])
    expect(plannedInstalls(root({ 'requirements.txt': 'pytest\n' }))).toMatchObject([{ ecosystem: 'python', args: ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'] }])
    expect(plannedInstalls(root({ 'go.mod': 'module x\n' }))).toMatchObject([{ ecosystem: 'go' }])
    expect(plannedInstalls(root({ 'Cargo.toml': '' }))).toMatchObject([{ ecosystem: 'rust' }])
    expect(plannedInstalls(root())).toEqual([])
  })
})

describe('installEnvironment', () => {
  it('runs each planned install once with a bounded spawn, reports outcomes and never throws', () => {
    const node = root({ 'package.json': '{}' })
    const spawn = vi.fn((command: string, _args?: string[], _options?: unknown) => ({ status: command === 'npm' ? 0 : 1, stdout: '', stderr: 'boom', pid: 1, output: [], signal: null }))
    const events: unknown[] = []
    const outcomes = installEnvironment([node, root({ 'go.mod': '' })], { spawn: spawn as never, onEvent: event => events.push(event) })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]![1]).toEqual(['install', '--no-audit', '--no-fund', '--loglevel=error'])
    expect((spawn.mock.calls[0]![2] as { cwd: string; timeout: number }).cwd).toBe(node)
    expect(outcomes.map(item => item.ok)).toEqual([true, false])
    expect(outcomes[1]!.detail).toContain('boom')
    expect(events.filter(event => (event as { kind: string }).kind === 'tool-start')).toHaveLength(2)
    const throwing = vi.fn(() => { throw new Error('spawn exploded') }) as never
    expect(installEnvironment([node], { spawn: throwing })[0]).toMatchObject({ ok: false })
  })
})


describe('suggested packages from failure output', () => {
  it('recognises the TypeScript type-definition hint and installs exactly the named packages', () => {
    const output = "error TS2582: Cannot find name 'test'. Do you need to install type definitions for a test runner? Try `npm i --save-dev @types/jest` or `npm i --save-dev @types/mocha`."
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['@types/jest', '@types/mocha'])
    const node = root({ 'package.json': '{}' }, ['node_modules'])
    expect(plannedInstalls(node)).toEqual([])
    expect(plannedInstalls(node, output)).toMatchObject([{ command: 'npm', args: ['install', '--save-dev', '--no-audit', '--no-fund', '--loglevel=error', '@types/jest', '@types/mocha'] }])
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })) as never
    expect(installEnvironment([node], { spawn, failureOutput: output })[0]).toMatchObject({ ok: true })
    expect(suggestedPackages('FAIL: expect(received).toBe(expected)')).toEqual([])
  })
})


describe('jest transform/preset modules', () => {
  it('recognises a missing ts-jest transform and installs it with typescript', () => {
    const output = '● Validation Error:\n\n  Module ts-jest in the transform option was not found.\n         <rootDir> is: /repo'
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['ts-jest', 'typescript'])
    expect(suggestedPackages('Preset babel-jest not found')).toEqual(['babel-jest'])
  })
})

describe('manifest drift + Jest option modules', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const repo = (): string => { const dir = mkdtempSync(path.join(tmpdir(), 'drift-')); dirs.push(dir); return dir }

  it('plans a reinstall when package.json declares a dependency node_modules lacks', () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29', 'jest-extended': '^3' } }))
    mkdirSync(path.join(dir, 'node_modules', 'jest'), { recursive: true })
    expect(missingNodeDependencies(dir)).toEqual(['jest-extended'])
    expect(plannedInstalls(dir).map(plan => plan.args[0])).toEqual(['install'])
    mkdirSync(path.join(dir, 'node_modules', 'jest-extended'), { recursive: true })
    expect(missingNodeDependencies(dir)).toEqual([])
    expect(plannedInstalls(dir)).toEqual([])
  })
  it('recognises any missing Jest option module and names it', () => {
    const output = '● Validation Error:\n\n  Module jest-extended in the setupFilesAfterEnv option was not found.\n'
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['jest-extended'])
    expect(isEnvironmentFailure(1, 'Module @swc/jest in the transform option was not found')).toBe(true)
  })
})

describe('hand-written lockfiles', () => {
  it('drops a lockfile npm rejects (EINTEGRITY) and retries the install once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lock-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), '{"devDependencies":{"jest":"^29"}}')
      writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/jest":{"integrity":"sha512-fake"}}}')
      const calls: string[][] = []
      const spawn = vi.fn((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        const first = calls.length === 1
        return { status: first ? 1 : 0, stderr: first ? 'npm error code EINTEGRITY\nnpm error sha512-fake integrity checksum failed' : '', stdout: '', pid: 1, output: [], signal: null } as never
      })
      const events: string[] = []
      const outcomes = installEnvironment([dir], { spawn: spawn as never, onEvent: e => { if (e.kind === 'text') events.push(e.text ?? '') } })
      expect(calls).toHaveLength(2)
      expect(existsSync(path.join(dir, 'package-lock.json'))).toBe(false)
      expect(outcomes[0]?.ok).toBe(true)
      expect(events.some(text => /package-lock\.json did not match/.test(text))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('unpublished pins', () => {
  it('relaxes an exact version the registry never published and retries once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pin-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@babel/preset-env': '7.23.0', jest: '^29' } }))
      const calls: string[][] = []
      const spawn = vi.fn((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        const first = calls.length === 1
        return { status: first ? 1 : 0, stderr: first ? 'npm error code ETARGET\nnpm error notarget No matching version found for @babel/preset-env@7.23.0.\nnpm error notarget In most cases you or one of your dependencies are requesting' : '', stdout: '', pid: 1, output: [], signal: null } as never
      })
      const events: string[] = []
      const outcomes = installEnvironment([dir], { spawn: spawn as never, onEvent: e => { if (e.kind === 'text') events.push(e.text ?? '') } })
      expect(calls).toHaveLength(2)
      expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).devDependencies['@babel/preset-env']).toBe('^7.0.0')
      expect(outcomes[0]?.ok).toBe(true)
      expect(events.some(text => /is not published; relaxed the pin/.test(text))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('group check', () => {
  it('detects the repository test command per ecosystem and skips the npm placeholder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-'))
    try {
      expect(detectCheckCommand(dir)).toBeUndefined()
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
      expect(detectCheckCommand(dir)).toBeUndefined()
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node tests/smoke.test.js' } }))
      expect(detectCheckCommand(dir)).toEqual({ command: 'npm', args: ['test', '--silent'] })
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
      expect(detectCheckCommand(dir)).toEqual({ command: 'pnpm', args: ['test'] })
      rmSync(path.join(dir, 'package.json')); rmSync(path.join(dir, 'pnpm-lock.yaml'))
      writeFileSync(path.join(dir, 'go.mod'), 'module x')
      expect(detectCheckCommand(dir)?.command).toBe('go')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('runs the check once, bounded, and reports a failure with the output tail', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
      const spawn = vi.fn(() => ({ status: 1, stdout: 'x'.repeat(10), stderr: 'AssertionError: expected 1 to be 2\n    at t.js:3:1', pid: 1, output: [], signal: null }) as never)
      const outcome = runGroupCheck([dir], { spawn: spawn as never })
      expect(outcome).toMatchObject({ ran: true, ok: false, command: 'npm test --silent' })
      expect(outcome.output).toContain('AssertionError')
      expect(spawn).toHaveBeenCalledWith('npm', ['test', '--silent'], expect.objectContaining({ cwd: dir }))
      expect(runGroupCheck([mkdtempSync(path.join(tmpdir(), 'empty-'))])).toEqual({ ran: false, ok: true, output: '' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
