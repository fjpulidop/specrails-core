import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AgentRole } from './executor-types.js'

const MAX_READ = 128 * 1024
const MAX_WRITE = 256 * 1024
const MAX_OUTPUT = 48 * 1024
const OMITTED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.next'])
const HIDDEN_STATE = new Set(['.git', '.specrails', '.claude', '.codex', '.gemini', '.kimi-code', '.agents'])
export interface WorkspaceToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): WorkspaceToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Expected an integer from 1 to ${max}`)
  return value
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
export function isWithinRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
export function canonicalWorkspace(cwd: string, allowedRoots: string[]): { cwd: string; roots: string[] } {
  if (!path.isAbsolute(cwd) || !allowedRoots.length || allowedRoots.some(root => !path.isAbsolute(root))) throw new Error('Workspace and allowed roots must be absolute paths')
  const roots = [...new Set(allowedRoots.map(root => realpathSync(root)))]
  const directory = realpathSync(cwd)
  if (roots.some(root => !lstatSync(root).isDirectory()) || !lstatSync(directory).isDirectory() || !roots.some(root => isWithinRoot(root, directory))) throw new Error('Workspace must be a directory inside the allowed roots')
  return { cwd: directory, roots }
}
/** Application tool boundary, not an OS sandbox for concurrent external processes. */
export class WorkspaceTools {
  readonly cwd: string
  readonly roots: string[]
  private readonly rootAliases: { lexical: string; canonical: string }[]
  constructor(cwd: string, roots: string[], private readonly role: AgentRole) {
    const scope = canonicalWorkspace(cwd, roots)
    this.cwd = scope.cwd
    this.roots = scope.roots
    this.rootAliases = roots.map(root => ({ lexical: path.resolve(root), canonical: realpathSync(root) })).sort((a, b) => b.lexical.length - a.lexical.length)
  }
  definitions(): WorkspaceToolDefinition[] {
    const file = { path: { type: 'string', description: 'Relative to the workspace, or an absolute path within an allowed root.' } }
    return [
      definition('list_files', 'List a directory, up to 500 entries. Runtime metadata and dependencies are omitted.', file, ['path']),
      definition('read_file', 'Read a UTF-8 source file up to 128 KiB. Binary files are rejected.', file, ['path']),
      definition('read_lines', 'Read numbered lines, up to 500 lines / 48 KiB, from a UTF-8 file up to 1 MiB. Returns a full-file SHA-256 for guarded edits.', { ...file, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['path']),
      definition('search_text', 'Search literal text recursively in source files. Skips dependencies, build output, metadata, binaries and symlinks. Returns bounded numbered matches and a truncation flag.', { ...file, query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, ['path', 'query']),
      definition('get_diff', 'Read the staged and unstaged Git diff against HEAD for one file, up to 48 KiB. Untracked files are identified; use read_lines for their content.', file, ['path']),
      ...(this.role === 'developer' ? [definition('write_file', 'Create or replace a UTF-8 source file (max 256 KiB). Parent directories are created. Runtime metadata cannot be changed.', { ...file, content: { type: 'string' } }, ['path', 'content'])] : []),
      ...(this.role === 'developer' ? [definition('apply_patch', 'Atomically replace one exact, unique fragment in a UTF-8 file. Rejects missing or ambiguous matches. Optionally guard against stale reads with expectedHash from read_lines.', { ...file, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, expectedHash: { type: 'string' } }, ['path', 'oldText', 'newText'])] : []),
    ]
  }
  private resolve(raw: string, write: boolean): string {
    if (!raw || raw.includes('\0') || (process.platform !== 'win32' && (raw.includes('\\') || /^[A-Za-z]:/.test(raw)))) throw new Error('Invalid workspace path')
    let target = path.resolve(this.cwd, raw)
    const alias = this.rootAliases.find(root => isWithinRoot(root.lexical, target))
    if (alias) target = path.resolve(alias.canonical, path.relative(alias.lexical, target))
    const root = this.roots.filter(candidate => isWithinRoot(candidate, target)).sort((a, b) => b.length - a.length)[0]
    if (!root) throw new Error('Path escapes the allowed workspace roots')
    const parts = path.relative(root, target).split(path.sep).filter(Boolean)
    if (parts.some(part => HIDDEN_STATE.has(part))) throw new Error('Access to runtime or provider metadata is not permitted')
    if (write && target === root) throw new Error('Cannot overwrite a workspace root')
    let current = root
    for (const part of parts) {
      current = path.join(current, part)
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink paths are not permitted') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (existsSync(target) && !this.roots.some(candidate => isWithinRoot(candidate, realpathSync(target)))) throw new Error('Canonical path escapes the allowed workspace roots')
    return target
  }
  execute(name: string, input: unknown): string {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be a JSON object')
    const args = input as Record<string, unknown>
    if (!this.definitions().some(tool => tool.function.name === name)) throw new Error(`Tool '${name}' is unavailable for the ${this.role} role`)
    const allowed = name === 'write_file' ? ['path', 'content'] : name === 'apply_patch' ? ['path', 'oldText', 'newText', 'expectedHash'] : name === 'read_lines' ? ['path', 'startLine', 'endLine'] : name === 'search_text' ? ['path', 'query', 'maxResults'] : ['path']
    if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.path !== 'string') throw new Error('Invalid tool arguments')
    const target = this.resolve(args.path, name === 'write_file' || name === 'apply_patch')
    if (name === 'read_lines') {
      const text = this.read(target, 1024 * 1024), lines = text.split('\n')
      if (lines.at(-1) === '') lines.pop()
      const start = integer(args.startLine, 1, Number.MAX_SAFE_INTEGER)
      const end = integer(args.endLine, start + 199, Number.MAX_SAFE_INTEGER)
      if (end < start) throw new Error('endLine must not precede startLine')
      const selected: { line: number; text: string }[] = []
      let bytes = 0
      const stop = Math.min(end, lines.length, start + 499)
      for (let line = start; line <= stop; line++) {
        const row = { line, text: lines[line - 1]! }
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8')
        if (bytes + size > MAX_OUTPUT) break
        selected.push(row); bytes += size
      }
      const nextLine = start + selected.length
      return JSON.stringify({ path: args.path, hash: digest(text), lines: selected, totalLines: lines.length, truncated: nextLine <= Math.min(end, lines.length), ...(nextLine <= lines.length ? { nextLine } : {}) })
    }
    if (name === 'search_text') return this.search(target, args)
    if (name === 'get_diff') return this.diff(target)
    if (name === 'apply_patch') {
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string' || args.oldText.includes('\0') || args.newText.includes('\0') || Buffer.byteLength(args.newText) > MAX_WRITE) throw new Error('Patch requires nonempty oldText and bounded UTF-8 newText')
      const text = this.read(target, MAX_WRITE)
      if (args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || args.expectedHash !== digest(text))) throw new Error('File changed since it was read; read it again before patching')
      const at = text.indexOf(args.oldText)
      if (at < 0) throw new Error('Patch text was not found')
      if (text.indexOf(args.oldText, at + 1) !== -1) throw new Error('Patch text is ambiguous; include more surrounding context')
      const content = text.slice(0, at) + args.newText + text.slice(at + args.oldText.length)
      if (Buffer.byteLength(content) > MAX_WRITE) throw new Error('Patched file exceeds 256 KiB')
      this.write(target, content)
      return JSON.stringify({ patched: args.path, hash: digest(content), bytes: Buffer.byteLength(content) })
    }
    if (name === 'list_files') {
      const entries = readdirSync(target, { withFileTypes: true }).filter(entry => !HIDDEN_STATE.has(entry.name) && entry.name !== 'node_modules' && !entry.isSymbolicLink())
      return JSON.stringify({ entries: entries.slice(0, 500).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 500 })
    }
    if (name === 'read_file') {
      return this.read(target, MAX_READ)
    }
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_WRITE || args.content.includes('\0')) throw new Error('Write requires UTF-8 content no larger than 256 KiB')
    this.write(target, args.content)
    return JSON.stringify({ written: args.path, bytes: Buffer.byteLength(args.content, 'utf8') })
  }
  private read(target: string, limit: number): string {
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > limit) throw new Error(`Read requires a regular file no larger than ${limit / 1024} KiB`)
      const bytes = Buffer.alloc(limit + 1)
      // A bounded descriptor read also protects against a file growing after stat.
      let count = 0
      while (count < bytes.length) {
        const size = readSync(fd, bytes, count, bytes.length - count, count)
        if (size === 0) break
        count += size
      }
      const content = bytes.subarray(0, count)
      if (count > limit || content.includes(0)) throw new Error('File is too large or binary')
      return content.toString('utf8')
    } finally { closeSync(fd) }
  }
  private write(target: string, content: string): void {
    mkdirSync(path.dirname(target), { recursive: true })
    this.resolve(target, true)
    const temporary = path.join(path.dirname(target), `.specrails-edit-${randomUUID()}.tmp`)
    try {
      const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o644
      writeFileSync(temporary, content, { flag: 'wx', mode })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
  }
  private search(target: string, args: Record<string, unknown>): string {
    if (typeof args.query !== 'string' || !args.query || args.query.length > 1000 || /[\r\n\0]/.test(args.query)) throw new Error('query must be a nonempty literal single-line string of at most 1000 characters')
    const max = integer(args.maxResults, 50, 100)
    const pending = [target], matches: { path: string; line: number; text: string }[] = []
    let visited = 0, scannedBytes = 0, outputBytes = 0, skipped = 0, truncated = false
    while (pending.length) {
      if (++visited > 2000 || scannedBytes >= 8 * 1024 * 1024) { truncated = true; break }
      const file = pending.pop()!
      try {
        this.resolve(file, false)
        const stat = lstatSync(file)
        if (stat.isSymbolicLink()) { skipped++; continue }
        if (stat.isDirectory()) {
          const remaining = Math.max(0, 2000 - visited - pending.length)
          const entries: string[] = []
          const dir = opendirSync(file)
          try {
            let entry
            let seen = 0
            while ((entry = dir.readSync())) {
              if (++seen > remaining) { truncated = true; break }
              if (!HIDDEN_STATE.has(entry.name) && !OMITTED_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) entries.push(entry.name)
            }
          } finally { dir.closeSync() }
          pending.push(...entries.sort().reverse().map(name => path.join(file, name)))
          continue
        }
        if (!stat.isFile() || stat.size > MAX_READ) { skipped++; continue }
        scannedBytes += stat.size
        const lines = this.read(file, MAX_READ).split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.includes(args.query)) continue
          const row = { path: path.relative(this.cwd, file), line: i + 1, text: lines[i]!.slice(0, 2000) }
          const size = Buffer.byteLength(JSON.stringify(row))
          if (matches.length >= max || outputBytes + size > MAX_OUTPUT) return JSON.stringify({ matches, truncated: true, skipped })
          if (row.text.length < lines[i]!.length) truncated = true
          matches.push(row); outputBytes += size
        }
      } catch { skipped++ }
    }
    return JSON.stringify({ matches, truncated, skipped })
  }
  private diff(target: string): string {
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('get_diff requires one file path')
    const root = this.roots.filter(root => isWithinRoot(root, target)).sort((a, b) => b.length - a.length)[0]!
    // Do not let an inherited Git context redirect an inspection outside this root.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }
    const relative = path.relative(root, target)
    const options = { encoding: 'utf8' as const, env, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }
    const git = ['-c', 'core.fsmonitor=false', '-C', root]
    const result = spawnSync('git', [...git, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', 'HEAD', '--', relative], options)
    const overflow = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
    if ((!overflow && result.error) || (!overflow && result.status !== 0)) throw new Error('Git diff is unavailable for this workspace')
    const bytes = Buffer.from(result.stdout ?? '', 'utf8')
    if (bytes.length || overflow) return JSON.stringify({ untracked: false, diff: bytes.subarray(0, MAX_OUTPUT).toString('utf8'), truncated: overflow || bytes.length > MAX_OUTPUT })
    const tracked = spawnSync('git', [...git, 'ls-files', '--error-unmatch', '--', relative], options)
    if (tracked.error || (tracked.status !== 0 && tracked.status !== 1)) throw new Error('Git diff is unavailable for this workspace')
    if (tracked.status === 1) return JSON.stringify({ untracked: true, diff: '', truncated: false })
    return JSON.stringify({ untracked: false, diff: '', truncated: false })
  }
}
