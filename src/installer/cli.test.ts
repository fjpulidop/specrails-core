import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../shared/args.js'
import { main } from './cli.js'

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
    const { subcommand, positionals } = parseArgs(['runtime', 'status', './ctx.json'])
    expect(subcommand).toBe('runtime')
    expect(positionals).toEqual(['status', './ctx.json'])
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

  it('routes pipeline trace to the requirement trace: fail-open by default, failing --check on an undemonstrated touched requirement', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cli trace '))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      mkdirSync(path.join(root, 'openspec', 'changes', 'add-search', 'specs', 'search'), { recursive: true })
      writeFileSync(path.join(root, 'openspec', 'changes', 'add-search', 'specs', 'search', 'spec.md'), '## ADDED Requirements\n### Requirement: Search projects\nThe system SHALL search.\n')
      expect(await main(['pipeline', 'trace', '--root', root])).toBe(0)
      expect(await main(['pipeline', 'trace', '--root', root, '--check', '--tests-passed'])).toBe(1)
      writeFileSync(path.join(root, 'search.test.js'), "test('[spec:search/search-projects] finds', () => {})\n")
      expect(await main(['pipeline', 'trace', '--root', root, '--check', '--tests-passed'])).toBe(0)
      expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('Requirements demonstrated 1/1')
    } finally {
      stdout.mockRestore(); stderr.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
