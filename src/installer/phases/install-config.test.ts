import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeFileLf } from '../util/fs.js'
import {
  CONFIG_RELATIVE_PATH,
  InvalidConfigError,
  loadInstallConfig,
  resolveConfigPath,
  validateInstallConfig,
  writeInstallConfig,
} from './install-config.js'

describe('install-config', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-cfg-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  describe('resolveConfigPath', () => {
    it('returns the default location when no explicit arg', () => {
      expect(resolveConfigPath('/my/repo')).toBe(path.join('/my/repo', CONFIG_RELATIVE_PATH))
    })

    it('honours an absolute explicit path', () => {
      expect(resolveConfigPath('/my/repo', '/tmp/alt.yaml')).toBe('/tmp/alt.yaml')
    })

    it('resolves a relative explicit path against the repo root', () => {
      expect(resolveConfigPath('/my/repo', 'alt.yaml')).toBe(path.resolve('/my/repo', 'alt.yaml'))
    })
  })

  describe('validateInstallConfig', () => {
    it('accepts a minimal valid config', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agents: { selected: ['sr-architect'] },
      })
      expect(result.version).toBe(1)
      expect(result.provider).toBe('claude')
      expect(result.agents.selected).toEqual(['sr-architect'])
    })

    it('accepts an optional agent_teams, tier, and preset', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agent_teams: true,
        tier: 'quick',
        agents: { selected: [], preset: 'balanced' },
      })
      expect(result.agent_teams).toBe(true)
      expect(result.tier).toBe('quick')
      expect(result.agents.preset).toBe('balanced')
    })

    it('rejects missing version', () => {
      try {
        validateInstallConfig({ provider: 'claude', agents: { selected: [] } })
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfigError)
        expect((err as InvalidConfigError).errors).toContain(`missing required 'version' field`)
      }
    })

    it('rejects unsupported version', () => {
      try {
        validateInstallConfig({ version: 2, provider: 'claude', agents: { selected: [] } })
      } catch (err) {
        expect((err as InvalidConfigError).errors[0]).toContain(`unsupported version`)
      }
    })

    it('rejects codex provider with a coming-soon message', () => {
      try {
        validateInstallConfig({ version: 1, provider: 'codex', agents: { selected: [] } })
      } catch (err) {
        const msgs = (err as InvalidConfigError).errors.join('\n')
        expect(msgs).toContain('Codex')
        expect(msgs).toContain('coming soon')
      }
    })

    it('rejects missing agents.selected', () => {
      try {
        validateInstallConfig({ version: 1, provider: 'claude', agents: {} })
      } catch (err) {
        expect((err as InvalidConfigError).errors[0]).toContain(`'agents.selected' must be a list`)
      }
    })

    it('rejects an unsupported preset', () => {
      try {
        validateInstallConfig({
          version: 1,
          provider: 'claude',
          agents: { selected: [], preset: 'bogus' },
        })
      } catch (err) {
        expect((err as InvalidConfigError).errors[0]).toContain(`unsupported preset`)
      }
    })

    it('rejects an unsupported tier', () => {
      try {
        validateInstallConfig({
          version: 1,
          provider: 'claude',
          tier: 'enterprise',
          agents: { selected: [] },
        })
      } catch (err) {
        expect((err as InvalidConfigError).errors[0]).toContain(`unsupported tier`)
      }
    })

    it('surfaces multiple errors in one throw', () => {
      try {
        validateInstallConfig({ version: 99, provider: 'bogus', agents: {} })
      } catch (err) {
        expect((err as InvalidConfigError).errors.length).toBeGreaterThanOrEqual(2)
      }
    })

    it('rejects a non-object top level', () => {
      expect(() => validateInstallConfig(null)).toThrow(InvalidConfigError)
      expect(() => validateInstallConfig('string')).toThrow(InvalidConfigError)
    })
  })

  describe('loadInstallConfig', () => {
    it('returns null when the file does not exist', () => {
      expect(loadInstallConfig(path.join(tmpDir, 'missing.yaml'))).toBeNull()
    })

    it('parses a YAML file from disk', () => {
      const p = path.join(tmpDir, 'install-config.yaml')
      writeFileLf(
        p,
        [
          'version: 1',
          'provider: claude',
          'agent_teams: false',
          'tier: full',
          'agents:',
          '  selected:',
          '    - sr-architect',
          '    - sr-developer',
          '  preset: balanced',
          '',
        ].join('\n'),
      )
      const cfg = loadInstallConfig(p)
      expect(cfg).not.toBeNull()
      expect(cfg!.provider).toBe('claude')
      expect(cfg!.agents.selected).toEqual(['sr-architect', 'sr-developer'])
      expect(cfg!.agents.preset).toBe('balanced')
    })

    it('surfaces YAML parse errors as InvalidConfigError', () => {
      const p = path.join(tmpDir, 'bad.yaml')
      writeFileLf(p, 'version: 1\nprovider: claude\n  bad indent')
      expect(() => loadInstallConfig(p)).toThrow(InvalidConfigError)
    })
  })

  describe('writeInstallConfig', () => {
    it('round-trips through loadInstallConfig', () => {
      const p = path.join(tmpDir, 'rt.yaml')
      writeInstallConfig(p, {
        version: 1,
        provider: 'claude',
        tier: 'quick',
        agents: { selected: ['sr-architect'], preset: 'max' },
      })
      const cfg = loadInstallConfig(p)
      expect(cfg!.tier).toBe('quick')
      expect(cfg!.agents.preset).toBe('max')
    })
  })
})
