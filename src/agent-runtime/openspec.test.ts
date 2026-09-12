import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(skill).toMatchObject({ name: 'openspec-ff-change', version: '1.4.1' })
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
