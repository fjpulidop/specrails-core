import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dispatcher = path.resolve(here, '..', '..', 'bin', 'specrails-core.mjs')
const distCli = path.resolve(here, '..', '..', 'dist', 'installer', 'cli.js')
const distFramework = path.resolve(
  here,
  '..',
  '..',
  'dist',
  'installer',
  'commands',
  'framework.js',
)
const hasCurrentDist =
  existsSync(distCli) &&
  existsSync(distFramework) &&
  readFileSync(distFramework, 'utf8').includes('assertFrameworkVersionComplete')

describe('specrails-core dispatcher help', () => {
  it('describes all supported providers without a Claude-only enrich claim', () => {
    const result = spawnSync(process.execPath, [dispatcher, 'help'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(
      'Provider-independent AI agent workflow system',
    )
    expect(result.stdout).toContain('claude, codex, gemini, or kimi')
    expect(result.stdout).toContain(
      "Run the configured provider's enrich workflow",
    )
    expect(result.stdout).toContain('swap-current')
    expect(result.stdout).not.toContain('via Claude CLI')
  })

  it('allowlists swap-current in the public dispatcher', () => {
    const source = readFileSync(dispatcher, 'utf8')
    expect(source).toMatch(
      /const KNOWN_SUBCOMMANDS = new Set\(\[[\s\S]*?'swap-current'/,
    )
    expect(source).toContain(
      'Available commands: init, update, doctor, install-framework, swap-current, assemble',
    )
  })

  it.skipIf(!hasCurrentDist)(
    'routes swap-current to the installer and rejects a nonexistent target',
    () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'specrails-dispatch-swap-'))
      try {
        const result = spawnSync(
          process.execPath,
          [
            dispatcher,
            'swap-current',
            '--framework-dir',
            path.join(tmp, 'framework'),
            '--version',
            'missing',
            '--providers',
            'claude',
          ],
          { encoding: 'utf8' },
        )

        expect(result.status).toBe(41)
        expect(result.stderr).not.toContain('Unknown command')
        expect(result.stderr).toContain('is not materialized')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )
})
