import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
export interface VerificationCommand {
  repositoryId: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}
export interface VerificationRequest { kind: 'full' | 'scoped'; commands: VerificationCommand[] }
export interface CommandReceipt {
  repositoryId: string; command: string; args: string[]; cwd: string
  environmentPolicy?: 'isolated-transport-v1'
  environmentHash: string; environmentKeys: string[]; environmentOverrideKeys: string[]; environmentOverridesHash: string
  exitCode: number; durationMs: number; output: string
}
export interface VerificationReceipt {
  id: string; kind: 'full' | 'scoped'; scopeHash: string; candidateHash: string
  commands: CommandReceipt[]; completedAt: string; valid: boolean; reason?: string
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
  scopeHash: string; candidateHash: string; artifactHash: string; recordedAt: string
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
export function fingerprintCandidate(state: PipelineState): string {
  const entries = state.context.repositories.map((repo) => ({
    id: repo.id, path: repo.path,
    files: trackedFiles(repo)
      .filter(({ file, tracked }) => !excluded(state, repo, relativeUnix(file)) && (tracked || !untrackedAgentMemory(relativeUnix(file))))
      .map(({ file }) => [relativeUnix(file), fileFingerprint(path.join(repo.path, file))]),
  }))
  return digest(canonical(entries))
}
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
function inspectReceipt(state: PipelineState, env = process.env): { valid: boolean; reasons: string[]; receipt?: VerificationReceipt } {
  const receipt = state.verification
  const reasons: string[] = []
  if (!receipt) return { valid: false, reasons: ['No verification receipt'] }
  if (!receipt.valid || receipt.kind !== 'full') reasons.push(receipt.reason ?? 'No successful full verification')
  if (receipt.scopeHash !== state.scopeHash) reasons.push('Spec scope changed')
  if (receipt.candidateHash !== fingerprintCandidate(state)) reasons.push('Candidate files changed')
  for (const command of receipt.commands) {
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
    state.acceptance = { ...report, scopeHash: state.scopeHash, candidateHash: fingerprintCandidate(state), artifactHash: artifactFingerprint(state), recordedAt: new Date().toISOString() }
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
  acceptance: ReturnType<typeof inspectAcceptance>; completion: PipelineCompletion
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
  return { schemaVersion: 1, runId: context.runId, change: state.change, context, stateDir: pipelineStateDirectory(context), resumePhase, phases: state.phases, verification, acceptance, completion }
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
  return { repositoryId: repo.id, command: command.command, args: command.args as string[], cwd, ...(env ? { env: env as Record<string, string> } : {}), timeoutMs }
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

async function executeCheck(command: VerificationCommand & { cwd: string }, log: (text: string) => void): Promise<CommandReceipt> {
  const started = Date.now()
  const overrides = normalizeVerificationEnvironment(command.env ?? {}) as Record<string, string>
  const overrideKeys = Object.keys(overrides).sort()
  const keys = verificationEnvironmentKeys(process.env, overrideKeys)
  const hash = environmentHash(keys)
  const overridesHash = digest(canonical(overrides))
  const env = verificationEnvironment(process.env, overrides)
  let output = ''
  let exitCode = -1
  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (code: number): void => { if (done) return; done = true; exitCode = code; if (timer) clearTimeout(timer); resolve() }
    try {
      const invocation = verificationInvocation(command.command, command.args, command.cwd, process.platform, env)
      child = spawn(invocation.command, invocation.args, { windowsVerbatimArguments: invocation.windowsVerbatimArguments, cwd: command.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) { output = String(error); finish(-1); return }
    const receive = (chunk: Buffer): void => { const text = chunk.toString('utf8'); output = (output + text).slice(-32_000); log(text) }
    child.stdout?.on('data', receive); child.stderr?.on('data', receive)
    child.on('error', (error) => { output += error.message; finish(-1) })
    child.on('close', (code) => finish(code ?? -1))
    timer = setTimeout(() => {
      output += '\nVerification command timed out'
      if (child.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
      }
      finish(-1)
    }, command.timeoutMs)
  })
  return { repositoryId: command.repositoryId, command: command.command, args: command.args, cwd: command.cwd, environmentPolicy: 'isolated-transport-v1', environmentHash: hash, environmentKeys: keys, environmentOverrideKeys: overrideKeys, environmentOverridesHash: overridesHash, exitCode, durationMs: Date.now() - started, output }
}
export async function verifyPipeline(contextInput: unknown, raw: unknown, log: (text: string) => void = () => {}): Promise<VerificationReceipt> {
  const context = validatePipelineContext(contextInput)
  const { request, commands } = verificationPlan(context, raw)
  const state = readState(context)
  const candidateHash = fingerprintCandidate(state)
  const results: CommandReceipt[] = []
  for (const command of commands) {
    results.push(await executeCheck(command, log))
    if (results[results.length - 1]!.exitCode !== 0) break
  }
  return locked(context, () => {
    const current = readState(context)
    const changed = fingerprintCandidate(current) !== candidateHash || current.revision !== state.revision
    const receipt: VerificationReceipt = {
      id: randomUUID(), kind: request.kind as 'full' | 'scoped', scopeHash: state.scopeHash, candidateHash, commands: results,
      completedAt: new Date().toISOString(), valid: !changed && results.length === commands.length && results.every((result) => result.exitCode === 0),
      ...(changed ? { reason: 'Candidate changed during verification' } : results.some((result) => result.exitCode !== 0) ? { reason: 'A verification command failed' } : {}),
    }
    atomicJson(safeChild(pipelineStateDirectory(context), 'receipts/' + receipt.id + '.json'), receipt)
    if (receipt.kind === 'full' || !receipt.valid || !current.verification) current.verification = receipt
    saveState(current)
    return receipt
  })
}
function verificationPlan(context: PipelineContext, raw: unknown) {
  const request = object(raw)
  if (!['full', 'scoped'].includes(String(request.kind)) || !Array.isArray(request.commands) || request.commands.length === 0 || request.commands.length > 100) fail('Verification requires bounded structured commands')
  const commands = request.commands.map((command) => validateCommand(context, command))
  if (request.kind === 'full' && context.repositories.some((repo) => !commands.some((command) => command.repositoryId === repo.id))) fail('Full verification must cover every selected repository')
  return { request, commands }
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
