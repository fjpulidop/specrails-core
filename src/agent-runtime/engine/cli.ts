import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validatePipelineContext } from '../../pipeline/pipeline-state.js'
import { validateRuntimeConfig } from '../config.js'
import { CORE_WORKFLOW_VERSION } from '../core-host.js'
import { EngineError, type JsonValue } from './contracts.js'
import { workflowDefinitionSchema } from './definition-schema.js'
import { MAX_STEERING_BYTES } from './steering/inbox.js'
import { MAX_DEFINITION_BYTES } from './canonical-json.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { configuredRoles } from './preflight.js'
import { validationPieceRegistry } from './pieces/index.js'
import { NODE_KINDS_VERSION } from './piece-registry.js'
import { cancelRun, createRun, definitionRunDirectory, freezeRunRequest, frozenRequestEngine, frozenRequestFile, resumeRun, signalRun } from './runs.js'
import { statusRun } from './run-status.js'
import { forkRun, type ForkRunOptions } from './fork.js'

export { NODE_KINDS_VERSION }
type Flags = Record<string, string | boolean>
const required = (flags: Flags, key: string): string => {
  const value = flags[key]
  if (typeof value !== 'string' || !value.trim()) throw new EngineError('invalid_arguments', `--${key} requires a value`)
  return value
}
const optional = (flags: Flags, key: string) => flags[key] === undefined ? undefined : required(flags, key)
const read = (filename: string): unknown => JSON.parse(readFileSync(filename, 'utf8'))

/** Keep definition bytes intact so duplicate keys and malformed UTF-8 are rejected. */
async function stdinBytes(maximum = MAX_DEFINITION_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    size += chunk.length
    if (size > maximum) throw new EngineError('invalid_arguments', `Standard input exceeds ${maximum} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function directory(flags: Flags): string {
  if (flags['run-dir'] !== undefined && flags.context !== undefined) throw new EngineError('invalid_arguments', 'Use --run-dir or --context, not both')
  return flags['run-dir'] !== undefined ? path.resolve(required(flags, 'run-dir')) : definitionRunDirectory(validatePipelineContext(read(required(flags, 'context'))))
}

/**
 * Resume and status select the engine from the frozen request (`workflow.engine`). A request
 * without the block is a legacy run. A definition database without a request (a fork destination
 * created before its request was materialized) still resolves to this engine.
 */
export function isDefinitionCommand(flags: Flags, command: string): boolean {
  if (['workflows', 'fork', 'signal', 'cancel'].includes(command) || flags.definition !== undefined && command === 'run') return true
  if (!['resume', 'status'].includes(command)) return false
  if (flags['run-dir'] !== undefined) return true
  if (flags.context === undefined) return false
  const context = validatePipelineContext(read(required(flags, 'context'))), requestFile = frozenRequestFile(context)
  if (existsSync(requestFile)) return frozenRequestEngine(read(requestFile)) === 2
  return existsSync(path.join(definitionRunDirectory(context), 'run.sqlite'))
}

/** Public workflow identity carried by status and results, matching the frozen request block. */
const workflowIdentity = (workflow: { id: string; version: string; source: string }) => ({ ...workflow, definitionHash: workflow.version, engine: 2 as const })

export async function runDefinitionCommand(flags: Flags, positionals: string[], emit: (value: unknown) => void): Promise<number> {
  const command = positionals[0]
  if (command === 'workflows') {
    if (!positionals[1] || positionals[1] === 'list') {
      emit({ type: 'runtime-workflows', nodeKindsVersion: NODE_KINDS_VERSION, nodeKinds: validationPieceRegistry().catalog(), definitionSchema: workflowDefinitionSchema,
        builtins: [{ id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, deprecated: false }] })
      return 0
    }
    if (positionals[1] !== 'validate' || flags.stdin !== true) throw new EngineError('invalid_arguments', 'Use workflows validate --stdin [--config file | --structural]')
    if (flags.structural !== undefined && flags.structural !== true) throw new EngineError('invalid_arguments', '--structural is a boolean flag')
    const roles = flags.config === undefined ? {} : configuredRoles(validateRuntimeConfig(read(required(flags, 'config'))))
    const validation = validateWorkflowDefinition(await stdinBytes(), validationPieceRegistry(), roles, { structural: flags.structural === true })
    emit({ ...validation, ...(flags.structural ? { roleResolution: 'deferred' } : {}) })
    return validation.ok ? 0 : 1
  }
  if (command === 'status') {
    const status = await statusRun(directory(flags), flags.compact === true)
    emit({ ...status, workflow: workflowIdentity(status.workflow) }); return 0
  }
  if (command === 'signal') {
    if (flags.stdin !== true) throw new EngineError('invalid_arguments', 'Signal requires --stdin')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await stdinBytes(MAX_STEERING_BYTES))
    const message = await signalRun(directory(flags), text, optional(flags, 'request-id'))
    emit({ type: 'runtime-signal-accepted', id: message.id, acceptedAt: message.createdAt }); return 0
  }
  if (command === 'cancel') { emit({ type: 'runtime-cancellation-accepted', ...await cancelRun(directory(flags), optional(flags, 'request-id')) }); return 0 }
  const cutOptions = () => ({ ...(flags['scope-id'] === undefined ? {} : { scopeId: required(flags, 'scope-id') }),
    ...(flags.visit === undefined ? {} : { visit: Number(required(flags, 'visit')) }) })
  if (command === 'fork') {
    const fork = await forkRun(directory(flags), { fromNodePath: required(flags, 'from'), runId: required(flags, 'run-id'), ...cutOptions(),
      ...(flags.state === undefined ? {} : { state: read(required(flags, 'state')) as ForkRunOptions['state'] }) })
    await freezeRunRequest(fork.directory)
    emit(fork)
    return 0
  }
  const controller = new AbortController(), abort = () => controller.abort(new EngineError('aborted', 'Process termination requested'))
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  try {
    let previous: Awaited<ReturnType<typeof statusRun>> | undefined
    let result: Awaited<ReturnType<typeof resumeRun>>
    if (command === 'run') {
      if (flags.workflow !== undefined) throw new EngineError('invalid_arguments', '--definition and --workflow are mutually exclusive')
      result = await createRun({ context: read(required(flags, 'context')), config: read(required(flags, 'config')),
        definition: readFileSync(required(flags, 'definition')), change: optional(flags, 'change'), signal: controller.signal, onEvent: emit })
    } else if (command === 'resume') {
      if (flags.definition !== undefined || flags.config !== undefined) throw new EngineError('invalid_arguments', 'Resume uses the frozen definition and config')
      if ((flags.answer !== undefined || flags.approve !== undefined) && (flags.recover !== undefined || flags.invalidate !== undefined)) throw new EngineError('invalid_arguments', 'Human answers and recovery cannot be combined')
      let target = directory(flags)
      previous = await statusRun(target)
      if (flags.invalidate !== undefined) {
        if (flags.recover !== undefined) throw new EngineError('invalid_arguments', 'Invalidate selects a new historical run; use recovery separately on that run')
        const fork = await forkRun(target, { fromNodePath: required(flags, 'invalidate'),
          runId: optional(flags, 'run-id') ?? previous.state.runId.slice(0, 96) + '-invalidate-' + randomUUID().slice(0, 8), ...cutOptions() })
        await freezeRunRequest(fork.directory)
        emit(fork); target = fork.directory
        previous = await statusRun(target)
      }
      const answers: Record<string, JsonValue> = {}, pending = previous.state.pendingInterrupts
      if (flags.answer !== undefined) {
        const matches = pending.filter(item => item.kind === 'question' && (flags['interrupt-id'] === undefined || item.id === required(flags, 'interrupt-id')))
        if (matches.length !== 1) throw new EngineError('interrupt_ambiguous', 'Select one pending question with --interrupt-id')
        answers[matches[0].id] = { answer: required(flags, 'answer') }
      }
      if (flags.approve !== undefined) for (const node of required(flags, 'approve').split(',')) {
        const matches = pending.filter(item => ['approval', 'gate'].includes(item.kind) && (item.nodePath === node || item.id === node))
        if (matches.length !== 1) throw new EngineError('interrupt_ambiguous', 'Approval must identify exactly one pending node or interrupt')
        answers[matches[0].id] = { approved: true }
      }
      result = await resumeRun(target, { signal: controller.signal, onEvent: emit, answers,
        recover: optional(flags, 'recover')?.split(','),
        ...(flags.context && flags.invalidate === undefined ? { context: validatePipelineContext(read(required(flags, 'context'))) } : {}) })
    } else throw new EngineError('invalid_arguments', `Unsupported definition command ${command}`)
    const delta = (key: 'costUsd' | 'inputTokens' | 'outputTokens') => {
      const current = result.state.usage[key], prior = previous ? previous.state.usage[key] : 0
      return current === null || prior === null ? null : Math.max(0, current - prior)
    }
    emit({ type: 'runtime-result', engineVersion: 2, ...result.state, revision: result.revision, eventCursor: result.eventCursor, workflow: workflowIdentity(result.workflow), completion: result.completion,
      ...('forkOf' in result ? { forkOf: result.forkOf } : {}), ...('error' in result ? { error: result.error } : {}),
      usage: result.state.usage, invocationUsage: { costUsd: delta('costUsd'), inputTokens: delta('inputTokens'), outputTokens: delta('outputTokens') }, metrics: result.metrics, efficiencySummary: result.efficiencySummary })
    return result.state.status === 'succeeded' ? 0 : result.state.status === 'paused' ? 2 : 1
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}
