import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTools } from './workspace-tools.js'
import { spawnSync } from 'node:child_process'

const temporary: string[] = []
function directory(): string { const root = mkdtempSync(path.join(tmpdir(), 'specrails-tools-')); temporary.push(root); return root }
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('scoped workspace tools', () => {
  it('reads numbered ranges and applies a unique patch guarded by the content hash', () => {
    const root = directory(), tools = new WorkspaceTools(root, [root], 'developer')
    const file = path.join(root, 'code.ts')
    writeFileSync(file, 'first\r\nconst value = 1\r\nlast\r\n', { mode: 0o640 })
    const read = JSON.parse(tools.execute('read_lines', { path: 'code.ts', startLine: 2, endLine: 2 }))
    expect(read).toMatchObject({ lines: [{ line: 2, text: 'const value = 1\r' }], totalLines: 3, truncated: false })
    tools.execute('apply_patch', { path: 'code.ts', oldText: 'value = 1', newText: 'value = 2', expectedHash: read.hash })
    expect(readFileSync(file, 'utf8')).toBe('first\r\nconst value = 2\r\nlast\r\n')
    expect(() => tools.execute('apply_patch', { path: 'code.ts', oldText: 'value = 2', newText: 'value = 3', expectedHash: read.hash })).toThrow('changed')
    expect(() => tools.execute('apply_patch', { path: 'code.ts', oldText: '\r\n', newText: '\n' })).toThrow('ambiguous')
    expect(() => tools.execute('apply_patch', { path: 'code.ts', oldText: 'missing', newText: '' })).toThrow('not found')
    expect(readFileSync(file, 'utf8')).toContain('value = 2')
  })
  it('bounds range output and searches literal text without traversing protected or generated directories', () => {
    const root = directory(), tools = new WorkspaceTools(root, [root], 'reviewer')
    writeFileSync(path.join(root, 'code.ts'), Array.from({ length: 800 }, (_, i) => `match.* ${i}`).join('\n'))
    for (const name of ['.specrails', '.git', 'node_modules']) {
      mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, 'secret'), 'match.* hidden')
    }
    writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
    const read = JSON.parse(tools.execute('read_lines', { path: 'code.ts', startLine: 1, endLine: 800 }))
    expect(read.lines).toHaveLength(500)
    expect(read).toMatchObject({ truncated: true, nextLine: 501 })
    const search = JSON.parse(tools.execute('search_text', { path: '.', query: 'match.*', maxResults: 2 }))
    expect(search.matches).toEqual([{ path: 'code.ts', line: 1, text: 'match.* 0' }, { path: 'code.ts', line: 2, text: 'match.* 1' }])
    expect(search.truncated).toBe(true)
    expect(tools.execute('search_text', { path: '.', query: 'hidden' })).not.toContain('secret')
    expect(() => tools.execute('search_text', { path: '.', query: '', maxResults: 2 })).toThrow('query')
    expect(() => tools.execute('read_lines', { path: 'code.ts', startLine: 3, endLine: 2 })).toThrow('endLine')
  })
  it('returns a file diff including staged changes without executing external diff commands', () => {
    const root = directory(), tools = new WorkspaceTools(root, [root], 'reviewer')
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid'])
    writeFileSync(path.join(root, 'code.ts'), 'before\n')
    git(['add', '.']); git(['commit', '-qm', 'initial'])
    writeFileSync(path.join(root, 'code.ts'), 'after\n'); git(['add', 'code.ts'])
    git(['config', 'diff.external', 'must-not-execute-this-command'])
    const diff = JSON.parse(tools.execute('get_diff', { path: 'code.ts' }))
    expect(diff).toMatchObject({ untracked: false, truncated: false })
    expect(diff.diff).toContain('-before')
    expect(diff.diff).toContain('+after')
    git(['rm', '-f', 'code.ts'])
    const deleted = JSON.parse(tools.execute('get_diff', { path: 'code.ts' }))
    expect(deleted).toMatchObject({ untracked: false })
    expect(deleted.diff).toContain('-before')
    writeFileSync(path.join(root, 'new.ts'), 'untracked')
    expect(JSON.parse(tools.execute('get_diff', { path: 'new.ts' }))).toMatchObject({ untracked: true })
    expect(() => tools.execute('get_diff', { path: '.' })).toThrow('one file')
  })
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
    expect(tools.definitions().map(tool => tool.function.name)).toEqual(['list_files', 'read_file', 'read_lines', 'search_text', 'get_diff'])
    expect(() => tools.execute('write_file', { path: 'file', content: 'bad' })).toThrow('unavailable')
    expect(() => tools.execute('apply_patch', { path: 'file', oldText: 'a', newText: 'b' })).toThrow('unavailable')
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
      expect(() => tools.execute('read_lines', { path: file })).toThrow()
      expect(() => tools.execute('search_text', { path: file, query: 'secret' })).toThrow()
      expect(() => tools.execute('get_diff', { path: file })).toThrow()
      expect(() => tools.execute('apply_patch', { path: file, oldText: 'secret', newText: 'bad' })).toThrow()
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
