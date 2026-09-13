// Generate contract examples through the built projection. These are synthetic wire fixtures.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { efficiencySummary } from '../dist/agent-runtime/efficiency-summary.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'efficiency-fixtures-'))
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value)
const hash = value => createHash('sha256').update(value).digest('hex')
const fixtures = {}
try {
  for (const name of ['success', 'correction-success', 'failure', 'reuse', 'invalidation', 'incomplete-metrics', 'unavailable-evidence']) {
    const usage = { costUsd: null, inputTokens: 100, outputTokens: 10 }
    const call = { invocationId: name + ':call:1', ordinal: 1, provider: 'fixture', model: 'base', status: 'succeeded', durationMs: 12, toolCalls: 0, usage, kind: 'initial', promptBytes: 100, contextBytes: 80, handoffBytes: 20, contextMode: 'full', tier: 'base', requestedEffort: null }
    const history = [{ id: name + ':attempt:1', stepId: 'developer', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', usage, invocations: [call] }]
    if (name === 'correction-success') history.push({ ...history[0], id: name + ':attempt:2', invocations: [{ ...call, invocationId: name + ':call:2', ordinal: 2, kind: 'correction', promptBytes: 40, contextBytes: 20, contextMode: 'incremental' }] })
    if (name === 'incomplete-metrics') { history[0].pendingInvocations = [{ ...call, invocationId: name + ':call:2', ordinal: 2 }]; history[0].status = 'interrupted' }
    const state = { runId: name, workflowVersion: '5', status: name === 'failure' ? 'failed' : 'succeeded', history, usage: { ...usage, durationMs: 1000 } }
    const planHash = hash('plan'), candidateHash = hash('candidate'), id = hash(name)
    const summary = { schemaVersion: 1, runId: name, id, checkId: 'check', executionId: id, repositoryId: 'backend-2', label: 'Contract example', status: name === 'failure' ? 'failed' : 'passed', disposition: name === 'reuse' ? 'reused' : 'executed', durationMs: name === 'reuse' ? 0 : 5, planHash, candidateHash: name === 'invalidation' ? hash('old') : candidateHash, sources: [] }
    if (name !== 'unavailable-evidence') {
      const dir = path.join(root, '.specrails/pipeline', name, 'verification/evidence-index'); fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(path.join(root, '.specrails/pipeline', name, 'verification/evidence'))
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ summary, integrity: hash(canonical(summary)) }))
    }
    fixtures[name] = efficiencySummary(state, { runId: name, backlogRoot: root }, { agents: Object.fromEntries(['architect','developer','reviewer'].map(role => [role,{provider:'fixture',model:'base'}])) }, { validation: name === 'failure' ? 'blocked' : 'verified', archive: 'pending', delivery: 'pending-host' }, { planHash, candidateHash, verification: { receipt: { commands: [{ evidenceId: id }] } } })
  }
  fs.mkdirSync('schemas/fixtures', { recursive: true })
  fs.writeFileSync('schemas/fixtures/runtime-efficiency-summary.v1.json', JSON.stringify({ schemaVersion: 1, synthetic: true, fixtures }, null, 2) + '\n')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
