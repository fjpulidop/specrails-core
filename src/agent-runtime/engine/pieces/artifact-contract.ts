import { readFileSync, readdirSync } from 'node:fs'
import { artifactPath } from '../../openspec.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError, type JsonObject, type Piece, type PieceResult } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { historyEntry, idSchema, paramsSchema, text } from './shared.js'

/** Every checkbox task of an OpenSpec tasks.md, in order. */
export function taskCheckboxes(tasks: string): Array<{ done: boolean; text: string }> {
  return [...tasks.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)].map(match => ({ done: match[1] !== ' ', text: match[2].trim() }))
}

/**
 * Tasks that ask the implementer to edit an artifact that freezes before implementation:
 * the change's proposal.md, design.md or delta specs. Only checkboxes may change after the
 * freeze, so such a task can never be completed. Citing them is fine ("as described in
 * design.md", "do not modify design.md"); the artifact must be the object of an editing
 * verb that is not negated, or the target of recording/writing evidence.
 */
export function tasksEditingFrozenArtifacts(tasks: ReadonlyArray<{ text: string }>, change: string): string[] {
  const escaped = change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const artifact = '[`\'"]?(?:openspec/changes/' + escaped + '/(?:proposal\\.md|design\\.md|specs/)|(?:proposal|design)\\.md\\b)'
  const edit = new RegExp('\\b(?:modify|modifies|update|updates|edit|edits|amend|amends|change|changes|rewrite|rewrites|fill in|fills in|append to|appends to|add to|adds to|write to|writes to)\\b(?:\\s+\\S+){0,3}?\\s+' + artifact, 'i')
  const record = new RegExp('\\b(?:record|records|write|writes|append|appends|log|logs|document|documents)\\b[^.;\\n]{0,80}?\\b(?:in|into|to)\\s+(?:the\\s+)?' + artifact, 'i')
  // "Do not modify design.md" is the opposite instruction: skip a verb negated just before it.
  const negated = /(?:\b(?:not|never|no|nor|without|avoid|avoiding)|n't)\s+(?:\S+\s+){0,2}$/i
  // Only the current clause can negate the verb ("Do not touch tests. Update design.md" asks for an edit).
  const clause = (before: string): string => before.split(/[.;!?:]\s/).pop() ?? before
  const asks = (pattern: RegExp, task: string): boolean => [...task.matchAll(new RegExp(pattern.source, 'gi'))]
    .some(match => !negated.test(clause(task.slice(Math.max(0, match.index - 40), match.index))))
  return tasks.filter(task => asks(edit, task.text) || asks(record, task.text)).map(task => task.text)
}

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
      const tasks = taskCheckboxes(files['tasks.md'])
      if (!tasks.length) return { outcome: 'fail', output: { reason: 'tasks_missing' } }
      if (params.action === 'freeze') {
        const frozenEdits = tasksEditingFrozenArtifacts(tasks, change)
        if (frozenEdits.length) return { outcome: 'fail', output: { reason: 'tasks_edit_frozen_artifacts', tasks: frozenEdits.slice(0, 20) },
          history: [historyEntry(context, [`The plan for change ${change} cannot freeze: these tasks edit proposal.md, design.md or the change's delta specs, which freeze before implementation (the implementer may only tick tasks):`,
            ...frozenEdits.slice(0, 20).map(task => '- ' + task.slice(0, 300)),
            'Rewrite each as work on repository files. Do not ask anyone to record evidence in frozen artifacts: host verification and the review keep the evidence.'].join('\n'))] }
      }
      // Completion may change checkboxes, never the approved task descriptions.
      files['tasks.md'] = files['tasks.md'].replace(/^(\s*[-*]\s+\[)[ xX](\]\s+)/gm, '$1 $2')
      const fingerprint = contentDigest(files), key = text(params.contractId)
      if (params.action === 'freeze') store.set(key, { fingerprint })
      else {
        const frozen = store.get(key) as JsonObject | undefined
        if (!frozen || frozen.fingerprint !== fingerprint) return { outcome: 'fail', output: { reason: frozen ? 'artifacts_changed' : 'contract_missing' } }
      }
      const incomplete = tasks.filter(task => !task.done).length
      return { outcome: params.requireCompletedTasks && incomplete ? 'fail' : 'pass', output: { fingerprint, tasks: tasks.length, incomplete } }
    },
  }
}
