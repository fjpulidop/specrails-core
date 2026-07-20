import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeFileLf } from '../util/fs.js'
import { ProviderError } from '../util/errors.js'
import {
  derivedPaths,
  isSupportedKimiVersion,
  parseCliVersion,
  probeKimiAuthentication,
  resolveProvider,
} from './provider-detect.js'

describe('provider-detect.resolveProvider', () => {
  it('uses explicit claude flag unconditionally', async () => {
    const result = await resolveProvider({ claude: false, codex: false }, { explicit: 'claude' })
    expect(result).toBe('claude')
  })

  it('uses explicit codex flag unconditionally', async () => {
    const result = await resolveProvider({ claude: false, codex: false }, { explicit: 'codex' })
    expect(result).toBe('codex')
  })

  it('prefers claude when both are installed (historical default)', async () => {
    expect(await resolveProvider({ claude: true, codex: true })).toBe('claude')
  })

  it('returns claude when only claude is installed', async () => {
    expect(await resolveProvider({ claude: true, codex: false })).toBe('claude')
  })

  it('returns codex when only codex is installed', async () => {
    expect(await resolveProvider({ claude: false, codex: true })).toBe('codex')
  })

  it('throws when neither is installed', async () => {
    await expect(
      resolveProvider({ claude: false, codex: false }),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('skipPrereqs bypasses a missing-CLI failure', async () => {
    const result = await resolveProvider(
      { claude: false, codex: false },
      { skipPrereqs: true },
    )
    expect(result).toBe('claude')
  })
})

describe('provider-detect.derivedPaths', () => {
  it('Claude uses .claude + CLAUDE.md', () => {
    expect(derivedPaths('claude')).toEqual({ providerDir: '.claude', instructionsFile: 'CLAUDE.md' })
  })

  it('Codex uses .codex + AGENTS.md', () => {
    expect(derivedPaths('codex')).toEqual({ providerDir: '.codex', instructionsFile: 'AGENTS.md' })
  })

  it('Gemini uses .gemini + GEMINI.md', () => {
    expect(derivedPaths('gemini')).toEqual({ providerDir: '.gemini', instructionsFile: 'GEMINI.md' })
  })

  it('Kimi uses provider-local .kimi-code/AGENTS.md', () => {
    expect(derivedPaths('kimi')).toEqual({
      providerDir: '.kimi-code',
      instructionsFile: '.kimi-code/AGENTS.md',
    })
  })
})

describe('provider-detect.resolveProvider — gemini', () => {
  it('uses explicit gemini flag unconditionally', async () => {
    expect(await resolveProvider({ claude: false, codex: false }, { explicit: 'gemini' })).toBe('gemini')
  })

  it('returns gemini when only gemini is installed', async () => {
    expect(await resolveProvider({ claude: false, codex: false, gemini: true })).toBe('gemini')
  })

  it('still prefers claude over gemini when both are installed', async () => {
    expect(await resolveProvider({ claude: true, codex: false, gemini: true })).toBe('claude')
  })
})

describe('provider-detect — kimi', () => {
  it('uses explicit kimi selection even when Claude is installed', async () => {
    expect(
      await resolveProvider(
        { claude: true, codex: true, gemini: true, kimi: false },
        { explicit: 'kimi' },
      ),
    ).toBe('kimi')
  })

  it('returns kimi when it is the only installed provider', async () => {
    expect(
      await resolveProvider({ claude: false, codex: false, gemini: false, kimi: true }),
    ).toBe('kimi')
  })

  it('keeps Claude-first auto-selection when Claude and Kimi are installed', async () => {
    expect(
      await resolveProvider({ claude: true, codex: false, gemini: false, kimi: true }),
    ).toBe('claude')
  })

  it('parses and enforces the tested Kimi version floor', () => {
    expect(parseCliVersion('kimi-code 0.27.0')).toBe('0.27.0')
    expect(parseCliVersion('Kimi CLI v1.2.3 (typescript)')).toBe('1.2.3')
    expect(isSupportedKimiVersion('0.26.9')).toBe(false)
    expect(isSupportedKimiVersion('0.27.0')).toBe(true)
    expect(isSupportedKimiVersion('0.28.1')).toBe(true)
    expect(isSupportedKimiVersion('unknown')).toBe(false)
  })

  it('requires both process model and API key as authentication evidence', async () => {
    const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-auth-empty-'))
    try {
      expect(
        await probeKimiAuthentication({
          kimiCodeHome: emptyHome,
          env: { PATH: '', KIMI_MODEL_API_KEY: 'secret-not-read' },
        }),
      ).toBe('unknown')
      expect(
        await probeKimiAuthentication({
          kimiCodeHome: emptyHome,
          env: {
            PATH: '',
            KIMI_MODEL_API_KEY: 'secret-not-read',
            KIMI_MODEL_NAME: 'third-party-model',
          },
        }),
      ).toBe('authenticated')
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it('recognises the managed credential file without reading its secret', async () => {
    const kimiHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-auth-file-'))
    try {
      writeFileLf(
        path.join(kimiHome, 'credentials', 'kimi-code.json'),
        '{"must-not-be-parsed":"or-copied"}\n',
      )
      expect(
        await probeKimiAuthentication({ kimiCodeHome: kimiHome, env: { PATH: '' } }),
      ).toBe('authenticated')
    } finally {
      rmSync(kimiHome, { recursive: true, force: true })
    }
  })
})
