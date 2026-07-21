import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

/**
 * Direct-run guard: `node dist/installer/cli.js <subcommand>` must auto-invoke
 * main() (the bundled-core path in specrails-desktop spawns the CLI exactly this
 * way). We run against the COMPILED dist when present; skipped when the package
 * has not been built (unit-only CI runs `vitest` without `build`).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const distCli = path.resolve(here, '..', '..', 'dist', 'installer', 'cli.js')

const maybe = existsSync(distCli) ? describe : describe.skip

maybe('cli direct-run guard (compiled dist)', () => {
  it('install-framework run as `node cli.js …` materializes the framework + current', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cli-direct-'))
    try {
      const res = spawnSync(
        process.execPath,
        [distCli, 'install-framework', '--framework-dir', path.join(tmp, 'fw'), '--provider', 'claude', '--version', '9.9.9'],
        { encoding: 'utf8' },
      )
      expect(res.status).toBe(0)
      const fw = path.join(tmp, 'fw')
      expect(existsSync(path.join(fw, '9.9.9', '.claude', 'agents'))).toBe(true)
      expect(readlinkSync(path.join(fw, 'current'))).toContain('9.9.9')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('still auto-runs when argv[1] reaches cli.js through a SYMLINKED path (macOS /var/folders staging)', () => {
    // Node realpaths the entry module (import.meta.url) but argv[1] stays the
    // literal spawn arg. specrails-desktop's core-update channel stages the
    // download under os.tmpdir() — a symlink on macOS — so the raw href
    // comparison used to fail and the CLI exited 0 having done NOTHING.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cli-direct-link-'))
    try {
      const pkgRoot = path.resolve(here, '..', '..')
      const linkRoot = path.join(tmp, 'core-link')
      symlinkSync(pkgRoot, linkRoot)
      const linkedCli = path.join(linkRoot, 'dist', 'installer', 'cli.js')
      const res = spawnSync(
        process.execPath,
        [linkedCli, 'install-framework', '--framework-dir', path.join(tmp, 'fw'), '--provider', 'claude', '--version', '9.9.9'],
        { encoding: 'utf8' },
      )
      expect(res.status).toBe(0)
      // The old broken guard also exited 0 — the REAL assertion is that work happened.
      expect(existsSync(path.join(tmp, 'fw', '9.9.9', '.claude', 'agents'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('assemble run as `node cli.js …` symlinks the workspace + writes the version marker', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cli-direct-asm-'))
    try {
      const fw = path.join(tmp, 'fw')
      const ws = path.join(tmp, 'ws')
      const repo = path.join(tmp, 'repo')
      spawnSync(
        process.execPath,
        [distCli, 'install-framework', '--framework-dir', fw, '--provider', 'claude', '--version', '9.9.9'],
        { encoding: 'utf8' },
      )
      const res = spawnSync(
        process.execPath,
        [distCli, 'assemble', '--workspace', ws, '--framework-dir', fw, '--provider', 'claude', '--version', '9.9.9', '--code-root', repo],
        { encoding: 'utf8' },
      )
      expect(res.status).toBe(0)
      expect(readFileSync(path.join(ws, '.specrails', 'specrails-version'), 'utf8').trim()).toBe('9.9.9')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
