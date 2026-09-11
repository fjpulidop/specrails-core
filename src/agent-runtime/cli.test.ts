import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runRuntimeCommand } from './cli.js'
import type { RuntimeConfig } from './executor-types.js'
import { pipelineStateDirectory, type PipelineContext } from '../installer/runtime/pipeline-state.js'

const executable = fileURLToPath(new URL('../../bin/specrails-core.mjs', import.meta.url))
let root: string
let context: PipelineContext
let contextFile: string
let configFile: string
let config: RuntimeConfig
let server: Server | undefined

function invoke(args: string[], stdin?: string): Promise<{ code: number | null; messages: Record<string, unknown>[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, 'runtime', ...args], { cwd: root, env: process.env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.stdin?.on('error', () => { /* Early validation failures can close stdin. */ })
    if (stdin !== undefined) child.stdin?.end(stdin)
    child.on('close', code => {
      try { resolve({ code, messages: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>), stderr }) }
      catch { reject(new Error('CLI emitted non-JSON output: ' + stdout + '\n' + stderr)) }
    })
  })
}
function errorText(value: { messages: Record<string, unknown>[]; stderr: string }): string {
  return String(value.messages.at(-1)?.error ?? value.stderr)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'runtime cli with spaces '))
  const repository = path.join(root, 'project')
  const backlogRoot = path.join(root, 'workspace')
  mkdirSync(repository); mkdirSync(backlogRoot)
  for (const args of [['init', '-q'], ['config', 'user.name', 'CLI Fixture'], ['config', 'user.email', 'cli@example.invalid']]) {
    const git = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
    if (git.status !== 0) throw new Error(git.stderr)
  }
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  for (const args of [['add', '.'], ['commit', '-qm', 'baseline']]) {
    const git = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
    if (git.status !== 0) throw new Error(git.stderr)
  }
  context = {
    schemaVersion: 1, runId: 'cli-fixture', backlogRoot, artifactRoot: repository, artifactRepositoryId: 'project',
    repositories: [{ id: 'project', name: 'Project', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 'cli-feature', title: 'CLI feature', description: 'Return 2', repositoryIds: ['project'] }],
  }
  config = {
    schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }],
    agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } },
    verification: [{ repositoryId: 'project', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(8)'] }],
  }
  contextFile = path.join(root, 'frozen context.json')
  configFile = path.join(root, 'runtime config.json')
  writeFileSync(contextFile, JSON.stringify(context))
  writeFileSync(configFile, JSON.stringify(config))
})
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  rmSync(root, { recursive: true, force: true })
})

describe('packaged programmatic runtime CLI', () => {
  it('prints JSON help and validates a config through the packaged dispatcher', async () => {
    const help = await invoke(['help'])
    expect(help.code, help.stderr).toBe(0)
    expect(help.messages[0]?.usage).toContain('specrails-core runtime validate --config <json>')
    const validation = await invoke(['validate', '--config', configFile])
    expect(validation.code, validation.stderr).toBe(0)
    expect(validation.messages).toEqual([{ type: 'runtime-config-valid', schemaVersion: 1 }])
  })

  it('reports a missing run through status without creating workflow state', async () => {
    const status = await invoke(['status', '--context', contextFile])
    expect(status.code, status.stderr).toBe(0)
    expect(status.messages).toEqual([{ type: 'runtime-status', state: null, pipeline: null }])
    expect(existsSync(path.join(pipelineStateDirectory(context), 'agent-workflow'))).toBe(false)
    expect((await invoke(['status', '--context', contextFile, '--compact'])).messages).toEqual(status.messages)
  })

  it('negotiates the runtime API without creating a workflow or contacting providers', async () => {
    const api = await invoke(['api'])
    expect(api.code, api.stderr).toBe(0)
    expect(api.messages).toEqual([{ type: 'runtime-api', apiVersion: 1, coreVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) }])
    expect(existsSync(pipelineStateDirectory(context))).toBe(false)
  })

  it('validates bounded configuration JSON over stdin without a temporary config file', async () => {
    rmSync(configFile)
    const validated = await invoke(['validate', '--stdin'], JSON.stringify(config))
    expect(validated.code, validated.stderr).toBe(0)
    expect(validated.messages).toEqual([{ type: 'runtime-config-valid', schemaVersion: 1 }])
    const malformed = await invoke(['validate', '--stdin'], '{')
    expect(malformed.code).toBe(1)
    const excessive = await invoke(['validate', '--stdin'], ' '.repeat(2 * 1024 * 1024 + 1))
    expect(excessive.code).toBe(1)
    expect(errorText(excessive)).toContain('exceeds 2 MiB')
    const ambiguous = await invoke(['validate', '--stdin', '--config', configFile], JSON.stringify(config))
    expect(ambiguous.code).toBe(1)
    expect(errorText(ambiguous)).toContain('not both')
  })

  it('returns clear nonzero errors for invalid config and unavailable resume', async () => {
    writeFileSync(configFile, JSON.stringify({ ...config, agents: { ...config.agents, architect: { provider: 'missing' } } }))
    const invalid = await invoke(['validate', '--config', configFile])
    expect(invalid.code).toBe(1)
    expect(errorText(invalid)).toContain('agents.architect.provider')
    const missing = await invoke(['resume', '--context', contextFile])
    expect(missing.code).toBe(1)
    expect(errorText(missing)).toContain('No programmatic run')
  })

  it('validates command names and required flags in the programmatic entry point', async () => {
    await expect(runRuntimeCommand({}, ['invalid'])).rejects.toThrow('Unknown runtime operation')
    await expect(runRuntimeCommand({}, ['validate'])).rejects.toThrow('Missing --config')
    const output: unknown[] = []
    expect(await runRuntimeCommand({}, [], item => output.push(item))).toBe(0)
    expect(output).toHaveLength(1)
  })

  it('completes a real local-provider CLI run, freezes config, and resumes approval with zero agent replay', async () => {
    const requests: { system: string; authorization: string | undefined }[] = []
    server = createServer(async (request, response) => {
      try {
        let raw = ''
        for await (const chunk of request) raw += String(chunk)
        const body = JSON.parse(raw) as { messages: { role: string; content: string }[] }
        const system = body.messages[0]!.content
        requests.push({ system, authorization: request.headers.authorization })
        let message: Record<string, unknown>
        if (system.includes('architect task')) {
          message = { role: 'assistant', content: JSON.stringify({
            proposal: '# CLI feature', design: '# Return the frozen value', tasks: [{ title: 'Implement feature' }],
            specs: [{ name: 'feature', content: '# Feature\n## Requirement: Requested value\n### Scenario: Read value\n- Return 2.\n' }], confidence: 'high',
          }) }
        } else if (system.includes('developer task') && !body.messages.some(item => item.role === 'tool')) {
          message = { role: 'assistant', content: null, tool_calls: [
            { id: 'write-code', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'code.cjs', content: 'module.exports = 2\n' }) } },
            { id: 'complete-task', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'openspec/changes/cli-feature/tasks.md', content: '- [x] 1. Implement feature\n' }) } },
          ] }
        } else if (system.includes('developer task')) message = { role: 'assistant', content: 'Implemented feature and completed the task' }
        else message = { role: 'assistant', content: JSON.stringify({
          approved: true, summary: 'Reviewed the exact verified candidate', issues: [], score: 90,
          aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
        }) }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0 } }))
      } catch (error) { response.writeHead(500); response.end(String(error)) }
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture server address')
    config.providers = [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1` }]
    config.agents = { architect: { provider: 'local', model: 'fixture-local' }, developer: { provider: 'local', model: 'fixture-local' }, reviewer: { provider: 'local', model: 'fixture-local' } }
    config.approvalBeforeArchive = true
    writeFileSync(configFile, JSON.stringify(config))
    const run = await invoke(['run', '--context', contextFile, '--config', configFile, '--change', 'cli-feature'])
    expect(run.code, JSON.stringify(run.messages.at(-1)) + run.stderr).toBe(2)
    expect(run.messages.at(-1)).toMatchObject({ type: 'runtime-result', status: 'paused', pendingApproval: { stepId: 'archive' }, invocationUsage: { inputTokens: 40, outputTokens: 20, costUsd: 0 } })
    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.authorization === undefined)).toBe(true)
    const requestFile = path.join(pipelineStateDirectory(context), 'agent-runtime-request.json')
    expect(JSON.parse(readFileSync(requestFile, 'utf8'))).toEqual({ change: 'cli-feature', config })

    const forbidden = await invoke(['resume', '--context', contextFile, '--config', configFile])
    expect(forbidden.code).toBe(1)
    expect(errorText(forbidden)).toContain('frozen configuration')
    const changedRun = await invoke(['run', '--context', contextFile, '--config', configFile, '--change', 'different-change'])
    expect(changedRun.code).toBe(1)
    expect(errorText(changedRun)).toContain('configuration changed')
    const invalidApproval = await invoke(['resume', '--context', contextFile, '--approve'])
    expect(invalidApproval.code).toBe(1)
    expect(errorText(invalidApproval)).toContain('comma-separated step IDs')
    const status = await invoke(['status', '--context', contextFile])
    expect(status.messages[0]).toMatchObject({ type: 'runtime-status', state: { status: 'paused' }, pipeline: { verification: { valid: true } } })

    // Removing the original config file proves resume reads its frozen request.
    rmSync(configFile)
    const resume = await invoke(['resume', '--context', contextFile, '--approve', 'archive'])
    expect(resume.code, JSON.stringify(resume.messages.at(-1)) + resume.stderr).toBe(0)
    expect(resume.messages.at(-1)).toMatchObject({ status: 'succeeded', invocationUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    expect(requests).toHaveLength(4)
    expect(existsSync(path.join(context.artifactRoot, 'openspec', 'specs', 'feature', 'spec.md'))).toBe(true)
    expect(existsSync(path.join(context.artifactRoot, 'openspec', 'changes', 'cli-feature'))).toBe(false)
  })
})
