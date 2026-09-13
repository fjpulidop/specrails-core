import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export type PipelinePhase = 'architect' | 'developer' | 'reviewer' | 'archive' | 'ship' | 'ci'
export type PhaseStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped'
export interface PipelineSpec { id: string | number; title: string; description: string; repositoryIds?: string[]; acceptanceCriteria?: string[] }
export interface PipelineRepository { id: string; name: string; path: string; baseSha?: string }
export interface PipelineContext {
  schemaVersion: 1
  runId: string
  backlogRoot: string
  backlogPath?: string
  artifactRoot: string
  artifactRepositoryId: string
  repositories: PipelineRepository[]
  ownership: { git: 'host' | 'core'; backlog: 'host' | 'core'; worktrees: 'host' | 'core' }
  specs: PipelineSpec[]
}
export interface HostCheckPolicy {
  reuse?: 'never' | 'snapshot-local'
  inputs?: string[]
  deterministic?: boolean
  readOnly?: boolean
  toolchainInputs?: string[]
  independentGroup?: string
  resources?: string[]
}
export interface VerificationCommand {
  key?: string
  label?: string
  policy?: HostCheckPolicy
  repositoryId: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}
/** `unverified` admits a full request whose commands do not cover every repository
 *  (or cover none): the receipt then records which repositories ran no check. */
export interface VerificationRequest { kind: 'full' | 'scoped'; commands: VerificationCommand[]; unverified?: boolean; planHash?: string }
export interface CommandReceipt {
  repositoryId: string; command: string; args: string[]; cwd: string
  environmentPolicy?: 'isolated-transport-v1'
  environmentHash: string; environmentKeys: string[]; environmentOverrideKeys: string[]; environmentOverridesHash: string
  exitCode: number; durationMs: number; output: string
  checkDefinitionHash?: string
  checkDefinition?: VerificationCommand
  disposition?: 'executed' | 'reused' | 'not-run'; reusedFrom?: string; reuseReason?: string; snapshot?: VerificationSnapshot
  pending?: boolean; evidenceId?: string; stdout?: string; stderr?: string; outputTruncated?: boolean
  key?: string; label?: string; configuredTimeoutMs?: number; appliedTimeoutMs?: number; deadline?: number
  outcome?: 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted'

}
export interface VerificationReceipt {
  id: string; kind: 'full' | 'scoped'; scopeHash: string; candidateHash: string; planHash?: string
  commands: CommandReceipt[]; notRunEvidenceIds?: string[]; completedAt: string; valid: boolean; reason?: string
  /** Repositories in scope that this receipt ran no command for (explicitly admitted by the request). */
  unverifiedRepositories?: string[]
}
export interface AcceptanceCriterion {
  specId: string
  criterionIndex: number
  requirement: string
  status: 'met' | 'exception' | 'blocked' | 'pending'
  evidence: string[]
  exception?: { reason: string; impact: string; material: boolean; acceptedBy: 'reviewer' | 'user' | 'host'; approvalEvidence: string }
}
export interface AcceptanceCheck {
  name: string
  status: 'passed' | 'failed' | 'unavailable'
  required: boolean
  evidence: string[]
  /** What was measured and what remains outside the measurement. */
  scope: string
  limitations: string
}
export interface AcceptanceReport {
  criteria: AcceptanceCriterion[]
  checks: AcceptanceCheck[]
  findings: string[]
}
export interface AcceptanceReceipt extends AcceptanceReport {
  scopeHash: string; candidateHash: string; artifactHash: string; recordedAt: string; planHash?: string
}
export interface PipelineCompletion {
  implementation: 'complete' | 'incomplete'
  validation: 'verified' | 'with-exceptions' | 'pending' | 'blocked'
  archive: PhaseStatus
  delivery: 'pending-host' | 'complete' | 'pending'
  reasons: string[]
}
interface PhaseRecord { startedAt?: string; durationMs?: number; attempts?: number; status: PhaseStatus; reason?: string; candidateHash?: string; artifactHash?: string; completedAt?: string }
export interface PipelineState {
  schemaVersion: 1; runId: string; change: string; context: PipelineContext; scopeHash: string
  revision: number; createdAt: string; updatedAt: string
  phases: Record<PipelinePhase, PhaseRecord>
  verificationPlan?: { hash: string; files: Array<{ path: string; hash: string }> }
  verification?: VerificationReceipt
  acceptance?: AcceptanceReceipt
  archivePath?: string
  archiveApproval?: { candidateHash: string; artifactHash: string; confidenceHash: string; acceptanceHash: string }
  artifactExclusions: string[]
  preview?: { baseHash: string; files: PreviewFile[]; createdAt: string }
}
export interface PreviewFile { repositoryId: string; path: string; operation: 'write' | 'delete'; sourcePath?: string; contentHash?: string }
const PHASES: PipelinePhase[] = ['architect', 'developer', 'reviewer', 'archive', 'ship', 'ci']
// Session identity belongs to the agent transport, not the checked application.
// Remove these from check subprocesses too, so ignored identity cannot become
// an unrecorded test input. Explicit command.env inputs remain bound overrides.
// Keep provider configuration, application inputs and host scope/configuration
// (including SPECRAILS_*) in the evidence; never exclude an entire prefix.
const TRANSPORT_ENV_KEYS = new Set([
  '_', 'PWD', 'OLDPWD', 'SHLVL',
  'AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT',
  'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION',
])
function verificationEnvironmentKeys(env: NodeJS.ProcessEnv, overrideKeys: string[] = []): string[] {
  return Object.keys(normalizeVerificationEnvironment(env)).filter((key) => !TRANSPORT_ENV_KEYS.has(key) && !overrideKeys.includes(key)).sort()
}
function normalizeVerificationEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = Object.create(null)
  for (const [raw, value] of Object.entries(env)) {
    if (value === undefined) continue
    const key = platform === 'win32' ? raw.toUpperCase() : raw
    if (Object.hasOwn(result, key) && result[key] !== value) fail('Ambiguous verification environment key: ' + key)
    result[key] = value
  }
  return result
}
export function verificationEnvironment(env: NodeJS.ProcessEnv, overrides: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const normalized = normalizeVerificationEnvironment(env, platform)
  return { ...Object.fromEntries(Object.entries(normalized).filter(([key]) => !TRANSPORT_ENV_KEYS.has(key))), ...normalizeVerificationEnvironment(overrides, platform) }
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function fail(message: string): never { throw new Error(message) }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
function readJson(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object')
  return value as Record<string, unknown>
}
function directory(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('Execution roots must be absolute paths')
  const resolved = realpathSync(value)
  if (!lstatSync(resolved).isDirectory()) fail('Execution root is not a directory: ' + value)
  return resolved
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
function safeChild(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) fail('Expected a repository-relative path')
  const target = path.resolve(root, relative)
  if (!within(root, target) || target === root) fail('Path escapes its repository: ' + relative)
  let current = root
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) fail('Refusing a symlink write path: ' + relative)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}
function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}
export function validatePipelineContext(input: unknown): PipelineContext {
  const data = object(input)
  if (data.schemaVersion !== 1 || typeof data.runId !== 'string' || !ID.test(data.runId)) fail('Invalid execution context version or runId')
  if (!Array.isArray(data.repositories) || data.repositories.length === 0) fail('Execution context needs repositories')
  const repositories = data.repositories.map((entry): PipelineRepository => {
    const repo = object(entry)
    if (typeof repo.id !== 'string' || !ID.test(repo.id) || typeof repo.name !== 'string') fail('Invalid repository identity')
    if (repo.baseSha !== undefined && (typeof repo.baseSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(repo.baseSha))) fail('Invalid repository base SHA')
    return { id: repo.id, name: repo.name, path: directory(repo.path), ...(repo.baseSha ? { baseSha: repo.baseSha as string } : {}) }
  })
  if (new Set(repositories.map((repo) => repo.id)).size !== repositories.length || new Set(repositories.map((repo) => repo.path)).size !== repositories.length) fail('Duplicate repository identity or path')
  const artifactRoot = directory(data.artifactRoot)
  if (!repositories.some((repo) => repo.id === data.artifactRepositoryId && repo.path === artifactRoot)) fail('artifactRoot must match artifactRepositoryId')
  const ownership = object(data.ownership)
  for (const key of ['git', 'backlog', 'worktrees']) if (!['host', 'core'].includes(String(ownership[key]))) fail('Invalid ownership: ' + key)
  if (!Array.isArray(data.specs)) fail('Frozen specs must be an array')
  const specs = data.specs.map((entry): PipelineSpec => {
    const spec = object(entry)
    if (!['string', 'number'].includes(typeof spec.id) || typeof spec.title !== 'string' || typeof spec.description !== 'string') fail('Invalid frozen spec')
    if (spec.repositoryIds !== undefined && (!Array.isArray(spec.repositoryIds) || !spec.repositoryIds.every((id) => repositories.some((repo) => repo.id === id)))) fail('Spec selects an unknown repository')
    if (spec.acceptanceCriteria !== undefined && (!Array.isArray(spec.acceptanceCriteria) || !spec.acceptanceCriteria.every((x) => typeof x === 'string'))) fail('Invalid acceptance criteria')
    return { id: spec.id as string | number, title: spec.title, description: spec.description, ...(spec.repositoryIds ? { repositoryIds: spec.repositoryIds as string[] } : {}), ...(spec.acceptanceCriteria ? { acceptanceCriteria: spec.acceptanceCriteria as string[] } : {}) }
  })
  if (!specs.length || new Set(specs.map(spec => String(spec.id))).size !== specs.length) fail('Frozen scope needs unique nonempty specs')
  const backlogRoot = directory(data.backlogRoot)
  const backlogPath = data.backlogPath === undefined ? path.join(backlogRoot, '.specrails', 'local-tickets.json') : String(data.backlogPath)
  if (!path.isAbsolute(backlogPath) || !within(backlogRoot, path.resolve(backlogPath))) fail('Backlog path escapes backlogRoot')
  return { schemaVersion: 1, runId: data.runId, backlogRoot, backlogPath, artifactRoot, artifactRepositoryId: String(data.artifactRepositoryId), repositories, ownership: ownership as PipelineContext['ownership'], specs }
}
export function pipelineStateDirectory(context: PipelineContext): string {
  return safeChild(context.backlogRoot, '.specrails/pipeline/' + context.runId)
}
function locked<T>(context: PipelineContext, operation: () => T): T {
  const dir = pipelineStateDirectory(context)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = safeChild(dir, 'journal.lock')
  const owner = { pid: process.pid, token: randomUUID() }
  const release = (target: string, token: string): void => {
    try { if (object(readJson(target)).token === token) rmSync(target) } catch { /* never remove a replacement or uncertain lease */ }
  }
  let fd: number
  try { fd = openSync(file, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // A stable exclusive guard serializes stale-owner recovery. Without it,
    // two readers of a dead PID could unlink the new winner's live lease.
    const guard = safeChild(dir, 'journal-reclaim.lock')
    const recovery = { pid: process.pid, token: randomUUID() }
    let guardFd: number
    try { guardFd = openSync(guard, 'wx', 0o600) } catch { fail('Pipeline journal recovery is locked; inspect a stale recovery guard before retrying') }
    try {
      writeFileSync(guardFd, JSON.stringify(recovery))
      if (existsSync(file)) {
        const previousText = readFileSync(file, 'utf8')
        const previous = object(JSON.parse(previousText))
        let stale = false
        if (typeof previous.pid === 'number' && previous.pid > 0) {
          try { process.kill(previous.pid, 0) } catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
        if (!stale || readFileSync(file, 'utf8') !== previousText) fail('Pipeline journal is locked by another operation')
        rmSync(file)
      }
      // A fast-path contender can win after unlink; exclusive create then
      // fails instead of deleting that contender's lease or running unlocked.
      fd = openSync(file, 'wx', 0o600)
    } finally { closeSync(guardFd); release(guard, recovery.token) }
  }
  try {
    writeFileSync(fd, JSON.stringify(owner))
    return operation()
  } finally { closeSync(fd); release(file, owner.token) }
}
function stateFile(context: PipelineContext): string { return path.join(pipelineStateDirectory(context), 'state.json') }
function readState(context: PipelineContext): PipelineState {
  const state = object(readJson(stateFile(context))) as unknown as PipelineState
  if (state.schemaVersion !== 1 || state.runId !== context.runId || state.scopeHash !== digest(canonical(context))) fail('Execution context differs from the frozen journal scope')
  return state
}
function saveState(state: PipelineState): void {
  state.revision += 1
  state.updatedAt = new Date().toISOString()
  atomicJson(stateFile(state.context), state)
}
function relativeUnix(value: string): string { return value.split(path.sep).join('/') }
function excluded(state: PipelineState, repo: PipelineRepository, relative: string): boolean {
  const absolute = path.join(repo.path, relative)
  if (within(pipelineStateDirectory(state.context), absolute)) return true
  if (['.specrails/kimi-role-wave.json', '.specrails/kimi-role-request.json', '.specrails/kimi-role-merge.json', '.specrails/kimi-role-worktrees/' + state.runId + '.json'].includes(relative)) return true
  if (relative === '.specrails/runtime' || relative.startsWith('.specrails/runtime/')) return true
  if (repo.id !== state.context.artifactRepositoryId) return false
  return state.artifactExclusions.some((item) => relative === item || relative.startsWith(item + '/'))
}
function fileFingerprint(file: string, ancestors = new Set<string>(), budget = { entries: 0, bytes: 0 }, linkedTree = false): string {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) {
    if (linkedTree) fail('Candidate has a missing symlink target: ' + file)
    return 'deleted'
  }
  if (++budget.entries > 50_000) fail('Linked candidate tree exceeds fingerprint entry limit: ' + file)
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(file)
    let target: string
    try { target = realpathSync(file) } catch { fail('Candidate has a dangling or cyclic symlink: ' + file) }
    if (ancestors.has(target)) fail('Candidate has a cyclic linked directory: ' + file)
    const next = new Set(ancestors)
    next.add(target)
    return 'link:' + link + ':' + fileFingerprint(target, next, budget, true)
  }
  if (stat.isDirectory() && linkedTree) {
    // Framework directory links are normal. Hash their actual inputs, not only
    // link text, with deterministic traversal and bounds. Git administration is
    // not a source input; dependency/output directories are not blindly hidden.
    const children = readdirSync(file, { withFileTypes: true }).filter((entry) => entry.name !== '.git').sort((a, b) => a.name.localeCompare(b.name))
    return 'directory:' + digest(canonical(children.map((entry) => [entry.name, fileFingerprint(path.join(file, entry.name), ancestors, budget, true)])))
  }
  if (!stat.isFile()) fail('Candidate contains a directory entry or unsupported file: ' + file)
  budget.bytes += stat.size
  if (linkedTree && budget.bytes > 256 * 1024 * 1024) fail('Linked candidate inputs exceed fingerprint byte limit: ' + file)
  return (stat.mode & 0o111 ? 'executable:' : 'file:') + digest(readFileSync(file))
}
function trackedFiles(repo: PipelineRepository): Array<{ file: string; tracked: boolean }> {
  // A provider's temporary GIT_CONFIG_COUNT/excludesFile must not hide
  // candidate files from verification or change receipt validity at handoff.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const list = (args: string[]): string[] => {
    const result = spawnSync('git', ['-c', 'core.excludesFile=', '-C', repo.path, 'ls-files', '-z', ...args], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    if (result.error || result.status !== 0) fail('Cannot fingerprint repository ' + repo.name + ': ' + (result.error?.message ?? result.stderr))
    return result.stdout.split('\0').filter(Boolean)
  }
  const tracked = new Set(list(['--cached']))
  return [...new Set([...tracked, ...list(['--others', '--exclude-standard'])])].sort().map(file => ({ file, tracked: tracked.has(file) }))
}
function untrackedAgentMemory(relative: string): boolean {
  // Native project memory can be written automatically after a role finishes,
  // even when the role keeps explicit notes under stateDir. Exclude only known
  // generated memory roots; tracked files and provider settings/skills still
  // belong to the candidate. Do not hide arbitrary provider directory content.
  return ['.claude', '.codex', '.gemini', '.kimi-code', '.specrails'].some(provider =>
    relative === provider + '/agent-memory' || relative.startsWith(provider + '/agent-memory/'))
}
export interface CandidateManifest {
  schemaVersion: 1
  scopeHash: string
  repositories: Array<{ id: string; path: string; files: Array<[string, string]> }>
}
export function candidateManifest(state: PipelineState): CandidateManifest {
  const entries = state.context.repositories.map((repo) => ({
    id: repo.id, path: repo.path,
    files: trackedFiles(repo)
      .filter(({ file, tracked }) => !excluded(state, repo, relativeUnix(file)) && (tracked || !untrackedAgentMemory(relativeUnix(file))))
      .map(({ file }): [string, string] => [relativeUnix(file), fileFingerprint(path.join(repo.path, file))]),
  }))
  return { schemaVersion: 1, scopeHash: state.scopeHash, repositories: entries }
}
export function fingerprintCandidate(state: PipelineState): string { return digest(canonical(candidateManifest(state).repositories)) }
function activeArtifactPath(state: PipelineState): string { return state.archivePath ?? path.join(state.context.artifactRoot, 'openspec', 'changes', state.change) }
function artifactFingerprint(state: PipelineState): string {
  const root = activeArtifactPath(state)
  if (!existsSync(root)) return 'missing'
  const result: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name)
      if (item.name === 'confidence-score.json') continue
      if (item.isDirectory()) walk(file)
      else {
        const relative = relativeUnix(path.relative(root, file))
        const fingerprint = relative === 'tasks.md' ? digest(readFileSync(file, 'utf8').replace(/^(\s*-\s+)\[[ x]\]/gm, '$1[ ]')) : fileFingerprint(file)
        result.push([relative, fingerprint])
      }
    }
  }
  walk(root)
  return digest(canonical(result))
}
export function initializePipeline(contextInput: unknown, change: string): PipelineState {
  const context = validatePipelineContext(contextInput)
  if (!slug.test(change)) fail('Invalid OpenSpec change name')
  return locked(context, () => {
    if (existsSync(stateFile(context))) {
      const existing = readState(context)
      if (existing.change !== change) fail('A runId cannot be reused for another change')
      return existing
    }
    const now = new Date().toISOString()
    const state: PipelineState = {
      schemaVersion: 1, runId: context.runId, change, context, scopeHash: digest(canonical(context)), revision: 0,
      createdAt: now, updatedAt: now,
      phases: Object.fromEntries(PHASES.map((phase) => [phase, { status: 'pending' }])) as PipelineState['phases'],
      artifactExclusions: ['openspec/changes/' + change],
    }
    atomicJson(path.join(pipelineStateDirectory(context), 'context.json'), context)
    saveState(state)
    return state
  })
}
function environmentHash(keys: string[], overrides: Record<string, string> = {}, env = process.env): string {
  const normalized = normalizeVerificationEnvironment(env)
  return digest(canonical(Object.fromEntries(keys.map((key) => [key, overrides[key] ?? normalized[key] ?? null]))))
}
/** Host-owned binding, including immutable harness bytes outside the candidate. */
export function bindVerificationPlan(contextInput: PipelineContext, hash: string, files: Array<{ path: string; hash: string }>): void {
  const context = validatePipelineContext(contextInput)
  if (!/^[a-f0-9]{64}$/.test(hash) || files.length > 801) fail('Invalid verification plan identity')
  for (const file of files) {
    const target = safeChild(pipelineStateDirectory(context), file.path)
    if (!/^[a-f0-9]{64}$/.test(file.hash) || digest(readFileSync(target)) !== file.hash) fail('Verification plan source changed')
  }
  locked(context, () => {
    const state = readState(context)
    const binding = { hash, files }
    if (canonical(state.verificationPlan) === canonical(binding)) return
    if (state.phases.archive.status === 'done') fail('Cannot change the archived verification plan')
    state.verificationPlan = binding
    state.acceptance = undefined
    state.archiveApproval = undefined
    saveState(state)
  })
}
function planReasons(state: PipelineState, hash?: string): string[] {
  if (hash !== state.verificationPlan?.hash) return ['Verification plan changed']
  try {
    for (const file of state.verificationPlan?.files ?? []) {
      if (digest(readFileSync(safeChild(pipelineStateDirectory(state.context), file.path))) !== file.hash) return ['Verification plan or harness source changed']
    }
  } catch { return ['Verification plan or harness source unavailable'] }
  return []
}
function inspectReceipt(state: PipelineState, env = process.env): { valid: boolean; reasons: string[]; receipt?: VerificationReceipt } {
  const receipt = state.verification
  const reasons: string[] = planReasons(state, receipt?.planHash)
  if (!receipt) return { valid: false, reasons: ['No verification receipt'] }
  if (!receipt.valid || receipt.kind !== 'full') reasons.push(receipt.reason ?? 'No successful full verification')
  if (receipt.scopeHash !== state.scopeHash) reasons.push('Spec scope changed')
  if (receipt.candidateHash !== fingerprintCandidate(state)) reasons.push('Candidate files changed')
  for (const command of receipt.commands) {
    if (command.snapshot?.eligible) {
      // The frozen logical command is recorded with each execution for inspection.
      const snapshot = command.checkDefinition ? verificationSnapshot(state.context, command.checkDefinition) : undefined
      if (!snapshot?.eligible || snapshot.inputHash !== command.snapshot.inputHash || snapshot.toolchainHash !== command.snapshot.toolchainHash) reasons.push('Verification inputs or toolchain changed')
    }
    if (command.exitCode !== 0) reasons.push('Command failed: ' + command.command)
    if (command.environmentPolicy !== 'isolated-transport-v1') reasons.push('Verification environment policy changed; run full verification again: ' + command.command)
    const currentKeys = verificationEnvironmentKeys(env, command.environmentOverrideKeys ?? [])
    if (canonical(currentKeys) !== canonical(command.environmentKeys) || command.environmentHash !== environmentHash(currentKeys, {}, env)) {
      const previousKeys = command.environmentKeys ?? []
      const added = currentKeys.filter(key => !previousKeys.includes(key))
      const removed = previousKeys.filter(key => !currentKeys.includes(key))
      // Names explain process handoff drift without retaining or revealing
      // values. A changed aggregate hash cannot identify which value changed.
      const summarize = (keys: string[]) => keys.slice(0, 10).map(key => JSON.stringify(key)).join(', ') + (keys.length > 10 ? ` (+${keys.length - 10} more)` : '')
      const details = [added.length ? 'added keys: ' + summarize(added) : '', removed.length ? 'removed keys: ' + summarize(removed) : ''].filter(Boolean)
      reasons.push('Verification environment changed: ' + command.command + ' (' + (details.join('; ') || 'recorded environment values differ') + ')')
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], receipt }
}
function designGate(state: PipelineState): void {
  const root = activeArtifactPath(state)
  for (const file of ['proposal.md', 'design.md', 'tasks.md']) if (!existsSync(path.join(root, file))) fail('Missing architecture artifact: ' + file)
  const specs = path.join(root, 'specs')
  if (!existsSync(specs) || !readdirSync(specs, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(path.join(specs, entry.name, 'spec.md')))) fail('Missing architecture delta specs')
  const design = object(readJson(path.join(root, 'design-confidence.json')))
  if (!['high', 'medium'].includes(String(design.confidence))) fail('Design confidence blocks implementation')
}
function confidenceGate(state: PipelineState): void {
  const file = path.join(activeArtifactPath(state), 'confidence-score.json')
  if (!existsSync(file)) fail('Required confidence-score.json is missing')
  const score = object(readJson(file))
  const aspects = object(score.aspects)
  if (score.change !== state.change || typeof score.overall !== 'number' || score.overall < 70) fail('Confidence score does not pass')
  for (const [name, threshold] of Object.entries({ type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 })) {
    if (typeof aspects[name] !== 'number' || Number(aspects[name]) < threshold || Number(aspects[name]) > 100) fail('Confidence aspect does not pass: ' + name)
  }
  if (score.overall > 100) fail('Invalid confidence score')
}
function taskGate(state: PipelineState): void {
  const tasks = readFileSync(path.join(activeArtifactPath(state), 'tasks.md'), 'utf8')
  if (!/^\s*-\s+\[x\]/m.test(tasks) || /^\s*-\s+\[ \]/m.test(tasks)) fail('Required implementation tasks remain incomplete')
}
/** Stable indices refer to the frozen scope, never to rewritten design text.
 * When no explicit AC list exists, the frozen description is the requirement. */
function frozenCriteria(context: PipelineContext): Array<Pick<AcceptanceCriterion, 'specId' | 'criterionIndex' | 'requirement'>> {
  return context.specs.flatMap(spec => (spec.acceptanceCriteria?.length ? spec.acceptanceCriteria : [spec.description || spec.title])
    .map((requirement, criterionIndex) => ({ specId: String(spec.id), criterionIndex, requirement })))
}
/** The frozen requirements an acceptance report must certify, in scope order. */
export function frozenAcceptanceCriteria(contextInput: unknown): Array<Pick<AcceptanceCriterion, 'specId' | 'criterionIndex' | 'requirement'>> {
  return frozenCriteria(validatePipelineContext(contextInput))
}
/** Validates a report against the frozen scope without recording it; throws the same errors `recordAcceptance` would. */
export function validateAcceptanceReport(contextInput: unknown, input: unknown): AcceptanceReport {
  return acceptanceReport(validatePipelineContext(contextInput), input)
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function evidence(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(nonempty) }
function acceptanceReport(context: PipelineContext, input: unknown): AcceptanceReport {
  const report = object(input)
  const expected = frozenCriteria(context)
  if (!Array.isArray(report.criteria) || report.criteria.length !== expected.length) fail('Acceptance must cover every frozen requirement exactly once')
  const seen = new Set<string>()
  const criteria = report.criteria.map((raw): AcceptanceCriterion => {
    const row = object(raw)
    const match = expected.find(item => item.specId === row.specId && item.criterionIndex === row.criterionIndex)
    const key = String(row.specId) + ':' + String(row.criterionIndex)
    if (!match || match.requirement !== row.requirement || seen.has(key)) fail('Acceptance requirement differs from frozen scope or is duplicated')
    seen.add(key)
    if (!['met', 'exception', 'blocked', 'pending'].includes(String(row.status)) || !evidence(row.evidence)) fail('Acceptance needs a valid status and concrete evidence for every requirement')
    let exception: AcceptanceCriterion['exception']
    if (row.status === 'exception') {
      const entry = object(row.exception)
      if (!nonempty(entry.reason) || !nonempty(entry.impact) || typeof entry.material !== 'boolean'
        || !['reviewer', 'user', 'host'].includes(String(entry.acceptedBy)) || !nonempty(entry.approvalEvidence)) fail('Exception needs reason, impact and recorded acceptance')
      if (entry.material && entry.acceptedBy === 'reviewer') fail('Material scope exceptions require user or host acceptance')
      exception = entry as unknown as NonNullable<AcceptanceCriterion['exception']>
    } else if (row.exception !== undefined) fail('Exception details require exception status')
    return { ...match, status: row.status as AcceptanceCriterion['status'], evidence: row.evidence, ...(exception ? { exception } : {}) }
  })
  if (!Array.isArray(report.checks) || !Array.isArray(report.findings) || !report.findings.every(nonempty)) fail('Acceptance needs checks and findings arrays')
  const checks = report.checks.map((raw): AcceptanceCheck => {
    const check = object(raw)
    if (!nonempty(check.name) || !['passed', 'failed', 'unavailable'].includes(String(check.status)) || typeof check.required !== 'boolean'
      || !evidence(check.evidence) || !nonempty(check.scope) || !nonempty(check.limitations)) fail('Check needs status, evidence, measurement scope and limitations')
    return { name: check.name, status: check.status as AcceptanceCheck['status'], required: check.required, evidence: check.evidence, scope: check.scope, limitations: check.limitations }
  })
  return { criteria, checks, findings: report.findings as string[] }
}
function inspectAcceptance(state: PipelineState): { valid: boolean; status: PipelineCompletion['validation']; reasons: string[]; receipt?: AcceptanceReceipt } {
  const receipt = state.acceptance
  if (!receipt) return { valid: false, status: 'pending', reasons: ['No acceptance evidence'] }
  const reasons: string[] = []
  try { acceptanceReport(state.context, receipt) } catch (error) {
    return { valid: false, status: 'blocked', reasons: [error instanceof Error ? error.message : String(error)] }
  }
  reasons.push(...planReasons(state, receipt.planHash))
  if (receipt.scopeHash !== state.scopeHash || receipt.candidateHash !== fingerprintCandidate(state) || receipt.artifactHash !== artifactFingerprint(state)) reasons.push('Acceptance evidence is stale')
  for (const row of receipt.criteria ?? []) if (row.status === 'blocked' || row.status === 'pending') reasons.push('Unresolved requirement: ' + row.requirement)
  for (const check of receipt.checks ?? []) if (check.required && check.status !== 'passed') reasons.push('Required check did not pass: ' + check.name)
  const exceptions = receipt.criteria?.some(row => row.status === 'exception') || receipt.checks?.some(check => check.status !== 'passed')
  return { valid: reasons.length === 0, status: reasons.length ? 'blocked' : exceptions ? 'with-exceptions' : 'verified', reasons, receipt }
}
function acceptanceGate(state: PipelineState): void {
  const acceptance = inspectAcceptance(state)
  if (!acceptance.valid) fail('Acceptance blocked: ' + acceptance.reasons.join('; '))
}
export function recordAcceptance(contextInput: unknown, input: unknown): PipelineState {
  const context = validatePipelineContext(contextInput)
  const report = acceptanceReport(context, input)
  return locked(context, () => {
    const state = readState(context)
    if (state.phases.developer.status !== 'done' || state.phases.archive.status === 'done') fail('Record acceptance after development and before archive')
    state.acceptance = { ...report, ...(state.verificationPlan ? { planHash: state.verificationPlan.hash } : {}), scopeHash: state.scopeHash, candidateHash: fingerprintCandidate(state), artifactHash: artifactFingerprint(state), recordedAt: new Date().toISOString() }
    // Replacing even just an exception decision requires a new review/approval.
    for (const phase of PHASES.slice(2)) {
      if (phase === 'reviewer' && state.phases[phase].status === 'running') continue
      const { durationMs, attempts } = state.phases[phase]
      state.phases[phase] = { status: 'pending', durationMs, attempts }
    }
    state.archiveApproval = undefined
    saveState(state)
    return state
  })
}
export function checkArchive(contextInput: unknown): PipelineState {
  const context = validatePipelineContext(contextInput)
  return locked(context, () => {
  const state = readState(context)
  if (state.phases.reviewer.status !== 'done') fail('Review must complete before archive')
  const verification = inspectReceipt(state)
  if (!verification.valid) fail('Archive blocked: ' + verification.reasons.join('; '))
  if (state.phases.reviewer.candidateHash !== fingerprintCandidate(state)) fail('Review does not describe the current candidate')
  if (state.phases.reviewer.artifactHash !== artifactFingerprint(state)) fail('Review artifacts changed after review')
  designGate(state)
  if (state.phases.architect.artifactHash !== artifactFingerprint(state)) fail('Architecture artifacts changed after design approval')
  taskGate(state)
  confidenceGate(state)
  acceptanceGate(state)
  state.archiveApproval = { candidateHash: fingerprintCandidate(state), artifactHash: artifactFingerprint(state), confidenceHash: digest(readFileSync(path.join(activeArtifactPath(state), 'confidence-score.json'))), acceptanceHash: digest(canonical(state.acceptance)) }
  saveState(state)
  return state
  })
}
export function transitionPipeline(contextInput: unknown, phase: PipelinePhase, status: PhaseStatus, reason?: string): PipelineState {
  const context = validatePipelineContext(contextInput)
  if (!PHASES.includes(phase) || !['running', 'done', 'blocked', 'failed', 'skipped'].includes(status)) fail('Invalid phase transition')
  return locked(context, () => {
    const state = readState(context)
    if ((status === 'blocked' || status === 'failed') && !reason?.trim()) fail('Blocked and failed phases require a reason')
    if (status === 'skipped' && !((phase === 'ship' || phase === 'ci') && context.ownership.git === 'host')) fail('Only host-owned shipping/CI can be skipped')
    if ((phase === 'ship' || phase === 'ci') && context.ownership.git === 'host' && status !== 'skipped') fail('Host owns delivery; Core cannot ship or monitor its CI')
    if (status === 'running' || status === 'done') {
      const before = PHASES.slice(0, PHASES.indexOf(phase))
      if (before.some((p) => !['done', 'skipped'].includes(state.phases[p].status))) fail('A required earlier phase is incomplete')
    }
    const previous = state.phases[phase]
    const now = new Date().toISOString()
    const timing = { attempts: previous.attempts ?? 0, durationMs: previous.durationMs ?? 0 }
    if (previous.status === 'running' && previous.startedAt) timing.durationMs += Math.max(0, Date.parse(now) - Date.parse(previous.startedAt))
    if (status === 'running' && previous.status !== 'running') timing.attempts += 1
    if (status === 'done') {
      if (phase === 'architect') {
        const root = activeArtifactPath(state)
        designGate(state)
        const specsDir = path.join(root, 'specs')
        if (existsSync(specsDir)) {
          for (const item of readdirSync(specsDir, { withFileTypes: true })) {
            if (item.isDirectory() && slug.test(item.name)) state.artifactExclusions.push('openspec/specs/' + item.name)
          }
        }
      }
      if (phase === 'developer' || phase === 'reviewer') {
        designGate(state)
        if (state.phases.architect.artifactHash !== artifactFingerprint(state)) fail('Architecture artifacts changed after design approval')
        taskGate(state)
        const verification = inspectReceipt(state)
        if (!verification.valid) fail('Fresh full verification required: ' + verification.reasons.join('; '))
      }
      if (phase === 'reviewer') { confidenceGate(state); acceptanceGate(state) }
      if (phase === 'archive') {
        const archiveRoot = path.join(context.artifactRoot, 'openspec', 'changes', 'archive')
        const candidates = existsSync(archiveRoot) ? readdirSync(archiveRoot).filter((name) => name.endsWith('-' + state.change)) : []
        if (existsSync(activeArtifactPath(state)) || candidates.length !== 1) fail('Archive location must be unambiguous and active change moved')
        state.archivePath = path.join(archiveRoot, candidates[0]!)
        state.artifactExclusions.push(relativeUnix(path.relative(context.artifactRoot, state.archivePath)))
        taskGate(state)
        confidenceGate(state)
        const approval = state.archiveApproval
        if (!approval || approval.acceptanceHash !== digest(canonical(state.acceptance)) || approval.candidateHash !== fingerprintCandidate(state) || approval.artifactHash !== artifactFingerprint(state) || approval.confidenceHash !== digest(readFileSync(path.join(activeArtifactPath(state), 'confidence-score.json')))) fail('Archive was not authorized for this exact reviewed candidate')
      }
      state.phases[phase] = { ...timing, status, candidateHash: fingerprintCandidate(state), artifactHash: artifactFingerprint(state), completedAt: new Date().toISOString() }
    } else {
      state.phases[phase] = { ...timing, status, ...(status === 'running' ? { startedAt: now } : {}), ...(reason ? { reason } : {}) }
      if (status === 'running') for (const later of PHASES.slice(PHASES.indexOf(phase) + 1)) state.phases[later] = { status: 'pending' }
    }
    saveState(state)
    return state
  })
}
export function inspectPipeline(contextInput: unknown): {
  schemaVersion: 1; runId: string; change: string; context: PipelineContext; stateDir: string
  resumePhase: PipelinePhase | null; phases: PipelineState['phases']; verification: ReturnType<typeof inspectReceipt>
  acceptance: ReturnType<typeof inspectAcceptance>; completion: PipelineCompletion; planHash?: string; candidateHash: string
} {
  const context = validatePipelineContext(contextInput)
  const state = readState(context)
  const candidate = fingerprintCandidate(state)
  const verification = inspectReceipt(state)
  let resumePhase: PipelinePhase | null = null
  for (const phase of PHASES) {
    const record = state.phases[phase]
    if (record.status === 'skipped') continue
    if (record.status !== 'done') { resumePhase = phase; break }
    if (phase === 'architect' && record.artifactHash !== artifactFingerprint(state)) { resumePhase = phase; break }
    if ((phase === 'developer' || phase === 'reviewer') && record.candidateHash !== candidate) {
      if (phase === 'developer' && state.phases.reviewer.status === 'done' && state.phases.reviewer.candidateHash === candidate) continue
      resumePhase = phase === 'developer' ? 'reviewer' : phase; break
    }
  }
  if (!verification.valid && state.phases.developer.status === 'done' && (resumePhase === null || ['archive', 'ship', 'ci'].includes(resumePhase))) resumePhase = 'reviewer'
  const acceptance = inspectAcceptance(state)
  if (!acceptance.valid && state.phases.reviewer.status === 'done' && (resumePhase === null || ['archive', 'ship', 'ci'].includes(resumePhase))) resumePhase = 'reviewer'
  const reviewed = state.phases.reviewer.status === 'done'
  const completion: PipelineCompletion = {
    implementation: state.phases.developer.status === 'done' && state.phases.architect.artifactHash === artifactFingerprint(state)
      && (state.phases.developer.candidateHash === candidate || (reviewed && state.phases.reviewer.candidateHash === candidate)) ? 'complete' : 'incomplete',
    validation: !verification.valid ? 'blocked' : !reviewed ? 'pending' : acceptance.status,
    archive: state.phases.archive.status,
    delivery: context.ownership.git === 'host' ? 'pending-host' : state.phases.ship.status === 'done' && state.phases.ci.status === 'done' ? 'complete' : 'pending',
    reasons: [...verification.reasons, ...acceptance.reasons],
  }
  return { schemaVersion: 1, runId: context.runId, change: state.change, context, stateDir: pipelineStateDirectory(context), planHash: state.verificationPlan?.hash, candidateHash: fingerprintCandidate(state), resumePhase, phases: state.phases, verification, acceptance, completion }
}
function validateCommand(context: PipelineContext, raw: unknown): VerificationCommand & { cwd: string } {
  const command = object(raw)
  const repo = context.repositories.find((item) => item.id === command.repositoryId)
  if (!repo || typeof command.command !== 'string' || !command.command || command.command.includes('\0') || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) fail('Invalid verification command')
  const cwd = command.cwd === undefined ? repo.path : directory(path.resolve(repo.path, String(command.cwd)))
  if (!within(repo.path, cwd)) fail('Verification cwd escapes selected repository')
  const env = command.env === undefined ? undefined : object(command.env)
  if (env && Object.values(env).some((value) => typeof value !== 'string' || value.includes('\0'))) fail('Invalid verification environment')
  const timeoutMs = command.timeoutMs === undefined ? 15 * 60_000 : Number(command.timeoutMs)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 * 60 * 60_000) fail('Invalid verification timeout')
  if (command.policy !== undefined) {
    const policy = object(command.policy)
    if (Object.keys(policy).some(key => !['reuse', 'inputs', 'deterministic', 'readOnly', 'toolchainInputs', 'independentGroup', 'resources'].includes(key))) fail('Invalid verification policy')
    if (policy.reuse !== undefined && !['never', 'snapshot-local'].includes(String(policy.reuse))) fail('Invalid verification reuse policy')
    for (const key of ['deterministic', 'readOnly']) if (policy[key] !== undefined && typeof policy[key] !== 'boolean') fail('Invalid verification policy flag')
    if (policy.independentGroup !== undefined && (typeof policy.independentGroup !== 'string' || !ID.test(policy.independentGroup))) fail('Invalid verification independence group')
    for (const key of ['inputs', 'toolchainInputs', 'resources']) if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].length > 256 || policy[key].some((value: unknown) => typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')))) fail('Invalid verification policy inputs')
  }
  if (command.key !== undefined && (typeof command.key !== 'string' || !ID.test(command.key))) fail('Invalid verification key')
  if (command.label !== undefined && (typeof command.label !== 'string' || !command.label.trim() || command.label.length > 256 || command.label.includes('\0'))) fail('Invalid verification label')
  return { ...(command.key === undefined ? {} : { key: command.key as string }), ...(command.label === undefined ? {} : { label: command.label as string }), ...(command.policy === undefined ? {} : { policy: command.policy as HostCheckPolicy }), repositoryId: repo.id, command: command.command, args: command.args as string[], cwd, ...(env ? { env: env as Record<string, string> } : {}), timeoutMs }
}
/**
 * Native executables retain structured argv; Windows script shims need cmd.
 * This runtime is copied as one standalone module into .specrails/runtime,
 * without installer util/exec. Keep this builtins-only equivalent local rather
 * than importing a helper absent from installed projects. Like runCommand, it
 * handles Windows shims; unlike a shell string it refuses ambiguous arguments.
 */
export function verificationInvocation(command: string, args: string[], cwd: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== 'win32') return { command, args }
  let resolved = command
  if (!/\.(cmd|bat|exe|com)$/i.test(command)) {
    const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    const bases = /[\\/]/.test(command) ? [path.win32.resolve(cwd, command)] : [path.win32.join(cwd, command), ...pathValue.split(';').map((dir) => path.win32.join(dir, command))]
    for (const base of bases) {
      const candidate = extensions.map((extension) => base + extension.toLowerCase()).find((file) => existsSync(file))
      if (candidate) { resolved = candidate; break }
    }
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args }
  // cmd performs a second parse, including environment expansion. Rather than
  // silently reinterpret a structured argument, reject ambiguous script input.
  // Call node/python/the native tool executable directly for these arguments.
  if ([resolved, ...args].some((value) => /[\r\n"%!^&|<>]/.test(value))) fail('Windows script-shim arguments contain cmd syntax; invoke the underlying executable with structured argv instead')
  const quote = (value: string): string => '"' + value + '"'
  return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', '"' + [resolved, ...args].map(quote).join(' ') + '"'], windowsVerbatimArguments: true }
}

/** Shared persisted-output/provider diagnostic redaction; preserves line structure. */
export function redactRuntimeText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const [key, value] of Object.entries(env)) if (/(token|secret|password|api_?key|credential)/i.test(key) && value && value.length >= 4) text = text.split(value).join('[redacted]')
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|(?:access[_-]?)?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '[url]' } })
}

async function executeCheck(command: VerificationCommand & { cwd: string }, log: (text: string) => void, signal?: AbortSignal, deadline?: number, evidenceId = digest(randomUUID())): Promise<CommandReceipt> {
  const started = Date.now()
  const overrides = normalizeVerificationEnvironment(command.env ?? {}) as Record<string, string>
  const overrideKeys = Object.keys(overrides).sort()
  const keys = verificationEnvironmentKeys(process.env, overrideKeys)
  const hash = environmentHash(keys)
  const overridesHash = digest(canonical(overrides))
  const env = verificationEnvironment(process.env, overrides)
  const configuredTimeoutMs = command.timeoutMs ?? 15 * 60_000
  const appliedTimeoutMs = Math.max(0, Math.min(configuredTimeoutMs, deadline === undefined ? Infinity : deadline - Date.now()))
  let outcome: CommandReceipt['outcome']
  let output = ''
  const streams = { stdout: '', stderr: '' }
  let outputTruncated = false
  const redact = (text: string) => redactRuntimeText(text, { ...process.env, ...overrides })
  let exitCode = -1
  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    let stopping = false
    let termination: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number): void => { if (done) return; done = true; exitCode = stopping ? -1 : code; outcome ??= code === 0 ? 'passed' : 'failed'; if (termination) clearTimeout(termination); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve() }
    const stop = (reason: string): void => {
      if (done || stopping) return
      stopping = true
      output = (output + '\n' + reason).slice(-32_000)
      if (child?.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
      }
      // Never publish a receipt while a normally terminating child is alive.
      if (!child?.pid) finish(-1)
      else termination = setTimeout(() => { outcome = 'interrupted'; child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(-1) }, 5000)
    }
    const abort = (): void => { outcome = 'cancelled'; stop('Verification command cancelled') }
    if (signal?.aborted) { abort(); return }
    if (appliedTimeoutMs <= 0) { outcome = 'timed-out'; stop('Workflow verification deadline exhausted'); return }
    try {
      const invocation = verificationInvocation(command.command, command.args, command.cwd, process.platform, env)
      child = spawn(invocation.command, invocation.args, { windowsVerbatimArguments: invocation.windowsVerbatimArguments, cwd: command.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) { output = String(error); finish(-1); return }
    for (const stream of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8')
      let liveLine = '', droppingLine = false
      const receive = (text: string): void => {
        const remaining = 1024 * 1024 - Buffer.byteLength(streams[stream])
        if (Buffer.byteLength(text) > remaining) outputTruncated = true
        if (remaining > 0) {
          let kept = text.slice(0, remaining)
          while (Buffer.byteLength(kept) > remaining || /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
          streams[stream] += kept
        }
        output = (output + text).slice(-32_000)
        // Redact whole bounded lines, so chunk boundaries cannot split credentials.
        for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
          if (!droppingLine) liveLine += part
          if (liveLine.length > 16384) { liveLine = ''; droppingLine = true }
          if (part.endsWith('\n')) {
            try { log(droppingLine ? '[Long output line omitted; inspect bounded evidence]\n' : redact(liveLine)) } catch { /* observer */ }
            liveLine = ''; droppingLine = false
          }
        }
      }
      child[stream]?.on('data', (chunk: Buffer) => receive(decoder.write(chunk)))
      child[stream]?.on('end', () => { receive(decoder.end()); if (liveLine) { try { log(redact(liveLine)) } catch { /* observer */ } } })
    }
    child.on('error', (error) => { output = (output + error.message).slice(-32_000); if (!child.pid) finish(-1) })
    child.on('close', (code) => finish(code ?? -1))
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { outcome = 'timed-out'; stop('Verification command timed out') }, appliedTimeoutMs)
    if (signal?.aborted) abort()
  })
  const persisted = (text: string): string => {
    const bytes = Buffer.from(redact(text))
    if (bytes.length > 1024 * 1024) outputTruncated = true
    return new StringDecoder('utf8').write(bytes.subarray(0, 1024 * 1024))
  }
  return { evidenceId, stdout: persisted(streams.stdout), stderr: persisted(streams.stderr), outputTruncated, ...(command.key ? { key: command.key } : {}), ...(command.label ? { label: command.label } : {}), configuredTimeoutMs, appliedTimeoutMs, ...(deadline === undefined ? {} : { deadline }), outcome, repositoryId: command.repositoryId, command: command.command, args: command.args, cwd: command.cwd, environmentPolicy: 'isolated-transport-v1', environmentHash: hash, environmentKeys: keys, environmentOverrideKeys: overrideKeys, environmentOverridesHash: overridesHash, exitCode, durationMs: Date.now() - started, output: redact(output) }
}
export interface VerificationSnapshot { eligible: boolean; reason: string; inputHash?: string; toolchainHash?: string }
/** Host opt-in is a declaration of determinism, not inferred hermeticity. */
export function verificationSnapshot(context: PipelineContext, command: VerificationCommand): VerificationSnapshot {
  const policy = command.policy
  if (policy?.reuse !== 'snapshot-local') return { eligible: false, reason: 'reuse-never' }
  if (policy.resources?.length) return { eligible: false, reason: 'reuse-ineligible-external-resources' }
  if (!policy.deterministic || !policy.readOnly || !policy.inputs?.length || !policy.toolchainInputs?.length) return { eligible: false, reason: 'reuse-ineligible-incomplete-declaration' }
  const repository = context.repositories.find(repo => repo.id === command.repositoryId)
  if (!repository || !path.isAbsolute(command.command)) return { eligible: false, reason: 'reuse-ineligible-executable-identity' }
  try {
    let count = 0, total = 0
    const inventory = (inputs: string[], tools: boolean): Array<[string, string]> => {
      const entries: Array<[string, string]> = []
      const seen = new Set<string>()
      const visit = (file: string): void => {
        if (seen.has(file)) return
        seen.add(file)
        if (++count > 10000) fail('reuse-ineligible-inventory-limit')
        const stat = lstatSync(file)
        if (stat.isSymbolicLink() || realpathSync(file) !== path.resolve(file)) fail('reuse-ineligible-symlink')
        if (stat.isDirectory()) {
          entries.push([file, 'directory'])
          for (const name of readdirSync(file).sort()) visit(path.join(file, name))
        } else if (stat.isFile()) {
          total += stat.size
          if (total > 256 * 1024 * 1024 || stat.size > 128 * 1024 * 1024) fail('reuse-ineligible-inventory-limit')
          entries.push([file, digest(readFileSync(file)) + ':' + stat.mode])
        } else fail('reuse-ineligible-nonfile-input')
      }
      for (const input of inputs) {
        const file = path.resolve(repository.path, input)
        if (!tools && !within(repository.path, file)) fail('reuse-ineligible-input-scope')
        visit(file)
      }
      return entries.sort(([left], [right]) => left.localeCompare(right))
    }
    const inputs = inventory(policy.inputs, false)
    const tools = inventory(policy.toolchainInputs, true)
    if (!tools.some(([file]) => file === path.resolve(command.command))) return { eligible: false, reason: 'reuse-ineligible-executable-not-declared' }
    // A lockfile alone cannot certify ignored dependency contents. Host manifests
    // must include each installed dependency directory this convention exposes.
    for (const directory of ['node_modules', '.venv', 'venv', 'vendor']) {
      const file = path.join(repository.path, directory)
      if (existsSync(file) && ![...inputs, ...tools].some(([item]) => item === file)) return { eligible: false, reason: 'reuse-ineligible-dependencies-not-declared' }
    }
    return { eligible: true, reason: 'snapshot-local-host-declaration', inputHash: digest(canonical(inputs)), toolchainHash: digest(canonical(tools)) }
  } catch (error) { return { eligible: false, reason: error instanceof Error && error.message.startsWith('reuse-ineligible-') ? error.message : 'reuse-ineligible-input-unavailable' } }
}

/** Contiguous waves preserve baseline order; an uncertain check is a barrier. */
export function verificationWaves<T extends VerificationCommand>(commands: T[], maxConcurrency = 1): T[][] {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) fail('Verification concurrency must be 1–4')
  const waves: T[][] = []
  let current: T[] = []
  for (const command of commands) {
    const policy = command.policy
    const independent = Boolean(policy?.independentGroup && policy.resources !== undefined)
    const fits = independent && current.length < maxConcurrency && current.every(previous => previous.repositoryId !== command.repositoryId && previous.policy?.independentGroup === policy!.independentGroup && previous.policy?.resources !== undefined && !previous.policy.resources.some(resource => policy!.resources!.includes(resource)))
    if (!fits && current.length) { waves.push(current); current = [] }
    current.push(command)
    if (!independent || current.length === maxConcurrency) { waves.push(current); current = [] }
  }
  if (current.length) waves.push(current)
  return waves
}
export async function verifyPipeline(contextInput: unknown, raw: unknown, log: (text: string) => void = () => {}, signal?: AbortSignal, options: { deadline?: number; maxConcurrency?: number; onEvidence?: (kind: 'check-started' | 'check-finished' | 'check-reused' | 'check-invalidated', payload: Record<string, string | number | null>) => Promise<void> } = {}): Promise<VerificationReceipt> {
  const context = validatePipelineContext(contextInput)
  const { request, commands, unverifiedRepositories } = verificationPlan(context, raw)
  let previous: VerificationReceipt | undefined
  const state = locked(context, () => {
    const current = readState(context)
    const problems = planReasons(current, typeof request.planHash === 'string' ? request.planHash : undefined)
    if (problems.length) fail(problems.join('; '))
    previous = current.verification
    if (current.verification) current.verification = { ...current.verification, valid: false, reason: 'Verification started; previous receipt is no longer current' }
    current.acceptance = undefined
    current.archiveApproval = undefined
    saveState(current)
    return current
  })
  const identityProblems = planReasons(state, typeof request.planHash === 'string' ? request.planHash : undefined)
  if (identityProblems.length) fail(identityProblems.join('; '))
  const candidateHash = fingerprintCandidate(state)
  const results: CommandReceipt[] = []
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    for (const wave of verificationWaves(commands, options.maxConcurrency)) {
      if (controller.signal.aborted) break
      const settled = await Promise.allSettled(wave.map(async command => {
        try {
        const prefix = `[verification ${command.repositoryId}/${command.label ?? command.key ?? command.command}] `
        const snapshot = verificationSnapshot(context, command)
        const old = previous?.valid && previous.kind === 'full' && previous.planHash === request.planHash && previous.candidateHash === candidateHash ? previous.commands.find(item => item.key === command.key && command.key !== undefined) : undefined
        const reuse = snapshot.eligible && old?.snapshot?.eligible && old.exitCode === 0 && old.checkDefinitionHash === digest(canonical(command)) && old.snapshot.inputHash === snapshot.inputHash && old.snapshot.toolchainHash === snapshot.toolchainHash && old.environmentHash === environmentHash(verificationEnvironmentKeys(process.env, old.environmentOverrideKeys)) && old.environmentOverridesHash === digest(canonical(normalizeVerificationEnvironment(command.env ?? {})))
        const evidenceId = digest(randomUUID())
        if (!reuse) {
          const pending: CommandReceipt = { repositoryId: command.repositoryId, key: command.key, label: command.label, command: command.command, args: command.args, cwd: command.cwd, environmentHash: '', environmentKeys: [], environmentOverrideKeys: [], environmentOverridesHash: '', evidenceId, pending: true, disposition: 'executed', outcome: 'interrupted', exitCode: -1, durationMs: 0, output: '' }
          persistCheckEvidence(context, pending, (request.planHash as string | undefined) ?? digest(canonical(commands)), candidateHash)
          await options.onEvidence?.('check-started', { executionId: evidenceId, repositoryId: command.repositoryId, checkId: command.key ?? '', label: command.label ?? command.command })
        }
        const result: CommandReceipt = reuse ? { ...old, evidenceId, disposition: 'reused', reusedFrom: old.evidenceId, durationMs: 0, snapshot, reuseReason: 'snapshot-local-identities-match' } : { ...await executeCheck(command, text => log(prefix + text), controller.signal, options.deadline, evidenceId), disposition: 'executed', snapshot, reuseReason: snapshot.eligible ? 'snapshot-local-no-current-match' : snapshot.reason }
        const { env: _env, ...definition } = command
        result.checkDefinition = definition
        result.checkDefinitionHash = digest(canonical(command))
        const after = verificationSnapshot(context, command)
        if (snapshot.eligible && (!after.eligible || after.inputHash !== snapshot.inputHash || after.toolchainHash !== snapshot.toolchainHash)) { result.exitCode = -1; result.outcome = 'failed'; result.reuseReason = 'snapshot-inputs-changed-during-verification' }
        if (result.exitCode !== 0) controller.abort()
        persistCheckEvidence(context, result, (request.planHash as string | undefined) ?? digest(canonical(commands)), candidateHash)
        await options.onEvidence?.(reuse ? 'check-reused' : 'check-finished', { executionId: evidenceId, repositoryId: command.repositoryId, checkId: command.key ?? '', label: command.label ?? command.command, exitCode: result.exitCode, durationMs: result.durationMs, reason: result.reuseReason ?? null })
        return result
        } catch (error) { controller.abort(); throw error }
      }))
      for (const result of settled) {
        if (result.status === 'fulfilled') results.push(result.value)
        else controller.abort()
      }
      const rejected = settled.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      if (results.some(result => result.exitCode !== 0)) break
    }
  } finally { signal?.removeEventListener('abort', abort) }
  const notRunEvidenceIds: string[] = []
  for (const command of commands.slice(results.length)) {
    const id = digest(randomUUID())
    const skipped: CommandReceipt = { repositoryId: command.repositoryId, key: command.key, label: command.label, command: command.command, args: command.args, cwd: command.cwd, environmentHash: '', environmentKeys: [], environmentOverrideKeys: [], environmentOverridesHash: '', evidenceId: id, disposition: 'not-run', outcome: 'cancelled', exitCode: -1, durationMs: 0, output: 'Not run after cancellation or an earlier failed check' }
    persistCheckEvidence(context, skipped, (request.planHash as string | undefined) ?? digest(canonical(commands)), candidateHash)
    notRunEvidenceIds.push(id)
  }
  const receipt = locked(context, () => {
    const current = readState(context)
    const changed = fingerprintCandidate(current) !== candidateHash || current.revision !== state.revision || planReasons(current, request.planHash as string | undefined).length > 0
    const receipt: VerificationReceipt = {
      id: randomUUID(), ...(state.verificationPlan ? { planHash: state.verificationPlan.hash } : {}), kind: request.kind as 'full' | 'scoped', scopeHash: state.scopeHash, candidateHash, commands: results, ...(notRunEvidenceIds.length ? { notRunEvidenceIds } : {}),
      completedAt: new Date().toISOString(), valid: !changed && !signal?.aborted && (options.deadline === undefined || Date.now() <= options.deadline) && results.length === commands.length && results.every((result) => result.exitCode === 0),
      ...(changed ? { reason: 'Candidate changed during verification' } : results.some((result) => result.exitCode !== 0) ? { reason: 'A verification command failed' } : {}),
      ...(unverifiedRepositories.length ? { unverifiedRepositories } : {}),
    }
    atomicJson(safeChild(pipelineStateDirectory(context), 'receipts/' + receipt.id + '.json'), receipt)
    if (receipt.kind === 'full' || !receipt.valid || !current.verification) current.verification = receipt
    else if (previous?.valid && previous.candidateHash === candidateHash) current.verification = previous
    saveState(current)
    return receipt
  })
  if (!receipt.valid) for (const result of results) {
    await options.onEvidence?.('check-invalidated', { executionId: result.evidenceId ?? '', repositoryId: result.repositoryId, checkId: result.key ?? '', label: result.label ?? result.command, reason: receipt.reason ?? 'Verification did not complete successfully' })
  }
  return receipt
}
function verificationPlan(context: PipelineContext, raw: unknown) {
  const request = object(raw)
  if (request.planHash !== undefined && (typeof request.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.planHash))) fail('Invalid verification plan hash')
  const unverified = request.unverified === true
  if (request.unverified !== undefined && typeof request.unverified !== 'boolean') fail('Verification unverified flag must be boolean')
  if (!['full', 'scoped'].includes(String(request.kind)) || !Array.isArray(request.commands) || (request.commands.length === 0 && !unverified) || request.commands.length > 100) fail('Verification requires bounded structured commands')
  const commands = request.commands.map((command) => validateCommand(context, command))
  const unverifiedRepositories = context.repositories.filter((repo) => !commands.some((command) => command.repositoryId === repo.id)).map((repo) => repo.id)
  if (request.kind === 'full' && !unverified && unverifiedRepositories.length) fail('Full verification must cover every selected repository')
  return { request, commands, unverifiedRepositories: request.kind === 'full' && unverified ? unverifiedRepositories : [] }
}
/** Validate a check plan without creating state or executing commands. */
export function validateVerificationRequest(contextInput: unknown, raw: unknown): void {
  verificationPlan(validatePipelineContext(contextInput), raw)
}
export function preparePreview(contextInput: unknown, raw: unknown): PipelineState {
  const context = validatePipelineContext(contextInput)
  const request = object(raw)
  if (!Array.isArray(request.files) || request.files.length === 0) fail('Preview needs explicit files')
  const inputFiles = request.files
  return locked(context, () => {
    const state = readState(context)
    const files = inputFiles.map((item: unknown, index: number): PreviewFile => {
      const input = object(item)
      const repo = context.repositories.find((entry) => entry.id === input.repositoryId)
      if (!repo || typeof input.path !== 'string' || !['write', 'delete'].includes(String(input.operation))) fail('Invalid preview file')
      const target = safeChild(repo.path, input.path)
      if (excluded(state, repo, relativeUnix(path.relative(repo.path, target)))) fail('Preview cannot overwrite runtime or lifecycle artifacts')
      if (input.operation === 'delete') return { repositoryId: repo.id, path: relativeUnix(path.relative(repo.path, target)), operation: 'delete' }
      if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) fail('Preview sourcePath must be absolute')
      const source = realpathSync(input.sourcePath)
      if (![context.backlogRoot, ...context.repositories.map((entry) => entry.path)].some((root) => within(root, source))) fail('Preview source is outside execution scope')
      const bytes = readFileSync(source)
      const cached = safeChild(pipelineStateDirectory(context), 'preview/' + String(index))
      mkdirSync(path.dirname(cached), { recursive: true, mode: 0o700 })
      writeFileSync(cached, bytes, { mode: 0o600 })
      return { repositoryId: repo.id, path: relativeUnix(path.relative(repo.path, target)), operation: 'write', sourcePath: cached, contentHash: digest(bytes) }
    })
    if (new Set(files.map((file) => file.repositoryId + ':' + file.path)).size !== files.length) fail('Duplicate preview target')
    state.preview = { baseHash: fingerprintCandidate(state), files, createdAt: new Date().toISOString() }
    saveState(state)
    return state
  })
}
export async function applyPreview(contextInput: unknown, verificationRequest: unknown, log: (text: string) => void = () => {}): Promise<VerificationReceipt> {
  const context = validatePipelineContext(contextInput)
  verificationPlan(context, verificationRequest)
  locked(context, () => {
    const state = readState(context)
    if (!state.preview || fingerprintCandidate(state) !== state.preview.baseHash) fail('Preview base changed; create a new preview instead of overwriting work')
    const operations = state.preview.files.map((file) => {
      const repo = context.repositories.find((entry) => entry.id === file.repositoryId)!
      const target = safeChild(repo.path, file.path)
      if (file.operation === 'write' && (!file.sourcePath || !within(path.join(pipelineStateDirectory(context), 'preview'), realpathSync(file.sourcePath)))) fail('Preview cache path escapes its owned directory')
      const content = file.operation === 'write' ? readFileSync(file.sourcePath!) : null
      if (content && digest(content) !== file.contentHash) fail('Preview content changed')
      return { target, content, before: existsSync(target) ? readFileSync(target) : null }
    })
    const applied: typeof operations = []
    try {
      for (const operation of operations) {
        mkdirSync(path.dirname(operation.target), { recursive: true })
        if (operation.content) writeFileSync(operation.target, operation.content)
        else rmSync(operation.target)
        applied.push(operation)
      }
    } catch (error) {
      for (const operation of applied.reverse()) {
        if (operation.before) writeFileSync(operation.target, operation.before)
        else rmSync(operation.target, { force: true })
      }
      throw error
    }
    state.verification = undefined
    for (const phase of PHASES.slice(1)) state.phases[phase] = { status: 'pending' }
    saveState(state)
  })
  // Applied files remain reviewable on failure; never ship based on preview's
  // unchanged baseline. The actual applied candidate owns this fresh receipt.
  return verifyPipeline(context, verificationRequest, log)
}
function parseArguments(argv: string[]): { operation: string; flags: Record<string, string | boolean> } {
  const operation = argv[0] ?? 'status'
  const flags: Record<string, string | boolean> = {}
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) fail('Unexpected positional argument: ' + arg)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { flags[arg.slice(2)] = next; i++ }
    else flags[arg.slice(2)] = true
  }
  return { operation, flags }
}
function resolveContext(flags: Record<string, string | boolean>, operation: string): PipelineContext {
  const file = typeof flags.context === 'string' ? flags.context : process.env.SPECRAILS_EXECUTION_CONTEXT
  if (file) return validatePipelineContext(readJson(file))
  const cwd = realpathSync(process.cwd())
  const legacy = safeChild(cwd, '.specrails/pipeline-context.json')
  if (existsSync(legacy)) {
    const previous = validatePipelineContext(readJson(legacy))
    if (operation !== 'init') return previous
    if (existsSync(stateFile(previous)) && readState(previous).change === flags.change) return previous
  }
  if (operation !== 'init') fail('Initialize the pipeline or supply SPECRAILS_EXECUTION_CONTEXT')
  const repo = realpathSync(process.env.SPECRAILS_REPO_DIR ?? cwd)
  let scope: Record<string, unknown> = {}
  if (typeof flags['scope-request'] === 'string') scope = object(readJson(flags['scope-request']))
  const backlogPath = typeof flags['backlog-path'] === 'string' ? flags['backlog-path'] : path.join(cwd, '.specrails', 'local-tickets.json')
  let specs: unknown = scope.specs ?? []
  if (typeof flags.tickets === 'string') {
    if (scope.specs !== undefined) fail('Choose --tickets or --scope-request specs, not both')
    const ids = flags.tickets.split(',').map((id) => id.trim().replace(/^#/, '')).filter(Boolean)
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-zA-Z0-9._-]+$/.test(id))) fail('Invalid or duplicate ticket IDs')
    const tickets = object(object(readJson(backlogPath)).tickets)
    specs = ids.map((id) => {
      if (!tickets[id]) fail('Ticket not found in backlog: ' + id)
      const ticket = object(tickets[id])
      if (typeof ticket.title !== 'string') fail('Ticket title is missing: ' + id)
      return { id: ticket.id ?? id, title: ticket.title, description: ticket.description ?? '',
        ...(ticket.acceptanceCriteria ? { acceptanceCriteria: ticket.acceptanceCriteria } : {}),
        ...(ticket.repositoryIds ? { repositoryIds: ticket.repositoryIds } : {}) }
    })
  }
  const context = validatePipelineContext({
    schemaVersion: 1, runId: randomUUID(), backlogRoot: cwd, backlogPath, artifactRoot: repo, artifactRepositoryId: 'primary',
    repositories: [{ id: 'primary', name: path.basename(repo), path: repo }], specs,
    ownership: scope.ownership ?? { git: 'host', backlog: 'host', worktrees: 'host' },
  })
  atomicJson(legacy, context)
  return context
}
export async function runPipelineCommand(flags: Record<string, string | boolean>, positionals: string[]): Promise<number> {
  const operation = positionals[0] ?? 'status'
  const context = resolveContext(flags, operation)
  let result: unknown
  switch (operation) {
    case 'init': result = initializePipeline(context, String(flags.change ?? '')); break
    case 'status': result = inspectPipeline(context); break
    case 'phase': result = transitionPipeline(context, String(flags.phase) as PipelinePhase, String(flags.status) as PhaseStatus, typeof flags.reason === 'string' ? flags.reason : undefined); break
    case 'acceptance':
      if (typeof flags.request !== 'string') fail('Provide --request with acceptance evidence JSON')
      result = recordAcceptance(context, readJson(flags.request)); break
    case 'archive-check': result = checkArchive(context); break
    case 'verify':
    case 'apply-preview': {
      if (typeof flags.request !== 'string') fail('Provide --request with structured verification JSON')
      const request = readJson(flags.request)
      const receipt = operation === 'verify' ? await verifyPipeline(context, request, (text) => process.stderr.write(text)) : await applyPreview(context, request, (text) => process.stderr.write(text))
      console.log(JSON.stringify(receipt))
      return receipt.valid ? 0 : 1
    }
    case 'preview':
      if (typeof flags.request !== 'string') fail('Provide --request with preview file JSON')
      result = preparePreview(context, readJson(flags.request)); break
    default: fail('Unknown pipeline operation: ' + operation)
  }
  console.log(JSON.stringify(result))
  return 0
}
export async function runPipelineCli(argv: string[]): Promise<number> {
  try { const { operation, flags } = parseArguments(argv); return await runPipelineCommand(flags, [operation]) }
  catch (error) { console.error('Pipeline: ' + (error instanceof Error ? error.message : String(error))); return 1 }
}

export interface VerificationEvidenceQuery { id?: string; section?: 'summary' | 'stdout' | 'stderr' | 'source'; sourceId?: string; cursor?: string; limit?: number }
interface EvidenceSource { id: string; displayPath: string; byteCount: number; hash: string; text: string }
interface EvidenceDocument {
  schemaVersion: 1; runId: string; id: string; checkId: string; repositoryId: string; label: string
  origin: string[]; required: true; disposition: 'executed' | 'reused' | 'not-run'; reusedFrom?: string
  status: 'passed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'
  reuseReason?: string; recordedAt: string; execution: { command: string; args: string[]; cwd: string; configuredTimeoutMs: number | null; appliedTimeoutMs: number | null; deadline: number | null; outcome: string | null }; planHash: string; candidateHash: string; executionId: string; exitCode: number | null; durationMs: number | null; outputTruncated: boolean
  stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number
  stdoutHash: string; stderrHash: string; sources: EvidenceSource[]
}
function evidenceSummary(document: EvidenceDocument) {
  const { stdout: _out, stderr: _err, sources, ...summary } = document
  return { ...summary, sources: sources.map(({ text: _text, ...source }) => source) }
}
function persistCheckEvidence(context: PipelineContext, result: CommandReceipt, planHash: string, candidateHash: string): void {
  const id = result.evidenceId!
  const planPath = safeChild(pipelineStateDirectory(context), 'verification/plan.json')
  const plan = existsSync(planPath) ? object(readJson(planPath)) : undefined
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const item = entries.find(entry => object(entry).id === result.key) as { origins?: string[]; id: string; harness?: { hash: string; sources: Array<{ path: string; hash: string }> } } | undefined
  const sources: EvidenceSource[] = []
  for (const source of item?.harness?.sources ?? []) {
    if (sources.length >= 8) fail('Too many evidence sources')
    const file = safeChild(pipelineStateDirectory(context), `verification/harnesses/${item!.id}/${item!.harness!.hash}/${source.path}`)
    if (lstatSync(file).size > 65536) fail('Evidence source exceeds size limit')
    const bytes = readFileSync(file)
    if (digest(bytes) !== source.hash) fail('Verification source changed during execution')
    sources.push({ id: digest(id + '\0' + source.path), displayPath: source.path, hash: source.hash, byteCount: bytes.length, text: bytes.toString('utf8') })
  }
  const stdout = result.stdout ?? '', stderr = result.stderr ?? ''
  const document: EvidenceDocument = {
    schemaVersion: 1, runId: context.runId, id, executionId: id, checkId: result.key ?? digest(canonical([result.repositoryId, result.command, result.args])), repositoryId: result.repositoryId,
    label: result.label ?? result.command, origin: item?.origins ?? ['host'], required: true, disposition: result.disposition ?? 'executed', ...(result.reusedFrom ? { reusedFrom: result.reusedFrom } : {}),
    status: result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'interrupted' ? 'interrupted' : result.exitCode === 0 ? 'passed' : 'failed',
    ...(result.reuseReason === undefined ? {} : { reuseReason: result.reuseReason }), recordedAt: new Date().toISOString(),
    execution: { command: redactRuntimeText(result.command), args: result.args.map(arg => redactRuntimeText(arg)), cwd: result.cwd, configuredTimeoutMs: result.configuredTimeoutMs ?? null, appliedTimeoutMs: result.appliedTimeoutMs ?? null, deadline: result.deadline ?? null, outcome: result.outcome ?? null },
    planHash, candidateHash, exitCode: result.pending ? null : result.exitCode, durationMs: result.pending ? null : result.durationMs, outputTruncated: result.outputTruncated ?? false,
    stdout, stderr, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutHash: digest(stdout), stderrHash: digest(stderr), sources,
  }
  atomicJson(safeChild(pipelineStateDirectory(context), 'verification/evidence/' + id + '.json'), { document, integrity: digest(canonical(document)) })
  const summary = evidenceSummary(document)
  atomicJson(safeChild(pipelineStateDirectory(context), 'verification/evidence-index/' + id + '.json'), { summary, integrity: digest(canonical(summary)) })
  // Receipt/status payloads carry references and short tails only.
  delete result.stdout; delete result.stderr
}
/** Historical read: no live repository validation, source execution or lifecycle mutation. */
export function readVerificationEvidence(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>, query: VerificationEvidenceQuery = {}) {
  if (!ID.test(context.runId) || !path.isAbsolute(context.backlogRoot)) fail('Invalid evidence scope')
  if (Object.keys(query).some(key => !['id', 'section', 'sourceId', 'cursor', 'limit'].includes(key))) fail('Invalid evidence query')
  const section = query.section ?? 'summary', limit = query.limit ?? 25
  if (!['summary', 'stdout', 'stderr', 'source'].includes(section) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Invalid evidence section or limit')
  if ((section === 'source') !== (query.sourceId !== undefined) || (!query.id && section !== 'summary')) fail('Source section requires a registered source ID and evidence ID')
  for (const value of [query.id, query.sourceId]) if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) fail('Invalid opaque evidence ID')
  const directory = safeChild(context.backlogRoot, '.specrails/pipeline/' + context.runId + '/verification/evidence')
  const binding = digest(canonical({ runId: context.runId, id: query.id ?? null, section, sourceId: query.sourceId ?? null }))
  let offset = 0
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 1024) fail('Invalid evidence cursor')
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) fail('Invalid evidence cursor')
      offset = cursor.offset
    } catch { fail('Invalid evidence cursor') }
  }
  const cursor = (next: number) => Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url')
  const load = (id: string): EvidenceDocument => {
    const file = safeChild(directory, id + '.json')
    if (lstatSync(file).size > 16 * 1024 * 1024) fail('Evidence exceeds size limit')
    const envelope = object(readJson(file)), document = envelope.document as EvidenceDocument
    if (!document || document.schemaVersion !== 1 || document.runId !== context.runId || document.id !== id || digest(canonical(document)) !== envelope.integrity) fail('Evidence integrity check failed')
    return document
  }
  if (!existsSync(directory) || (query.id && !existsSync(safeChild(directory, query.id + '.json')))) return { schemaVersion: 1, available: false, items: [], truncated: false }
  if (!query.id) {
    const indexDirectory = safeChild(context.backlogRoot, '.specrails/pipeline/' + context.runId + '/verification/evidence-index')
    if (!existsSync(indexDirectory)) return { schemaVersion: 1, available: false, items: [], truncated: false }
    const ids = readdirSync(indexDirectory).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort()
    if (ids.length > 10000) fail('Evidence index exceeds limit')
    const selected = ids.slice(offset, offset + limit)
    return { schemaVersion: 1, available: true, items: selected.map(file => {
      const indexFile = safeChild(indexDirectory, file)
      if (lstatSync(indexFile).size > 65536) fail('Evidence summary exceeds limit')
      const index = object(readJson(indexFile)), summary = object(index.summary)
      if (summary.id !== file.slice(0, -5) || summary.runId !== context.runId || index.integrity !== digest(canonical(summary))) fail('Evidence index integrity check failed')
      return summary
    }), truncated: offset + selected.length < ids.length, ...(offset + selected.length < ids.length ? { nextCursor: cursor(offset + selected.length) } : {}) }
  }
  const document = load(query.id)
  if (section === 'summary') return { schemaVersion: 1, available: true, items: [evidenceSummary(document)], truncated: false }
  const source = section === 'source' ? document.sources.find(source => source.id === query.sourceId) : undefined
  if (section === 'source' && !source) fail('Source does not belong to this evidence')
  let outputDocument = document
  const visited = new Set([document.id])
  while (outputDocument.reusedFrom && section !== 'source') {
    if (visited.has(outputDocument.reusedFrom) || visited.size > 100) fail('Invalid reused evidence chain')
    visited.add(outputDocument.reusedFrom)
    outputDocument = load(outputDocument.reusedFrom)
  }
  const content = source?.text ?? (section === 'stdout' ? outputDocument.stdout : outputDocument.stderr)
  // Character offsets are opaque. Stop at code-point boundaries within 64 KiB.
  if (offset > content.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset] ?? ''))) fail('Invalid evidence text cursor')
  let text = '', bytes = 0
  for (const character of content.slice(offset)) {
    const size = Buffer.byteLength(character)
    if (bytes + size > 65536) break
    text += character; bytes += size
  }
  const next = offset + text.length
  return { schemaVersion: 1, available: true, text, byteCount: bytes, totalBytes: Buffer.byteLength(content), truncated: next < content.length || document.outputTruncated, ...(next < content.length ? { nextCursor: cursor(next) } : {}) }
}
