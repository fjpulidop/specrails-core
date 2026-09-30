import { archivedOpenSpecChange, archiveOpenSpecChange } from '../../graph/artifacts.js'
import { OpenSpecCommandError, resolveOpenSpecCli, runOpenSpec } from '../../openspec.js'
import { EngineError, type Piece, type PieceResult } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { boundedText, json, paramsSchema, text } from './shared.js'

const schema = paramsSchema({ change: { type: 'string', minLength: 1, maxLength: 128 }, allowArchived: { type: 'boolean' }, repositoryId: { type: 'string', minLength: 1, maxLength: 128 } }, ['change'])
function changeId(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) throw new EngineError('invalid_arguments', 'Invalid OpenSpec change identifier')
  return value
}

export function openSpecPieces(bindings: PieceDependencyProvider): Piece[] {
  return [{
    descriptor: { kind: 'openspec-validate', paramsSchema: schema, outcomes: ['pass', 'fail', 'failed'], effect: 'read', requiresAI: false },
    async execute(params, context): Promise<PieceResult> {
      const deps = bindings()
      if (params.repositoryId !== undefined && params.repositoryId !== deps.context.artifactRepositoryId) throw new EngineError('artifact_scope_mismatch', 'OpenSpec repository must match the frozen artifact repository')
      const change = changeId(text(params.change))
      const archived = params.allowArchived === true ? archivedOpenSpecChange(deps.context, change) : undefined
      if (archived) return { outcome: 'pass', output: { change, archived, skipped: true } }
      let stdout: string, exited = true
      try { stdout = await runOpenSpec(resolveOpenSpecCli(), deps.context.artifactRoot, ['validate', change, '--strict', '--json'], context.signal) }
      catch (error) {
        if (!(error instanceof OpenSpecCommandError) || error.exitCode === undefined || error.exitCode < 1) throw error
        stdout = error.stdout
        exited = false
      }
      let report: { items?: Array<{ id?: string; type?: string; valid?: boolean }> }
      try { report = JSON.parse(stdout) as typeof report }
      catch { throw new EngineError('openspec_invalid_output', 'OpenSpec did not return its validation report') }
      const item = report.items?.find(entry => entry.id === change && entry.type === 'change')
      if (!item || typeof item.valid !== 'boolean') throw new EngineError('openspec_invalid_output', 'OpenSpec validation did not report the requested change')
      return { outcome: exited && item.valid ? 'pass' : 'fail', output: json(report) }
    },
  }, {
    descriptor: { kind: 'openspec-archive', paramsSchema: { ...schema, properties: { ...(schema.properties as import('../contracts.js').JsonObject), requiresVerified: { type: 'boolean' }, reviewedCandidate: { type: 'string' }, approvedCandidate: { type: 'string' } } }, outcomes: ['next', 'failed'], effect: 'write', requiresAI: false },
    async execute(params, context): Promise<PieceResult> {
      const deps = bindings()
      if (params.repositoryId !== undefined && params.repositoryId !== deps.context.artifactRepositoryId) throw new EngineError('artifact_scope_mismatch', 'OpenSpec repository must match the frozen artifact repository')
      const snapshot = deps.executionSnapshot(context)
      const verified = snapshot.verified ?? deps.verifiedBeforeWrite?.(context)
      if (params.requiresVerified && (!snapshot.candidate || !verified || verified.candidateHash !== snapshot.candidate.hash)) return { outcome: 'failed', output: { reason: 'unverified' } }
      if ([params.reviewedCandidate, params.approvedCandidate].some(hash => hash !== undefined && hash !== snapshot.candidate?.hash)) return { outcome: 'failed', output: { reason: 'candidate_changed' } }
      const change = changeId(text(params.change)), initial = snapshot.candidate?.hash
      const archived = params.allowArchived === true ? archivedOpenSpecChange(deps.context, change) : undefined
      if (archived) return { outcome: 'next', output: { change, archived, skipped: true } }
      try {
        await archiveOpenSpecChange(deps.context, change, { directory: deps.artifactDirectory(context), beforePublish: () => {
          if (initial !== deps.executionSnapshot(context).candidate?.hash) throw new EngineError('candidate_changed', 'Candidate changed while preparing the OpenSpec archive')
        } }, context.signal)
      } catch (error) {
        if (!(error instanceof OpenSpecCommandError) || error.exitCode === undefined || error.exitCode < 1) throw error
        return { outcome: 'failed', status: 'failed', error: { code: 'openspec_command_failed', message: boundedText(error.message, 4000) },
          output: { change, exitCode: error.exitCode, stdout: boundedText(error.stdout) } }
      }
      return { outcome: 'next', output: { change, archived: true }, history: [{ id: context.frame.attemptId + ':archive', transition: context.frame.transition, attempt: context.frame.attempt, ordinal: 0, nodePath: context.frame.nodePath, text: boundedText('Archived OpenSpec change ' + change) }] }
    },
  }]
}
