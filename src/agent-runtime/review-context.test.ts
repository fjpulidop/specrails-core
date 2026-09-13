import { expect, it } from 'vitest'
import { boundedReviewManifest, reviewChanges } from './review-context.js'
import type { CandidateManifest } from '../installer/runtime/pipeline-state.js'

function manifest(files: Array<[string, string]>): CandidateManifest { return { schemaVersion: 1, scopeHash: 'scope', repositories: [{ id: 'front', path: '/front', files }] } }
it('compares against the actual previous reviewed candidate including deletions and modes', () => {
  const old = boundedReviewManifest(manifest([['src/a.ts', 'file:old'], ['src/gone.ts', 'file:x'], ['run', 'file:x']]))
  const current = boundedReviewManifest(manifest([['src/a.ts', 'file:new'], ['src/added.ts', 'file:y'], ['run', 'executable:x']]))
  expect(reviewChanges(old, current)).toMatchObject({ mode: 'incremental', changes: [
    { path: 'src/a.ts', status: 'changed' }, { path: 'src/gone.ts', status: 'deleted' }, { path: 'run', status: 'changed' }, { path: 'src/added.ts', status: 'added' },
  ] })
})
it('uses full review for shared contracts, incomplete manifests and different scope', () => {
  const old = boundedReviewManifest(manifest([]))
  for (const file of ['package-lock.json', 'api/openapi.yml', 'src/auth/guard.ts', 'db/migration.sql', '.github/workflows/ci.yml']) expect(reviewChanges(old, boundedReviewManifest(manifest([[file, 'new']]))).mode).toBe('full')
  expect(reviewChanges({ ...old, truncated: true }, old).mode).toBe('full')
  expect(reviewChanges({ ...old, scopeHash: 'other' }, old).mode).toBe('full')
  expect(boundedReviewManifest(manifest(Array.from({ length: 10_001 }, (_, i) => [String(i), 'hash']))).truncated).toBe(true)
})
