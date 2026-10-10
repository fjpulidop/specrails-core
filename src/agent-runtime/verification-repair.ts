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
import { describeModifiedFiles, type CommandReceipt, type PipelineContext, type VerificationReceipt, type VerificationSelfMutation } from '../pipeline/pipeline-state.js'
import { driftedNodeDependencies, hostPrecondition, installEnvironment, isEnvironmentFailure, type DriftedDependency, type InstallOutcome } from './compact/environment.js'
import type { HostBlocker } from './engine/contracts.js'
import { guardrailEnabled, type GuardrailSettings } from './guardrails.js'

export type { HostBlocker } from './engine/contracts.js'

const BLOCKER_KINDS: ReadonlySet<string> = new Set(['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope', 'nondeterministic-output'])
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

/**
 * Installed dependencies out of their declared ranges in any package root that
 * contains a failing command's cwd (from the cwd up to its repository). The
 * failure such drift causes is arbitrary (a lint error on an untouched file),
 * so the drift itself, not the output, marks the failure as environmental.
 */
export function driftedFailureRoots(context: PipelineContext, receipt: VerificationReceipt): Array<{ root: string; drift: DriftedDependency[] }> {
  const roots = new Set<string>()
  for (const command of receipt.commands) {
    const repository = command.exitCode === 0 ? undefined : context.repositories.find(repo => repo.id === command.repositoryId)
    if (!repository) continue
    for (let directory = command.cwd || repository.path; ; directory = path.dirname(directory)) {
      const relative = path.relative(repository.path, directory)
      if (relative.startsWith('..') || path.isAbsolute(relative)) break
      if (existsSync(path.join(directory, 'package.json'))) roots.add(directory)
      if (!relative) break
    }
  }
  return [...roots].map(root => ({ root, drift: driftedNodeDependencies(root) })).filter(item => item.drift.length > 0)
}
/** Why a failed receipt is the host's environment to repair: a missing tool or dependency in the output, or installed versions out of their declared ranges. */
export function environmentFailure(context: PipelineContext, receipt: VerificationReceipt): { drift: Array<{ root: string; drift: DriftedDependency[] }> } | undefined {
  const drift = driftedFailureRoots(context, receipt)
  return drift.length || receipt.commands.some(command => isEnvironmentFailure(command.exitCode, command.output)) ? { drift } : undefined
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

/** Error code of a verification whose commands keep rewriting the candidate: the repository's or operator's to fix, never the fixer's. */
export const NONDETERMINISTIC_OUTPUT_CODE = 'verification_nondeterministic_output'
/**
 * Every command exited 0 and ran to completion, and the receipt is invalid only
 * because the commands modified the candidate themselves: deterministic tool
 * output (a regenerated mapping) the host may adopt, never a code failure.
 */
export function selfMutationOnly(receipt: VerificationReceipt): boolean {
  return !receipt.valid && !!receipt.selfMutation?.files.length && receipt.commands.length > 0 && !receipt.notRunEvidenceIds?.length
    && receipt.commands.every(command => command.exitCode === 0 && (command.outcome === undefined || command.outcome === 'passed'))
}
/** The typed blocker for output that did not converge on the adoption re-run, or that the `verification-output-adoption` guardrail keeps out of the candidate. */
export function nondeterministicOutputBlocker(context: PipelineContext, receipt: VerificationReceipt, adoption: boolean): HostBlocker {
  const mutation = receipt.selfMutation ?? { files: [], commands: [] }
  const command = receipt.commands.find(item => item.repositoryId === mutation.files[0]?.repositoryId && item.disposition !== 'reused') ?? receipt.commands[0]
  return { kind: 'nondeterministic-output', reason: (adoption ? `the verification commands modified ${describeModifiedFiles(mutation)}, and modified them again when the host verified the adopted output once more`
    : `the verification commands modified ${describeModifiedFiles(mutation)}, and the verification-output-adoption guardrail keeps verification output out of the candidate`).slice(0, BLOCKER_TEXT_LIMIT),
  command: command?.command.slice(0, 512) ?? '', args: (command?.args ?? []).slice(0, 16).map(arg => arg.slice(0, 256)), cwd: command ? checkoutRelative(context, command.cwd) : '.',
  requiredAction: 'Commit the generated output on the base branch or make the generator idempotent, then retry the run.' }
}
/** The progress line naming the files the host adopted into the candidate. */
export function adoptedOutputNote(mutation: VerificationSelfMutation): string {
  return `[verification] adopted ${mutation.files.length + (mutation.omittedFiles ?? 0)} generated file(s): ${describeModifiedFiles(mutation).replace(/^\d+ candidate files?: /, '')}`
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
  const roots = [...new Set([...installRoots(context, failed), ...driftedFailureRoots(context, receipt).map(item => item.root)])]
  const installs = installEnvironment(roots, { failureOutput: receipt.commands.map(command => command.output).join('\n'), lockfileRepair: guardrailEnabled(guardrails, 'lockfile-repair'),
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
