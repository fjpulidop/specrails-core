import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ELECTRON_HEADLESS_GUARD, headlessEnvironment } from './pipeline-state.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The compiled guard (`npm test` builds first); the source is a .cts file.
const guard = path.join(root, 'dist', 'pipeline', 'electron-headless-guard.cjs')

describe('headlessEnvironment', () => {
  const present = () => true
  it('marks every command headless, stops browser auto-open and loads the Electron guard', () => {
    const env = headlessEnvironment({ PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=4096' }, '/opt/core dist/guard.cjs', present)
    expect(env).toEqual({ PATH: '/bin', SPECRAILS_HEADLESS: '1', BROWSER: 'none', NODE_OPTIONS: '--max-old-space-size=4096 --require "/opt/core dist/guard.cjs"' })
  })
  it('is idempotent and never duplicates the guard', () => {
    const once = headlessEnvironment({}, '/g.cjs', present)
    expect(headlessEnvironment(once, '/g.cjs', present)).toEqual(once)
    expect(once.NODE_OPTIONS).toBe('--require "/g.cjs"')
  })
  it('honours an explicit opt-out and a missing guard file', () => {
    const optOut = { SPECRAILS_HEADLESS: '0', BROWSER: 'firefox' }
    expect(headlessEnvironment(optOut, '/g.cjs', present)).toBe(optOut)
    expect(headlessEnvironment({}, '/g.cjs', () => false)).toEqual({ SPECRAILS_HEADLESS: '1', BROWSER: 'none' })
  })
  it('points at the guard shipped next to the module', () => {
    expect(path.basename(ELECTRON_HEADLESS_GUARD)).toBe('electron-headless-guard.cjs')
  })
})

describe.skipIf(!existsSync(guard))('electron-headless-guard (compiled)', () => {
  // A parent that drops NODE_OPTIONS (as Playwright's Electron launcher does)
  // and starts a child; the child reports the NODE_OPTIONS it received.
  // Asynchronous spawns are covered (Playwright, launchers); spawnSync is not.
  const parent = [
    "const { execFile } = require('child_process')",
    'delete process.env.NODE_OPTIONS',
    "execFile(process.execPath, ['-e', 'process.stdout.write(process.env.NODE_OPTIONS || String())'], { env: { ...process.env, ...JSON.parse(process.argv[1]) } }, (error, stdout) => {",
    '  if (error) throw error',
    "  process.stdout.write(JSON.stringify({ marker: globalThis.__specrailsHeadlessGuard || null, child: stdout }))",
    '})',
  ].join('\n')
  const run = (headless: string | undefined, childEnv: Record<string, string>) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }
    delete env.SPECRAILS_HEADLESS
    if (headless !== undefined) env.SPECRAILS_HEADLESS = headless
    const result = spawnSync(process.execPath, ['-e', parent, JSON.stringify(childEnv)], { env, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout) as { marker: unknown; child: string }
  }

  it('gives itself back to a headless child whose NODE_OPTIONS was dropped', () => {
    const { marker, child } = run('1', {})
    expect(marker).toEqual({ forwarding: true })
    expect(child).toBe(`--require ${JSON.stringify(guard)}`)
  })
  it('leaves children that dropped the headless contract alone', () => {
    expect(run('1', { SPECRAILS_HEADLESS: '0' }).child).toBe('')
  })
  it('does nothing without SPECRAILS_HEADLESS=1', () => {
    expect(run(undefined, {})).toEqual({ marker: null, child: '' })
  })
})
