import { describe, expect, it } from 'vitest'

import { ProviderError } from '../util/errors.js'
import { derivedPaths, resolveProvider } from './provider-detect.js'

describe('provider-detect.resolveProvider', () => {
  it('uses explicit claude flag unconditionally', async () => {
    const result = await resolveProvider({ claude: false, codex: false }, { explicit: 'claude' })
    expect(result).toBe('claude')
  })

  it('rejects explicit codex with a "coming soon" error', async () => {
    await expect(
      resolveProvider({ claude: true, codex: true }, { explicit: 'codex' }),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('prefers claude when both are installed', async () => {
    expect(await resolveProvider({ claude: true, codex: true })).toBe('claude')
  })

  it('returns claude when only claude is installed', async () => {
    expect(await resolveProvider({ claude: true, codex: false })).toBe('claude')
  })

  it('throws when only codex is installed', async () => {
    await expect(
      resolveProvider({ claude: false, codex: true }),
    ).rejects.toBeInstanceOf(ProviderError)
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
})
