import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import type { AgentRequest, AgentResult, RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import { createRun, definitionRunDirectory, resumeRun } from '../runs.js'

/*
 * Executable reference definitions for the legacy fix loop (Freestyle) and a
 * verify/fix repair. Providers are deterministic local executors; host checks,
 * SQLite, decisions and policies are real.
 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
type Reply = AgentResult | ((request: AgentRequest) => AgentResult | Promise<AgentResult>)
const usage = { inputTokens: 10, outputTokens: 5, costUsd: null }
const decision = (verdict: 'continue' | 'stop', reason = verdict === 'stop' ? 'Every criterion is met' : 'More work remains'): AgentResult =>
  ({ text: JSON.stringify({ verdict, reason }), usage })

function setup(runId: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'reference loop ')); roots.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 1\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Return two', description: 'value.cjs returns two' }] })
  const role = { provider: 'fixture' }
  // Loops decide with a read-only custom role, as Desktop binds `loop-decider`;
  // the built-in reviewer is an OpenSpec verification role.
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role },
    roles: { 'loop-decider': { ...role, access: 'read', artifacts: 'none' } },
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./value.cjs")!==2)process.exit(1)'] }] }
  const write = (value: number) => writeFileSync(path.join(repository, 'value.cjs'), `module.exports = ${value}\n`)
  return { context, config, repository, write, change: 'reference-change' }
}
function registry(plan: Reply[], requests: AgentRequest[]) {
  return new ExecutorRegistry().register('fixture', { async execute(request) {
    requests.push(request)
    const next = plan[requests.length - 1]
    if (!next) throw new Error(`Unexpected invocation ${requests.length}: ${requests.map(item => item.role).join(", ")}`)
    return typeof next === 'function' ? await next(request) : next
  } })
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}.json`, import.meta.url), 'utf8'))
const kinds = (requests: AgentRequest[]) => requests.map(request => request.role)

it('Freestyle stops after verified work with one decision', async () => {
  const f = setup('freestyle-pass'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('freestyle'), registry: registry([
    () => { f.write(2); return { text: 'Implemented', usage } }, decision('stop')], requests) })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(kinds(requests)).toEqual(['prompt', 'loop-decider'])
})

it('Freestyle repairs a failed host check before deciding', async () => {
  const f = setup('freestyle-fix'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('freestyle'), registry: registry([
    { text: 'Claims VERIFICATION: PASS without the change', usage },
    () => { f.write(2); return { text: 'Fixed', usage } }, decision('stop')], requests) })
  expect(result).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  // A model's PASS text cannot bypass the failed host check.
  expect(kinds(requests)).toEqual(['prompt', 'prompt', 'loop-decider'])
  expect(requests[1].prompt).toContain('Repair the reported failures')
})

it('Freestyle follows a continue verdict into another fix pass', async () => {
  const f = setup('freestyle-continue'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('freestyle'), registry: registry([
    () => { f.write(2); return { text: 'Implemented part', usage } }, decision('continue'),
    { text: 'Completed the remaining criterion', usage }, decision('stop')], requests) })
  expect(result).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(kinds(requests)).toEqual(['prompt', 'loop-decider', 'prompt', 'loop-decider'])
})

it('Freestyle stops a loop that makes no progress instead of reporting success', async () => {
  const f = setup('freestyle-stall'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('freestyle'), registry: registry([
    () => { f.write(2); return { text: 'Implemented', usage } }, decision('continue'),
    { text: 'Nothing changed', usage }, decision('continue'),
    { text: 'Nothing changed', usage }, decision('continue'),
    { text: 'Nothing changed', usage }, decision('continue')], requests) })
  expect(result.completion?.ok).not.toBe(true)
  // Bounded by the decider's no-progress limit, far below maxTransitions.
  expect(requests.length).toBeLessThanOrEqual(6)
})

it('Freestyle fails fast after consecutive provider failures', async () => {
  const f = setup('freestyle-failfast'), requests: AgentRequest[] = []
  const fail = () => { throw new Error('Provider unavailable') }
  const result = await createRun({ ...f, definition: fixture('freestyle'), registry: registry([fail, fail, fail, fail], requests) })
  expect(result.state.status).toBe('failed')
  expect(requests.length).toBeLessThanOrEqual(2)
})

it('Freestyle pauses for a human answer and repeats the blocked work with it', async () => {
  const f = setup('freestyle-question'), requests: AgentRequest[] = []
  const reg = registry([{ text: 'LOOP_BLOCKED: Which value should be returned?', usage },
    request => { expect(request.prompt).toContain('Return two'); f.write(2); return { text: 'Implemented', usage } }, decision('stop')], requests)
  let result = await createRun({ ...f, definition: fixture('freestyle'), registry: reg })
  expect(result.state.status).toBe('paused')
  result = await resumeRun(definitionRunDirectory(f.context), { registry: reg, answers: { [result.state.pendingInterrupts[0].id]: { answer: 'Return two' } } })
  expect(result).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(kinds(requests)).toEqual(['prompt', 'prompt', 'loop-decider'])
})

it('verify-fix succeeds without any AI call when checks already pass', async () => {
  const f = setup('verify-fix-pass'), requests: AgentRequest[] = []
  f.write(2)
  const result = await createRun({ ...f, definition: fixture('verify-fix'), registry: registry([], requests) })
  expect(result).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(requests).toHaveLength(0)
})

it('verify-fix repairs the actual failure with a write prompt', async () => {
  const f = setup('verify-fix-repair'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('verify-fix'), registry: registry([() => { f.write(2); return { text: 'Repaired', usage } }], requests) })
  expect(result).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(kinds(requests)).toEqual(['prompt'])
  expect(requests[0].prompt).toContain('Repair the actual verification failures')
})

it('verify-fix stops after two repairs that never fix the failure', async () => {
  const f = setup('verify-fix-stall'), requests: AgentRequest[] = []
  const result = await createRun({ ...f, definition: fixture('verify-fix'), registry: registry(Array.from({ length: 60 }, () => ({ text: 'Tried again', usage })), requests) })
  expect(result.state.status).toBe('failed')
  expect(result.completion?.ok).not.toBe(true)
  // Exactly the two allowed repairs, never an unbounded verify/repair cycle.
  expect(kinds(requests)).toEqual(['prompt', 'prompt'])
})
