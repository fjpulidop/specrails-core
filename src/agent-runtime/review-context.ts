import type { CandidateManifest } from '../installer/runtime/pipeline-state.js'

export interface ReviewManifest extends CandidateManifest { truncated: boolean }
export function boundedReviewManifest(manifest: CandidateManifest): ReviewManifest {
  let remaining = 10_000
  let truncated = false
  let bytes = 512 * 1024
  const repositories = manifest.repositories.map(repo => {
    const files: typeof repo.files = []
    for (const file of repo.files) {
      const size = Buffer.byteLength(JSON.stringify(file))
      if (files.length >= remaining || size > bytes) break
      files.push(file)
      bytes -= size
    }
    remaining -= files.length
    truncated ||= files.length !== repo.files.length
    return { ...repo, files }
  })
  return { ...manifest, repositories, truncated }
}
const TRANSVERSAL = /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle|pyproject\.toml|Cargo(?:\.toml|\.lock)|[^/]*(?:openapi|security|auth|contract)[^/]*|\.github)(?:\/|$)|\.(?:proto|sql)$/i

export function reviewChanges(previous: ReviewManifest | undefined, current: ReviewManifest): { mode: 'full' | 'incremental'; reason: string; changes: Array<{ repositoryId: string; path: string; status: 'added' | 'changed' | 'deleted' }> } {
  if (!previous || previous.truncated || current.truncated) return { mode: 'full', reason: 'Previous or current review manifest is unavailable or truncated', changes: [] }
  if (previous.scopeHash !== current.scopeHash || previous.repositories.length !== current.repositories.length) return { mode: 'full', reason: 'Review scope identity differs; validate frozen scope before continuing', changes: [] }
  const changes: ReturnType<typeof reviewChanges>['changes'] = []
  for (const repo of current.repositories) {
    const old = previous.repositories.find(item => item.id === repo.id && item.path === repo.path)
    if (!old) return { mode: 'full', reason: 'Repository identity changed', changes: [] }
    const before = new Map(old.files), after = new Map(repo.files)
    for (const file of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(file) === after.get(file)) continue
      changes.push({ repositoryId: repo.id, path: file, status: !after.has(file) ? 'deleted' : !before.has(file) ? 'added' : 'changed' })
    }
  }
  const transversal = changes.some(change => TRANSVERSAL.test(change.path))
  return { mode: transversal ? 'full' : 'incremental', reason: transversal ? 'A shared contract, build, dependency or security input changed' : 'Changes since the previous reviewed candidate', changes }
}
