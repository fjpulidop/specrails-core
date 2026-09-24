import { z } from 'zod'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { acquireWorkflowLease, fingerprint, readWorkflowState } from './durable-store.js'
import { WorkspaceTools } from './workspace-tools.js'
import { artifactPath, hash, resolveOpenSpecCli, runOpenSpec } from './openspec.js'
import { write } from './graph/artifacts.js'
import { expandedPlanCommands, readVerificationPlan } from './verification-plan.js'
import { inspectPipeline, pipelineStateDirectory, validatePipelineContext, verifyPipeline } from '../installer/runtime/pipeline-state.js'

const file = { repositoryId: z.string().min(1).max(128), path: z.string().min(1).max(1024) }
const operation = { operationId: z.string().uuid(), reason: z.string().trim().min(1).max(2000), acknowledgeInterrupted: z.boolean().optional(), changedPrecondition: z.string().trim().min(1).max(2000).optional() }
export const recoveryRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }).strict(),
  z.object({ action: z.literal('history'), offset: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('list_files'), ...file }).strict(),
  z.object({ action: z.literal('read_file'), ...file, startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('diff'), ...file }).strict(),
  z.object({ action: z.literal('patch'), ...file, ...operation, expectedHash: z.string().regex(/^[a-f0-9]{64}$/), oldText: z.string().min(1).max(16_384), newText: z.string().max(16_384) }).strict(),
  z.object({ action: z.literal('check'), ...operation, kind: z.enum(['openspec', 'verification']), checkId: z.string().min(1).max(256).optional() }).strict(),
])
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>
interface Attempt {
  operationId: string; requestHash: string; action: 'patch' | 'check'; reason: string; startedAt: string; completedAt?: string
  status: 'pending' | 'applied' | 'passed' | 'failed' | 'interrupted'
  repositoryId?: string; path?: string; beforeHash?: string; afterHash?: string
  candidateHash: string; checkId?: string; changedPrecondition?: string; output?: string; error?: string
}

/** Recovery never accepts absolute paths or aliases for control/secret files. */
function safePath(raw: string, mutation: boolean): string {
  const parts = raw.split('/')
  if (raw !== '.' && (path.isAbsolute(raw) || raw.includes('\\') || raw.includes(':') || parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) throw new Error('Recovery needs a repository-relative path without traversal or platform aliases')
  const lower = parts.map(p => p.toLowerCase())
  if (lower.some(p => ['.git', '.specrails', '.claude', '.codex', '.gemini', '.kimi-code', '.agents', '.ssh', '.aws', 'node_modules'].includes(p) || /^\.env(?:\.|$)/.test(p))) throw new Error('Recovery cannot access runtime metadata, dependencies or secret files')
  if (mutation && (lower[0] === 'openspec' && lower[1] !== 'specs' || lower.some(p => ['agents.md', 'claude.md', 'gemini.md'].includes(p)))) throw new Error('Recovery cannot change frozen plans, archives or agent instructions')
  return raw
}

/** Uses the SAME cross-process lease as resume. No provider calls or checkpoint editing. */
export async function runRecovery(contextInput: unknown, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const context = validatePipelineContext(contextInput), request = recoveryRequestSchema.parse(input)
  const directory = pipelineStateDirectory(context), workflowDirectory = path.join(directory, 'agent-workflow')
  if (!await readWorkflowState(workflowDirectory, context.runId)) throw new Error('Recovery requires an existing saved run')
  const release = await acquireWorkflowLease(workflowDirectory, context.runId)
  try {
    const state = (await readWorkflowState(workflowDirectory, context.runId))!
    const inspection = inspectPipeline(context) // verifies the frozen scope against the journal
    const historyPath = artifactPath(directory, 'recovery-history.json')
    const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) as Attempt[] : []
    if (!Array.isArray(history) || history.length > 100) throw new Error('Invalid recovery history')
    const plan = readVerificationPlan(context)
    if (request.action === 'history') {
      const offset = request.offset ?? 0, ordered = [...history].reverse()
      return { attempts: ordered.slice(offset, offset + 20), total: history.length, ...(offset + 20 < history.length ? { nextOffset: offset + 20 } : {}) }
    }
    if (request.action === 'inspect') return {
      runId: context.runId, status: state.status, nextStep: state.nextStep, repositories: context.repositories,
      verification: { valid: inspection.verification.valid, reasons: inspection.verification.reasons },
      checks: plan?.entries.map(entry => ({ id: entry.id, label: entry.label, repositoryId: entry.command.repositoryId, command: entry.command.command, args: entry.command.args, cwd: entry.command.cwd })) ?? [],
      attempts: history.slice(-10),
    }
    let workspace: WorkspaceTools | undefined
    if ('repositoryId' in request) {
      const repository = context.repositories.find(repo => repo.id === request.repositoryId)
      if (!repository) throw new Error('Repository does not belong to this run')
      safePath(request.path, request.action === 'patch')
      const target = path.join(repository.path, request.path)
      if (existsSync(target)) safePath(path.relative(repository.path, realpathSync(target)).split(path.sep).join('/') || '.', request.action === 'patch')
      workspace = new WorkspaceTools(repository.path, [repository.path], 'developer')
    }
    if (request.action === 'read_file') return JSON.parse(workspace!.execute('read_lines', { path: request.path, ...(request.startLine ? { startLine: request.startLine } : {}), ...(request.endLine ? { endLine: request.endLine } : {}) }))
    if (request.action === 'diff') return JSON.parse(workspace!.execute('get_diff', { path: request.path }))
    if (request.action === 'list_files') {
      const result = JSON.parse(workspace!.execute('list_files', { path: request.path })) as { entries: { name: string }[]; truncated: boolean }
      result.entries = result.entries.filter(entry => { try { safePath(request.path === '.' ? entry.name : request.path + '/' + entry.name, false); return true } catch { return false } })
      return result
    }
    if (state.status === 'succeeded' || inspection.phases.archive.status === 'done') throw new Error('Completed or archived runs cannot be repaired; inspect their delivery instead')
    if ((state.status === 'running' || Object.values(state.steps).some(step => ['running', 'interrupted'].includes(step.status))) && !request.acknowledgeInterrupted) throw new Error('Inspect interrupted writes and explicitly acknowledge them before repairing')
    if (request.action === 'check' && (request.kind === 'verification' ? !request.checkId : request.checkId !== undefined)) throw new Error('Verification requires a saved checkId; OpenSpec validation does not accept one')
    const save = () => write(historyPath, JSON.stringify(history, null, 2) + '\n')
    const requestHash = fingerprint(request)
    const previous = history.find(attempt => attempt.operationId === request.operationId)
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Error('operationId was already used for a different request')
      if (previous.status === 'pending') {
        // Crash after atomic file publication but before recording completion.
        if (request.action === 'patch') {
          const current = JSON.parse(workspace!.execute('read_lines', { path: request.path, endLine: 1 })) as { hash: string }
          previous.status = current.hash === previous.afterHash ? 'applied' : 'interrupted'
        } else previous.status = 'interrupted'
        previous.completedAt = new Date().toISOString(); save()
      }
      return { ...previous, replayed: true, notice: 'Recorded outcome; inspect current files/evidence before continuing.' }
    }
    if (history.length >= 100) throw new Error('Recovery attempt limit reached; inspect the history before continuing manually')
    const checkId = request.action === 'check' ? request.checkId ?? 'openspec' : undefined
    const lastCheck = history.filter(attempt => attempt.action === 'check' && attempt.checkId === checkId && attempt.candidateHash === inspection.candidateHash).at(-1)
    if (request.action === 'check' && lastCheck && ['failed', 'interrupted', 'pending'].includes(lastCheck.status) && !request.changedPrecondition) throw new Error('This check already failed or was interrupted on this candidate; state the changed precondition before retrying')
    const attempt: Attempt = { operationId: request.operationId, requestHash, action: request.action, reason: request.reason,
      startedAt: new Date().toISOString(), status: 'pending', candidateHash: inspection.candidateHash,
      ...(checkId ? { checkId } : {}), ...(request.changedPrecondition ? { changedPrecondition: request.changedPrecondition } : {}),
    }
    if (request.action === 'patch') {
      const before = workspace!.execute('read_file', { path: request.path })
      if (hash(before) !== request.expectedHash) throw new Error('File changed since inspection; read it again before patching')
      const at = before.indexOf(request.oldText)
      if (at < 0 || before.indexOf(request.oldText, at + 1) >= 0 || request.oldText === request.newText) throw new Error('Patch requires exactly one matching fragment and an actual change')
      const after = before.slice(0, at) + request.newText + before.slice(at + request.oldText.length)
      Object.assign(attempt, { repositoryId: request.repositoryId, path: request.path, beforeHash: request.expectedHash, afterHash: hash(after) })
    }
    history.push(attempt); save() // write-ahead record: an uncertain attempt is never blindly replayed
    try {
      signal?.throwIfAborted()
      if (request.action === 'patch') {
        workspace!.execute('apply_patch', { path: request.path, expectedHash: request.expectedHash, oldText: request.oldText, newText: request.newText })
        attempt.status = 'applied'
      } else if (request.kind === 'openspec') {
        const output = await runOpenSpec(resolveOpenSpecCli(), context.artifactRoot, ['validate', '--all', '--strict', '--no-interactive', '--json'], signal)
        attempt.output = output.slice(-16_000)
        const report = JSON.parse(output) as { items?: { valid?: boolean }[]; summary?: { totals?: { failed?: number } } }
        if (!report.items?.length || report.items.some(item => item.valid !== true) || report.summary?.totals?.failed !== 0) throw new Error('OpenSpec did not report successful validation of any specs/changes; inspect the saved output')
        attempt.status = 'passed'
      } else {
        if (!plan) throw new Error('No saved verification plan is available')
        const command = expandedPlanCommands(context, plan).find(item => item.key === request.checkId)
        if (!command) throw new Error('checkId does not belong to the saved verification plan')
        const receipt = await verifyPipeline(context, { kind: 'scoped', planHash: plan.planHash, commands: [command] }, text => { attempt.output = ((attempt.output ?? '') + text).slice(-16_000) }, signal, { deadline: Date.now() + 45_000 })
        attempt.status = receipt.valid ? 'passed' : 'failed'
        if (!receipt.valid) attempt.error = receipt.reason ?? 'Verification failed'
      }
    } catch (error) { attempt.status = 'failed'; attempt.error = (error instanceof Error ? error.message : String(error)).slice(-6000) }
    attempt.completedAt = new Date().toISOString(); save()
    return { ...attempt, notice: 'A repair/check is not workflow completion. Resume revalidates all required gates in the original run.' }
  } finally { await release() }
}
