// The change a run makes, measured by the host from git rather than taken from
// a role's own summary, and the boundary it must stay inside.
//
// Observed (a monorepo app registered as the repository, busuu-courses inside
// busuu-web): the configured `yarn test` ran at the checkout root and fanned
// out to every workspace; the fixer then "repaired" .yarnrc.yml, the root
// package.json and two other apps, the reviewer rejected those unrelated
// edits, the fixer reverted them, verification failed again — a loop that
// never converged. A repository scope makes the boundary explicit: commands
// default to the package, reviews see the exact change set, and edits outside
// the scope are undone by the host before anyone verifies or reviews them.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pipelineStateDirectory, withinRepositoryScope, type PipelineContext, type PipelineRepository } from '../pipeline/pipeline-state.js'

export interface ChangedFile { path: string; status: 'added' | 'modified' | 'deleted' }
export interface RepositoryChangeSet { repositoryId: string; scope?: string[]; files: ChangedFile[]; truncated: boolean }
/** An out-of-scope edit Core undid after a role turn. */
export interface DiscardedEdit { repositoryId: string; path: string; restored: 'base' | 'previous' | 'removed' }

/** Git's empty tree: the base of a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Files whose change inside the scope legitimately refreshes a lockfile of an enclosing workspace. */
const MANIFESTS = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Pipfile', 'Gemfile', 'composer.json', 'requirements.txt'])
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'go.work.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', '.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json'])
const AGENT_MEMORY = ['.claude', '.codex', '.gemini', '.kimi-code'].map(root => root + '/agent-memory')
const GENERATED = new Set(['node_modules', 'coverage', '.nyc_output', '.jest-cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.gradle', '.cache', '.turbo'])
/** Bounded memory for restoring a previous out-of-scope state byte for byte; beyond it the base is restored. */
const RESTORE_FILE_LIMIT = 8 * 1024 * 1024
const RESTORE_TOTAL_LIMIT = 64 * 1024 * 1024
/** Untracked files present when the run started are host/user state (overlays, local files), not the change. */
const PREEXISTING_LIMIT = 20_000

function gitEnv(): NodeJS.ProcessEnv {
  // An inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE must not redirect the inspection.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' }
}
function git(root: string, args: string[], allowFailure = false): { ok: boolean; stdout: string; overflow: boolean } {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const overflow = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS'
  const ok = !result.error && result.status === 0
  if (!ok && !allowFailure) throw new Error(`git ${args[0]} failed in ${root}: ${String(result.error?.message ?? result.stderr ?? '').trim().slice(0, 400)}`)
  return { ok, stdout: result.stdout ?? '', overflow }
}
const posix = (file: string): string => file.split(path.sep).join('/')

/** A command without `cwd` runs in its repository's scope directory, never at the root of a larger checkout. */
export function withScopeDefault<T extends { repositoryId: string; cwd?: string }>(context: PipelineContext, command: T): T {
  if (command.cwd !== undefined) return command
  const scope = context.repositories.find(repo => repo.id === command.repositoryId)?.scope
  return scope?.length ? { ...command, cwd: scope[0] } : command
}
/** Model-proposed checks stay inside the repository scope: they prove the change, not the whole checkout. */
export function assertProposalInScope(context: PipelineContext, command: { repositoryId: string; cwd?: string }, what = 'verification proposal'): void {
  const repository = context.repositories.find(repo => repo.id === command.repositoryId)
  if (!repository?.scope?.length || command.cwd === undefined) return
  const relative = posix(path.relative(repository.path, path.resolve(repository.path, command.cwd)))
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || !withinRepositoryScope(repository, relative)) {
    throw new Error(`Invalid ${what} cwd ${JSON.stringify(command.cwd)}: it runs outside the repository scope (${repository.scope.join(', ')}). Omit cwd to run in ${repository.scope[0]}, or name a directory inside the scope.`)
  }
}

/** Untracked, non-ignored paths; a checkout with an enormous untracked tree reports directories instead of files. */
function untracked(root: string): string[] {
  const files = git(root, ['ls-files', '--others', '--exclude-standard', '-z'], true)
  if (files.ok) return files.stdout.split('\0').filter(Boolean)
  if (!files.overflow) git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  return git(root, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']).stdout.split('\0').filter(Boolean)
}

interface BaseRecord { base: string; preexisting?: string[] }
function baseFile(context: PipelineContext): string { return path.join(pipelineStateDirectory(context), 'change-base.json') }
/**
 * The commit each repository's change is measured against — the host's frozen
 * base when it declared one, otherwise HEAD the first time Core asks (before
 * any role edits) — plus the untracked files that already existed then.
 * Recorded once, so every later turn measures the same change.
 */
function baseRecords(context: PipelineContext): Record<string, BaseRecord> {
  const file = baseFile(context)
  let recorded: Record<string, BaseRecord> = {}
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: number; repositories?: Record<string, BaseRecord> }
    if (value.schemaVersion === 1 && value.repositories && typeof value.repositories === 'object') recorded = value.repositories
  } catch { /* first use */ }
  let changed = false
  for (const repository of context.repositories) {
    const known = recorded[repository.id]
    if (known && typeof known.base === 'string' && /^[a-f0-9]{40,64}$/.test(known.base)) continue
    let base = repository.baseSha
    if (!base) {
      const head = git(repository.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], true)
      base = head.ok && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : EMPTY_TREE
    }
    let present: string[] | undefined
    try { present = untracked(repository.path) } catch { /* not a git checkout: the change cannot be measured */ }
    recorded[repository.id] = { base, ...(present && present.length <= PREEXISTING_LIMIT ? { preexisting: present } : {}) }
    changed = true
  }
  if (changed) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(temp, JSON.stringify({ schemaVersion: 1, repositories: recorded }) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
    finally { rmSync(temp, { force: true }) }
  }
  return recorded
}
/** Base commit per repository id; the first call records it. */
export function changeBases(context: PipelineContext): Record<string, string> {
  return Object.fromEntries(Object.entries(baseRecords(context)).map(([id, record]) => [id, record.base]))
}

/** Host and runtime state, the change's own OpenSpec artifacts and generated trees are never part of the code change. */
function ignored(context: PipelineContext, repository: PipelineRepository, change: string | undefined, file: string, fresh: boolean): boolean {
  if (file === '.specrails' || file.startsWith('.specrails/')) return true
  if (repository.id === context.artifactRepositoryId && change && (file === 'openspec/changes/' + change || file.startsWith('openspec/changes/' + change + '/'))) return true
  if (!fresh) return false
  return AGENT_MEMORY.some(root => file === root || file.startsWith(root + '/')) || file.split('/').some(segment => GENERATED.has(segment))
}

/** Every path that differs from the base: tracked edits (staged or not), deletions and new untracked files. */
export function repositoryChanges(context: PipelineContext, repository: PipelineRepository, base: string, change?: string): ChangedFile[] {
  const files = new Map<string, ChangedFile['status']>()
  const diff = git(repository.path, ['diff', '--name-status', '-z', '--no-renames', '--ignore-submodules=all', base, '--']).stdout.split('\0')
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const status = diff[i]!, file = diff[i + 1]!
    if (!status || !file || ignored(context, repository, change, file, false)) continue
    files.set(file, status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified')
  }
  for (const file of untracked(repository.path)) {
    const relative = file.replace(/\/$/, '')
    if (!files.has(relative) && !ignored(context, repository, change, relative, true)) files.set(file, 'added')
  }
  return [...files].map(([file, status]) => ({ path: file, status })).sort((a, b) => a.path.localeCompare(b.path))
}

/** What this run changed, per repository and bounded: untracked files that predate the run are not part of it. */
export function changeSet(context: PipelineContext, change?: string, limit = 5000): RepositoryChangeSet[] {
  const records = baseRecords(context)
  return context.repositories.map(repository => {
    const record = records[repository.id]!
    const preexisting = new Set(record.preexisting ?? [])
    const files = repositoryChanges(context, repository, record.base, change).filter(file => !(file.status === 'added' && preexisting.has(file.path)))
    return { repositoryId: repository.id, ...(repository.scope ? { scope: repository.scope } : {}), files: files.slice(0, limit), truncated: files.length > limit }
  })
}

function dependencyFileForScope(repository: PipelineRepository, file: string): boolean {
  // A dependency change in the package legitimately refreshes the lockfile (or
  // Yarn's install artifacts) of a workspace that encloses the scope.
  const enclosing = (directory: string): boolean => (repository.scope ?? []).some(scope => directory === '.' || directory === '' || scope === directory || scope.startsWith(directory + '/'))
  if (LOCKFILES.has(path.posix.basename(file))) return enclosing(path.posix.dirname(file))
  const yarn = /^(?:(.*)\/)?\.yarn\/(?:cache\/|install-state\.gz$)/.exec(file)
  return yarn !== null && enclosing(yarn[1] ?? '.')
}
/** Changes outside the repository scope (none when the whole checkout is the repository). */
export function outOfScope(repository: PipelineRepository, files: readonly ChangedFile[]): ChangedFile[] {
  if (!repository.scope?.length) return []
  const manifestChanged = files.some(file => withinRepositoryScope(repository, file.path) && MANIFESTS.has(path.posix.basename(file.path)))
  return files.filter(file => !withinRepositoryScope(repository, file.path.replace(/\/$/, '')) && !(manifestChanged && dependencyFileForScope(repository, file.path)))
}

interface SavedState { fingerprint: string; content?: Buffer; mode?: number; link?: string }
/** The out-of-scope state before a role turn: the host undoes only what that turn did. */
export interface ScopeGuard { change?: string; repositories: Array<{ id: string; base: string; before: Map<string, SavedState> }> }

function fingerprintOf(file: string): { fingerprint: string; content?: Buffer; mode?: number; link?: string } {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return { fingerprint: 'missing' }
  if (stat.isSymbolicLink()) { const link = readlinkSync(file); return { fingerprint: 'link:' + link, link } }
  if (!stat.isFile()) return { fingerprint: 'other' }
  const content = readFileSync(file)
  return { fingerprint: `file:${stat.mode & 0o777}:${createHash('sha256').update(content).digest('hex')}`, content, mode: stat.mode & 0o777 }
}

export function captureOutOfScope(context: PipelineContext, change?: string): ScopeGuard {
  const scoped = context.repositories.filter(repository => repository.scope?.length)
  if (!scoped.length) return { change, repositories: [] }
  const bases = changeBases(context)
  let budget = 0
  return {
    change,
    repositories: scoped.map(repository => {
      const base = bases[repository.id]!
      const before = new Map<string, SavedState>()
      for (const file of outOfScope(repository, repositoryChanges(context, repository, base, change))) {
        const { content, ...saved } = fingerprintOf(path.join(repository.path, file.path))
        const keep = content && content.length <= RESTORE_FILE_LIMIT && budget + content.length <= RESTORE_TOTAL_LIMIT
        if (keep) budget += content.length
        before.set(file.path, keep ? { ...saved, content } : saved)
      }
      return { id: repository.id, base, before }
    }),
  }
}

function restoreFromBase(repository: PipelineRepository, base: string, files: readonly string[]): DiscardedEdit[] {
  const restored: DiscardedEdit[] = []
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100)
    const tracked = base === EMPTY_TREE ? new Set<string>() : new Set(git(repository.path, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', base, '--', ...batch.map(file => file.replace(/\/$/, ''))]).stdout.split('\0').filter(Boolean))
    const existing = batch.filter(file => tracked.has(file))
    if (existing.length) git(repository.path, ['restore', '--source=' + base, '--staged', '--worktree', '--', ...existing])
    const added = batch.filter(file => !tracked.has(file))
    if (added.length) git(repository.path, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...added.map(file => file.replace(/\/$/, ''))], true)
    for (const file of added) rmSync(path.join(repository.path, file), { recursive: true, force: true })
    restored.push(...existing.map(file => ({ repositoryId: repository.id, path: file, restored: 'base' as const })), ...added.map(file => ({ repositoryId: repository.id, path: file.replace(/\/$/, ''), restored: 'removed' as const })))
  }
  return restored
}
function restorePrevious(repository: PipelineRepository, file: string, saved: SavedState): void {
  const target = path.join(repository.path, file)
  rmSync(target, { recursive: true, force: true })
  if (saved.fingerprint === 'missing') return
  mkdirSync(path.dirname(target), { recursive: true })
  if (saved.link !== undefined) symlinkSync(saved.link, target)
  else writeFileSync(target, saved.content!, { mode: saved.mode ?? 0o644 })
}

/**
 * Undoes every out-of-scope edit made since `guard` was captured. A path the
 * turn changed outside the scope returns to its state before the turn: its
 * base content, its earlier out-of-scope content, or absence. In-scope work,
 * ignored files and out-of-scope state that predates the turn stay untouched.
 */
export function discardOutOfScopeEdits(context: PipelineContext, guard: ScopeGuard): DiscardedEdit[] {
  const discarded: DiscardedEdit[] = []
  for (const entry of guard.repositories) {
    const repository = context.repositories.find(repo => repo.id === entry.id)!
    const now = outOfScope(repository, repositoryChanges(context, repository, entry.base, guard.change)).map(file => file.path)
    const changedNow = new Set(now)
    // A tracked file the turn returned to its base content leaves the change smaller: that clean-up stays.
    const settled = [...entry.before.keys()].filter(file => !changedNow.has(file))
    const tracked = settled.length && entry.base !== EMPTY_TREE ? new Set(git(repository.path, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', entry.base, '--', ...settled]).stdout.split('\0').filter(Boolean)) : new Set<string>()
    const toBase: string[] = []
    for (const file of new Set([...now, ...entry.before.keys()])) {
      const saved = entry.before.get(file)
      if (!saved) { toBase.push(file); continue }
      if (saved.fingerprint === fingerprintOf(path.join(repository.path, file)).fingerprint) continue
      if (!changedNow.has(file) && tracked.has(file)) continue
      if (saved.fingerprint === 'missing' || saved.link !== undefined || saved.content) {
        restorePrevious(repository, file, saved)
        discarded.push({ repositoryId: repository.id, path: file, restored: 'previous' })
      } else toBase.push(file)
    }
    discarded.push(...restoreFromBase(repository, entry.base, toBase))
  }
  return discarded.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.path.localeCompare(b.path))
}

/** Bounded prompt lines for a change set; repository ids prefix the paths only when several repositories are in scope. */
export function renderChangeSet(sets: readonly RepositoryChangeSet[], limit = 150): string[] {
  const multiple = sets.length > 1
  const lines: string[] = []
  let hidden = 0
  for (const set of sets) {
    for (const file of set.files) {
      if (lines.length >= limit) { hidden++; continue }
      lines.push(`- ${multiple ? '`' + set.repositoryId + '` ' : ''}\`${file.path}\` (${file.status})`)
    }
    if (set.truncated) hidden++
  }
  if (hidden) lines.push(`- … ${hidden}${sets.some(set => set.truncated) ? '+' : ''} more not listed; compare against the base with git to see them.`)
  return lines
}
/** One human line naming discarded edits, bounded. */
export function describeDiscarded(edits: readonly DiscardedEdit[], multiple: boolean, limit = 12): string {
  const names = edits.map(edit => (multiple ? edit.repositoryId + ':' : '') + edit.path)
  return names.slice(0, limit).join(', ') + (names.length > limit ? ` and ${names.length - limit} more` : '')
}
