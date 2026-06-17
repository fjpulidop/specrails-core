import { describe, expect, it } from 'vitest'

import { ProviderError } from '../util/errors.js'
import { derivedPaths, resolveProvider } from './provider-detect.js'

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
