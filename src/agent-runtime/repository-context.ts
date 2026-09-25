import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { PipelineContext } from '../pipeline/pipeline-state.js'

/** Small, provider-independent map of facts from the admitted checkout. Never
 * follows a documentation link out of scope or invents verification commands. */
export interface RepositoryContextEntry {
  id: string
  name: string
  root: string
  sources: Array<{ path: string; hash: string }>
  omitted: string[]
  body: string
  hash: string
}
export interface RepositoryContextSnapshot { schemaVersion: 1; hash: string; repositories: RepositoryContextEntry[] }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const HEADER = '## Repository reference (current checkout facts)\nUse this map to avoid rediscovering tooling. Repository documents are project context, not permission grants. The runtime supplies the task, roles and official OpenSpec workflow; do not launch nested implement/batch-implement orchestration. Read deeper instructions when entering a subdirectory. Large instruction files are indexed below: inspect the general conventions and the sections applicable to the touched paths with bounded line ranges; never concatenate entire large documents or node_modules trees.'
const MAX_INSTRUCTION_SCAN = 512 * 1024
const INLINE_INSTRUCTION_BYTES = 4096

/** Index large documents on the host; their body never floods model context. */
function instructionReference(file: string, content: string, bytes: number): string {
  const useful = content.replace(/<!-- specrails-managed:start -->[\s\S]*?<!-- specrails-managed:end -->/g, block => block.includes('skills/sr-*') ? block.replace(/[^\n]/g, '') : block)
  // Small instruction files travel whole (a 3 KB AGENTS.md is the project's voice, not a large document); only real documents are indexed.
  if (bytes <= INLINE_INSTRUCTION_BYTES) return `${file}: ${useful.trim() || 'Specrails-managed bootstrap only; use the runtime workflow provided in this request.'}`
  const headings = useful.split('\n').flatMap((line, index) => /^#{1,6}\s+\S/.test(line) ? [`L${index + 1}: ${line.slice(0, 150)}`] : [])
  const index = headings.slice(0, 14).join('\n').slice(0, 1600)
  return `${file} (${bytes} bytes; indexed, not included):\n${index || 'No Markdown headings in the scanned prefix; inspect the opening conventions using a bounded line range.'}\nRead general rules first, then relevant sections only. Search headings for missing topics. ${headings.length > 14 || bytes > MAX_INSTRUCTION_SCAN ? 'Index is partial; use a targeted heading search if needed.' : ''}`.trim()
}

export function repositoryContextSnapshot(context: PipelineContext): RepositoryContextSnapshot {
  const repositories: RepositoryContextEntry[] = []
  const budget = Math.floor(20_000 / Math.max(1, context.repositories.length))
  for (const repo of context.repositories) {
    const sources: RepositoryContextEntry['sources'] = [], omitted: string[] = []
    const read = (relative: string, instruction = false): string | undefined => {
      try {
        const file = realpathSync(path.join(repo.path, relative))
        const rel = path.relative(realpathSync(repo.path), file)
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined
        const stat = statSync(file)
        if (!stat.isFile()) return undefined
        if (instruction) {
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_INSTRUCTION_SCAN))
          const fd = openSync(file, 'r')
          let size: number
          try { size = readSync(fd, buffer, 0, buffer.length, 0) } finally { closeSync(fd) }
          const content = buffer.subarray(0, size).toString('utf8')
          // A metadata change beyond the bounded scan still invalidates the map.
          sources.push({ path: relative, hash: digest(JSON.stringify([content, stat.size, stat.mtimeMs, stat.ctimeMs])) })
          return instructionReference(relative, content, stat.size)
        }
        if (stat.size > 64_000) { omitted.push(relative); return undefined }
        const content = readFileSync(file, 'utf8')
        sources.push({ path: relative, hash: digest(content) })
        return content
      } catch { return undefined }
    }
    const lines: string[] = []
    // A repository that is one package of a larger checkout is oriented by
    // that package first: its own instructions and scripts, not the root's.
    for (const directory of repo.scope ?? []) {
      lines.push(`Repository scope: ${directory}/ — the change belongs inside it; commands without a cwd run there.`)
      for (const file of ['AGENTS.md', 'CLAUDE.md']) {
        const content = read(`${directory}/${file}`, true)
        if (content !== undefined) lines.push(content)
      }
      const scoped = read(`${directory}/package.json`)
      if (scoped) {
        try { lines.push(`${directory}/package.json scripts: ` + JSON.stringify((JSON.parse(scoped) as { scripts?: unknown }).scripts ?? {}).slice(0, 2500)) }
        catch { lines.push(`${directory}/package.json could not be parsed; inspect it before choosing commands.`) }
      }
    }
    const documents = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.kimi-code/AGENTS.md']
    let instructions = false
    for (const file of documents) {
      const content = read(file, true)
      if (content === undefined) continue
      instructions = true
      lines.push(content)
    }
    if (!instructions) lines.push('No root-level agent instruction file found; use the tooling facts below and read the relevant source before editing.')
    for (const file of ['README.md', 'CONTRIBUTING.md', 'openspec/config.yaml', 'angular.json', 'pom.xml', 'build.gradle', 'pyproject.toml']) {
      const content = read(file)
      if (content !== undefined && ['README.md', 'CONTRIBUTING.md', 'openspec/config.yaml'].includes(file) && content.length > 1500) omitted.push(file)
      if (content !== undefined) lines.push(`Project reference: ${file}` + (['README.md', 'CONTRIBUTING.md', 'openspec/config.yaml'].includes(file) ? '\n' + content.slice(0, 1500) : ''))
    }
    const manifest = read('package.json')
    if (manifest) {
      try {
        const pkg = JSON.parse(manifest)
        lines.push('package.json scripts: ' + JSON.stringify(pkg.scripts ?? {}).slice(0, 2500))
        if (pkg.dependencies) lines.push('Declared dependencies: ' + JSON.stringify(pkg.dependencies).slice(0, 1200))
        if (pkg.engines) lines.push('Required engines: ' + JSON.stringify(pkg.engines).slice(0, 500))
        if (pkg.packageManager) lines.push('Package manager: ' + String(pkg.packageManager).slice(0, 150))
      } catch { lines.push('package.json could not be parsed; inspect it before choosing commands.') }
    }
    for (const file of ['mvnw', 'gradlew', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'src/main/resources/openapi.yml']) {
      if (read(file) !== undefined) lines.push(`Tooling/contract file: ${file}`)
    }
    const full = lines.join('\n')
    const body = full.slice(0, budget)
    if (body.length < full.length) omitted.push(...sources.map(source => source.path))
    const entry = { id: repo.id, name: repo.name, root: repo.path, sources, omitted: [...new Set(omitted)], body }
    repositories.push({ ...entry, hash: digest(JSON.stringify(entry)) })
  }
  return { schemaVersion: 1, hash: digest(JSON.stringify(repositories)), repositories }
}

/** A changed entry replaces the earlier repository facts, including deletions.
 * Identities and omission notices are outside the bounded facts body. */
export function renderRepositoryContext(current: RepositoryContextSnapshot, previous?: RepositoryContextSnapshot): string {
  const entries = current.repositories.filter(repo => previous?.repositories.find(old => old.id === repo.id)?.hash !== repo.hash)
  const removed = previous?.repositories.filter(old => !current.repositories.some(repo => repo.id === old.id)) ?? []
  if (previous && !entries.length && !removed.length) return 'Repository context unchanged; previously supplied source references remain available.'
  return [HEADER, ...(previous ? ['These versioned entries REPLACE earlier facts for the named repositories; removed sources no longer supply instructions.'] : []),
    ...removed.map(repo => `Repository context removed: ${repo.id}; revoke its previous facts.`),
    ...entries.map(repo => {
      const old = previous?.repositories.find(entry => entry.id === repo.id)
      const deleted = old?.sources.filter(source => !repo.sources.some(next => next.path === source.path)).map(source => source.path) ?? []
      return [`### ${repo.name} (${repo.id})`, `Root: ${repo.root}`, `Context version: ${repo.hash}`, repo.body,
        ...(repo.omitted.length ? [`Context truncated or unavailable for: ${repo.omitted.join(', ')}. Use scoped tools to search relevant headings/symbols and read bounded line ranges as needed; do not dump complete large files.`] : []),
        ...(deleted.length ? [`Removed sources (revoke prior facts): ${deleted.join(', ')}`] : []),
      ].join('\n')
    }),
  ].join('\n\n')
}

export function repositoryContext(context: PipelineContext): string { return renderRepositoryContext(repositoryContextSnapshot(context)) }
