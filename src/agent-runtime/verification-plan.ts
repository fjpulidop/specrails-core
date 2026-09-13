import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { bindVerificationPlan, pipelineStateDirectory, validateVerificationRequest, type PipelineContext, type VerificationCommand, type HostCheckPolicy } from '../installer/runtime/pipeline-state.js'
import { fingerprint } from './durable-store.js'
import { child, write } from './graph/artifacts.js'

export interface ProposedCheck {
  kind: 'command' | 'harness'
  key: string
  repositoryId: string
  label: string
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  entrypoint?: string
  files?: Array<{ path: string; content: string }>
}
export interface HarnessSource { path: string; hash: string; byteCount: number }
export interface PlanEntry {
  id: string
  key: string
  label: string
  origins: Array<'host' | 'architect' | 'developer'>
  command: VerificationCommand
  harness?: { hash: string; entrypoint: string; sources: HarnessSource[] }
}
export interface VerificationPlan {
  schemaVersion: 1
  runId: string
  revision: number
  planHash: string
  integrity: string
  scopeHash: string
  executionPolicy: { maxConcurrency: number }
  baseline: PlanEntry[]
  developer: PlanEntry[]
  entries: PlanEntry[]
}
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const bytesHash = (text: string): string => createHash('sha256').update(text).digest('hex')
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) throw new Error('Invalid verification proposal ' + field)
  return value
}
function sourcePath(value: unknown): string {
  const file = text(value, 'file path', 1024)
  if (/^[a-z]:/i.test(file) || path.isAbsolute(file) || file.includes('\\') || /[\x00-\x1f\x7f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid verification proposal file path')
  return file
}
/** All declarations are validated before any source is materialized. */
export function validateProposedChecks(context: PipelineContext, raw: unknown): ProposedCheck[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('Invalid verificationChecks: expected at most 20 checks')
  let bytes = 0
  const keys = new Set<string>()
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid verification proposal')
    const check = value as Record<string, unknown>
    for (const key of Object.keys(check)) if (!['kind', 'key', 'repositoryId', 'label', 'command', 'args', 'cwd', 'timeoutMs', 'entrypoint', 'files'].includes(key)) throw new Error('Invalid verification proposal field: ' + key)
    if (!['command', 'harness'].includes(String(check.kind)) || typeof check.key !== 'string' || !SAFE_ID.test(check.key) || keys.has(check.key)) throw new Error('Invalid or duplicate verification proposal key/kind')
    keys.add(check.key)
    text(check.label, 'label', 256)
    text(check.command, 'command', 4096)
    if (!Array.isArray(check.args) || check.args.length > 128 || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) throw new Error('Invalid verification proposal args')
    validateVerificationRequest(context, { kind: 'scoped', commands: [check] })
    if (check.kind === 'command') {
      if (check.entrypoint !== undefined || check.files !== undefined) throw new Error('Invalid command proposal: harness fields are forbidden')
    } else {
      const entrypoint = sourcePath(check.entrypoint)
      if (!Array.isArray(check.files) || !check.files.length || check.files.length > 8) throw new Error('Invalid harness files: expected 1–8 files')
      const paths = new Set<string>()
      for (const raw of check.files) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid harness source')
        const file = raw as Record<string, unknown>
        if (Object.keys(file).some(key => !['path', 'content'].includes(key))) throw new Error('Invalid harness source fields')
        const filePath = sourcePath(file.path)
        if ([...paths].some(prior => prior === filePath.toLowerCase() || prior.startsWith(filePath.toLowerCase() + '/') || filePath.toLowerCase().startsWith(prior + '/'))) throw new Error('Duplicate harness source path')
        paths.add(filePath.toLowerCase())
        if (typeof file.content !== 'string') throw new Error('Invalid harness source content')
        const length = Buffer.byteLength(file.content)
        if (length > 64 * 1024 || (bytes += length) > 256 * 1024) throw new Error('Invalid harness source size')
      }
      if (!check.files.some(file => file.path === entrypoint)) throw new Error('Invalid harness entrypoint: source is missing')
    }
    return structuredClone(check) as unknown as ProposedCheck
  })
}

function normalized(command: VerificationCommand): VerificationCommand {
  return JSON.parse(JSON.stringify({ ...command, args: [...command.args], cwd: command.cwd ?? '.', timeoutMs: command.timeoutMs ?? 15 * 60_000 }))
}
function entry(key: string, label: string, command: VerificationCommand, origin: PlanEntry['origins'][number], harness?: PlanEntry['harness']): PlanEntry {
  const definition = normalized(command)
  delete definition.key; delete definition.label
  return { key, label, command: definition, origins: [origin], ...(harness ? { harness } : {}), id: fingerprint({ key, command: definition, harness: harness ?? null }) }
}
function mergePolicy(left?: HostCheckPolicy, right?: HostCheckPolicy): HostCheckPolicy {
  return {
    reuse: left?.reuse === 'snapshot-local' && right?.reuse === 'snapshot-local' ? 'snapshot-local' : 'never',
    deterministic: left?.deterministic === true && right?.deterministic === true,
    readOnly: left?.readOnly === true && right?.readOnly === true,
    inputs: [...new Set([...(left?.inputs ?? []), ...(right?.inputs ?? [])])].sort(),
    toolchainInputs: [...new Set([...(left?.toolchainInputs ?? []), ...(right?.toolchainInputs ?? [])])].sort(),
    ...(left?.independentGroup && left.independentGroup === right?.independentGroup && left.resources && right.resources ? { independentGroup: left.independentGroup, resources: [...new Set([...left.resources, ...right.resources])].sort() } : {}),
  }
}
function coalesce(entries: PlanEntry[]): PlanEntry[] {
  const results = new Map<string, PlanEntry>()
  for (const item of entries) {
    const { policy: _policy, ...command } = item.command
    const semantic = fingerprint({ command, harness: item.harness ?? null })
    const old = results.get(semantic)
    if (!old) { results.set(semantic, structuredClone(item)); continue }
    if (item.origins.some(origin => origin !== 'developer')) old.command.policy = mergePolicy(old.command.policy, item.command.policy)
    old.origins = [...new Set([...old.origins, ...item.origins])]
  }
  return [...results.values()]
}
function planFile(context: PipelineContext): string { return child(pipelineStateDirectory(context), 'verification/plan.json') }
export function readVerificationPlan(context: PipelineContext): VerificationPlan | null {
  const file = planFile(context)
  if (!existsSync(file)) return null
  if (statSync(file).size > 2 * 1024 * 1024) throw new Error('Verification plan exceeds its size limit')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  const { integrity, ...payload } = value
  if (integrity !== fingerprint(payload)) throw new Error('Verification plan failed its integrity check')
  if (value.scopeHash !== fingerprint(context) || value.schemaVersion !== 1 || value.runId !== context.runId || !Array.isArray(value.baseline) || !Array.isArray(value.developer) || !Array.isArray(value.entries) || value.entries.length > 100 || value.planHash !== fingerprint({ policyVersion: 1, scopeHash: value.scopeHash, executionPolicy: value.executionPolicy, entries: value.entries })) throw new Error('Verification plan failed its integrity check')
  return value as VerificationPlan
}
export function initializeVerificationPlan(context: PipelineContext, host: VerificationCommand[], architect: VerificationCommand[], maxConcurrency = 1): VerificationPlan {
  const previous = readVerificationPlan(context)
  const baseline = ([['host', host], ['architect', architect]] as const).flatMap(([origin, commands]) => commands.map((command, i) => entry(`${origin}:${command.key ?? `${i}-${fingerprint(normalized(command)).slice(0, 12)}`}`, command.label ?? [command.command, ...command.args].join(' ').slice(0, 256), command, origin)))
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) throw new Error('Invalid verification concurrency')
  if (previous && fingerprint(previous.baseline) !== fingerprint(baseline)) throw new Error('Verification baseline is immutable')
  return savePlan(context, baseline, previous?.developer ?? [], previous, { maxConcurrency })
}
function buildPlan(context: PipelineContext, baseline: PlanEntry[], developer: PlanEntry[], previous: VerificationPlan | null, executionPolicy = previous?.executionPolicy ?? { maxConcurrency: 1 }): VerificationPlan {
  const entries = coalesce([...baseline, ...developer])
  if (entries.length > 100) throw new Error('Invalid verification plan: maximum 100 effective checks')
  const scopeHash = fingerprint(context)
  const planHash = fingerprint({ policyVersion: 1, scopeHash, executionPolicy, entries })
  const payload = { schemaVersion: 1 as const, runId: context.runId, revision: (previous?.revision ?? 0) + (previous?.planHash === planHash ? 0 : 1), planHash, scopeHash, executionPolicy, baseline, developer, entries }
  const plan: VerificationPlan = { ...payload, integrity: fingerprint(payload) }
  const serialized = JSON.stringify(plan) + '\n'
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('Verification plan exceeds 2 MiB')
  return plan
}
function savePlan(context: PipelineContext, baseline: PlanEntry[], developer: PlanEntry[], previous: VerificationPlan | null, executionPolicy = previous?.executionPolicy ?? { maxConcurrency: 1 }): VerificationPlan {
  const plan = buildPlan(context, baseline, developer, previous, executionPolicy)
  write(planFile(context), JSON.stringify(plan) + '\n')
  return plan
}
export function addDeveloperChecks(context: PipelineContext, proposals: ProposedCheck[]): VerificationPlan {
  const previous = readVerificationPlan(context)
  if (!previous) throw new Error('Verification baseline is unavailable')
  const checked = validateProposedChecks(context, proposals)
  const developer = new Map(previous.developer.map(item => [item.key, item]))
  const sources: Array<{ file: string; content: string }> = []
  for (const check of checked) {
    const command: VerificationCommand = { repositoryId: check.repositoryId, command: check.command, args: check.args, ...(check.cwd === undefined ? {} : { cwd: check.cwd }), ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }) }
    const files = check.files?.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, hash: bytesHash(file.content), byteCount: Buffer.byteLength(file.content) }))
    const harness = files ? { hash: fingerprint(files), entrypoint: check.entrypoint!, sources: files } : undefined
    const item = entry('dev:' + check.key, check.label, command, 'developer', harness)
    developer.set(item.key, item)
    for (const file of check.files ?? []) sources.push({ file: child(pipelineStateDirectory(context), `verification/harnesses/${item.id}/${harness!.hash}/${file.path}`), content: file.content })
  }
  const plan = buildPlan(context, previous.baseline, [...developer.values()], previous)
  // An interrupted write cannot activate a partial harness. Old immutable
  // revisions remain readable; only the new manifest changes the active plan.
  for (const source of sources) {
    if (existsSync(source.file) && readFileSync(source.file, 'utf8') !== source.content) throw new Error('Immutable verification source changed')
  }
  for (const source of sources) {
    if (!existsSync(source.file)) write(source.file, source.content)
  }
  write(planFile(context), JSON.stringify(plan) + '\n')
  return plan
}
export function expandedPlanCommands(context: PipelineContext, plan: VerificationPlan): VerificationCommand[] {
  return plan.entries.map(item => {
    if (!item.harness) return { ...item.command, key: item.id, label: item.label }
    const repository = context.repositories.find(repo => repo.id === item.command.repositoryId)
    if (!repository) throw new Error('Harness repository is no longer admitted')
    for (const source of item.harness.sources) {
      const file = child(pipelineStateDirectory(context), `verification/harnesses/${item.id}/${item.harness.hash}/${source.path}`)
      if (bytesHash(readFileSync(file, 'utf8')) !== source.hash) throw new Error('Verification harness source changed')
    }
    const entrypoint = child(pipelineStateDirectory(context), `verification/harnesses/${item.id}/${item.harness.hash}/${item.harness.entrypoint}`)
    return { ...item.command, key: item.id, label: item.label, args: [...item.command.args, entrypoint], env: { SPECRAILS_CHECK_REPO_ROOT: repository.path } }
  })
}

/** Bind the exact manifest and every source to lifecycle gates. */
export function bindPlan(context: PipelineContext, plan: VerificationPlan): void {
  const files = [{ path: 'verification/plan.json', hash: bytesHash(readFileSync(planFile(context), 'utf8')) }]
  for (const item of plan.entries) for (const source of item.harness?.sources ?? []) {
    files.push({ path: `verification/harnesses/${item.id}/${item.harness!.hash}/${source.path}`, hash: source.hash })
  }
  bindVerificationPlan(context, plan.planHash, files)
}
