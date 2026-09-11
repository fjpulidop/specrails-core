import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from '../installer/cli.js'
import { inspectPipeline, pipelineStateDirectory, validatePipelineContext } from '../installer/runtime/pipeline-state.js'
import { validateRuntimeConfig } from './config.js'
import { CORE_PACKAGE_VERSION, RUNTIME_API_VERSION, runCoreWorkflow } from './core-host.js'
import { readWorkflowState } from './workflow.js'
import type { WorkflowState } from './workflow-types.js'

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
function compactState(state: WorkflowState | null) {
  if (!state) return null
  return {
    runId: state.runId, status: state.status, nextStep: state.nextStep, updatedAt: state.updatedAt,
    error: state.error, pendingApproval: state.pendingApproval, usage: state.usage,
    steps: Object.fromEntries(Object.entries(state.steps).map(([id, step]) => [id, { status: step.status }])),
  }
}
function compactPipeline(pipeline: ReturnType<typeof inspectPipeline> | null) {
  if (!pipeline) return null
  const receipt = pipeline.verification.receipt
  return {
    schemaVersion: pipeline.schemaVersion, runId: pipeline.runId, change: pipeline.change,
    stateDir: pipeline.stateDir, resumePhase: pipeline.resumePhase, phases: pipeline.phases,
    verification: {
      ...pipeline.verification,
      receipt: receipt ? { ...receipt, commands: receipt.commands.map(command => ({ ...command, output: undefined })) } : undefined,
    },
  }
}
function stringFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = flags[key]
  if (typeof value !== 'string' || !value) throw new Error('Missing --' + key)
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
  if (command === 'help') {
    emit({ usage: [
      'specrails-core runtime api',
      'specrails-core runtime validate --config <json>',
      'specrails-core runtime validate --stdin',
      'specrails-core runtime run --context <json> --config <json> --change <kebab-case>',
      'specrails-core runtime status --context <json> [--compact]',
      'specrails-core runtime resume --context <json> [--approve archive] [--recover developer] [--invalidate verify]',
    ] })
    return 0
  }
  if (command === 'api') {
    emit({ type: 'runtime-api', apiVersion: RUNTIME_API_VERSION, coreVersion: CORE_PACKAGE_VERSION })
    return 0
  }
  if (command === 'validate') {
    if (flags.stdin !== undefined && flags.stdin !== true) throw new Error('--stdin is a boolean flag')
    if (flags.stdin && flags.config !== undefined) throw new Error('Use --stdin or --config, not both')
    validateRuntimeConfig(flags.stdin ? await readStdin() : read(stringFlag(flags, 'config')))
    emit({ type: 'runtime-config-valid', schemaVersion: 1 })
    return 0
  }
  if (!['run', 'status', 'resume'].includes(command)) throw new Error('Unknown runtime operation: ' + command)
  const context = validatePipelineContext(read(stringFlag(flags, 'context')))
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const previous = await readWorkflowState(directory, context.runId)
  if (command === 'status') {
    const pipeline = previous ? inspectPipeline(context) : null
    emit({ type: 'runtime-status', state: flags.compact ? compactState(previous) : previous, pipeline: flags.compact ? compactPipeline(pipeline) : pipeline })
    return 0
  }
  const requestFile = path.join(pipelineStateDirectory(context), 'agent-runtime-request.json')
  let request: { change: string; config: unknown }
  if (command === 'resume') {
    if (!previous) throw new Error('No programmatic run exists for this context')
    request = read(requestFile) as typeof request
    if (flags.config || flags.change) throw new Error('Resume uses the frozen configuration and change; start a new run to change them')
  } else {
    request = { change: stringFlag(flags, 'change'), config: validateRuntimeConfig(read(stringFlag(flags, 'config'))) }
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
      approve: list(flags, 'approve'), recoverInterrupted: list(flags, 'recover'), invalidate: list(flags, 'invalidate'),
      onEvent: event => emit({ type: 'workflow-event', event }),
      onAgentEvent: (role, event) => emit({ type: 'agent-event', role, event }),
      onVerificationOutput: text => emit({ type: 'verification-output', text }),
    })
    emit({ type: 'runtime-result', runId: state.runId, status: state.status, nextStep: state.nextStep, error: state.error, pendingApproval: state.pendingApproval, usage: state.usage, invocationUsage: invocationUsage(state, previous?.history.length ?? 0) })
    return state.status === 'succeeded' ? 0 : state.status === 'paused' ? 2 : 1
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { subcommand, flags, positionals } = parseArgs(process.argv.slice(2))
  try { process.exitCode = await runRuntimeCommand(flags, [subcommand ?? 'help', ...positionals]) }
  catch (error) {
    process.stdout.write(JSON.stringify({ type: 'runtime-result', status: 'failed', error: error instanceof Error ? error.message : String(error) }) + '\n')
    process.exitCode = 1
  }
}
