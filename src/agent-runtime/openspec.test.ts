import { createRoleInvoker } from './graph/roles.js'
import { ExecutorRegistry } from './executors.js'
import { unknownUsage, type RuntimeConfig } from './executor-types.js'
import type { WorkflowStepContext } from './workflow-types.js'
import type { PipelineContext } from '../pipeline/pipeline-state.js'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { artifactPath, OpenSpecTools, prepareOpenSpec, roleOpenSpecContext, sameOpenSpecDirectory } from './openspec.js'

let root: string
let architect: OpenSpecTools
let developer: OpenSpecTools
let reviewer: OpenSpecTools
const delta = '## ADDED Requirements\n### Requirement: Medical alert\nThe system SHALL display active alerts.\n#### Scenario: Visit booking\n- **WHEN** booking a visit\n- **THEN** active alerts are displayed.\n'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'openspec-integration-'))
  mkdirSync(path.join(root, 'openspec'))
  writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\ncontext: |\n  This project uses real medical alerts.\nrules:\n  proposal:\n    - Keep alerts informational.\n')
  const directory = path.join(root, '.state')
  const prepared = prepareOpenSpec(root, 'medical-alert', directory)
  architect = new OpenSpecTools(roleOpenSpecContext(prepared, root, 'medical-alert', directory, 'architect', 'claude'))
  developer = new OpenSpecTools(roleOpenSpecContext(prepared, root, 'medical-alert', directory, 'developer', 'codex'))
  reviewer = new OpenSpecTools(roleOpenSpecContext(prepared, root, 'medical-alert', directory, 'reviewer', 'kimi'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
async function author(): Promise<void> {
  await architect.execute({ action: 'load_skill' })
  await architect.execute({ action: 'new' })
  for (const [artifact, file, content] of [
    ['proposal', 'proposal.md', '## Why\nMedical alerts must be visible during booking.\n## What Changes\n- Display alerts.\n## Capabilities\n### New Capabilities\n- `alerts`: informational alerts.\n### Modified Capabilities\nNone.\n## Impact\nVisit booking.\n'],
    ['design', 'design.md', '## Context\nRead existing notes and render informational alerts without blocking booking.'],
    ['specs', 'specs/alerts/spec.md', delta],
    ['tasks', 'tasks.md', '## 1. Alerts\n- [ ] 1.1 Display alerts and cover booking behavior\n'],
  ]) {
    await architect.execute({ action: 'instructions', artifact })
    await architect.execute({ action: 'write_artifact', path: file, content })
  }
}
describe('official OpenSpec CLI and confined role tools', () => {
  it('uses real project rules, metadata, dependency order, deltas and apply progress', async () => {
    await expect(architect.execute({ action: 'new' })).rejects.toThrow('Load the official')
    const skill = await architect.execute({ action: 'load_skill' })
    expect(skill).toMatchObject({ name: 'openspec-ff-change', version: '1.14.3' })
    await architect.execute({ action: 'new' })
    const proposal = await architect.execute({ action: 'instructions', artifact: 'proposal' })
    expect(JSON.stringify(proposal)).toContain('Keep alerts informational')
    expect(JSON.stringify(proposal)).toContain('real medical alerts')
    await expect(architect.execute({ action: 'write_artifact', path: 'tasks.md', content: '- [ ] task' })).rejects.toThrow('dependencies')
    await author()
    architect.assertParticipation()
    const cursor = architect.participationCursor()
    expect(() => architect.assertParticipation(cursor)).toThrow('Required OpenSpec role workflow was not executed')
    expect((await architect.assertReady()).progress).toEqual({ total: 1, complete: 0, remaining: 1 })
    expect(readFileSync(path.join(root, 'openspec/changes/medical-alert/.openspec.yaml'), 'utf8')).toContain('spec-driven')
  }, 60000)
  it('rejects empty artifacts even when OpenSpec status reports complete', async () => {
    await author()
    writeFileSync(path.join(root, 'openspec/changes/medical-alert/proposal.md'), '')
    expect((await architect.status()).isComplete).toBe(true)
    await expect(architect.assertReady()).rejects.toThrow('Empty OpenSpec artifact')
  }, 60000)
  it('enforces architect artifact scope, checkbox-only developer writes, and read-only review', async () => {
    await author()
    await expect(architect.execute({ action: 'write_artifact', path: '../../../code.md', content: 'bad' })).rejects.toThrow('Not a spec-driven artifact')
    await developer.execute({ action: 'load_skill' })
    await developer.execute({ action: 'instructions', artifact: 'apply' })
    await expect(developer.execute({ action: 'write_artifact', path: 'tasks.md', content: '- [x] Skip actual work' })).rejects.toThrow('only task checkboxes')
    const tasks = readFileSync(path.join(root, 'openspec/changes/medical-alert/tasks.md'), 'utf8')
    await developer.execute({ action: 'write_artifact', path: 'tasks.md', content: tasks.replace('[ ]', '[x]') })
    expect((await developer.assertReady()).state).toBe('all_done')
    await reviewer.execute({ action: 'load_skill' })
    await reviewer.execute({ action: 'instructions', artifact: 'apply' })
    await expect(reviewer.execute({ action: 'write_artifact', path: 'tasks.md', content: tasks })).rejects.toThrow('Reviewer cannot')
    await expect(reviewer.execute({ action: 'instructions', artifact: 'verify' })).rejects.toThrow('Unknown OpenSpec artifact')
  }, 60000)
  it('returns real apply context when a reviewer loads its skill, including over MCP', async () => {
    await author()
    const file = path.join(root, 'reviewer-context.json')
    writeFileSync(file, JSON.stringify(reviewer.context))
    const client = new Client({ name: 'reviewer-regression', version: '1' })
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/agent-runtime/openspec-tool-server.js'), file], stderr: 'pipe' }))
      const cursor = reviewer.participationCursor()
      const loaded = await client.callTool({ name: 'workflow', arguments: { action: 'load_skill' } })
      expect(loaded.isError).not.toBe(true)
      const payload = JSON.parse((loaded.content as { text: string }[])[0].text)
      expect(payload.planning.status.schemaName).toBe('spec-driven')
      expect(payload.planning.apply.progress).toEqual({ total: 1, complete: 0, remaining: 1 })
      expect(JSON.stringify(payload.planning.apply.contextFiles)).toContain('tasks.md')
      // Reproduce the reported reviewer: specs + validate, no separate apply query.
      await reviewer.execute({ action: 'instructions', artifact: 'specs' })
      await reviewer.execute({ action: 'validate' })
      expect(() => reviewer.assertParticipation(cursor)).not.toThrow()
      expect(() => reviewer.assertParticipation(reviewer.participationCursor())).toThrow('missing')
      const ledger = readFileSync(path.join(reviewer.context.stateDirectory, 'openspec-reviewer.jsonl'), 'utf8')
      expect(ledger).toContain('"artifact":"apply","via":"load_skill"')
    } finally { await client.close() }
  }, 60000)
  it('creates a fresh change and executes status and every artifact instruction inside the architect load_skill', async () => {
    const loaded = await architect.execute({ action: 'load_skill' }) as { planning: { status: { artifacts: { id: string; status: string }[] }; instructions: Record<string, { artifactId: string; instruction: string; template: string }> }; next: string }
    expect(readFileSync(path.join(root, 'openspec/changes/medical-alert/.openspec.yaml'), 'utf8')).toContain('spec-driven')
    expect(Object.keys(loaded.planning.instructions).sort()).toEqual(['design', 'proposal', 'specs', 'tasks'])
    expect(loaded.planning.instructions.proposal.artifactId).toBe('proposal')
    expect(JSON.stringify(loaded.planning.instructions.proposal)).toContain('Keep alerts informational')
    expect(loaded.next).toContain('Do not repeat these queries')
    // The architect writes directly; the dependency order is still enforced.
    await expect(architect.execute({ action: 'write_artifact', path: 'tasks.md', content: '- [ ] task' })).rejects.toThrow('dependencies')
    await architect.execute({ action: 'write_artifact', path: 'proposal.md', content: '## Why\nAlerts.\n## What Changes\n- Display alerts.\n## Capabilities\n### New Capabilities\n- `alerts`: alerts.\n### Modified Capabilities\nNone.\n## Impact\nBooking.\n' })
    await architect.execute({ action: 'write_artifact', path: 'design.md', content: '## Context\nRender alerts.' })
    await architect.execute({ action: 'write_artifact', path: 'specs/alerts/spec.md', content: delta })
    await architect.execute({ action: 'write_artifact', path: 'tasks.md', content: '## 1. Alerts\n- [ ] 1.1 Display alerts\n' })
    expect(() => architect.assertParticipation()).not.toThrow()
    expect((await architect.assertReady()).progress.total).toBe(1)
    const ledger = readFileSync(path.join(architect.context.stateDirectory, 'openspec-architect.jsonl'), 'utf8')
    for (const artifact of ['proposal', 'design', 'specs', 'tasks']) expect(ledger).toContain(`"artifact":"${artifact}","via":"load_skill"`)
    expect(ledger).toContain('"action":"new","via":"load_skill"')
    // A role that may not create changes never creates one through load_skill.
    rmSync(path.join(root, 'openspec/changes/medical-alert'), { recursive: true, force: true })
    await developer.execute({ action: 'load_skill' }).catch(() => null)
    expect(existsSync(path.join(root, 'openspec/changes/medical-alert'))).toBe(false)
  }, 60000)
  it('reads the apply context files of the change, within a total bound and never outside the change', async () => {
    await author()
    const apply = await developer.apply()
    const texts = developer.contextFileTexts(apply)
    expect(Object.keys(texts).sort()).toEqual(['design.md', 'proposal.md', 'specs/alerts/spec.md', 'tasks.md'])
    expect(texts['specs/alerts/spec.md']).toBe(delta)
    expect(developer.contextFileTexts({ contextFiles: { stray: [path.join(root, 'openspec/config.yaml')] } })).toEqual({})
    // The CLI may spell the change through another route than realpathSync (macOS /var vs /private/var,
    // Windows short names): the same file is still read, keyed by its change-relative path.
    const spelled = path.join(root, 'openspec', 'changes', 'medical-alert', 'specs', 'alerts', 'spec.md')
    expect(developer.contextFileTexts({ contextFiles: { specs: [spelled] } })).toEqual({ 'specs/alerts/spec.md': delta })
    expect(developer.contextFileTexts(undefined)).toEqual({})
    const bounded = developer.contextFileTexts(apply, Buffer.byteLength(texts['proposal.md']!) + 10)
    expect(Object.values(bounded).every(text => Object.values(texts).includes(text))).toBe(true)
    expect(Object.keys(bounded).length).toBeLessThan(4)
  }, 60000)
  it('returns real task instructions when the architect reuses complete artifacts', async () => {
    await author()
    const cursor = architect.participationCursor()
    const loaded = await architect.execute({ action: 'load_skill' }) as { planning: { status: { isComplete: boolean }; tasks: unknown } }
    expect(loaded.planning.status.isComplete).toBe(true)
    expect(loaded.planning.tasks).toBeTruthy()
    await architect.execute({ action: 'status' })
    await architect.execute({ action: 'validate' })
    expect(() => architect.assertParticipation(cursor)).not.toThrow()
    expect(readFileSync(path.join(architect.context.stateDirectory, 'openspec-architect.jsonl'), 'utf8')).toContain('"artifact":"tasks","via":"load_skill"')
  }, 60000)
  it.each([
    { role: 'correct', skill: 'openspec-apply-change' as const, access: 'write' as const, artifacts: 'tasks-checkboxes' as const },
    { role: 'reviewer', skill: 'openspec-verify-change' as const, access: 'read' as const, artifacts: 'none' as const },
    { role: 'assess', skill: 'openspec-verify-change' as const, access: 'read' as const, artifacts: 'none' as const },
  ].flatMap(binding => [true, false].map(complete => ({ ...binding, complete }))))('bootstraps $role and refuses unavailable planning context (artifacts: $complete)', async ({ role, skill, access, artifacts, complete }) => {
    if (complete) await author()
    let calls = 0
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      calls++
      expect(request.prompt).toContain('Host-loaded official ' + (skill === 'openspec-verify-change' ? 'verify' : 'apply') + ' workflow')
      expect(request.prompt).toContain(skill)
      expect(request.prompt).toContain('contextFiles')
      // The current artifact texts travel with the context, so the role does not reopen them.
      expect(request.prompt).toContain('artifactTexts')
      expect(request.prompt).toContain(JSON.stringify('## 1. Alerts\n- [ ] 1.1 Display alerts and cover booking behavior\n'))
      if (skill === 'openspec-verify-change') {
        expect(request.access).toBe('read')
        expect(request.artifacts).toBe('none')
      }
      // Mirror the logged reviewer: inspect/report without any workflow calls.
      return { text: 'Inspected the candidate against the supplied context', usage: unknownUsage() }
    } })
    const agent = { provider: 'fixture' }
    const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: agent, developer: agent, reviewer: agent }, verification: [],
      ...(role !== 'reviewer' ? { roles: { [role]: { ...agent, access, artifacts, openspecSkill: skill } } } : {}) }
    const tools = { ...(skill === 'openspec-verify-change' ? reviewer.context : developer.context), role, openspecSkill: skill, access, artifacts }
    const context = { schemaVersion: 1, runId: 'review-context', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }],
      ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Medical alert', description: 'Display alerts', acceptanceCriteria: ['Display alerts'] }] } as PipelineContext
    const invoke = createRoleInvoker({ context, config, registry, openspec: { [role]: tools } })
    const step = { runId: 'review-context', stepId: role, attemptId: 'attempt', signal: new AbortController().signal,
      checkpoint: { history: [], events: [], steps: {} }, remainingBudget: () => ({}), reportUsage: () => {} } as unknown as WorkflowStepContext
    const outcome = await invoke(role, step, { prompt: 'Inspect the current candidate' }, (_output, text) => text)
    expect(outcome.ok, JSON.stringify(outcome)).toBe(complete)
    expect(calls).toBe(complete ? 1 : 0)
    const workflow = new OpenSpecTools(tools)
    if (complete) {
      expect(readFileSync(path.join(tools.stateDirectory, `openspec-${role}.jsonl`), 'utf8')).toContain('"origin":"host"')
      const cursor = workflow.participationCursor()
      expect(() => workflow.assertParticipation(cursor)).toThrow('missing')
      // Each new visit gets fresh actual CLI context, not a trace from last time.
      expect((await invoke(role, step, { prompt: 'Inspect again' }, (_output, text) => text)).ok).toBe(true)
      expect(() => workflow.assertParticipation(cursor)).not.toThrow()
      if (artifacts === 'none') await expect(workflow.execute({ action: 'write_artifact', path: 'tasks.md', content: '- [x] bypass' })).rejects.toThrow('cannot write artifacts')
    } else expect(() => workflow.assertParticipation()).toThrow('missing')
  }, 60000)

  it('does not record a loaded role when its required CLI context fails', async () => {
    await expect(reviewer.execute({ action: 'load_skill' })).rejects.toThrow('metadata is missing')
    expect(reviewer.participationCursor()).toBe(0)
    expect(() => reviewer.assertParticipation()).toThrow('missing load_skill, instructions apply')
  })
  it('compares canonical directory identities without admitting another planning root', async () => {
    await author()
    const status = await architect.status()
    const cli = path.join(root, 'status-fixture.cjs')
    const equivalent = (value: string) => value + path.sep + '.'
    writeFileSync(cli, 'console.log(' + JSON.stringify(JSON.stringify({ ...status, changeRoot: equivalent(status.changeRoot), actionContext: { ...status.actionContext, allowedEditRoots: [equivalent(root)] } })) + ')')
    const tools = new OpenSpecTools({ ...architect.context, cli })
    expect((await tools.status()).schemaName).toBe('spec-driven')
    if (process.platform === 'win32') {
      expect(sameOpenSpecDirectory(root.toUpperCase(), root)).toBe(true)
      // GitHub's Windows temp directory can contain a DOS 8.3 user alias.
      const shortPathResult = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${root}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true })
      expect(shortPathResult.status, shortPathResult.stderr).toBe(0)
      const shortRoot = shortPathResult.stdout.trim()
      expect(sameOpenSpecDirectory(shortRoot, root)).toBe(true)
      expect(sameOpenSpecDirectory(root, shortRoot)).toBe(true)
    }
    expect(sameOpenSpecDirectory(equivalent(root), root)).toBe(true)
    expect(sameOpenSpecDirectory('.', root)).toBe(false)
    expect(sameOpenSpecDirectory(path.join(root, 'missing'), root)).toBe(false)
    writeFileSync(cli, 'console.log(' + JSON.stringify(JSON.stringify({ ...status, changeRoot: root })) + ')')
    await expect(tools.status()).rejects.toThrow('Unsupported OpenSpec planning root')
    writeFileSync(cli, 'console.log(' + JSON.stringify(JSON.stringify({ ...status, actionContext: { ...status.actionContext, allowedEditRoots: [path.join(root, '.state')] } })) + ')')
    await expect(tools.status()).rejects.toThrow('Unsupported OpenSpec planning root')
  }, 60000)
  it('rejects traversal and dangling symlinks before creating a destination', async () => {
    expect(() => artifactPath(root, '../escape')).toThrow('Invalid artifact path')
    symlinkSync(path.join(root, 'absent'), path.join(root, 'link'))
    expect(() => artifactPath(root, 'link/file.md')).toThrow('symlinks')
  })
  it('refuses a modified admitted skill', async () => {
    writeFileSync(architect.context.skillPath, 'A replaced skill')
    await expect(architect.execute({ action: 'load_skill' })).rejects.toThrow('changed since admission')
  })
  it('does not start an OpenSpec operation after cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by requester'))
    const tools = new OpenSpecTools(architect.context, controller.signal)
    await expect(tools.execute({ action: 'load_skill' })).rejects.toThrow('Cancelled by requester')
  })
  it('serves the official skill and real CLI over a real stdio MCP connection', async () => {
    const file = path.join(root, 'mcp-context.json')
    writeFileSync(file, JSON.stringify(architect.context))
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/agent-runtime/openspec-tool-server.js'), file], stderr: 'pipe' })
    const client = new Client({ name: 'openspec-test', version: '1' })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['workflow'])
      const skill = await client.callTool({ name: 'workflow', arguments: { action: 'load_skill' } })
      expect(JSON.stringify(skill)).toContain('openspec-ff-change')
      const created = await client.callTool({ name: 'workflow', arguments: { action: 'new' } })
      expect(created.isError).not.toBe(true)
      expect((await architect.status()).isComplete).toBe(false)
    } finally { await client.close() }
  }, 60000)
})


describe('declared OpenSpec artifact permissions', () => {
  it.each(['none', 'tasks-checkboxes', 'all'] as const)('enforces %s independently of role name and source access', async artifacts => {
    await author()
    const tools = new OpenSpecTools({ ...architect.context, role: 'security-reviewer', access: 'read', artifacts, openspecSkill: 'openspec-ff-change' })
    await tools.execute({ action: 'load_skill' })
    await tools.execute({ action: 'instructions', artifact: 'proposal' })
    const proposal = { action: 'write_artifact' as const, path: 'proposal.md', content: readFileSync(path.join(root, 'openspec/changes/medical-alert/proposal.md'), 'utf8') + '\nExtra detail.\n' }
    if (artifacts === 'all') await expect(tools.execute(proposal)).resolves.toHaveProperty('written')
    else await expect(tools.execute(proposal)).rejects.toThrow()
    await tools.execute({ action: 'instructions', artifact: artifacts === 'tasks-checkboxes' ? 'apply' : 'tasks' })
    const tasks = readFileSync(path.join(root, 'openspec/changes/medical-alert/tasks.md'), 'utf8')
    const update = { action: 'write_artifact' as const, path: 'tasks.md', content: tasks.replace('[ ]', '[x]') }
    if (artifacts === 'none') await expect(tools.execute(update)).rejects.toThrow()
    else await expect(tools.execute(update)).resolves.toHaveProperty('written')
    if (artifacts === 'tasks-checkboxes') await expect(tools.execute({ ...update, content: update.content + '\nChanged requirement.\n' })).rejects.toThrow('checkboxes')
    const progress = { action: 'write_progress' as const, progress: { summary: 'Reviewed files', completedTasks: [], nextTasks: [], checks: [], blockers: [] } }
    if (artifacts === 'none') await expect(tools.execute(progress)).rejects.toThrow()
    else await expect(tools.execute(progress)).resolves.toHaveProperty('record')
  }, 60000)
})

describe('skipped OpenSpec workflow steps (contract 5.16)', () => {
  const proposal = '## Why\nMedical alerts must be visible during booking.\n## What Changes\n- Display alerts.\n## Capabilities\n### New Capabilities\n- `alerts`: informational alerts.\n### Modified Capabilities\nNone.\n## Impact\nVisit booking.\n'
  const agent = { provider: 'fixture', model: 'small' }
  const planRole = { ...agent, access: 'write' as const, artifacts: 'all' as const, openspecSkill: 'openspec-ff-change' as const }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: agent, developer: agent, reviewer: agent }, verification: [], roles: { plan: planRole } }
  const pipeline = () => ({ schemaVersion: 1, runId: 'plan-protocol', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Medical alert', description: 'Display alerts', acceptanceCriteria: ['Display alerts'] }] } as PipelineContext)
  const step = () => ({ runId: 'plan-protocol', stepId: 'architect', attemptId: 'attempt', signal: new AbortController().signal,
    checkpoint: { history: [], events: [], steps: {} }, remainingBudget: () => ({}), reportUsage: () => {} } as unknown as WorkflowStepContext)
  const json = (value: unknown) => ({ text: JSON.stringify(value), usage: unknownUsage() })
  const plan = { confidence: 'high', question: '', verification: [] }
  /** A definition's `plan` role on the fast-forward skill, as Desktop's Implement recipe binds it. */
  function planner(turns: Array<(tools: OpenSpecTools, prompt: string) => Promise<{ text: string; usage: ReturnType<typeof unknownUsage> }>>) {
    const prompts: string[] = []
    const context = { ...architect.context, role: 'plan', openspecSkill: 'openspec-ff-change' as const, access: 'write' as const, artifacts: 'all' as const }
    const registry = new ExecutorRegistry().register('fixture', { execute: async request => {
      prompts.push(request.prompt)
      const turn = turns[prompts.length - 1]
      if (!turn) throw new Error('Unexpected extra turn')
      return turn(new OpenSpecTools(request.openspec!), request.prompt)
    } })
    const invoke = createRoleInvoker({ context: pipeline(), config, registry, openspec: { plan: context } })
    return { prompts, run: () => invoke('plan', step(), { prompt: 'Plan the change', structured: true }, output => output) }
  }
  it('lets a planner of any role id ask its question before any artifact exists', async () => {
    const { prompts, run } = planner([async () => json({ confidence: 'low', question: 'Must add return a + b or a * b?', verification: [] })])
    expect(await run()).toMatchObject({ ok: true, value: { confidence: 'low' } })
    expect(prompts).toHaveLength(1)
  })

  it('lets a planner decline the ticket without creating artifacts', async () => {
    const { prompts, run } = planner([async () => json({ confidence: 'declined', question: 'The person said this ticket belongs to another repository.', verification: [] })])
    expect(await run()).toMatchObject({ ok: true, value: { confidence: 'declined' } })
    expect(prompts).toHaveLength(1)
  })

  /** A planner turn after load_skill: write every artifact (load_skill already ran new, status and the instructions), then validate. */
  async function writeAll(tools: OpenSpecTools): Promise<void> {
    await tools.execute({ action: 'load_skill' })
    for (const [file, content] of [['proposal.md', proposal], ['design.md', '## Context\nRender alerts.'], ['specs/alerts/spec.md', delta], ['tasks.md', '## 1. Alerts\n- [ ] 1.1 Display alerts\n']]) await tools.execute({ action: 'write_artifact', path: file, content })
    await tools.execute({ action: 'validate' })
  }

  it('gives one corrective turn that names each missing step and the exact calls from the current state', async () => {
    const { prompts, run } = planner([async () => json(plan), async tools => { await writeAll(tools); return json(plan) }])
    expect(await run()).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(2)
    const reminder = prompts[1]!
    expect(reminder).toContain('Your turn ended without these required steps: load_skill, instructions tasks.')
    // load_skill creates the change and runs every instructions query, so the reminder names only the writes after it.
    expect(reminder).toContain('1. {"action":"load_skill"}')
    expect(reminder).toContain('{"action":"write_artifact","path":"proposal.md"}')
    expect(reminder).toContain('{"action":"write_artifact","path":"specs/<capability>/spec.md"}')
    expect(reminder).toContain('{"action":"write_artifact","path":"tasks.md"}')
    expect(reminder).toContain('{"action":"validate"}')
    expect(reminder).not.toContain('{"action":"new"}')
    expect(reminder).not.toContain('"action":"instructions"')
    expect(reminder).toContain('confidence low')
  }, 60000)

  it('needs no corrective turn once load_skill has run: it executes the instructions the skill requires', async () => {
    const { prompts, run } = planner([async tools => { await writeAll(tools); return json(plan) }])
    expect(await run()).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(1)
  }, 60000)

  it('fails with the typed omission and the model that skipped the steps when the corrective turn skips them too', async () => {
    const { prompts, run } = planner([async () => json(plan), async () => json(plan)])
    const outcome = await run()
    expect(outcome).toEqual({ ok: false, failure: 'openspec_workflow_omitted',
      error: 'Required OpenSpec role workflow was not executed: plan must execute openspec-ff-change (missing load_skill, instructions tasks); the plan model (fixture/small) skipped the required OpenSpec steps again after one corrective reminder' })
    expect(prompts).toHaveLength(2)
  }, 60000)

  it('keeps the workflow reminder and the malformed-reply repair as separate single budgets', async () => {
    const { prompts, run } = planner([
      async () => ({ text: 'not json', usage: unknownUsage() }),
      async tools => { await writeAll(tools); return { text: 'still not json', usage: unknownUsage() } },
      async () => json(plan),
    ])
    expect(await run()).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain('1. {"action":"load_skill"}')
    expect(prompts[2]).not.toContain('Your turn ended without these required steps')
  }, 60000)

  it('accepts the repository-relative and absolute spelling of an artifact of this change and says what a refused call needs', async () => {
    await architect.execute({ action: 'load_skill' })
    await architect.execute({ action: 'new' })
    await expect(architect.execute({ action: 'write_artifact', path: 'proposal.md' })).rejects.toThrow('write_artifact needs content')
    await expect(architect.execute({ action: 'write_artifact', path: 'openspec/changes/other-change/proposal.md', content: proposal })).rejects.toThrow('one of proposal.md, design.md, specs/<capability>/spec.md or tasks.md (got "openspec/changes/other-change/proposal.md")')
    await expect(architect.execute({ action: 'write_artifact', path: path.join(root, 'proposal.md'), content: proposal })).rejects.toThrow('Not a spec-driven artifact')
    expect(await architect.execute({ action: 'write_artifact', path: 'openspec/changes/medical-alert/proposal.md', content: proposal })).toMatchObject({ written: expect.stringMatching(/medical-alert[\\/]proposal\.md$/) })
    await architect.execute({ action: 'instructions', artifact: 'design' })
    await architect.execute({ action: 'write_artifact', path: path.join(root, 'openspec/changes/medical-alert/design.md'), content: '## Context\nRender alerts.' })
    expect(readFileSync(path.join(root, 'openspec/changes/medical-alert/design.md'), 'utf8')).toContain('Render alerts')
    const log = readFileSync(path.join(architect.context.stateDirectory, 'openspec-architect.jsonl'), 'utf8')
    expect(log).toContain('"path":"design.md"')
  }, 60000)
})
