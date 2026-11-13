// Which agent-proposed verification commands the host adds to its plan.
//
// A repository without configured checks takes the proposals as its checks
// (validated like any configured command). A repository with configured
// checks keeps them and may gain only runs of a package script the
// repository itself declares, such as `npm run test:e2e`: a change whose
// acceptance needs browser or integration tests then gets host evidence for
// them, without the agent introducing arbitrary commands next to the
// configured ones. The same holds for a script file the repository holds
// (`python3.11 scripts/check_startup.py`, `bash scripts/smoke.sh`): a Python
// or shell project has no package scripts, and its acceptance check (for
// example a real-container startup) would otherwise never get host evidence.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ACCEPTANCE_SCRIPT_TIMEOUT_MS, type PipelineContext, type VerificationCommand } from '../pipeline/pipeline-state.js'

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

/** Interpreters that run one repository file; the file decides what runs, the interpreter adds nothing. */
const SCRIPT_INTERPRETER = /^(?:(?:\.venv|venv)\/bin\/)?(?:python(?:\d+(?:\.\d+)?)?|node|bash|sh|ruby|php)$/

/**
 * True when the command runs a file inside the repository with a plain interpreter
 * (`python3.11 scripts/x.py --flag`). The file must exist when verification runs and
 * stay inside the repository; interpreter options (`-c`, `-m`, `-e`) are refused.
 */
export function runsRepositoryScript(repositoryRoot: string, command: Pick<VerificationCommand, 'command' | 'args' | 'cwd'>): boolean {
  if (!SCRIPT_INTERPRETER.test(command.command)) return false
  const [file] = command.args
  if (!file || file.startsWith('-') || path.isAbsolute(file)) return false
  const root = path.resolve(repositoryRoot)
  const target = path.resolve(root, command.cwd ?? '.', file)
  const inside = path.relative(root, target)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return false
  try { return existsSync(target) && statSync(target).isFile() } catch { return false }
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
      const packageScript = !!script && declaresScript(path.resolve(repository.path, command.cwd ?? '.'), script)
      if (!packageScript && !runsRepositoryScript(repository.path, command)) continue
    }
    const key = planKey(command)
    if (seen.has(key)) continue
    seen.add(key)
    // A repository script is an acceptance check (a container build, a restart): it gets the longer
    // limit. Tests and package scripts keep the ordinary default.
    admitted.push(command.timeoutMs === undefined && runsRepositoryScript(repository.path, command) ? { ...command, timeoutMs: ACCEPTANCE_SCRIPT_TIMEOUT_MS } : command)
  }
  return admitted
}
