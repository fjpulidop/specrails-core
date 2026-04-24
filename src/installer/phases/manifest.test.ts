import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { readTextFile, writeFileLf } from '../util/fs.js'
import { buildManifest, sha256Of, writeManifestFiles } from './manifest.js'

describe('manifest', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-manifest-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('sha256Of', () => {
    it('produces a stable sha256: prefixed hex digest', () => {
      const f = path.join(tmpDir, 'sample.txt')
      writeFileLf(f, 'hello specrails')
      const digest = sha256Of(f)
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // Same input → same output.
      expect(sha256Of(f)).toBe(digest)
    })
  })

  describe('buildManifest', () => {
    const setupFakePackage = (scriptDir: string): void => {
      writeFileLf(path.join(scriptDir, 'templates', 'agents', 'a.md'), 'agent a')
      writeFileLf(path.join(scriptDir, 'templates', 'agents', 'b.md'), 'agent b')
      writeFileLf(path.join(scriptDir, 'templates', 'rules', 'r.md'), 'rule')
      writeFileLf(path.join(scriptDir, 'templates', 'node_modules', 'should-skip.txt'), 'x')
      writeFileLf(path.join(scriptDir, 'templates', 'package-lock.json'), '{}')
      writeFileLf(path.join(scriptDir, 'commands', 'enrich.md'), 'enrich')
      writeFileLf(path.join(scriptDir, 'commands', 'doctor.md'), 'doctor')
    }

    it('lists every template file plus the two bundled commands', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakePackage(scriptDir)

      const manifest = buildManifest({
        scriptDir,
        repoRoot,
        version: '4.2.0',
        installedAt: '2026-01-01T00:00:00Z',
      })

      expect(manifest.version).toBe('4.2.0')
      expect(manifest.installed_at).toBe('2026-01-01T00:00:00Z')
      expect(Object.keys(manifest.artifacts)).toEqual([
        'commands/specrails/doctor.md',
        'commands/specrails/enrich.md',
        'templates/agents/a.md',
        'templates/agents/b.md',
        'templates/rules/r.md',
      ])
    })

    it('skips node_modules and package-lock.json under templates/', () => {
      const scriptDir = path.join(tmpDir, 'core')
      const repoRoot = path.join(tmpDir, 'repo')
      setupFakePackage(scriptDir)

      const manifest = buildManifest({
        scriptDir,
        repoRoot,
        version: '1.0.0',
      })

      const keys = Object.keys(manifest.artifacts)
      expect(keys.some((k) => k.includes('node_modules'))).toBe(false)
      expect(keys.some((k) => k.endsWith('package-lock.json'))).toBe(false)
    })

    it('produces stable, sorted artifact keys regardless of fs readdir order', () => {
      const scriptDir = path.join(tmpDir, 'core')
      setupFakePackage(scriptDir)

      const m1 = buildManifest({
        scriptDir,
        repoRoot: path.join(tmpDir, 'repo'),
        version: '1.0.0',
      })
      // Running twice must produce identical keys in identical order.
      const m2 = buildManifest({
        scriptDir,
        repoRoot: path.join(tmpDir, 'repo'),
        version: '1.0.0',
      })
      expect(Object.keys(m1.artifacts)).toEqual(Object.keys(m2.artifacts))
    })

    it('populates installed_at with ISO 8601 UTC when not supplied', () => {
      const scriptDir = path.join(tmpDir, 'core')
      setupFakePackage(scriptDir)

      const manifest = buildManifest({
        scriptDir,
        repoRoot: path.join(tmpDir, 'repo'),
        version: '1.0.0',
      })
      expect(manifest.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })
  })

  describe('writeManifestFiles', () => {
    it('writes .specrails/specrails-manifest.json and .specrails/specrails-version', () => {
      const manifest = {
        version: '5.0.0',
        installed_at: '2026-04-24T12:00:00Z',
        artifacts: { 'a.md': 'sha256:deadbeef' },
      }
      const { manifestPath, versionPath } = writeManifestFiles(tmpDir, manifest)
      expect(readTextFile(versionPath).trim()).toBe('5.0.0')
      const parsed = JSON.parse(readTextFile(manifestPath))
      expect(parsed.version).toBe('5.0.0')
      expect(parsed.artifacts['a.md']).toBe('sha256:deadbeef')
    })
  })
})
