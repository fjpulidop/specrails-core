import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeFileLf } from '../util/fs.js'
import {
  CONFIG_RELATIVE_PATH,
  InvalidConfigError,
  loadInstallConfig,
  resolveProviderModelConfig,
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

    it('accepts gemini as a valid provider', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'gemini',
        agents: { selected: ['sr-architect'] },
      })
      expect(result.provider).toBe('gemini')
    })

    it('accepts kimi as a valid provider', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'kimi',
        agents: { selected: ['sr-architect'] },
      })
      expect(result.provider).toBe('kimi')
      expect(result.models).toEqual({
        preset: 'balanced',
        defaults: { model: 'k3' },
        overrides: {},
      })
    })

    it.each(['balanced', 'budget', 'max'] as const)(
      'resolves the %s preset to an explicit Kimi model id',
      (preset) => {
        expect(resolveProviderModelConfig('kimi', preset)).toEqual({
          preset,
          defaults: { model: 'k3' },
          overrides: {},
        })
      },
    )

    it('retains exact custom Kimi aliases without Claude interpretation', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'kimi',
        agents: { selected: ['sr-architect'] },
        models: {
          preset: 'max',
          defaults: { model: 'sonnet' },
          overrides: { 'sr-architect': 'company/custom-kimi' },
        },
      })
      expect(result.models).toEqual({
        preset: 'max',
        defaults: { model: 'sonnet' },
        overrides: { 'sr-architect': 'company/custom-kimi' },
      })
    })

    it.each([
      '--yolo',
      'team model',
      ' team/model',
      'team/model ',
      'team/model\n--yolo',
      `a${'b'.repeat(128)}`,
    ])('rejects unsafe Kimi model id %j before installation', (model) => {
      expect(() =>
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: { selected: ['sr-architect'] },
          models: {
            preset: 'balanced',
            defaults: { model },
            overrides: { 'sr-reviewer': model },
          },
        }),
      ).toThrow(/safe Kimi model id/)
    })

    it('rejects blank Kimi model identifiers', () => {
      expect(() =>
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: { selected: ['sr-architect'] },
          models: {
            preset: 'balanced',
            defaults: { model: '  ' },
            overrides: {},
          },
        }),
      ).toThrow(/safe Kimi model id/)
    })

    it('validates every selected and excluded agent id', () => {
      try {
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: {
            selected: ['sr-architect', '../escape', 42, '-leading'],
            excluded: ['sr-reviewer', 'UPPERCASE', 'x'.repeat(65)],
          },
        })
        throw new Error('expected config validation to fail')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfigError)
        expect((err as InvalidConfigError).errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining(`'agents.selected[1]'`),
            expect.stringContaining(`'agents.selected[2]'`),
            expect.stringContaining(`'agents.selected[3]'`),
            expect.stringContaining(`'agents.excluded[1]'`),
            expect.stringContaining(`'agents.excluded[2]'`),
          ]),
        )
      }
    })

    it('rejects duplicate and overlapping selected/excluded agents', () => {
      try {
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: {
            selected: ['sr-architect', 'sr-architect', 'sr-reviewer'],
            excluded: ['sr-reviewer', 'sr-reviewer'],
          },
        })
        throw new Error('expected config validation to fail')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfigError)
        const messages = (err as InvalidConfigError).errors.join('\n')
        expect(messages).toContain(
          `'agents.selected' must not contain duplicate agent id 'sr-architect'`,
        )
        expect(messages).toContain(
          `'agents.excluded' must not contain duplicate agent id 'sr-reviewer'`,
        )
        expect(messages).toContain(
          `'agents.selected' and 'agents.excluded' must not overlap: sr-reviewer`,
        )
      }
    })

    it('rejects unsafe per-agent override keys', () => {
      expect(() =>
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: { selected: ['sr-architect'] },
          models: {
            preset: 'balanced',
            defaults: { model: 'k3' },
            overrides: { '../escape': 'k3' },
          },
        }),
      ).toThrow(/models\.overrides.*lowercase kebab-case agent id/)
    })

    it('accepts an optional tier and preset', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        tier: 'quick',
        agents: { selected: [], preset: 'balanced' },
      })
      expect(result.tier).toBe('quick')
      expect(result.agents.preset).toBe('balanced')
    })

    it('tolerates a legacy agent_teams field (backward compat) without failing', () => {
      // Older configs may still carry `agent_teams: true/false`. The field is no
      // longer supported but must be silently ignored, never rejected.
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agent_teams: true,
        tier: 'quick',
        agents: { selected: ['sr-architect'], preset: 'balanced' },
      })
      expect(result.provider).toBe('claude')
      expect(result.tier).toBe('quick')
      expect(result.agents.selected).toEqual(['sr-architect'])
      expect((result as unknown as Record<string, unknown>).agent_teams).toBeUndefined()
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

    it('accepts codex as a valid provider', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'codex',
        agents: { selected: [] },
      })
      expect(result.provider).toBe('codex')
      expect(result.models?.defaults.model).toBe('gpt-5.5-mini')
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
      expect(cfg!.models?.defaults.model).toBe('sonnet')
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
      expect(cfg!.models).toEqual({
        preset: 'max',
        defaults: { model: 'sonnet' },
        overrides: {
          'sr-architect': 'opus',
          'sr-product-manager': 'opus',
        },
      })
    })
  })

  describe('integration contract consistency', () => {
    it('publishes exactly the config providers and preset values the validator resolves', () => {
      const contract = JSON.parse(
        readFileSync(path.join(process.cwd(), 'integration-contract.json'), 'utf8'),
      ) as {
        schemaVersion: string
        configSchema: { fields: Record<string, string> }
        modelPresets: Record<
          'balanced' | 'budget' | 'max',
          {
            defaults: { model: string }
            overrides: Record<string, string>
          }
        >
      }

      expect(contract.schemaVersion).toBe('3.2')
      expect(contract.configSchema.fields.provider).toBe(
        'string — claude | codex | gemini | kimi',
      )
      expect(contract.configSchema.fields.provider).not.toContain('auto')

      for (const preset of ['balanced', 'budget', 'max'] as const) {
        const resolved = resolveProviderModelConfig('claude', preset)
        expect(contract.modelPresets[preset]).toMatchObject({
          defaults: resolved.defaults,
          overrides: resolved.overrides,
        })
      }
    })
  })
})
