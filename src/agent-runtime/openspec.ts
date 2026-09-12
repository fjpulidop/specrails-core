import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRole, CliProvider } from './executor-types.js'

export const OPENSPEC_VERSION = '1.4.1'
export const ROLE_SKILLS = { architect: 'openspec-ff-change', developer: 'openspec-apply-change', reviewer: 'openspec-verify-change' } as const
export interface OpenSpecRoleContext {
  root: string
  change: string
  stateDirectory: string
  cli: string
  skillPath: string
  skillHash: string
  role: AgentRole
}
export interface OpenSpecStatus {
  changeRoot: string
  schemaName: string
  isComplete: boolean
  applyRequires: string[]
  actionContext?: { allowedEditRoots?: string[]; mode?: string }
  artifacts: { id: string; status: string }[]
  artifactPaths: Record<string, { existingOutputPaths: string[]; resolvedOutputPath: string }>
}
export interface OpenSpecApply {
  state: 'blocked' | 'ready' | 'all_done'
  contextFiles: Record<string, string | string[]>
  tasks: { id: string; description: string; done: boolean }[]
  progress: { total: number; complete: number; remaining: number }
}
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
export function resolveOpenSpecCli(): string {
  const require = createRequire(import.meta.url)
  const pkg = path.resolve(path.dirname(require.resolve('@fission-ai/openspec')), '../package.json')
  const manifest = JSON.parse(readFileSync(pkg, 'utf8'))
  if (manifest.version !== OPENSPEC_VERSION) throw new Error(`OpenSpec ${OPENSPEC_VERSION} required; found ${manifest.version}`)
  return path.join(path.dirname(pkg), 'bin/openspec.js')
}
export async function runOpenSpec(cli: string, root: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const result = await promisify(execFile)(process.execPath, [cli, ...args], {
      cwd: root, signal, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: '1' },
    })
    return result.stdout
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; status?: number }
    throw new Error(`OpenSpec ${args[0]} failed (${result.status ?? 'process error'}): ${String(result.stderr || result.stdout || '').slice(-6000)}`)
  }
}
/** Reject symlink traversal even when the final destination does not exist. */
export function artifactPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Invalid artifact path')
  let target = realpathSync(root)
  for (const part of relative.split(/[\\/]/)) {
    target = path.join(target, part)
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('Artifact symlinks are forbidden') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}
/** CLI-generated skills, never reimplemented templates. No user/global config writes. */
export function prepareOpenSpec(root: string, change: string, directory: string): { cli: string; skillRoot: string; identity: Record<string, string> } {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) throw new Error('Invalid OpenSpec change name')
  const cli = resolveOpenSpecCli()
  mkdirSync(directory, { recursive: true })
  const skillRoot = path.join(directory, 'openspec-skills')
  const marker = path.join(skillRoot, 'ready.json')
  if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).version !== OPENSPEC_VERSION) throw new Error('Saved OpenSpec skill version is incompatible; start a new run')
  if (!existsSync(marker)) {
    const staging = mkdtempSync(path.join(directory, '.prepare-openspec-'))
    try {
      const config = path.join(staging, 'config')
      mkdirSync(path.join(config, 'openspec'), { recursive: true })
      writeFileSync(path.join(config, 'openspec/config.json'), JSON.stringify({ profile: 'custom', delivery: 'skills', workflows: ['ff', 'apply', 'verify'], featureFlags: {} }))
      const target = path.join(staging, 'project')
      mkdirSync(target)
      execFileSync(process.execPath, [cli, 'init', '--tools', 'claude,codex,gemini,kimi', '--profile', 'custom', target], {
        cwd: target, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, XDG_CONFIG_HOME: config, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        for (const name of Object.values(ROLE_SKILLS)) {
          const content = readFileSync(path.join(target, '.' + provider, 'skills', name, 'SKILL.md'), 'utf8')
          const destination = path.join(skillRoot, provider, name)
          mkdirSync(destination, { recursive: true })
          writeFileSync(path.join(destination, 'SKILL.md'), content, { mode: 0o600 })
        }
      }
      writeFileSync(marker, JSON.stringify({ version: OPENSPEC_VERSION }))
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  const identity: Record<string, string> = { version: OPENSPEC_VERSION, root: realpathSync(root), change }
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) for (const name of Object.values(ROLE_SKILLS)) {
    identity[`${provider}/${name}`] = hash(readFileSync(path.join(skillRoot, provider, name, 'SKILL.md'), 'utf8'))
  }
  if (existsSync(path.join(root, 'openspec/schemas/spec-driven'))) throw new Error('Custom spec-driven schema overrides are not supported by this runtime')
  const config = artifactPath(root, 'openspec/config.yaml')
  identity.projectConfig = existsSync(config) ? hash(readFileSync(config, 'utf8')) : 'absent'
  return { cli, skillRoot, identity }
}
export function roleOpenSpecContext(prepared: ReturnType<typeof prepareOpenSpec>, root: string, change: string, directory: string, role: AgentRole, provider: CliProvider): OpenSpecRoleContext {
  return { root, change, stateDirectory: directory, cli: prepared.cli, role,
    skillPath: path.join(prepared.skillRoot, provider, ROLE_SKILLS[role], 'SKILL.md'),
    skillHash: prepared.identity[`${provider}/${ROLE_SKILLS[role]}`]!,
  }
}
/** OpenSpec uses cwd paths; Windows may report a different case or short-name
 * spelling than realpathSync. Compare existing filesystem identities, not text. */
export function sameOpenSpecDirectory(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false
  try { return path.relative(realpathSync(candidate), realpathSync(expected)) === '' }
  catch { return false }
}

export class OpenSpecTools {
  constructor(readonly context: OpenSpecRoleContext, private readonly signal?: AbortSignal) {}
  private async call(args: string[]): Promise<unknown> { return JSON.parse(await runOpenSpec(this.context.cli, this.context.root, args, this.signal)) }
  async status(): Promise<OpenSpecStatus> {
    const metadata = artifactPath(this.context.root, `openspec/changes/${this.context.change}/.openspec.yaml`)
    if (!existsSync(metadata)) throw new Error('OpenSpec change metadata is missing; the architect must create the change with OpenSpec')
    const status = await this.call(['status', '--change', this.context.change, '--json']) as OpenSpecStatus
    const expected = artifactPath(this.context.root, `openspec/changes/${this.context.change}`)
    if (!sameOpenSpecDirectory(status.changeRoot, expected) || status.schemaName !== 'spec-driven' || status.actionContext?.mode !== 'repo-local' || !status.actionContext?.allowedEditRoots?.some(root => sameOpenSpecDirectory(root, this.context.root))) throw new Error('Unsupported OpenSpec planning root or schema; select an admitted repo-local spec-driven change')
    return status
  }
  async apply(): Promise<OpenSpecApply> { await this.status(); return await this.call(['instructions', 'apply', '--change', this.context.change, '--json']) as OpenSpecApply }
  async validate(): Promise<unknown> { await this.status(); return this.call(['validate', this.context.change, '--strict', '--json']) }
  async execute(input: { action: string; artifact?: string; path?: string; content?: string }): Promise<unknown> {
    this.signal?.throwIfAborted()
    const { action } = input
    const log = path.join(this.context.stateDirectory, `openspec-${this.context.role}.jsonl`)
    const history: { action: string; artifact?: string }[] = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    if (action !== 'load_skill' && !history.some(item => item.action === 'load_skill')) throw new Error('Load the official role skill first')
    let result: unknown
    const prerequisites: { action: string; artifact?: string; via: string }[] = []
    if (action === 'load_skill') {
      const content = readFileSync(this.context.skillPath, 'utf8')
      if (hash(content) !== this.context.skillHash) throw new Error('OpenSpec skill changed since admission')
      // Both official apply and verify start with these read-only CLI queries.
      // Execute them as part of the agent's tool request and return their actual
      // outputs, so loading a skill cannot omit its required planning context.
      const planning = this.context.role === 'architect' ? undefined : {
        status: await this.status(),
        apply: await this.call(['instructions', 'apply', '--change', this.context.change, '--json']),
      }
      if (planning) prerequisites.push({ action: 'status', via: 'load_skill' }, { action: 'instructions', artifact: 'apply', via: 'load_skill' })
      result = { name: ROLE_SKILLS[this.context.role], source: this.context.skillPath, version: OPENSPEC_VERSION, content,
        ...(planning ? { planning, next: 'The official status and instructions apply queries have executed for this request. Read every planning.apply.contextFiles path, then perform the remaining role skill steps. This is planning context, not proof that implementation or review is complete.' } : {}),
      }
    } else if (action === 'new') {
      if (this.context.role !== 'architect') throw new Error('Only the architect can create a change')
      const target = artifactPath(this.context.root, `openspec/changes/${this.context.change}`)
      result = existsSync(target) ? await this.status() : await this.call(['new', 'change', this.context.change, '--json'])
      await this.status()
    } else if (action === 'status') result = await this.status()
    else if (action === 'instructions') {
      const status = await this.status()
      if (input.artifact !== 'apply' && !status.artifacts.some(item => item.id === input.artifact)) throw new Error('Unknown OpenSpec artifact')
      result = await this.call(['instructions', input.artifact!, '--change', this.context.change, '--json'])
    } else if (action === 'validate') result = await this.validate()
    else if (action === 'write_artifact') {
      if (this.context.role === 'reviewer') throw new Error('Reviewer cannot write artifacts')
      const status = await this.status()
      if (!input.path?.endsWith('.md') || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 256 * 1024) throw new Error('Invalid artifact content')
      if (this.context.role === 'developer' && input.path !== 'tasks.md') throw new Error('Developer may update only OpenSpec tasks')
      if (!['proposal.md', 'design.md', 'tasks.md'].includes(input.path) && !/^specs\/[a-z0-9-]+\/spec\.md$/.test(input.path)) throw new Error('Not a spec-driven artifact')
      const artifact = input.path.startsWith('specs/') ? 'specs' : input.path.replace('.md', '')
      if (!['ready', 'done'].includes(status.artifacts.find(item => item.id === artifact)?.status ?? '')) throw new Error('OpenSpec dependencies are incomplete for this artifact')
      if (!history.some(item => item.action === 'instructions' && item.artifact === (this.context.role === 'developer' ? 'apply' : artifact))) throw new Error('Read OpenSpec instructions before writing this artifact')
      const target = artifactPath(status.changeRoot, input.path)
      if (this.context.role === 'developer') {
        const normalize = (text: string): string => text.replace(/^(\s*-\s+)\[[ x]\]/gm, '$1[ ]')
        if (normalize(readFileSync(target, 'utf8')) !== normalize(input.content)) throw new Error('Developer may change only task checkboxes')
      }
      this.signal?.throwIfAborted()
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, input.content, 'utf8')
      result = { written: target, sha256: hash(input.content) }
    } else throw new Error('Unsupported OpenSpec operation')
    this.signal?.throwIfAborted()
    const timestamp = new Date().toISOString()
    appendFileSync(log, [{ action, artifact: input.artifact, path: input.path }, ...prerequisites]
      .map(event => JSON.stringify({ ...event, timestamp }) + '\n').join(''), { mode: 0o600 })
    return result
  }
  private participationEvents(): { action: string; artifact?: string }[] {
    const log = path.join(this.context.stateDirectory, `openspec-${this.context.role}.jsonl`)
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  participationCursor(): number { return this.participationEvents().length }
  assertParticipation(after = 0): void {
    const rows = this.participationEvents().slice(after)
    const artifact = this.context.role === 'architect' ? 'tasks' : 'apply'
    const missing = [!rows.some(row => row.action === 'load_skill') ? 'load_skill' : '', !rows.some(row => row.action === 'instructions' && row.artifact === artifact) ? `instructions ${artifact}` : ''].filter(Boolean)
    if (missing.length) throw new OpenSpecParticipationError(`Required OpenSpec role workflow was not executed: ${this.context.role} must execute ${ROLE_SKILLS[this.context.role]} (missing ${missing.join(', ')})`)
  }
  async assertReady(): Promise<OpenSpecApply> {
    const status = await this.status()
    if (!status.isComplete) throw new Error('OpenSpec planning artifacts remain incomplete')
    const apply = await this.call(['instructions', 'apply', '--change', this.context.change, '--json']) as OpenSpecApply
    if (apply.state === 'blocked' || !apply.progress.total) throw new Error('OpenSpec apply is blocked')
    for (const files of Object.values(apply.contextFiles)) for (const file of (Array.isArray(files) ? files : [files])) {
      const relative = path.relative(status.changeRoot, file)
      const safe = artifactPath(status.changeRoot, relative)
      if (!readFileSync(safe, 'utf8').trim()) throw new Error('Empty OpenSpec artifact: ' + relative)
    }
    for (const name of ['proposal.md', 'design.md', 'tasks.md']) {
      if (!readFileSync(artifactPath(status.changeRoot, name), 'utf8').trim()) throw new Error('Empty OpenSpec artifact: ' + name)
    }
    await this.call(['validate', this.context.change, '--strict', '--json'])
    return apply
  }
}
export const OPENSPEC_BRIDGE_ENTRY = fileURLToPath(new URL('./openspec-tool-server.js', import.meta.url))

export const OPENSPEC_TOOL_DEFINITION = { type: 'function', function: { name: 'openspec_workflow', description: 'Run the official OpenSpec role workflow. Load the skill first (developer/reviewer also receive real status and apply context), then use its CLI instructions and write artifacts within the fixed change.', parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['load_skill', 'new', 'status', 'instructions', 'validate', 'write_artifact'] }, artifact: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } } } } }
export function openSpecPrompt(context: OpenSpecRoleContext): string {
  return `\n## Official OpenSpec workflow binding\nExecute ${ROLE_SKILLS[context.role]} for change ${context.change}. This headless transport loads the official, version-pinned skill through the openspec_workflow tool (MCP server specrails_openspec, tool workflow on CLI providers). This is explicit skill-document adaptation, not a native slash command.\nFirst call action=load_skill and follow the returned complete official skill. Bind its openspec CLI commands to this tool: new change -> action=new; status -> status; instructions <artifact> -> instructions with artifact; validate -> validate. Author each artifact yourself using write_artifact with its change-relative path and content; read the official instructions first. Do not reproduce templates from memory or return the artifacts in final JSON. The tool fixes the change identity and runs OpenSpec ${OPENSPEC_VERSION}.\nRead source/dependencies with your normal read tools. For this frozen scope, change selection is already answered. Bind AskUserQuestion to a low-confidence final result with question (architect), or a reported blocking issue (other roles); LangGraph asks the requester. Bind TodoWrite to concise progress narration. Do not invoke another role, apply/archive from architect, or archive from developer/reviewer. Return the Specrails JSON report after the official workflow. For developer and reviewer, load_skill already executes status and instructions apply and returns their real outputs in planning; read planning.apply.contextFiles and perform the rest of the official skill. You may refresh instructions apply when needed. Verify is a skill, not an instructions artifact.\n`
}
export function writeOpenSpecBridge(context: OpenSpecRoleContext, directory: string): { command: string; args: string[] } {
  const file = path.join(directory, 'openspec-context.json')
  writeFileSync(file, JSON.stringify(context), { mode: 0o600 })
  return { command: process.execPath, args: [OPENSPEC_BRIDGE_ENTRY, file] }
}

/** A repairable protocol omission, distinct from invalid artifacts or failed verification. */
export class OpenSpecParticipationError extends Error {}
export function openSpecRepairPrompt(context: OpenSpecRoleContext): string {
  return `The previous ${context.role} result cannot be accepted because you omitted the required official OpenSpec workflow. Do not merely resend the JSON. Continue this same role with the work already available. Load ${ROLE_SKILLS[context.role]} using the scoped workflow tool (action=load_skill), consult status and instructions ${context.role === 'architect' ? 'tasks' : 'apply'}, and execute the complete returned skill procedure against the current artifacts and code. Reconcile your previous conclusions with that procedure; correct your report if necessary. Do not rerun the implementation or the host verification commands. ${context.role === 'reviewer' ? 'Stay read-only; do not modify code or artifacts.' : 'Keep already-correct work and respect the same frozen scope.'} Finish with the originally requested JSON report.
`
}
