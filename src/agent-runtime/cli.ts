import { runEvaluation } from './evaluation.js'
import { efficiencySummary } from './efficiency-summary.js'
import type { RuntimeConfig } from './executor-types.js'
import { rolePromptDefaults } from './prompts.js'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from '../installer/cli.js'
import { readVerificationEvidence, type PipelineContext, type VerificationEvidenceQuery, inspectPipeline, pipelineStateDirectory, validatePipelineContext } from '../installer/runtime/pipeline-state.js'
import { normalizeRuntimeConfig, validateRuntimeConfig } from './config.js'
import { CORE_PACKAGE_VERSION, CORE_WORKFLOW_VERSION, RUNTIME_API_VERSION, coreRuntimeIdentity, preflightCoreWorkflow, runCoreWorkflow } from './core-host.js'
import { sameRuntimeIdentity, type RuntimeIdentity } from './runtime-identity.js'
import { readWorkflowState } from './workflow.js'
import type { WorkflowState } from './workflow-types.js'
import { runtimeEfficiency } from './efficiency.js'
import { configuredCapabilities } from './capabilities.js'
import { createExecutorRegistry } from './executors.js'

function read(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')) }
async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > 2 * 1024 * 1024) throw new Error('Runtime configuration stdin exceeds 2 MiB')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** The host-facing summary: phase status, pending interrupts and usage without accumulated outputs. */
export function compactState(state: WorkflowState | null) {
  if (!state) return null
  return {
    runId: state.runId, traceId: state.traceId, status: state.status, nextStep: state.nextStep, updatedAt: state.updatedAt,
    error: state.error, pendingApproval: state.pendingApproval, pendingQuestion: state.pendingQuestion, usage: state.usage,
    steps: Object.fromEntries(Object.entries(state.steps).map(([id, step]) => [id, { status: step.status, visits: step.visits }])),
    metrics: runtimeEfficiency(state),
  }
}
function compactPipeline(pipeline: ReturnType<typeof inspectPipeline> | null) {
  if (!pipeline) return null
  const receipt = pipeline.verification.receipt
  return {
    schemaVersion: pipeline.schemaVersion, runId: pipeline.runId, change: pipeline.change,
    stateDir: pipeline.stateDir, resumePhase: pipeline.resumePhase, phases: pipeline.phases,
    completion: pipeline.completion, acceptance: { valid: pipeline.acceptance.valid, status: pipeline.acceptance.status, reasons: pipeline.acceptance.reasons },
    verification: {
      ...pipeline.verification,
      receipt: receipt ? { ...receipt, commands: receipt.commands.map(command => ({ evidenceId: command.evidenceId, key: command.key, repositoryId: command.repositoryId, label: command.label, exitCode: command.exitCode, durationMs: command.durationMs, disposition: command.disposition, reuseReason: command.reuseReason })) } : undefined,
    },
  }
}
function stringFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = flags[key]
  if (typeof value !== 'string' || !value) throw new Error('Missing --' + key)
  return value
}
function optionalString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error('--' + key + ' needs a nonempty value')
  return value
}
function list(flags: Record<string, string | boolean>, key: string): string[] | undefined {
  const value = flags[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error('--' + key + ' needs comma-separated step IDs')
  return value.split(',').map(item => item.trim())
}
function invocationUsage(state: WorkflowState, priorCount: number) {
  const attempts = state.history.slice(priorCount)
  const sum = (key: 'costUsd' | 'inputTokens' | 'outputTokens') => attempts.some(a => a.usage?.[key] == null)
    ? null : attempts.reduce((total, a) => total + (a.usage?.[key] ?? 0), 0)
  return { costUsd: sum('costUsd'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') }
}

export async function runRuntimeCommand(flags: Record<string, string | boolean>, positionals: string[], emit: (value: unknown) => void = value => process.stdout.write(JSON.stringify(value) + '\n')): Promise<number> {
  const command = positionals[0] ?? 'help'
  if (command === 'prompts') { emit({ type: 'runtime-role-prompts', defaults: rolePromptDefaults() }); return 0 }
  if (command === 'capabilities') {
    if (flags.stdin !== undefined && flags.stdin !== true) throw new Error('--stdin is a boolean flag')
    if (flags.stdin && flags.config !== undefined) throw new Error('Use --stdin or --config, not both')
    const config = validateRuntimeConfig(flags.stdin ? await readStdin() : read(stringFlag(flags, 'config')))
    emit({ type: 'runtime-capabilities', runtimeIdentity: coreRuntimeIdentity(), ...await configuredCapabilities(config, createExecutorRegistry(config)) })
    return 0
  }
  if (command === 'evaluate') {
    if (flags.real !== undefined && flags.real !== true) throw new Error('--real is a boolean flag')
    const report = await runEvaluation({ output: stringFlag(flags, 'output'), real: flags.real === true, ...(flags.config === undefined ? {} : { config: validateRuntimeConfig(read(stringFlag(flags, 'config'))) }), ...(flags['max-cost-usd'] === undefined ? {} : { maxCostUsd: Number(stringFlag(flags, 'max-cost-usd')) }), ...(flags.repetitions === undefined ? {} : { repetitions: Number(stringFlag(flags, 'repetitions')) }) })
    emit({ type: 'runtime-evaluation', mode: report.mode, observations: report.observations.length, output: stringFlag(flags, 'output'), monetaryConclusion: report.monetaryConclusion, correctionPromptTargetMet: report.correctionPromptTargetMet, noObservedQualityDrop: report.noObservedQualityDrop, stopReason: report.stopReason })
    return report.stopReason || (!flags.real && (!report.noObservedQualityDrop || !report.noExtraInvocations || !report.correctionPromptTargetMet)) ? 1 : 0
  }
  if (command === 'help') {
    emit({ usage: [
      'specrails-core runtime api',
      'specrails-core runtime evaluate --output <directory> [--repetitions <1..20>] [--real --config <json> --max-cost-usd <limit>]',
      'specrails-core runtime capabilities --config <json>',
      'specrails-core runtime evidence --context <json> [--id <opaqueId>] [--section summary|stdout|stderr|source] [--source-id <opaqueId>] [--cursor <cursor>] [--limit <1..100>]',
      'specrails-core runtime prompts',
      'specrails-core runtime validate --config <json>',
      'specrails-core runtime validate --stdin',
      'specrails-core runtime run --context <json> --config <json> --change <kebab-case>',
      'specrails-core runtime status --context <json> [--compact]',
      'specrails-core runtime resume --context <json> [--approve archive] [--answer <text>] [--recover developer] [--invalidate verify]',
    ] })
    return 0
  }
  if (command === 'api') {
    emit({ type: 'runtime-api', apiVersion: RUNTIME_API_VERSION, coreVersion: CORE_PACKAGE_VERSION, runtimeIdentity: coreRuntimeIdentity(), workflowVersions: [CORE_WORKFLOW_VERSION], capabilities: { efficientRoleExecution: 1, reproducibleVerification: 1, implementationEfficiencyMetrics: 1 } })
    return 0
  }
  if (command === 'validate') {
    if (flags.stdin !== undefined && flags.stdin !== true) throw new Error('--stdin is a boolean flag')
    if (flags.stdin && flags.config !== undefined) throw new Error('Use --stdin or --config, not both')
    validateRuntimeConfig(flags.stdin ? await readStdin() : read(stringFlag(flags, 'config')))
    emit({ type: 'runtime-config-valid', schemaVersion: 1 })
    return 0
  }
  if (command === 'evidence') {
    const context = read(stringFlag(flags, 'context')) as PipelineContext
    const query = { ...(flags.id === undefined ? {} : { id: stringFlag(flags, 'id') }), ...(flags.section === undefined ? {} : { section: stringFlag(flags, 'section') }), ...(flags['source-id'] === undefined ? {} : { sourceId: stringFlag(flags, 'source-id') }), ...(flags.cursor === undefined ? {} : { cursor: stringFlag(flags, 'cursor') }), ...(flags.limit === undefined ? {} : { limit: Number(stringFlag(flags, 'limit')) }) }
    emit(readVerificationEvidence(context, query as VerificationEvidenceQuery))
    return 0
  }
  if (!['run', 'status', 'resume'].includes(command)) throw new Error('Unknown runtime operation: ' + command)
  const context = validatePipelineContext(read(stringFlag(flags, 'context')))
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const previous = await readWorkflowState(directory, context.runId)
  if (command === 'status') {
    const pipeline = previous ? inspectPipeline(context) : null
    const requestPath = path.join(pipelineStateDirectory(context), 'agent-runtime-request.json')
    const config = existsSync(requestPath) ? (read(requestPath) as { config?: RuntimeConfig }).config : undefined
    emit({ type: 'runtime-status', state: flags.compact ? compactState(previous) : previous, pipeline: flags.compact ? compactPipeline(pipeline) : pipeline, ...(previous ? { metrics: runtimeEfficiency(previous), efficiencySummary: efficiencySummary(previous, context, config, pipeline?.completion, pipeline ?? undefined) } : {}) })
    return 0
  }
  const requestFile = path.join(pipelineStateDirectory(context), 'agent-runtime-request.json')
  let request: { change: string; config: unknown; runtimeIdentity?: RuntimeIdentity }
  if (command === 'resume') {
    if (!previous) throw new Error('No programmatic run exists for this context')
    request = read(requestFile) as typeof request
    if (request.runtimeIdentity && !sameRuntimeIdentity(request.runtimeIdentity, coreRuntimeIdentity())) throw new Error('The original runtime package identity differs. Restore the retained original runtime; the saved request has not been changed.')
    if (flags.config || flags.change) throw new Error('Resume uses the frozen configuration and change; start a new run to change them')
  } else {
    if (flags.answer !== undefined || flags.approve !== undefined) throw new Error('Answers and approvals apply to runtime resume')
    request = { change: stringFlag(flags, 'change'), config: normalizeRuntimeConfig(read(stringFlag(flags, 'config'))), runtimeIdentity: coreRuntimeIdentity() }
    await preflightCoreWorkflow({ context, change: request.change, config: request.config })
    const serialized = JSON.stringify(request, null, 2) + '\n'
    mkdirSync(path.dirname(requestFile), { recursive: true, mode: 0o700 })
    try { writeFileSync(requestFile, serialized, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(requestFile, 'utf8') !== serialized) throw new Error('Run configuration changed; use a new run ID')
      if (previous) throw new Error('Run already exists; use runtime resume explicitly')
    }
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  try {
    const state = await runCoreWorkflow({
      context, change: request.change, config: request.config, resume: command === 'resume', signal: controller.signal,
      approve: list(flags, 'approve'), answer: optionalString(flags, 'answer'), recoverInterrupted: list(flags, 'recover'), invalidate: list(flags, 'invalidate'),
      onEvent: event => emit(event.type === 'efficiency_updated' ? { type: 'runtime-efficiency-event', schemaVersion: 1, eventId: event.id, runId: event.runId, attemptId: event.attemptId, kind: event.efficiencyActivity?.kind ?? 'role-context', payload: event.efficiencyActivity?.payload ?? event.efficiency } : { type: 'workflow-event', event }),
      onSpan: span => emit({ type: 'span', span }),
      onAgentEvent: (role, event) => emit({ type: 'agent-event', role, event }),
      onVerificationOutput: text => emit({ type: 'verification-output', text }),
    })
    let inspection: ReturnType<typeof inspectPipeline> | undefined
    try { inspection = inspectPipeline(context) } catch { /* A failed scope inspection must not erase recorded spend. */ }
    emit({ type: 'runtime-result', runId: state.runId, traceId: state.traceId, status: state.status, nextStep: state.nextStep, error: state.error, pendingApproval: state.pendingApproval, pendingQuestion: state.pendingQuestion, usage: state.usage, invocationUsage: invocationUsage(state, previous?.history.length ?? 0), metrics: runtimeEfficiency(state), efficiencySummary: efficiencySummary(state, context, request.config as RuntimeConfig, inspection?.completion, inspection) })
    return state.status === 'succeeded' ? 0 : state.status === 'paused' ? 2 : 1
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { subcommand, flags, positionals } = parseArgs(process.argv.slice(2))
  try { process.exitCode = await runRuntimeCommand(flags, [subcommand ?? 'help', ...positionals]) }
  catch (error) {
    process.stdout.write(JSON.stringify({ type: 'runtime-result', status: 'failed', error: error instanceof Error ? error.message : String(error) }) + '\n')
    process.exitCode = 1
  }
}
