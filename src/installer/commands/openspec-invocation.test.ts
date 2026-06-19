import { describe, expect, it } from 'vitest'

import { buildOpenSpecInvocation } from './init.js'

/**
 * Unit tests for the three openspec invocation forms (PHASE 8 — bundled
 * openspec offline). `buildOpenSpecInvocation` is pure given an env object +
 * pinned version, so no spawning / npm access is required.
 */
describe('buildOpenSpecInvocation', () => {
  const repoRoot = '/tmp/repo'
  const pinned = '1.4.1'

  it('form 1 (node-script): BIN + NODE set → runs `node <cli> init …`', () => {
    const env: NodeJS.ProcessEnv = {
      SPECRAILS_OPENSPEC_BIN: '/bundle/openspec/dist/cli.js',
      SPECRAILS_OPENSPEC_NODE: '/bundle/node/bin/node',
    }
    const { bin, args } = buildOpenSpecInvocation(repoRoot, 'claude', env, pinned)
    expect(bin).toBe('/bundle/node/bin/node')
    expect(args).toEqual([
      '/bundle/openspec/dist/cli.js',
      'init',
      '--tools',
      'claude',
      repoRoot,
    ])
  })

  it('form 2 (direct-bin): only BIN set → runs the CLI directly', () => {
    const env: NodeJS.ProcessEnv = {
      SPECRAILS_OPENSPEC_BIN: '/usr/local/bin/openspec',
    }
    const { bin, args } = buildOpenSpecInvocation(repoRoot, 'codex', env, pinned)
    expect(bin).toBe('/usr/local/bin/openspec')
    expect(args).toEqual(['init', '--tools', 'codex', repoRoot])
  })

  it('form 3 (npx): neither set → falls back to pinned npx spec', () => {
    const env: NodeJS.ProcessEnv = {}
    const { bin, args } = buildOpenSpecInvocation(repoRoot, 'gemini', env, pinned)
    expect(bin).toBe('npx')
    expect(args).toEqual([
      '--yes',
      '-p',
      `@fission-ai/openspec@${pinned}`,
      '--',
      'openspec',
      'init',
      '--tools',
      'gemini',
      repoRoot,
    ])
  })

  it('NODE set WITHOUT BIN is ignored → falls back to npx (node alone is meaningless)', () => {
    const env: NodeJS.ProcessEnv = {
      SPECRAILS_OPENSPEC_NODE: '/bundle/node/bin/node',
    }
    const { bin, args } = buildOpenSpecInvocation(repoRoot, 'claude', env, pinned)
    expect(bin).toBe('npx')
    expect(args).toContain(`@fission-ai/openspec@${pinned}`)
  })
})
