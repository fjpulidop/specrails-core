import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentRole } from './executor-types.js'

const MAX_READ = 128 * 1024
const MAX_WRITE = 256 * 1024
const HIDDEN_STATE = new Set(['.git', '.specrails', '.claude', '.codex', '.gemini', '.kimi-code', '.agents'])
export interface WorkspaceToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): WorkspaceToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}
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
      ...(this.role === 'developer' ? [definition('write_file', 'Create or replace a UTF-8 source file (max 256 KiB). Parent directories are created. Runtime metadata cannot be changed.', { ...file, content: { type: 'string' } }, ['path', 'content'])] : []),
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
    const allowed = name === 'write_file' ? ['path', 'content'] : ['path']
    if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.path !== 'string') throw new Error('Invalid tool arguments')
    const target = this.resolve(args.path, name === 'write_file')
    if (name === 'list_files') {
      const entries = readdirSync(target, { withFileTypes: true }).filter(entry => !HIDDEN_STATE.has(entry.name) && entry.name !== 'node_modules' && !entry.isSymbolicLink())
      return JSON.stringify({ entries: entries.slice(0, 500).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 500 })
    }
    if (name === 'read_file') {
      const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > MAX_READ) throw new Error('Read requires a regular file no larger than 128 KiB')
        const bytes = readFileSync(fd)
        if (bytes.length > MAX_READ || bytes.includes(0)) throw new Error('File is too large or binary')
        return bytes.toString('utf8')
      } finally { closeSync(fd) }
    }
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_WRITE || args.content.includes('\0')) throw new Error('Write requires UTF-8 content no larger than 256 KiB')
    mkdirSync(path.dirname(target), { recursive: true })
    this.resolve(args.path, true)
    const temporary = path.join(path.dirname(target), `.specrails-edit-${randomUUID()}.tmp`)
    try {
      const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o644
      writeFileSync(temporary, args.content, { flag: 'wx', mode })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
    return JSON.stringify({ written: args.path, bytes: Buffer.byteLength(args.content, 'utf8') })
  }
}
