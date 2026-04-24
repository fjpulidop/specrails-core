import { describe, expect, it } from 'vitest'

import { main, parseArgs } from './cli.js'

describe('cli.parseArgs', () => {
  it('captures the first positional as the subcommand', () => {
    const { subcommand } = parseArgs(['init'])
    expect(subcommand).toBe('init')
  })

  it('handles --flag=value form', () => {
    const { flags } = parseArgs(['init', '--root-dir=/tmp/repo'])
    expect(flags['root-dir']).toBe('/tmp/repo')
  })

  it('handles --flag value (space) form', () => {
    const { flags } = parseArgs(['init', '--root-dir', '/tmp/repo'])
    expect(flags['root-dir']).toBe('/tmp/repo')
  })

  it('treats --flag with no value as boolean true', () => {
    const { flags } = parseArgs(['init', '--yes'])
    expect(flags.yes).toBe(true)
  })

  it('expands -h into help and -v into version', () => {
    expect(parseArgs(['-h']).flags.help).toBe(true)
    expect(parseArgs(['-v']).flags.version).toBe(true)
  })

  it('collects further bare tokens as positionals', () => {
    const { subcommand, positionals } = parseArgs(['profile', 'validate', './foo.json'])
    expect(subcommand).toBe('profile')
    expect(positionals).toEqual(['validate', './foo.json'])
  })

  it('returns an empty ParsedArgs for no input', () => {
    const parsed = parseArgs([])
    expect(parsed.subcommand).toBeNull()
    expect(parsed.positionals).toEqual([])
    expect(parsed.flags).toEqual({})
  })
})

describe('cli.main', () => {
  it('--help exits zero', async () => {
    expect(await main(['--help'])).toBe(0)
  })

  it('help subcommand exits zero', async () => {
    expect(await main(['help'])).toBe(0)
  })

  it('no args exits zero and shows usage (via the help path)', async () => {
    expect(await main([])).toBe(0)
  })

  it('--version exits zero', async () => {
    expect(await main(['--version'])).toBe(0)
  })

  it('version subcommand exits zero', async () => {
    expect(await main(['version'])).toBe(0)
  })

  it('unknown subcommand exits 1', async () => {
    expect(await main(['bogus'])).toBe(1)
  })

  it('perf-check returns 0 (no runtime perf paths in core)', async () => {
    expect(await main(['perf-check'])).toBe(0)
  })
})
