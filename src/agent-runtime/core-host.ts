import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkArchive, fingerprintCandidate, initializePipeline, inspectPipeline, pipelineStateDirectory,
  transitionPipeline, validatePipelineContext, validateVerificationRequest, verifyPipeline,
  type PipelineContext, type PipelineState, type VerificationCommand,
} from '../installer/runtime/pipeline-state.js'
import { validateRuntimeConfig } from './config.js'
import { createExecutorRegistry, type ExecutorRegistry } from './executors.js'
import { AgentExecutionError, type AgentEvent, type AgentResult, type AgentRole, type RuntimeConfig } from './executor-types.js'
import { ARCHITECT_OUTPUT_SCHEMA, correctionInstructions, repairInstructions, REVIEW_OUTPUT_SCHEMA, ROLE_INSTRUCTIONS_VERSION, roleInstructions, type RoleFeedback } from './prompts.js'
import { readWorkflowState, runWorkflow } from './workflow.js'
import type { JsonValue, StepResult, WorkflowEvent, WorkflowState, WorkflowStepContext } from './workflow-types.js'

export const RUNTIME_API_VERSION = 1
export const CORE_WORKFLOW_VERSION = '2'
export const CORE_PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
const ZERO_USAGE = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ASPECTS = { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 }
/** Executor failures that mean "this session cannot be continued", not "the role failed". */
const SESSION_FALLBACK_CODES = new Set(['provider_execution_error', 'provider_spawn_error', 'incomplete_response', 'invalid_response', 'provider_not_found'])

export interface CoreWorkflowOptions {
  context: PipelineContext | unknown
  change: string
  config: RuntimeConfig | unknown
  registry?: ExecutorRegistry
  signal?: AbortSignal
  resume?: boolean
  approve?: string[]
  recoverInterrupted?: string[]
  invalidate?: string[]
  onEvent?: (event: WorkflowEvent) => void | Promise<void>
  onAgentEvent?: (role: AgentRole, event: AgentEvent) => void
  onVerificationOutput?: (text: string) => void
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a structured JSON object from agent')
  return value as Record<string, unknown>
}
function markdown(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500_000) throw new Error('Invalid agent field: ' + name)
  return value.trim() + '\n'
}
/** Accepts the object wherever the model put it: bare, fenced, or surrounded by commentary. */
export function parseAgentObject(text: string): Record<string, unknown> {
  if (text.length > 2_000_000) throw new Error('Structured agent response is too large')
  const trimmed = text.trim()
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')]
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed)
  if (fenced) candidates.push(fenced[1]!)
  const first = trimmed.indexOf('{'), last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  let failure: unknown
  for (const candidate of candidates) {
    try { return object(JSON.parse(candidate)) } catch (error) { failure = error }
  }
  throw failure instanceof Error ? failure : new Error('Expected a structured JSON object from agent')
}
/** All generated paths are relative and reject symlink ancestors, including
 * already-existing archive/spec directories. */
function child(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Artifact path escapes repository')
  let cursor = root
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing symlink artifact path: ' + relative)
  }
  return target
}
function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
function journal(context: PipelineContext): PipelineState {
  return JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'state.json'), 'utf8')) as PipelineState
}
function writeArchitecture(context: PipelineContext, change: string, output: Record<string, unknown>): void {
  const proposal = markdown(output.proposal, 'proposal')
  const design = markdown(output.design, 'design')
  if (!['high', 'medium', 'low'].includes(String(output.confidence))) throw new Error('Invalid design confidence')
  if (!Array.isArray(output.tasks) || !output.tasks.length || output.tasks.length > 200) throw new Error('Architecture requires 1–200 tasks')
  const tasks = output.tasks.map((task, i) => {
    const title = object(task).title
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title) || title.length > 1000) throw new Error('Invalid task title')
    return '- [ ] ' + (i + 1) + '. ' + title.trim()
  }).join('\n') + '\n'
  if (!Array.isArray(output.specs) || !output.specs.length || output.specs.length > 100) throw new Error('Architecture requires 1–100 specifications')
  const specs = output.specs.map((item) => {
    const spec = object(item)
    if (typeof spec.name !== 'string' || !SLUG.test(spec.name) || spec.name.length > 100) throw new Error('Invalid specification name')
    return { name: spec.name, content: markdown(spec.content, 'spec.content') }
  })
  if (new Set(specs.map(s => s.name)).size !== specs.length) throw new Error('Duplicate specification names')
  const prefix = 'openspec/changes/' + change + '/'
  const files = [
    ['proposal.md', proposal], ['design.md', design], ['tasks.md', tasks],
    ['design-confidence.json', JSON.stringify({ confidence: output.confidence }, null, 2) + '\n'],
    ...specs.map(s => ['specs/' + s.name + '/spec.md', s.content]),
  ]
  // Validate every destination before the first write.
  const targets = files.map(([name, content]) => [child(context.artifactRoot, prefix + name), content!] as const)
  for (const [target, content] of targets) write(target, content)
}
/** Commands the architect proposed for repositories the configuration leaves uncovered. */
function proposedVerification(context: PipelineContext, configured: VerificationCommand[], output: Record<string, unknown>): VerificationCommand[] {
  if (output.verification === undefined || output.verification === null) return []
  if (!Array.isArray(output.verification) || output.verification.length > 100) throw new Error('Invalid proposed verification commands')
  const covered = new Set(configured.map(command => command.repositoryId))
  const proposed = output.verification.map(item => {
    const command = object(item)
    if (typeof command.repositoryId !== 'string' || typeof command.command !== 'string' || !command.command.trim() || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string')) throw new Error('Invalid proposed verification command')
    return { repositoryId: command.repositoryId, command: command.command, args: command.args as string[], ...(typeof command.cwd === 'string' && command.cwd ? { cwd: command.cwd } : {}) }
  }).filter(command => !covered.has(command.repositoryId) && context.repositories.some(repository => repository.id === command.repositoryId))
  if (proposed.length) validateVerificationRequest(context, { kind: 'scoped', commands: proposed })
  return proposed
}
function validReview(output: Record<string, unknown>): boolean {
  if (typeof output.approved !== 'boolean' || typeof output.summary !== 'string'
    || !Array.isArray(output.issues) || !output.issues.every(i => typeof i === 'string')
    || typeof output.score !== 'number' || !Number.isFinite(output.score) || output.score < 0 || output.score > 100) throw new Error('Invalid structured review')
  const aspects = object(output.aspects)
  for (const name of Object.keys(ASPECTS)) {
    const value = aspects[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Invalid review aspect: ' + name)
  }
  return output.approved && output.issues.length === 0 && output.score >= 70
    && Object.entries(ASPECTS).every(([name, threshold]) => Number(aspects[name]) >= threshold)
}
function openTasks(context: PipelineContext, change: string): string[] {
  const file = child(context.artifactRoot, 'openspec/changes/' + change + '/tasks.md')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^\s*-\s+\[ \]/.test(line)).map(line => line.replace(/^\s*-\s+\[ \]\s*/, '').trim()).slice(0, 50)
}
/** Attempts count from the latest explicit resume: a human continuing a blocked run grants a fresh budget. */
function developerVisitsSinceResume(checkpoint: WorkflowState): number {
  const resumed = [...checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')
  return checkpoint.history.filter(attempt => attempt.stepId === 'developer' && (!resumed || attempt.startedAt >= resumed.timestamp)).length
}
function verificationRecord(value: unknown): { commands: VerificationCommand[] } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return { commands: Array.isArray(record.verification) ? record.verification as VerificationCommand[] : [] }
}

/** Archive is deterministic and replayable only with explicit write recovery.
 * The reviewed specification documents are complete replacements, not deltas. */
function archive(context: PipelineContext, change: string): void {
  const state = journal(context)
  if (state.phases.archive.status !== 'done') {
    const active = child(context.artifactRoot, 'openspec/changes/' + change)
    if (existsSync(active)) {
      checkArchive(context)
      transitionPipeline(context, 'archive', 'running')
      const specsDir = child(context.artifactRoot, 'openspec/changes/' + change + '/specs')
      const specs = readdirSync(specsDir, { withFileTypes: true }).filter(item => item.isDirectory())
      const writes = specs.map(spec => {
        if (!SLUG.test(spec.name)) throw new Error('Invalid archived specification name')
        return [child(context.artifactRoot, 'openspec/specs/' + spec.name + '/spec.md'), readFileSync(child(context.artifactRoot, 'openspec/changes/' + change + '/specs/' + spec.name + '/spec.md'), 'utf8')] as const
      })
      const destination = child(context.artifactRoot, 'openspec/changes/archive/' + state.createdAt.slice(0, 10) + '-' + change)
      if (existsSync(destination)) throw new Error('Archive destination already exists')
      for (const [file, content] of writes) write(file, content)
      mkdirSync(path.dirname(destination), { recursive: true })
      renameSync(active, destination)
    }
    // If the process died after rename, Core rechecks the saved archive approval.
    transitionPipeline(context, 'archive', 'done')
  }
  // A crash can also occur after Core's archive receipt but before these host
  // ownership markers. Reconcile them when repeating the interrupted step.
  if (context.ownership.git === 'host') {
    const current = journal(context)
    if (current.phases.ship.status !== 'skipped') transitionPipeline(context, 'ship', 'skipped')
    if (current.phases.ci.status !== 'skipped') transitionPipeline(context, 'ci', 'skipped')
  }
}

export async function runCoreWorkflow(options: CoreWorkflowOptions): Promise<WorkflowState> {
  const context = validatePipelineContext(options.context)
  const config = validateRuntimeConfig(options.config, { registeredProviderIds: options.registry?.ids() })
  if (!config.enabled) throw new Error('Programmatic agent runtime is disabled')
  if (context.ownership.git !== 'host') throw new Error('Programmatic runtime requires host-owned delivery; Core shipping is not implemented by this workflow')
  if (!SLUG.test(options.change) || options.change.length > 100) throw new Error('Invalid workflow change name')
  if (!context.specs.length) throw new Error('Programmatic implementation requires a frozen spec or goal')
  // Configured commands are validated against the frozen scope up front; coverage
  // is completed by the architect (or left explicitly unverified) at run time.
  if (config.verification.length) validateVerificationRequest(context, { kind: 'scoped', commands: config.verification })
  const registry = options.registry ?? createExecutorRegistry(config)
  for (const selected of Object.values(config.agents)) registry.validateLimits(selected.provider, config.limits ?? {})
  const state = initializePipeline(context, options.change)
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const previous = await readWorkflowState(directory, context.runId)
  if (!previous && existsSync(path.join(context.artifactRoot, 'openspec/changes', options.change))) {
    throw new Error('Change already exists without a programmatic checkpoint; use a new change name')
  }
  if (state.phases.archive.status === 'done') {
    const checked = inspectPipeline(context)
    if (!checked.verification.valid || (checked.resumePhase && !['ship', 'ci'].includes(checked.resumePhase))) {
      throw new Error('Archived run evidence changed; start a new run for the changed candidate or environment')
    }
  }
  const attempts = config.limits?.maxAttempts ?? 3
  const note = (role: AgentRole, text: string): void => { try { options.onAgentEvent?.(role, { kind: 'text', text }) } catch { /* Observer cannot replay agent effects. */ } }
  const roots = [...context.repositories.map(repo => repo.path)].sort((a, b) => b.length - a.length)
  const relativize = (detail: string): string => {
    // Host logs read better with repository-relative paths; the tool call itself is unchanged.
    for (const root of roots) {
      if (detail === root) return context.repositories.length > 1 ? path.basename(root) : '.'
      if (detail.startsWith(root + path.sep)) return (context.repositories.length > 1 ? path.basename(root) + path.sep : '') + detail.slice(root.length + 1)
    }
    return detail
  }
  const forward = (role: AgentRole, structured: boolean) => (event: AgentEvent): void => {
    // The final JSON of a structured role is an artifact, not narration; the host
    // reports what it did with it instead of echoing it into the log.
    if (structured && event.kind === 'text' && /^\s*(\{|```)/.test(event.text ?? '')) return
    const shaped = event.kind === 'tool-start' && event.detail ? { ...event, detail: relativize(event.detail) } : event
    try { options.onAgentEvent?.(role, shaped) } catch { /* Observer cannot replay agent effects. */ }
  }
  const execute = async (role: AgentRole, step: WorkflowStepContext, prompt: string, extra: { resumeSessionId?: string; outputSchema?: Record<string, unknown> }): Promise<AgentResult> => {
    const selected = config.agents[role]
    return registry.execute(selected.provider, {
      role, prompt, cwd: context.artifactRoot, allowedRoots: context.repositories.map(repo => repo.path),
      model: selected.model, maxTurns: selected.maxTurns, signal: step.signal,
      timeoutMs: config.limits?.timeoutMs,
      maxTokens: config.limits?.maxTokens === undefined ? undefined : Math.max(0, config.limits.maxTokens - step.checkpoint.usage.knownTokens),
      maxCostUsd: config.limits?.maxCostUsd === undefined ? undefined : Math.max(0, config.limits.maxCostUsd - step.checkpoint.usage.knownCostUsd),
      ...extra, onEvent: forward(role, role !== 'developer'),
    })
  }
  const feedbackFor = (step: WorkflowStepContext): RoleFeedback => ({ verification: step.previousOutputs.verify ?? null, review: step.previousOutputs.reviewer ?? null })
  const invoke = async (role: AgentRole, step: WorkflowStepContext, accept: (output: Record<string, unknown>, text: string, result: AgentResult) => StepResult): Promise<StepResult> => {
    const selected = config.agents[role]
    const structured = role !== 'developer'
    const outputSchema = role === 'architect' ? ARCHITECT_OUTPUT_SCHEMA : role === 'reviewer' ? REVIEW_OUTPUT_SCHEMA : undefined
    const plan = role === 'architect' ? config.verification : verificationRecord(step.previousOutputs.architect).commands
    const previousDeveloper = role === 'developer' ? (step.previousOutputs.developer as { sessionId?: unknown; provider?: unknown } | undefined) : undefined
    const resumable = typeof previousDeveloper?.sessionId === 'string' && previousDeveloper.provider === selected.provider && developerVisitsSinceResume(step.checkpoint) > 1
    const fullPrompt = roleInstructions(role, context, options.change, { feedback: feedbackFor(step), verification: plan })
    let usage: AgentResult['usage'] | undefined
    try {
      let result: AgentResult
      if (resumable) {
        // A correction pass continues the developer's own session: the code it
        // wrote and the reasons behind it are already in context.
        try { result = await execute(role, step, correctionInstructions(role, feedbackFor(step)), { resumeSessionId: previousDeveloper!.sessionId as string }) }
        catch (error) {
          if (!(error instanceof AgentExecutionError) || !SESSION_FALLBACK_CODES.has(error.code)) throw error
          note(role, 'Previous developer session is unavailable; starting a fresh developer turn with the same feedback.')
          result = await execute(role, step, fullPrompt, {})
        }
      } else result = await execute(role, step, fullPrompt, { outputSchema })
      usage = result.usage
      if (!structured) return { ...accept({}, result.text, result), usage: result.usage }
      let output: Record<string, unknown> | undefined, problem: string | undefined
      try { output = result.structured ?? parseAgentObject(result.text) } catch (error) { problem = error instanceof Error ? error.message : String(error) }
      if (output) {
        try { return { ...accept(output, result.text, result), usage: result.usage } }
        catch (error) { problem = error instanceof Error ? error.message : String(error); if (!/Invalid|Expected|requires|Duplicate|malformed/i.test(problem)) return { status: 'failed', error: problem, usage: result.usage } }
      }
      // One bounded repair turn inside the same session: the role keeps its work
      // and only resends the object. Without a session the role starts over once.
      if (!result.sessionId) return { status: 'failed', error: problem, usage: result.usage }
      note(role, `The ${role} reply was not a valid result (${problem}); asking the same session to resend it.`)
      const repaired = await execute(role, step, repairInstructions(role, problem!), { resumeSessionId: result.sessionId, outputSchema })
      usage = { inputTokens: usage.inputTokens === null || repaired.usage.inputTokens === null ? null : usage.inputTokens + repaired.usage.inputTokens, outputTokens: usage.outputTokens === null || repaired.usage.outputTokens === null ? null : usage.outputTokens + repaired.usage.outputTokens, costUsd: usage.costUsd === null || repaired.usage.costUsd === null ? null : usage.costUsd + repaired.usage.costUsd }
      try { return { ...accept(repaired.structured ?? parseAgentObject(repaired.text), repaired.text, repaired), usage } }
      catch (error) { return { status: 'failed', error: String(error instanceof Error ? error.message : error), usage } }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error), ...(error instanceof AgentExecutionError ? { usage: error.usage } : usage ? { usage } : {}) }
    }
  }
  return runWorkflow({
    directory, runId: context.runId,
    input: JSON.parse(JSON.stringify({ context, config, change: options.change, coreVersion: CORE_PACKAGE_VERSION, instructionsVersion: ROLE_INSTRUCTIONS_VERSION })) as JsonValue,
    resume: options.resume, signal: options.signal, approve: options.approve, recoverInterrupted: options.recoverInterrupted, invalidate: options.invalidate,
    budget: { maxCostUsd: config.limits?.maxCostUsd, maxTokens: config.limits?.maxTokens, maxDurationMs: config.limits?.timeoutMs },
    onEvent: options.onEvent,
    validateCompleted: async (step, _record, checkpoint) => {
      // The engine invokes this only after acquiring its run lease and accepting
      // an explicit interrupted-write recovery. A crash after the archive rename
      // leaves Core's active artifact path temporarily absent. Reconcile that
      // one deterministic operation before checking earlier phase fingerprints;
      // transitionPipeline still verifies the saved exact-candidate approval.
      if (step.id === 'architect' && checkpoint.nextStep === 'archive'
        && checkpoint.steps.archive?.status === 'interrupted'
        && options.recoverInterrupted?.includes('archive')
        && journal(context).phases.archive.status === 'running'
        && !existsSync(child(context.artifactRoot, 'openspec/changes/' + options.change))) {
        archive(context, options.change)
      }
      const inspection = inspectPipeline(context)
      if (step.id === 'architect') return inspection.phases.architect.status === 'done' && inspection.resumePhase !== 'architect'
      if (step.id === 'verify') return inspection.verification.valid
      if (step.id === 'reviewer') return inspection.phases.reviewer.status === 'done' && inspection.verification.valid && !['architect', 'developer', 'reviewer'].includes(inspection.resumePhase ?? '')
      if (step.id === 'archive') return inspection.phases.archive.status === 'done'
      return true
    },
    workflow: { id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, maxTransitions: attempts * 3 + 3, steps: [
      { id: 'architect', effect: 'write', execute: async step => {
        transitionPipeline(context, 'architect', 'running')
        return invoke('architect', step, output => {
          const proposed = proposedVerification(context, config.verification, output)
          writeArchitecture(context, options.change, output)
          const plan = [...config.verification, ...proposed]
          const uncovered = context.repositories.filter(repository => !plan.some(command => command.repositoryId === repository.id)).map(repository => repository.id)
          if (output.confidence === 'low') {
            transitionPipeline(context, 'architect', 'blocked', 'Design confidence is low')
            return { status: 'blocked', error: 'Design confidence is low; inspect the proposal and revise the frozen scope in a new run' }
          }
          transitionPipeline(context, 'architect', 'done')
          const tasks = Array.isArray(output.tasks) ? output.tasks.length : 0
          const specs = Array.isArray(output.specs) ? output.specs.map(spec => String(object(spec).name)) : []
          note('architect', `Architecture written: ${tasks} task${tasks === 1 ? '' : 's'}, spec${specs.length === 1 ? '' : 's'} ${specs.join(', ')}, confidence ${String(output.confidence)}.`
            + (proposed.length ? ` Verification proposed by the architect: ${proposed.map(command => [command.command, ...command.args].join(' ')).join('; ')}.` : '')
            + (uncovered.length ? ` No verification command for ${uncovered.join(', ')}; the reviewer will inspect that work without automated checks.` : ''))
          return { status: 'succeeded', output: { change: options.change, verification: plan as unknown as JsonValue, unverifiedRepositories: uncovered } }
        })
      } },
      { id: 'developer', effect: 'write', execute: async step => {
        if (developerVisitsSinceResume(step.checkpoint) > attempts) return { status: 'blocked', error: 'Implementation correction limit reached; inspect the feedback in the log and resume to grant more attempts', usage: ZERO_USAGE }
        transitionPipeline(context, 'developer', 'running')
        return invoke('developer', step, (_output, text, result) => ({ status: 'succeeded', output: { summary: text.slice(-32_000), provider: config.agents.developer.provider, ...(result.sessionId ? { sessionId: result.sessionId } : {}) } }))
      } },
      { id: 'verify', effect: 'write', execute: async step => {
        // Unchecked tasks are developer feedback, not a workflow failure: the
        // developer sees exactly which tasks remain and continues its session.
        const open = openTasks(context, options.change)
        if (open.length) {
          note('developer', `Verification skipped: ${open.length} task${open.length === 1 ? '' : 's'} still unchecked in tasks.md; returning to the developer.`)
          return { status: 'succeeded', output: { valid: false, reason: 'Required implementation tasks remain unchecked in tasks.md', incompleteTasks: open, commands: [] }, next: 'developer', usage: ZERO_USAGE }
        }
        const plan = verificationRecord(step.previousOutputs.architect).commands
        const uncovered = context.repositories.filter(repository => !plan.some(command => command.repositoryId === repository.id)).map(repository => repository.id)
        const receipt = await verifyPipeline(context, { kind: 'full', commands: plan, ...(uncovered.length ? { unverified: true } : {}) }, options.onVerificationOutput, step.signal)
        const evidence = { valid: receipt.valid, receiptId: receipt.id, unverifiedRepositories: uncovered, commands: receipt.commands.map(({ repositoryId, command, args, exitCode, output }) => ({ repositoryId, command, args, exitCode, output })) }
        if (!receipt.valid) {
          note('developer', `Verification failed (${receipt.reason ?? 'a command failed'}); returning to the developer with the exact output.`)
          return { status: 'succeeded', output: evidence as JsonValue, next: 'developer', usage: ZERO_USAGE }
        }
        transitionPipeline(context, 'developer', 'done')
        note('developer', plan.length ? `Verification passed: ${plan.length} command${plan.length === 1 ? '' : 's'} exited 0.` : 'No verification commands available; relying on task completion and review.')
        return { status: 'succeeded', output: evidence as JsonValue, usage: ZERO_USAGE }
      } },
      { id: 'reviewer', effect: 'write', execute: async step => {
        transitionPipeline(context, 'reviewer', 'running')
        return invoke('reviewer', step, output => {
          if (!validReview(output)) {
            transitionPipeline(context, 'reviewer', 'blocked', 'Review requests corrections')
            const issues = Array.isArray(output.issues) ? output.issues.length : 0
            note('reviewer', `Review requested corrections (score ${String(output.score)}, ${issues} issue${issues === 1 ? '' : 's'}); returning to the developer.`)
            return { status: 'succeeded', output: output as JsonValue, next: 'developer' }
          }
          write(child(context.artifactRoot, 'openspec/changes/' + options.change + '/confidence-score.json'), JSON.stringify({ change: options.change, overall: output.score, aspects: output.aspects, summary: output.summary }, null, 2) + '\n')
          transitionPipeline(context, 'reviewer', 'done')
          note('reviewer', `Review approved with score ${String(output.score)}: ${String(output.summary)}`)
          return { status: 'succeeded', output: { ...output, candidateHash: fingerprintCandidate(journal(context)) } as JsonValue }
        })
      } },
      { id: 'archive', effect: 'write', execute: async step => {
        if (journal(context).phases.archive.status !== 'done' && config.approvalBeforeArchive && !step.approved) return { status: 'paused', error: 'Approve archive after inspecting the verified implementation', usage: ZERO_USAGE }
        archive(context, options.change)
        return { status: 'succeeded', output: { archivePath: journal(context).archivePath!, deliveryOwner: context.ownership.git }, usage: ZERO_USAGE }
      } },
    ] },
  })
}
