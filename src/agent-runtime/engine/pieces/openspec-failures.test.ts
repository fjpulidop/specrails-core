import { expect, it, vi } from 'vitest'
import { archiveOpenSpecChange } from '../../graph/artifacts.js'
import { OpenSpecCommandError } from '../../openspec.js'
import type { PieceExecutionContext } from '../contracts.js'
import { openSpecPieces } from './openspec.js'
import type { PieceDependencies } from './ports.js'

vi.mock('../../graph/artifacts.js', () => ({ archiveOpenSpecChange: vi.fn(), archivedOpenSpecChange: vi.fn() }))
const context = { signal: new AbortController().signal } as PieceExecutionContext
const deps = { context: { artifactRepositoryId: 'repo' }, executionSnapshot: () => ({}), artifactDirectory: () => '/adapter' } as unknown as PieceDependencies
const archive = () => openSpecPieces(() => deps).find(piece => piece.descriptor.kind === 'openspec-archive')!

it('retains a bounded CLI business failure for explicit recovery routing', async () => {
  vi.mocked(archiveOpenSpecChange).mockRejectedValueOnce(new OpenSpecCommandError('invalid archive', 1, 'Invalid spec'))
  expect(await archive().execute({ change: 'feature' }, context)).toMatchObject({
    outcome: 'failed', status: 'failed', error: { code: 'openspec_command_failed' }, output: { change: 'feature', exitCode: 1, stdout: 'Invalid spec' },
  })
})
it.each([new OpenSpecCommandError('timed out', undefined, '', 'ETIMEDOUT'), new Error('preimage changed')])('does not relabel infrastructure or write conflicts as repairable CLI errors: %s', async error => {
  vi.mocked(archiveOpenSpecChange).mockRejectedValueOnce(error)
  await expect(archive().execute({ change: 'feature' }, context)).rejects.toBe(error)
})

it('rejects stale reviewed and approved candidates before archive effects', async () => {
  const guarded = { ...deps, executionSnapshot: () => ({ candidate: { hash: 'current' }, verified: { candidateHash: 'current' } }) } as unknown as PieceDependencies
  const piece = openSpecPieces(() => guarded).find(item => item.descriptor.kind === 'openspec-archive')!
  expect(await piece.execute({ change: 'feature', requiresVerified: true, reviewedCandidate: 'old' }, context)).toMatchObject({ outcome: 'failed', output: { reason: 'candidate_changed' } })
  expect(await piece.execute({ change: 'feature', requiresVerified: true, reviewedCandidate: 'current', approvedCandidate: 'old' }, context)).toMatchObject({ outcome: 'failed', output: { reason: 'candidate_changed' } })
})
it('requires a current host verification receipt when the workflow enables the archive gate', async () => {
  expect(await archive().execute({ change: 'feature', requiresVerified: true }, context)).toMatchObject({ outcome: 'failed', output: { reason: 'unverified' } })
})
