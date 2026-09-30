import { readFileSync, readdirSync } from 'node:fs'
import { artifactPath } from '../../openspec.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError, type JsonObject, type Piece, type PieceResult } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { idSchema, paramsSchema, text } from './shared.js'

/** A reusable artifact invariant, with no agent roles, phase order or successor policy. */
export function artifactContractPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'artifact-contract', paramsSchema: paramsSchema({
      change: { type: 'string', minLength: 1, maxLength: 128 }, contractId: idSchema, action: { enum: ['freeze', 'check'] },
      requireCompletedTasks: { type: 'boolean' },
    }, ['change', 'contractId', 'action']), outcomes: ['pass', 'fail', 'failed'], effect: 'read', requiresAI: false },
    async execute(params, context): Promise<PieceResult> {
      const deps = bindings(), change = text(params.change)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change) || change.length > 64) throw new EngineError('invalid_arguments', 'Invalid change identifier')
      const store = deps.artifactContracts?.(context)
      if (!store) throw new EngineError('artifact_contract_unavailable', 'Scoped artifact contracts are not bound')
      const directory = 'openspec/changes/' + change
      const files: Record<string, string> = {}
      let bytes = 0
      const read = (relative: string): string => {
        const source = readFileSync(artifactPath(deps.context.artifactRoot, directory + '/' + relative), 'utf8')
        bytes += Buffer.byteLength(source)
        if (bytes > 2 * 1024 * 1024 || Object.keys(files).length >= 200) throw new EngineError('output_limit', 'Artifact contract exceeds its read limit')
        return source
      }
      try {
        for (const name of ['proposal.md', 'design.md', 'tasks.md']) files[name] = read(name)
        const walk = (relative: string): void => {
          for (const entry of readdirSync(artifactPath(deps.context.artifactRoot, directory + '/' + relative), { withFileTypes: true })) {
            const child = relative + '/' + entry.name
            if (entry.isSymbolicLink()) throw new EngineError('artifact_scope_mismatch', 'Artifact contracts reject symlinks')
            if (entry.isDirectory()) walk(child)
            else if (entry.isFile() && entry.name.endsWith('.md')) files[child] = read(child)
          }
        }
        walk('specs')
      } catch (error) {
        if (error instanceof EngineError) throw error
        return { outcome: 'fail', output: { reason: 'required_artifacts_missing' } }
      }
      if (!Object.keys(files).some(name => name.startsWith('specs/')) || Object.values(files).some(source => !source.trim())) return { outcome: 'fail', output: { reason: 'empty_artifacts' } }
      const tasks = [...files['tasks.md'].matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)]
      if (!tasks.length) return { outcome: 'fail', output: { reason: 'tasks_missing' } }
      // Completion may change checkboxes, never the approved task descriptions.
      files['tasks.md'] = files['tasks.md'].replace(/^(\s*[-*]\s+\[)[ xX](\]\s+)/gm, '$1 $2')
      const fingerprint = contentDigest(files), key = text(params.contractId)
      if (params.action === 'freeze') store.set(key, { fingerprint })
      else {
        const frozen = store.get(key) as JsonObject | undefined
        if (!frozen || frozen.fingerprint !== fingerprint) return { outcome: 'fail', output: { reason: frozen ? 'artifacts_changed' : 'contract_missing' } }
      }
      const incomplete = tasks.filter(task => task[1] === ' ').length
      return { outcome: params.requireCompletedTasks && incomplete ? 'fail' : 'pass', output: { fingerprint, tasks: tasks.length, incomplete } }
    },
  }
}
