// Host-owned repair of a failed verification, shared by the legacy graph
// (`graph/nodes.ts`) and the engine v2 `verify` piece.
//
// A failed check is not always a defect in the change: a fresh worktree has no
// node_modules, a new machine has no Playwright browser, a registry token has
// expired. The host classifies the failure first (a precondition it cannot
// satisfy becomes a structured blocker), installs what it can once, and only a
// failure that survives that becomes correction feedback.
import type { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { CommandReceipt, PipelineContext, VerificationReceipt } from '../pipeline/pipeline-state.js'
import { hostPrecondition, installEnvironment, type InstallOutcome } from './compact/environment.js'
import type { HostBlocker } from './engine/contracts.js'
import { guardrailEnabled, type GuardrailSettings } from './guardrails.js'

export type { HostBlocker } from './engine/contracts.js'

const BLOCKER_KINDS: ReadonlySet<string> = new Set(['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope'])
const BLOCKER_TEXT_LIMIT = 2_000

/** Where a missing dependency install belongs: the nearest directory with a lockfile or manifest above the failing command, else the repository root. */
const INSTALL_MARKERS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml']
export function installRoots(context: PipelineContext, commands: readonly CommandReceipt[]): string[] {
  const roots: string[] = []
  for (const command of commands) {
    const repository = context.repositories.find(repo => repo.id === command.repositoryId)
    if (!repository) continue
    let directory = command.cwd
    let chosen = repository.path
    for (;;) {
      const relative = path.relative(repository.path, directory)
      if (relative.startsWith('..') || path.isAbsolute(relative)) break
      if (INSTALL_MARKERS.some(name => existsSync(path.join(directory, name)))) { chosen = directory; break }
      if (!relative) break
      directory = path.dirname(directory)
    }
    roots.push(chosen)
  }
  // Every repository root stays a candidate: its plan is a no-op when it is already installed.
  return [...new Set([...roots, ...context.repositories.map(repository => repository.path)])]
}

/** A directory as the log should name it: relative to the checkout that contains it. */
export function checkoutRelative(context: PipelineContext, directory: string): string {
  const repository = context.repositories.find(repo => { const relative = path.relative(repo.path, directory); return !relative.startsWith('..') && !path.isAbsolute(relative) })
  return repository ? path.relative(repository.path, directory).split(path.sep).join('/') || '.' : directory
}

/** The legacy host-facing sentence for a blocker; engine v2 hosts read the structured blocker instead. */
export function hostPreconditionMessage(reason: string, command: string, args: readonly string[], directory: string): string {
  return `Verification cannot run in this environment: ${reason} (\`${[command, ...args].join(' ')}\` in ${directory}). This is not a defect in the change, so no correction round was started. Make it available to Specrails (for example in the login shell profile Specrails loads, or with a refreshed registry token), then resume.`
}

/** A failed check the host must unblock (credentials, registry access, a missing variable): no correction round can repair it. */
export function preconditionBlock(context: PipelineContext, receipt: VerificationReceipt): HostBlocker | undefined {
  for (const command of receipt.commands) {
    if (command.exitCode === 0) continue
    const precondition = hostPrecondition(command.output)
    if (precondition) return boundedBlocker({ kind: precondition.kind, reason: precondition.reason, command: command.command, args: command.args, cwd: checkoutRelative(context, command.cwd),
      requiredAction: precondition.requiredAction, ...(command.evidenceId ? { evidenceId: command.evidenceId } : {}) })
  }
  return undefined
}

export interface EnvironmentRepair { installs: InstallOutcome[]; refused?: HostBlocker }
/**
 * Runs the planned installs for the failed commands' roots once, narrating each
 * step through `note` exactly as the legacy graph logs it (`[environment] npm
 * install (app)`, `Environment: installed …`). An install the host cannot
 * complete for a precondition reason becomes `refused`.
 */
export function repairEnvironment(context: PipelineContext, receipt: VerificationReceipt, guardrails: GuardrailSettings | undefined, note: (text: string) => void, spawn?: typeof spawnSync): EnvironmentRepair {
  const failed = receipt.commands.filter(command => command.exitCode !== 0)
  const installs = installEnvironment(installRoots(context, failed), { failureOutput: receipt.commands.map(command => command.output).join('\n'), lockfileRepair: guardrailEnabled(guardrails, 'lockfile-repair'),
    ...(spawn ? { spawn } : {}), onEvent: event => note(event.kind === 'text' ? event.text ?? '' : `[environment] ${event.tool ?? ''} ${event.detail ?? ''}`.trim()) })
  const refused = installs.find(outcome => outcome.precondition)
  if (!refused) return { installs }
  const precondition = hostPrecondition(refused.detail) ?? { kind: 'environment' as const, reason: refused.precondition!, requiredAction: 'Repair the verification environment, then retry the run.' }
  const cwd = checkoutRelative(context, refused.root)
  const command = [refused.command, ...refused.args].join(' ')
  return { installs, refused: boundedBlocker({ kind: precondition.kind, reason: `installing its dependencies failed because ${refused.precondition}`, command: refused.command, args: refused.args, cwd,
    // A network blocker on an install names the exact command to repeat with connectivity; other kinds keep the classifier's action.
    requiredAction: precondition.kind === 'network' ? `Run \`${command}\` in ${cwd} with network access, then retry the run.` : precondition.requiredAction }) }
}

/** A blocker as a durable JSON value: known kind, bounded strings, at most 16 arguments. */
export function boundedBlocker(value: unknown): HostBlocker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.kind !== 'string' || !BLOCKER_KINDS.has(raw.kind)) return undefined
  const bounded = (field: unknown, limit = BLOCKER_TEXT_LIMIT): string => typeof field === 'string' ? field.slice(0, limit) : ''
  const args = Array.isArray(raw.args) ? raw.args.slice(0, 16).map(arg => bounded(arg, 256)) : []
  // A correction role reports free-text `evidence` instead of a host reason.
  const reason = bounded(raw.reason) || bounded(raw.evidence)
  return { kind: raw.kind as HostBlocker['kind'], reason, command: bounded(raw.command, 512), args, cwd: bounded(raw.cwd, 512), requiredAction: bounded(raw.requiredAction),
    ...(typeof raw.evidenceId === 'string' && raw.evidenceId ? { evidenceId: bounded(raw.evidenceId, 128) } : {}) }
}
