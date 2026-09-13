import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EVALUATION_CORPUS, type EvaluationCase } from './evaluation-corpus.js'
import { fingerprint } from './durable-store.js'
import { runCoreWorkflow, coreRuntimeIdentity } from './core-host.js'
import { ExecutorRegistry } from './executors.js'
import { OpenSpecTools } from './openspec.js'
import { validatePipelineContext, type PipelineContext } from '../installer/runtime/pipeline-state.js'
import type { AgentRequest, RuntimeConfig } from './executor-types.js'
import { runtimeEfficiency } from './efficiency.js'

export interface EvaluationOptions { output: string; config?: RuntimeConfig; maxCostUsd?: number; real?: boolean; repetitions?: number }
function oracle(test: EvaluationCase, file: string): boolean {
  return spawnSync(process.execPath, ['-e', 'const assert = require("node:assert/strict"); const api = require(process.argv[1]);' + test.oracle, file], { encoding: 'utf8', timeout: 10000 }).status === 0
}
function prepare(test: EvaluationCase, root: string): PipelineContext {
  const repositories = test.repositories.map(id => {
    const directory = path.join(root, id); mkdirSync(directory)
    writeFileSync(path.join(directory, 'implementation.cjs'), test.source)
    writeFileSync(path.join(directory, 'AGENTS.md'), '# Repository guidance\n' + 'Keep public behavior stable. Follow the existing implementation.cjs convention.\n'.repeat(180))
    execFileSync('git', ['init', '-q', directory])
    execFileSync('git', ['-C', directory, 'add', '.'])
    execFileSync('git', ['-C', directory, '-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.invalid', 'commit', '-qm', 'frozen fixture'])
    return { id, name: id, path: directory, baseSha: execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  })
  return validatePipelineContext({ schemaVersion: 1, runId: randomUUID(), backlogRoot: root, artifactRoot: repositories[0]!.path, artifactRepositoryId: repositories[0]!.id, repositories, ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: test.id, description: test.description + ' Implement behavior in implementation.cjs in every selected repository.', repositoryIds: test.repositories, acceptanceCriteria: [test.description] }] })
}
function fixtureRegistry(test: EvaluationCase, context: PipelineContext): ExecutorRegistry {
  let developers = 0, reviews = 0
  const sessions = new Map<string, string[]>()
  return new ExecutorRegistry().register('fixture', {
    capabilities: () => ({ transport: 'offline-fixture', continuation: 'supported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request: AgentRequest) {
      const sessionId = 'fixture-' + request.role
      if (request.resumeSessionId && !sessions.has(request.resumeSessionId)) throw new Error('Fixture session was not restored')
      const history = sessions.get(sessionId) ?? []; history.push(request.prompt); sessions.set(sessionId, history)
      const tools = new OpenSpecTools(request.openspec!)
      await tools.execute({ action: 'load_skill' })
      let output: object
      if (request.role === 'architect') {
        await tools.execute({ action: 'new' })
        const artifacts = [
          ['proposal', 'proposal.md', `## Why\n${test.description}\n## What Changes\n- Implement the requested behavior.\n## Capabilities\n### New Capabilities\n- \`fixture-behavior\`: ${test.description}\n### Modified Capabilities\nNone.\n## Impact\nSelected repositories.\n`],
          ['design', 'design.md', `## Context\n${test.description}\n## Decisions\nUse the existing implementation.cjs pattern and keep the public function boundary.`],
          ['specs', 'specs/fixture-behavior/spec.md', `## ADDED Requirements\n### Requirement: Requested behavior\nThe implementation SHALL satisfy the frozen behavior.\n#### Scenario: Supported input\n- **WHEN** a supported input is supplied\n- **THEN** the expected value is returned without losing required ordering or boundary behavior\n`],
          ['tasks', 'tasks.md', '## 1. Implementation\n- [ ] 1.1 Implement and test the requested behavior\n'],
        ]
        for (const [artifact, file, content] of artifacts) { await tools.execute({ action: 'instructions', artifact }); await tools.execute({ action: 'write_artifact', path: file, content }) }
        output = { confidence: 'high', planningDepth: context.repositories.length > 1 ? 'full' : 'focused', referencePatterns: ['implementation.cjs'], riskFlags: [], verification: [] }
      } else {
        await tools.execute({ action: 'instructions', artifact: 'apply' })
        if (request.role === 'developer') {
          developers++
          for (const repo of context.repositories) writeFileSync(path.join(repo.path, 'implementation.cjs'), test.correction && developers === 1 ? test.defects[0]! : test.solution)
          writeFileSync(path.join(context.artifactRoot, 'openspec/changes/evaluation-change/tasks.md'), '## 1. Implementation\n- [x] 1.1 Implement and test the requested behavior\n')
          output = { summary: 'Implemented fixture behavior', files: ['implementation.cjs'], tests: [], verification: 'Core executes the frozen checks', incomplete: [] }
        } else {
          reviews++
          const approved = !(test.correction === 'review' && reviews === 1)
          output = { approved, summary: approved ? 'Behavior reviewed' : 'Stable order is missing', issues: approved ? [] : ['Preserve original order'], score: approved ? 95 : 50, aspects: Object.fromEntries(['type_correctness', 'pattern_adherence', 'test_coverage', 'security', 'architectural_alignment'].map(key => [key, approved ? 95 : 50])), acceptance: { criteria: [{ specId: '1', criterionIndex: 0, status: approved ? 'met' : 'blocked', evidence: ['implementation.cjs inspected against frozen behavior'] }], checks: [], findings: [] } }
        }
      }
      return { text: JSON.stringify(output), structuredOutput: output, sessionId, usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 100, costUsd: 0 } }
    },
  })
}

export async function runEvaluation(options: EvaluationOptions) {
  const repetitions = options.repetitions ?? 1
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('Evaluation repetitions must be 1–20')
  if (options.real && (!options.config || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd! <= 0 || Object.values(options.config.agents).some(role => !role.model))) throw new Error('Real evaluation requires explicit per-role models and a positive aggregate spend limit')
  const identity = coreRuntimeIdentity()
  const observations: Array<Record<string, unknown>> = []
  let spend = 0, stopReason: string | null = null
  const root = mkdtempSync(path.join(tmpdir(), 'specrails-evaluation-'))
  try {
    for (let repeat = 0; repeat < repetitions && !stopReason; repeat++) for (const test of EVALUATION_CORPUS) {
      // Check the independent oracle itself against defective candidates.
      const probe = path.join(root, 'oracle-probe.cjs')
      writeFileSync(probe, test.solution)
      if (!oracle(test, probe)) throw new Error('Acceptance oracle rejects reference solution: ' + test.id)
      for (const defect of test.defects) { writeFileSync(probe, defect); if (oracle(test, probe)) throw new Error('Acceptance oracle admits defective variant: ' + test.id) }
      const order = options.real && Math.random() < 0.5 ? ['optimized', 'full'] : ['full', 'optimized']
      for (const mode of order) {
        if (stopReason) break
        const workspace = path.join(root, `${test.id}-${repeat}-${mode}`); mkdirSync(workspace)
        const context = prepare(test, workspace)
        const base = options.config ?? { schemaVersion: 1, enabled: true, providers: [], agents: { architect: { provider: 'fixture', model: 'fixture' }, developer: { provider: 'fixture', model: 'fixture' }, reviewer: { provider: 'fixture', model: 'fixture' } }, verification: [] }
        const config: RuntimeConfig = { ...structuredClone(base), approvalBeforeArchive: false, efficiency: { schemaVersion: 1, contextMode: mode === 'full' ? 'full' : 'incremental', reviewMode: mode === 'full' ? 'full' : 'incremental', planning: mode === 'full' ? 'full' : 'proportional', verification: { maxConcurrency: 1 } }, limits: { ...base.limits, maxAttempts: 3, timeoutMs: 300000, ...(options.real ? { maxCostUsd: options.maxCostUsd! - spend } : {}) }, verification: context.repositories.map(repo => ({ repositoryId: repo.id, command: process.execPath, args: ['-e', 'const assert = require("node:assert/strict"); const api = require("./implementation.cjs");' + (test.verification ?? '')] })) }
        if (options.real && config.limits!.maxCostUsd! <= 0) { stopReason = 'Aggregate spend limit reached'; break }
        const started = Date.now()
        let state
        try { state = await runCoreWorkflow({ context, change: 'evaluation-change', config, ...(options.real ? {} : { registry: fixtureRegistry(test, context) }) }) }
        catch (error) { observations.push({ caseId: test.id, repeat, mode, status: 'blocked', independentAccepted: false, error: error instanceof Error ? error.message : String(error), runtimeIdentity: identity, taskHash: fingerprint(test), oracleHash: fingerprint(test.oracle), repositories: context.repositories.map(({ id, baseSha }) => ({ id, baseSha })), configHash: fingerprint(config) }); stopReason = 'Runtime preflight failed; experiment stopped without retry'; break }
        const accepted = context.repositories.every(repo => oracle(test, path.join(repo.path, 'implementation.cjs')))
        const metrics = runtimeEfficiency(state)
        const calls = state.history.flatMap(attempt => attempt.invocations ?? [])
        observations.push({ caseId: test.id, repeat, mode, order, taskHash: fingerprint(test), oracleHash: fingerprint(test.oracle), repositories: context.repositories.map(({ id, baseSha }) => ({ id, baseSha })), configHash: fingerprint(config), runtimeIdentity: identity, cacheState: 'uncontrolled-provider-cache; fresh workspace and role sessions', status: state.status, independentAccepted: accepted && state.status === 'succeeded', activeDurationMs: Date.now() - started, metrics, invocations: calls.map(call => ({ kind: call.kind, promptBytes: call.promptBytes, provider: call.provider, model: call.model, status: call.status })), failures: state.history.filter(attempt => attempt.status !== 'succeeded' || (attempt.output as { valid?: boolean; approved?: boolean } | undefined)?.valid === false || (attempt.output as { approved?: boolean } | undefined)?.approved === false).map(attempt => ({ role: attempt.stepId, status: attempt.status, error: attempt.error ?? null })) })
        if (options.real) {
          if (metrics.total.costUsd === null) stopReason = 'Billing incomplete; monetary comparison is inconclusive and further spend is stopped'
          else spend += metrics.total.costUsd
        }
      }
      if (stopReason) break
    }
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null }
    const groups = Object.fromEntries(['full', 'optimized'].map(mode => {
      const rows = observations.filter(row => row.mode === mode)
      const accepted = rows.filter(row => row.independentAccepted).length
      const costs = rows.map(row => (row.metrics as ReturnType<typeof runtimeEfficiency> | undefined)?.total.costUsd)
      const knownCost = costs.every(value => typeof value === 'number') ? costs.reduce<number>((sum, value) => sum + value!, 0) : null
      const durations = rows.flatMap(row => typeof row.activeDurationMs === 'number' ? [row.activeDurationMs] : [])
      const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null
      return [mode, { samples: rows.length, independentlyAccepted: accepted, costPerAcceptedUsd: options.real && knownCost !== null && accepted ? knownCost / accepted : null, medianActiveDurationMs: median(durations), minActiveDurationMs: durations.length ? Math.min(...durations) : null, maxActiveDurationMs: durations.length ? Math.max(...durations) : null, standardDeviationMs: average === null ? null : Math.sqrt(durations.reduce((sum, value) => sum + (value - average) ** 2, 0) / durations.length) }]
    }))
    const full = groups.full!, optimized = groups.optimized!
    const paired = observations.length === EVALUATION_CORPUS.length * repetitions * 2 && full.samples === optimized.samples
    const noObservedQualityDrop = paired && optimized.independentlyAccepted >= full.independentlyAccepted
    const promptPairs = observations.filter(row => row.mode === 'full' && row.caseId === 'verification-correction').map(row => {
      const other = observations.find(item => item.mode === 'optimized' && item.caseId === row.caseId && item.repeat === row.repeat)
      const correction = (value: Record<string, unknown> | undefined) => (value?.invocations as Array<{ kind?: string; promptBytes?: number }> | undefined)?.find(call => call.kind === 'correction')?.promptBytes
      const before = correction(row), after = correction(other)
      return { caseId: row.caseId, repeat: row.repeat, fullBytes: before ?? null, optimizedBytes: after ?? null, reduction: before && after !== undefined ? 1 - after / before : null }
    })
    const noExtraInvocations = paired && observations.filter(row => row.mode === 'full').every(row => {
      const other = observations.find(item => item.mode === 'optimized' && item.caseId === row.caseId && item.repeat === row.repeat)
      return Array.isArray(row.invocations) && Array.isArray(other?.invocations) && other.invocations.length <= row.invocations.length
    })
    const monetaryConclusion = options.real && paired && full.costPerAcceptedUsd !== null && optimized.costPerAcceptedUsd !== null && full.costPerAcceptedUsd > 0 ? optimized.costPerAcceptedUsd <= full.costPerAcceptedUsd * 0.8 && noObservedQualityDrop ? 'target-met-in-this-sample' : 'target-not-met-in-this-sample' : 'inconclusive'
    const report = { schemaVersion: 1, experiment: Object.values(options.config?.agents ?? {}).some(role => role.escalation) ? 'routing' : 'same-model', noExtraInvocations, mode: options.real ? 'real' : 'offline', runtimeIdentity: identity, corpusHash: fingerprint(EVALUATION_CORPUS), measurement: options.real ? 'reported-provider-usage' : 'synthetic-fixture-usage; no actual AI savings measured', monetaryTarget: 0.2, monetaryConclusion, groups, noObservedQualityDrop, promptPairs, correctionPromptTargetMet: promptPairs.length > 0 && promptPairs.every(pair => pair.reduction !== null && pair.reduction >= 0.4), sampleLimitations: 'Small descriptive paired sample; does not establish a universal quality or savings guarantee.', stopReason, reportedSpendUsd: options.real ? spend : 0, observations }
    mkdirSync(options.output, { recursive: true })
    writeFileSync(path.join(options.output, 'evaluation.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(path.join(options.output, 'evaluation.md'), `# Implementation efficiency evaluation\n\nMode: ${report.mode}. ${report.measurement}.\n\nMonetary target: 20% lower aggregate cost per independently accepted output. Conclusion: ${monetaryConclusion}.\n\n${JSON.stringify(groups, null, 2)}\n\nCorrection prompt comparison: ${JSON.stringify(promptPairs)}\n\n${observations.map(row => `- ${row.caseId}, ${row.mode}: ${row.status}; independent acceptance ${row.independentAccepted}; ${row.activeDurationMs} ms`).join('\n')}\n\n${stopReason ?? (options.real ? report.sampleLimitations : 'No paid benchmark has established monetary savings.')}\n`)
    return report
  } finally { rmSync(root, { recursive: true, force: true }) }
}
