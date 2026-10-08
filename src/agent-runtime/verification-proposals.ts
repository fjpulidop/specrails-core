// Which agent-proposed verification commands the host adds to its plan.
//
// A repository without configured checks takes the proposals as its checks
// (validated like any configured command). A repository with configured
// checks keeps them and may gain only runs of a package script the
// repository itself declares, such as `npm run test:e2e`: a change whose
// acceptance needs browser or integration tests then gets host evidence for
// them, without the agent introducing arbitrary commands next to the
// configured ones.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { PipelineContext, VerificationCommand } from '../pipeline/pipeline-state.js'

/** The package script a command runs (`npm test`, `npm run x`, `pnpm [run] x`, `yarn [run] x`), when it runs exactly one with no extra arguments. */
export function packageScriptOf(command: Pick<VerificationCommand, 'command' | 'args'>): string | undefined {
  const [first, second, ...rest] = command.args
  if (command.command === 'npm') {
    if (first === 'test' && second === undefined) return 'test'
    if ((first === 'run' || first === 'run-script') && second && !rest.length) return second
    return undefined
  }
  if (command.command === 'pnpm' || command.command === 'yarn') {
    if (first === 'run' && second && !rest.length) return second
    if (first && second === undefined && !first.startsWith('-')) return first
  }
  return undefined
}

function declaresScript(directory: string, script: string): boolean {
  const file = path.join(directory, 'package.json')
  if (!existsSync(file)) return false
  try {
    const scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> }).scripts
    return !!scripts && typeof scripts[script] === 'string'
  } catch { return false }
}

const planKey = (command: VerificationCommand): string => JSON.stringify([command.repositoryId, command.cwd ?? '', command.command, command.args])

/**
 * The proposals to append to `planned` (already scope-defaulted). `normalize`
 * applies the caller's scope default; proposals are expected to be
 * structurally valid.
 */
export function admitVerificationProposals(context: PipelineContext, planned: readonly VerificationCommand[], proposals: readonly VerificationCommand[], normalize: (command: VerificationCommand) => VerificationCommand): VerificationCommand[] {
  const configured = new Set(planned.map(command => command.repositoryId))
  const seen = new Set(planned.map(planKey))
  const admitted: VerificationCommand[] = []
  for (const raw of proposals) {
    const repository = context.repositories.find(repo => repo.id === raw.repositoryId)
    if (!repository) continue
    const command = normalize(raw)
    if (configured.has(raw.repositoryId)) {
      const script = packageScriptOf(command)
      if (!script || !declaresScript(path.resolve(repository.path, command.cwd ?? '.'), script)) continue
    }
    const key = planKey(command)
    if (seen.has(key)) continue
    seen.add(key)
    admitted.push(command)
  }
  return admitted
}
