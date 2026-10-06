import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeFileLf } from '../util/fs.js'
import { resetLoggerStreams, setLoggerStreams } from '../util/logger.js'
import {
  CONFIG_RELATIVE_PATH,
  InvalidConfigError,
  loadInstallConfig,
  resolveProviderModelConfig,
  resolveConfigPath,
  validateInstallConfig,
  writeInstallConfig,
} from './install-config.js'

/** A role id an older Core shipped; composed so the retired names never appear literally. */
const legacyRole = (role: string): string => `sr-${role}`

describe('install-config', () => {
  let tmpDir: string
  let logged: string[]

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-cfg-test-'))
    logged = []
    const sink = new PassThrough()
    sink.on('data', (chunk: Buffer) => logged.push(chunk.toString()))
    setLoggerStreams({ out: sink, err: sink })
  })

  afterEach(() => {
    resetLoggerStreams()
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
    it('accepts a minimal valid config without an agents section', () => {
      const result = validateInstallConfig({ version: 1, provider: 'claude' })
      expect(result.version).toBe(1)
      expect(result.provider).toBe('claude')
      expect(result.agents).toBeUndefined()
      expect(result.models).toEqual({ preset: 'balanced', defaults: { model: 'sonnet' }, overrides: {} })
      expect(logged.join('')).toBe('')
    })

    it('accepts a legacy agents selection, echoes it back and warns once that it is ignored', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agents: { selected: [legacyRole('architect')] },
      })
      expect(result.agents?.selected).toEqual([legacyRole('architect')])
      const out = logged.join('')
      expect(out).toContain('agents.selected')
      expect(out).toContain('ignored since Core 6.3')
      expect(out.match(/ignored since Core 6\.3/g)).toHaveLength(1)
    })

    it('stays silent for an empty legacy selection', () => {
      const result = validateInstallConfig({ version: 1, provider: 'claude', agents: { selected: [] } })
      expect(result.agents).toEqual({ selected: [] })
      expect(logged.join('')).toBe('')
    })

    it('rejects an agents section that is not a mapping', () => {
      expect(() => validateInstallConfig({ version: 1, provider: 'claude', agents: [legacyRole('architect')] })).toThrow(/'agents' must be a mapping/)
      expect(() => validateInstallConfig({ version: 1, provider: 'claude', agents: legacyRole('architect') })).toThrow(/'agents' must be a mapping/)
    })

    it('accepts gemini as a valid provider', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'gemini',
        agents: { selected: [legacyRole('architect')] },
      })
      expect(result.provider).toBe('gemini')
    })

    it('accepts kimi as a valid provider', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'kimi',
        agents: { selected: [legacyRole('architect')] },
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
        agents: { selected: [legacyRole('architect')] },
        models: {
          preset: 'max',
          defaults: { model: 'sonnet' },
          overrides: { [legacyRole('architect')]: 'company/custom-kimi' },
        },
      })
      expect(result.models).toEqual({
        preset: 'max',
        defaults: { model: 'sonnet' },
        overrides: { [legacyRole('architect')]: 'company/custom-kimi' },
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
          agents: { selected: [legacyRole('architect')] },
          models: {
            preset: 'balanced',
            defaults: { model },
            overrides: { [legacyRole('reviewer')]: model },
          },
        }),
      ).toThrow(/safe Kimi model id/)
    })

    it('rejects blank Kimi model identifiers', () => {
      expect(() =>
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: { selected: [legacyRole('architect')] },
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
            selected: [legacyRole('architect'), '../escape', 42, '-leading'],
            excluded: [legacyRole('reviewer'), 'UPPERCASE', 'x'.repeat(65)],
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
            selected: [legacyRole('architect'), legacyRole('architect'), legacyRole('reviewer')],
            excluded: [legacyRole('reviewer'), legacyRole('reviewer')],
          },
        })
        throw new Error('expected config validation to fail')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfigError)
        const messages = (err as InvalidConfigError).errors.join('\n')
        expect(messages).toContain(
          `'agents.selected' must not contain duplicate agent id '${legacyRole('architect')}'`,
        )
        expect(messages).toContain(
          `'agents.excluded' must not contain duplicate agent id '${legacyRole('reviewer')}'`,
        )
        expect(messages).toContain(
          `'agents.selected' and 'agents.excluded' must not overlap: ${legacyRole('reviewer')}`,
        )
      }
    })

    it('rejects unsafe per-agent override keys', () => {
      expect(() =>
        validateInstallConfig({
          version: 1,
          provider: 'kimi',
          agents: { selected: [legacyRole('architect')] },
          models: {
            preset: 'balanced',
            defaults: { model: 'k3' },
            overrides: { '../escape': 'k3' },
          },
        }),
      ).toThrow(/models\.overrides.*lowercase kebab-case agent id/)
    })

    it('accepts an optional preset', () => {
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agents: { selected: [], preset: 'balanced' },
      })
      expect(result.agents?.preset).toBe('balanced')
    })

    it('tolerates legacy agent_teams and tier fields (backward compat) without failing', () => {
      // Older configs may still carry `agent_teams: true/false` and `tier: full|quick`.
      // Both are no longer supported but must be silently ignored, never rejected
      // and never carried forward onto the parsed config.
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        agent_teams: true,
        tier: 'quick',
        agents: { selected: [legacyRole('architect')], preset: 'balanced' },
      })
      expect(result.provider).toBe('claude')
      expect(result.agents?.selected).toEqual([legacyRole('architect')])
      expect((result as unknown as Record<string, unknown>).agent_teams).toBeUndefined()
      expect((result as unknown as Record<string, unknown>).tier).toBeUndefined()
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

    it('rejects an agents section without a selected list (malformed, not merely legacy)', () => {
      expect(() => validateInstallConfig({ version: 1, provider: 'claude', agents: {} })).toThrow(InvalidConfigError)
      try {
        validateInstallConfig({ version: 1, provider: 'claude', agents: { selected: legacyRole('architect') } })
        throw new Error('expected config validation to fail')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfigError)
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

    it('ignores any tier value (tolerated, never rejected)', () => {
      // v5 has no install tiers. A legacy/unknown tier value is silently ignored,
      // never a validation error.
      const result = validateInstallConfig({
        version: 1,
        provider: 'claude',
        tier: 'enterprise',
        agents: { selected: [] },
      })
      expect((result as unknown as Record<string, unknown>).tier).toBeUndefined()
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
          `    - ${legacyRole('architect')}`,
          `    - ${legacyRole('developer')}`,
          '  preset: balanced',
          '',
        ].join('\n'),
      )
      const cfg = loadInstallConfig(p)
      expect(cfg).not.toBeNull()
      expect(cfg!.provider).toBe('claude')
      expect(cfg!.agents?.selected).toEqual([legacyRole('architect'), legacyRole('developer')])
      expect(cfg!.agents?.preset).toBe('balanced')
      expect(cfg!.models?.defaults.model).toBe('sonnet')
      expect(logged.join('')).toContain('ignored since Core 6.3')
    })

    it('parses a YAML file that has no agents section and raises no error about agents', () => {
      const p = path.join(tmpDir, 'install-config.yaml')
      writeFileLf(p, ['version: 1', 'provider: codex', ''].join('\n'))
      const cfg = loadInstallConfig(p)
      expect(cfg).toEqual({ version: 1, provider: 'codex', models: { preset: 'balanced', defaults: { model: 'gpt-5.5-mini' }, overrides: {} } })
      expect(logged.join('')).not.toMatch(/agents/)
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
        agents: { selected: [legacyRole('architect')], preset: 'max' },
      })
      const cfg = loadInstallConfig(p)
      expect(cfg!.provider).toBe('claude')
      expect(cfg!.agents?.preset).toBe('max')
      // No preset ships per-role overrides any more: Core has no role ids.
      expect(cfg!.models).toEqual({
        preset: 'max',
        defaults: { model: 'sonnet' },
        overrides: {},
      })
    })

    it('round-trips a config without an agents section', () => {
      const p = path.join(tmpDir, 'rt-no-agents.yaml')
      writeInstallConfig(p, { version: 1, provider: 'gemini' })
      expect(loadInstallConfig(p)).toMatchObject({ version: 1, provider: 'gemini' })
      expect(loadInstallConfig(p)!.agents).toBeUndefined()
    })
  })

  describe('integration contract consistency', () => {
    it('publishes exactly the config providers and preset values the validator resolves', () => {
      const contract = JSON.parse(
        readFileSync(path.join(process.cwd(), 'integration-contract.json'), 'utf8'),
      ) as {
        schemaVersion: string
        configSchema: { fields: Record<string, string> }
        checkpoints: Record<string, string>
        modelPresets: Record<
          'balanced' | 'budget' | 'max',
          {
            defaults: { model: string }
            overrides: Record<string, string>
          }
        >
      }

      expect(contract.schemaVersion).toBe('5.2')
      expect(contract.configSchema.fields.provider).toBe(
        'string — claude | codex | gemini | kimi',
      )
      expect(contract.configSchema.fields.provider).not.toContain('auto')
      // The agents section is optional and deprecated; nothing is generated for it.
      expect(contract.configSchema.fields.agents).toMatch(/optional.*deprecated/i)
      expect(contract.configSchema.fields['agents.selected']).toMatch(/deprecated/)
      expect(contract.checkpoints.agent_generation).toBeUndefined()

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
