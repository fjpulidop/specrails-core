import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTools } from './workspace-tools.js'

const temporary: string[] = []
function directory(): string { const root = mkdtempSync(path.join(tmpdir(), 'specrails-tools-')); temporary.push(root); return root }
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('scoped workspace tools', () => {
  it('reads, lists and atomically writes files in multiple declared roots', () => {
    const root = directory(), other = directory(), tools = new WorkspaceTools(root, [root, other], 'developer')
    tools.execute('write_file', { path: 'src/hello.ts', content: 'export const hello = "¡hola!"\n' })
    expect(tools.execute('read_file', { path: 'src/hello.ts' })).toContain('¡hola!')
    expect(JSON.parse(tools.execute('list_files', { path: 'src' })).entries).toEqual([{ name: 'hello.ts', type: 'file' }])
    tools.execute('write_file', { path: path.join(other, 'hello.txt'), content: 'second root' })
    expect(readFileSync(path.join(other, 'hello.txt'), 'utf8')).toBe('second root')
  })
  it.each(['architect', 'reviewer'] as const)('enforces %s read-only tools even if called directly', role => {
    const root = directory(), tools = new WorkspaceTools(root, [root], role)
    expect(tools.definitions().map(tool => tool.function.name)).toEqual(['list_files', 'read_file'])
    expect(() => tools.execute('write_file', { path: 'file', content: 'bad' })).toThrow('unavailable')
    expect(() => tools.execute('run_shell', { command: 'bad' })).toThrow('unavailable')
  })
  it('rejects traversal, sibling-prefix paths, runtime metadata and symlink escapes', () => {
    const parent = directory(), root = path.join(parent, 'repo'), sibling = path.join(parent, 'repo-evil')
    mkdirSync(root); mkdirSync(sibling); writeFileSync(path.join(sibling, 'secret'), 'secret')
    symlinkSync(sibling, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const tools = new WorkspaceTools(root, [root], 'developer')
    for (const file of ['../repo-evil/secret', path.join(sibling, 'secret'), 'link/secret', '.git/config', '.specrails/pipeline/state.json', '.codex/config.toml']) {
      expect(() => tools.execute('read_file', { path: file })).toThrow()
      expect(() => tools.execute('write_file', { path: file, content: 'bad' })).toThrow()
    }
    expect(readFileSync(path.join(sibling, 'secret'), 'utf8')).toBe('secret')
  })
  it('rejects large, binary and malformed inputs', () => {
    const root = directory(), tools = new WorkspaceTools(root, [root], 'developer')
    writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
    writeFileSync(path.join(root, 'large'), 'a'.repeat(128 * 1024 + 1))
    expect(() => tools.execute('read_file', { path: 'binary' })).toThrow('binary')
    expect(() => tools.execute('read_file', { path: 'large' })).toThrow('128 KiB')
    expect(() => tools.execute('write_file', { path: 'large', content: 'a'.repeat(256 * 1024 + 1) })).toThrow('256 KiB')
    expect(() => tools.execute('read_file', { path: 'large', command: 'x' })).toThrow('Invalid tool arguments')
  })
})
