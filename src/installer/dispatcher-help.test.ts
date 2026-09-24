import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dispatcher = path.resolve(here, '..', '..', 'bin', 'specrails-core.mjs')
const hasDist = existsSync(path.resolve(here, '..', '..', 'dist', 'installer', 'cli.js'))
const run = (...args: string[]) => spawnSync(process.execPath, [dispatcher, ...args], { encoding: 'utf8' })

describe.skipIf(!hasDist)('specrails-core bin', () => {
  it.each([['help'], ['--help'], ['-h'], []])('prints usage for %j', (...args) => {
    const result = run(...args)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('claude, codex, gemini, or kimi')
    for (const command of ['init', 'install-framework', 'swap-current', 'assemble', 'pipeline', 'runtime']) expect(result.stdout).toContain(command)
    for (const removed of ['enrich', 'update', 'doctor', 'profile']) expect(result.stdout).not.toMatch(new RegExp(`^  ${removed}\\b`, 'm'))
  })

  it('prints help for `init --help` instead of installing', () => {
    const result = run('init', '--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Commands:')
  })

  it('rejects removed commands as unknown', () => {
    for (const removed of ['update', 'doctor', 'profile', 'enrich']) {
      const result = run(removed)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Unknown command: ${removed}`)
    }
  })

  it('routes swap-current to the installer and rejects a nonexistent target', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'specrails-dispatch-swap-'))
    try {
      const result = run('swap-current', '--framework-dir', path.join(tmp, 'framework'), '--version', 'missing', '--providers', 'claude')
      expect(result.status).toBe(41)
      expect(result.stderr).toContain('is not materialized')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
