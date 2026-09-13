import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { initializePipeline, pipelineStateDirectory, readVerificationEvidence, validatePipelineContext, verifyPipeline, type PipelineContext } from '../installer/runtime/pipeline-state.js'
import { addDeveloperChecks, bindPlan, expandedPlanCommands, initializeVerificationPlan } from './verification-plan.js'
import { OpenAICompatibleExecutor } from './openai-executor.js'
import type { OpenSpecRoleContext } from './openspec.js'
let root: string, context: PipelineContext, binding: OpenSpecRoleContext, evidenceId: string
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'runtime-evidence-'))
  const repository = path.join(root, 'repo'); mkdirSync(repository)
  execFileSync('git', ['init', '-q', repository])
  context = validatePipelineContext({ schemaVersion: 1, runId: 'evidence-fixture', backlogRoot: root, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Fixture', description: 'Verify behavior', repositoryIds: ['repo'] }] })
  initializePipeline(context, 'evidence-fixture')
  initializeVerificationPlan(context, [], [])
  const plan = addDeveloperChecks(context, [{ kind: 'harness', key: 'behavior', repositoryId: 'repo', label: 'Behavior', command: process.execPath, args: [], entrypoint: 'check.cjs', files: [{ path: 'check.cjs', content: 'require("./helper.cjs");process.stdout.write("🙂".repeat(20000))' }, { path: 'helper.cjs', content: 'module.exports = true' }] }])
  bindPlan(context, plan)
  const receipt = await verifyPipeline(context, { kind: 'full', planHash: plan.planHash, commands: expandedPlanCommands(context, plan) })
  expect(receipt.valid).toBe(true)
  evidenceId = receipt.commands[0]!.evidenceId!
  binding = { root: context.artifactRoot, change: 'evidence-fixture', stateDirectory: pipelineStateDirectory(context), cli: 'unused', skillPath: 'unused', skillHash: 'unused', role: 'reviewer', evidenceScope: { backlogRoot: context.backlogRoot, runId: context.runId } }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('discovers both immutable source IDs and pages evidence through the compiled MCP bridge', async () => {
  const file = path.join(root, 'bridge.json'); writeFileSync(file, JSON.stringify(binding))
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../dist/agent-runtime/openspec-tool-server.js', import.meta.url)), file], stderr: 'pipe' })
  const client = new Client({ name: 'fixture', version: '1' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('read_verification_evidence')
    const read = async (args: Record<string, unknown>) => {
      const response = await client.callTool({ name: 'read_verification_evidence', arguments: args })
      expect(response.isError).not.toBe(true)
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text)
    }
    const detail = await read({ id: evidenceId })
    expect(detail.items[0].sources).toHaveLength(2)
    const helper = detail.items[0].sources.find((source: { displayPath: string }) => source.displayPath === 'helper.cjs')
    expect(await read({ id: evidenceId, section: 'source', sourceId: helper.id })).toMatchObject({ text: 'module.exports = true' })
    const first = await read({ id: evidenceId, section: 'stdout' })
    expect(first.byteCount).toBe(65536)
    expect(await read({ id: evidenceId, section: 'stdout', cursor: first.nextCursor })).toMatchObject({ byteCount: 14464 })
  } finally { await client.close() }
})

it('advertises and executes the same resolver in the API provider without shell access', async () => {
  let turn = 0
  const query: Record<string, unknown>[] = [{ id: evidenceId }, { id: evidenceId, section: 'stdout' }]
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string)
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('read_verification_evidence')
    if (turn === 2) {
      const first = JSON.parse(body.messages.at(-1).content)
      expect(first.byteCount).toBe(65536)
      query.push({ id: evidenceId, section: 'stdout', cursor: first.nextCursor })
    }
    if (turn === 3) expect(JSON.parse(body.messages.at(-1).content).byteCount).toBe(14464)
    const args = query[turn++]
    const message = args ? { role: 'assistant', tool_calls: [{ id: 'call-' + turn, type: 'function', function: { name: 'read_verification_evidence', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Evidence inspected' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: args ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }))
  }
  const result = await new OpenAICompatibleExecutor({ id: 'fixture', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid/v1' }, { fetch }).execute({ role: 'reviewer', prompt: 'Inspect saved evidence', model: 'fixture', cwd: context.artifactRoot, allowedRoots: [context.artifactRoot], maxTurns: 4, openspec: binding })
  expect(result.text).toBe('Evidence inspected')
  expect(turn).toBe(4)
  expect(readVerificationEvidence(context, { id: evidenceId })).toMatchObject({ available: true })
})
