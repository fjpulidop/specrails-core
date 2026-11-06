import { OpenSpecTools } from './openspec.js'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { runCoreWorkflow } from './core-host.js'
import { type AgentRequest, type AgentResult } from './executor-types.js'
import { inspectPipeline, pipelineStateDirectory } from '../pipeline/pipeline-state.js'
import { efficiencySummary } from './efficiency-summary.js'
import { acceptance, active, architecture, archivedChangeFile, change, config, context, develop, fake, git, journalFile, opts, result, review, root, write } from './__tests__/core-host-fixture.js'

describe('programmatic Core host with real evidence gates', () => {
  it('completes coverage with architect-proposed commands and admits repositories without any check', async () => {
    config.verification = config.verification.slice(0, 1)
    const proposed = { repositoryId: 'back', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);process.stdout.write("proposed check passed")'] }
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') { expect(request.prompt).toContain('already configured by the host'); return result({ ...architecture, verification: [proposed, { ...proposed, repositoryId: 'front' }] }) }
      if (request.role === 'developer') { expect(request.prompt).toContain('proposed check passed'.length ? 'repository `back`' : ''); develop(); return result('Done') }
      return result(review)
    })
    let output = ''
    const state = await runCoreWorkflow(opts(registry, { onVerificationOutput: text => { output += text } }))
    expect(state.status, state.error).toBe('succeeded')
    expect(output).toContain('proposed check passed')
    expect(output).toContain('real verification passed')
    expect(calls[2]!.prompt).toContain('All verification commands passed')
    // A proposal for an already-configured repository is ignored, never duplicated.
    expect(inspectPipeline(context).verification.receipt?.commands.map(command => command.repositoryId)).toEqual(['front', 'back'])
    rmSync(root, { recursive: true, force: true })
  })

  it('runs without any verification command and tells the reviewer which repositories were unverified', async () => {
    config.verification = []
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls[2]!.prompt).toContain('No automated verification command was available')
    expect(calls[2]!.prompt).toContain('`front`, `back`')
    const receipt = inspectPipeline(context).verification.receipt!
    expect(receipt.commands).toEqual([])
    expect(receipt.unverifiedRepositories).toEqual(['front', 'back'])
    expect(inspectPipeline(context).verification.valid).toBe(true)
  })

  it('rejects architecture changes made by a developer despite passing tests', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      develop()
      write(active('design.md'), '# Weakened design introduced during implementation')
      return result('Done')
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Architecture artifacts changed')
  })

  it('refuses reviewer approval for a candidate modified after verification', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      write(path.join(context.repositories[1]!.path, 'code.cjs'), 'module.exports = 3\n')
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Fresh full verification required')
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })

  it('does not let an archive observer change the exact reviewed candidate', async () => {
    const { registry } = fake()
    const state = await runCoreWorkflow(opts(registry, { onEvent: event => {
      if (event.type === 'step_started' && event.stepId === 'archive') write(path.join(context.artifactRoot, 'code.cjs'), 'module.exports = 3\n')
    } }))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Archive blocked')
    expect(existsSync(active())).toBe(true)
  })

  it('pauses a low-confidence design on its question and resumes the architect with the answer', async () => {
    const question = 'Should both repositories share one module?'
    const answered: string[] = []
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') {
        if (request.prompt.includes('## Answers from the requester')) { answered.push(request.prompt); return result(architecture) }
        return result({ ...architecture, confidence: 'low', question })
      }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const paused = await runCoreWorkflow(opts(registry))
    expect(paused.status).toBe('paused')
    expect(paused.error).toBe(question)
    expect(paused.pendingQuestion).toMatchObject({ stepId: 'architect', question })
    // The single investigation pass also works without a provider session.
    expect(calls).toHaveLength(2)
    expect(readFileSync(active('proposal.md'), 'utf8')).toContain('# Feature')
    expect(JSON.parse(readFileSync(active('design-confidence.json'), 'utf8'))).toEqual({ confidence: 'low', question })
    expect(inspectPipeline(context).phases.architect.status).toBe('blocked')
    expect((await runCoreWorkflow(opts(registry, { resume: true }))).status).toBe('paused')
    expect(calls).toHaveLength(2)
    const state = await runCoreWorkflow(opts(registry, { resume: true, answer: 'Yes, one shared module.' }))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'architect', 'developer', 'reviewer'])
    expect(answered[0]).toContain('1. Yes, one shared module.')
    expect(state.steps.architect?.visits).toBe(1)
    expect(state.pendingQuestion).toBeUndefined()
    expect(JSON.parse(readFileSync(archivedChangeFile('design-confidence.json'), 'utf8'))).toEqual({ confidence: 'high' })
  })

  describe('architect clarifications', () => {
    const blockingQuestion = 'Should archived projects appear in search?'
    const recordFile = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'clarifications.json'), 'utf8'))

    it('pauses before planning on a high-impact question without a safe default and resumes with the answer', async () => {
      const { registry, calls } = fake(async request => {
        if (request.role === 'architect') {
          if (request.prompt.includes('## Answers from the requester')) return result({ ...architecture, design: architecture.design + '## Assumptions\n- Archived projects: excluded, as answered.\n', clarifications: [{ question: blockingQuestion, impact: 'high', default: 'Excluded, as answered' }] })
          // Clarification-only reply: no artifacts are authored before the answer.
          return result({ confidence: 'high', clarifications: [{ question: blockingQuestion, impact: 'high', default: null }, { question: 'Page size?', impact: 'low', default: '25' }] })
        }
        if (request.role === 'developer') { develop(); return result('Done') }
        return result(review)
      })
      const paused = await runCoreWorkflow(opts(registry))
      expect(paused.status).toBe('paused')
      expect(paused.pendingQuestion).toMatchObject({ stepId: 'architect', question: blockingQuestion })
      expect(calls.map(call => call.role)).toEqual(['architect'])
      expect(calls[0]!.prompt).toContain('Clarification policy: ask-on-high')
      expect(existsSync(active('proposal.md'))).toBe(false)
      expect(inspectPipeline(context).phases.architect.status).toBe('blocked')
      expect(recordFile()).toMatchObject({ schemaVersion: 1, change, policy: 'ask-on-high', status: 'awaiting-answers', blocking: [{ question: blockingQuestion, impact: 'high', default: null }], answers: [] })
      const state = await runCoreWorkflow(opts(registry, { resume: true, answer: 'Exclude archived projects.' }))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
      expect(calls[1]!.prompt).toContain('1. Exclude archived projects.')
      expect(recordFile()).toMatchObject({ status: 'proceeded', blocking: [], answers: ['Exclude archived projects.'], assumptions: ['- Archived projects: excluded, as answered.'] })
      expect(state.steps.architect?.output).toMatchObject({ clarifications: [{ question: blockingQuestion, impact: 'high', default: 'Excluded, as answered' }] })
    })

    it('proceeds on low-impact clarifications and records the assumptions written in design.md', async () => {
      const design = architecture.design + '## Assumptions\n- Page size? Assumed 25, as in the projects list.\n'
      const { registry, calls } = fake(async request => request.role === 'architect'
        ? result({ ...architecture, design, clarifications: [{ question: 'Page size?', impact: 'low', default: '25' }] })
        : request.role === 'developer' ? (develop(), result('Done')) : result(review))
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
      expect(recordFile()).toMatchObject({ status: 'proceeded', clarifications: [{ question: 'Page size?', impact: 'low', default: '25' }], blocking: [], assumptions: ['- Page size? Assumed 25, as in the projects list.'] })
    })

    it('proceeds without clarifications and records an empty list', async () => {
      const { registry, calls } = fake()
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
      expect(recordFile()).toMatchObject({ status: 'proceeded', clarifications: [], blocking: [], answers: [], assumptions: [] })
      expect(state.steps.architect?.output).toMatchObject({ clarifications: [] })
    })

    it('never pauses under always-proceed', async () => {
      Object.assign(config, { architect: { clarifications: 'always-proceed' } })
      const design = architecture.design + '## Assumptions\n- Archived projects: excluded by default.\n'
      const { registry, calls } = fake(async request => request.role === 'architect'
        ? result({ ...architecture, design, clarifications: [{ question: blockingQuestion, impact: 'high', default: null }] })
        : request.role === 'developer' ? (develop(), result('Done')) : result(review))
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls[0]!.prompt).toContain('Clarification policy: always-proceed')
      expect(recordFile()).toMatchObject({ policy: 'always-proceed', status: 'proceeded', assumptions: ['- Archived projects: excluded by default.'] })
    })

    it('repairs a design without Non-Goals in the same architect session', async () => {
      let architectCalls = 0
      const { registry, calls } = fake(async request => {
        if (request.role === 'architect') {
          architectCalls++
          if (architectCalls === 1) return { ...result({ ...architecture, design: '# Design\nUpdate both selected repositories.' }), sessionId: 'arch' }
          expect(request.resumeSessionId).toBe('arch')
          expect(request.prompt).toContain('Invalid design.md')
          writeFileSync(active('design.md'), architecture.design)
          return result({ confidence: 'high' })
        }
        return request.role === 'developer' ? (develop(), result('Done')) : result(review)
      })
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    })

    it('fails the architect when the repaired design still has no Non-Goals', async () => {
      let architectCalls = 0
      const { registry } = fake(async request => request.role === 'architect'
        ? (++architectCalls === 1 ? result({ ...architecture, design: '# Design\n## Non-Goals\n<!-- What is explicitly out of scope -->\n' }) : result({ confidence: 'high' }))
        : result(review))
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status).toBe('failed')
      expect(state.error).toContain('Invalid design.md')
    })
  })

  describe('requirement trace', () => {
    const id = 'feature/implement-shared-behavior'
    const traceFile = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'spec-trace.json'), 'utf8'))

    it('asks the developer to tag touched requirements, binds the trace to the receipt and shows it to the reviewer', async () => {
      const { registry, calls } = fake(async request => {
        if (request.role === 'architect') return result(architecture)
        if (request.role === 'developer') {
          develop()
          write(path.join(context.repositories[0]!.path, 'code.test.cjs'), `// spec: ${id}\nrequire('node:assert').equal(require('./code.cjs'), 2)\n`)
          return result('Done')
        }
        return result(review)
      })
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      const developer = calls.find(call => call.role === 'developer')!.prompt
      expect(developer).toContain('## Requirement tags')
      expect(developer).toContain('- `' + id + '`')
      const report = traceFile()
      expect(report).toMatchObject({ schemaVersion: 1, evidence: 'receipt', changes: [change], touched: [id], touchedUndemonstrated: [], requirements: 1 })
      expect(report.receiptId).toBe(journalFile().verification?.id)
      const reviewer = calls.find(call => call.role === 'reviewer')!.prompt
      expect(reviewer).toContain('Requirement trace (advisory, bound to receipt')
      expect(reviewer).toContain('Requirements demonstrated 1/1')
      expect(reviewer).toContain('Every requirement this change adds or modifies is demonstrated.')
      expect(reviewer).toContain('9. Spec claims')
      expect(journalFile().acceptance?.findings).toContain(`Spec trace (advisory, receipt ${String(report.receiptId)}): Requirements demonstrated 1/1; touched by this change 1/1.`)
      expect(journalFile().acceptance?.checks.some(check => check.name.includes('trace'))).toBe(false)
    })

    it('reports an untagged requirement to the reviewer without failing verification', async () => {
      const { registry, calls } = fake()
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(traceFile()).toMatchObject({ touchedUndemonstrated: [id], undemonstrated: [{ id, reason: 'no-test' }] })
      expect(calls.find(call => call.role === 'reviewer')!.prompt).toContain(`Not demonstrated by a tagged test that a passing verification command ran: ${id} (no-test).`)
      expect(inspectPipeline(context).completion.validation).toBe('verified')
    })
  })

  describe('baseline on touch', () => {
    const radius = '## Blast radius\n- `code.cjs`: returns 2\n- `back:code.cjs`: returns 2\n'
    const touching = { ...architecture, design: architecture.design + radius }
    const baselineFile = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'baseline.json'), 'utf8'))
    const characterize = (value: number) => { for (const repository of context.repositories) write(path.join(repository.path, 'code.test.cjs'), `// spec: legacy-code/returns-the-configured-value\nif (require('./code.cjs') !== ${value}) process.exit(3)\n`) }
    const tick = (prefix: string) => write(active('tasks.md'), readFileSync(active('tasks.md'), 'utf8').replace(`- [ ] ${prefix}`, `- [x] ${prefix}`))
    /** Architect that answers the baseline turn by inserting the Baseline group and an as-built spec. */
    async function architectTurn(request: AgentRequest): Promise<AgentResult> {
      if (!request.prompt.includes('## Baseline before the change')) return result(touching)
      const tools = new OpenSpecTools(request.openspec!)
      await tools.execute({ action: 'instructions', artifact: 'tasks' })
      await tools.execute({ action: 'write_artifact', path: 'tasks.md', content: '## 0. Baseline\n- [ ] 0.1 Characterize code.cjs\n\n## 1. Change\n' + readFileSync(active('tasks.md'), 'utf8') })
      await tools.execute({ action: 'write_artifact', path: 'specs/legacy-code/spec.md', content: '## ADDED Requirements\n### Requirement: Returns the configured value\nThe module SHALL return its configured value.\n#### Scenario: Read\n- **WHEN** required\n- **THEN** it returns the configured value\n' })
      return result({ confidence: 'high' })
    }
    const developerSummary = { summary: 'Characterized', files: [], tests: ['code.test.cjs'], verification: 'none', incomplete: [] }
    beforeEach(() => {
      Object.assign(config, { baselineOnTouch: true, verification: context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['code.test.cjs'] })) })
    })

    it('records the files of each archived change in the capability map', async () => {
      Object.assign(config, { baselineOnTouch: false, verification: context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9)'] })) })
      const state = await runCoreWorkflow(opts(fake().registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(JSON.parse(readFileSync(path.join(context.artifactRoot, 'openspec', 'capability-map.json'), 'utf8'))).toEqual({ schemaVersion: 1, capabilities: { feature: { files: ['back:code.cjs', 'code.cjs'], changes: [change] } } })
      expect(existsSync(path.join(pipelineStateDirectory(context), 'baseline.json'))).toBe(false)
    })

    it('characterizes an uncovered module on the base code before the change, attributing its cost apart', async () => {
      const { registry, calls } = fake(async request => {
        if (request.role === 'architect') return architectTurn(request)
        if (request.role === 'developer' && request.prompt.includes('## Baseline stage (this turn only)')) { characterize(1); tick('0.1'); return result(developerSummary) }
        if (request.role === 'developer') { develop(); characterize(2); return result({ ...developerSummary, summary: 'Implemented', files: ['code.cjs'] }) }
        return result(review)
      })
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'developer', 'reviewer'])
      const record = baselineFile()
      expect(record).toMatchObject({ change, status: 'passed', detection: { uncovered: ['code.cjs', 'back:code.cjs'] }, tests: ['code.test.cjs'] })
      const receipt = JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'receipts', `${String(record.receiptId)}.json`), 'utf8'))
      expect(receipt).toMatchObject({ valid: true })
      expect(calls[3]!.prompt).toContain('## Baseline\n')
      expect(calls[4]!.prompt).toContain('This change started with a Baseline')
      const summary = efficiencySummary(state, context, config)
      expect(summary.invocations.byKind.baseline).toBe(2)
      expect(summary.baseline).toEqual({ invocations: 2, roles: ['architect', 'developer'], costUsd: 0.2, inputTokens: 40, outputTokens: 20 })
    })

    it('stops with a host blocker when the characterization tests fail on the base code', async () => {
      const { registry, calls } = fake(async request => {
        if (request.role === 'architect') return architectTurn(request)
        if (request.role === 'developer') { characterize(2); tick('0.1'); return result(developerSummary) }
        return result(review)
      })
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status).toBe('blocked')
      expect(state.error).toContain('Characterization tests fail on the base code')
      expect(state.error).toContain('(baseline_characterization_failed)')
      expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer'])
      expect(baselineFile()).toMatchObject({ status: 'failed', tests: ['code.test.cjs'] })
      expect(readFileSync(path.join(context.repositories[0]!.path, 'code.cjs'), 'utf8')).toBe('module.exports = 1\n')
    })

    it('stops when the baseline stage edits the module itself', async () => {
      const { registry } = fake(async request => {
        if (request.role === 'architect') return architectTurn(request)
        if (request.role === 'developer') { develop(); characterize(2); return result(developerSummary) }
        return result(review)
      })
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status).toBe('blocked')
      expect(state.error).toContain('The baseline stage changed non-test files (code.cjs')
      expect(baselineFile()).toMatchObject({ status: 'violated' })
    })

    it('adds nothing when a spec already covers the touched module', async () => {
      write(path.join(context.artifactRoot, 'openspec', 'specs', 'value', 'spec.md'), '# value Specification\n\n## Purpose\nThe shared value.\n\n## Requirements\n### Requirement: Value\nThe system SHALL keep the value in code.cjs.\n\n#### Scenario: Read\n- **WHEN** code.cjs is required\n- **THEN** it returns the value\n')
      write(path.join(context.artifactRoot, 'openspec', 'capability-map.json'), JSON.stringify({ schemaVersion: 1, capabilities: { feature: { files: ['back:code.cjs'], changes: ['earlier'] } } }))
      git(context.artifactRoot, ['add', '.']); git(context.artifactRoot, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'specs'])
      for (const repository of context.repositories) { write(path.join(repository.path, 'code.test.cjs'), "if (require('./code.cjs') !== 2) process.exit(3)\n"); git(repository.path, ['add', '.']); git(repository.path, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'test']) }
      const { registry, calls } = fake(async request => request.role === 'architect' ? result(touching) : request.role === 'developer' ? (develop(), result('Done')) : result(review))
      const state = await runCoreWorkflow(opts(registry))
      expect(state.status, state.error).toBe('succeeded')
      expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
      expect(baselineFile()).toMatchObject({ status: 'not-needed', detection: { covered: ['code.cjs', 'back:code.cjs'], uncovered: [] } })
    })
  })

  it('lets the architect investigate once in its own session before anyone is asked', async () => {
    let architectCalls = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') {
        architectCalls++
        if (architectCalls === 1) return { ...result({ ...architecture, confidence: 'low', question: 'Which module owns the value?' }), sessionId: 'arch-session' }
        expect(request.resumeSessionId).toBe('arch-session')
        expect(request.prompt).toContain('confidence was low')
        expect(request.prompt).toContain('Which module owns the value?')
        return { ...result(architecture), sessionId: 'arch-session' }
      }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    expect(state.steps.architect?.output).toMatchObject({ confidence: 'high', assumed: false, deepenPasses: 1 })
    expect(state.pendingQuestion).toBeUndefined()
  })

  it('proceeds on stated assumptions after the investigation when the project prefers autonomy', async () => {
    config.architect = { onLowConfidence: 'proceed' }
    const low = { ...architecture, confidence: 'low', question: 'Which module owns the value?' }
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return { ...result(low), sessionId: 'arch-session' }
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'architect', 'developer', 'reviewer'])
    expect(state.steps.architect?.output).toMatchObject({ confidence: 'low', assumed: true, deepenPasses: 1 })
  })

  it('records acceptance evidence from the reviewer and from Core\'s own verification receipts', async () => {
    const { registry, calls } = fake()
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls[2]!.prompt).toContain('spec `7`, criterion 0: Both repositories return 2')
    const journal = journalFile()
    expect(journal.acceptance?.criteria).toEqual([{ specId: '7', criterionIndex: 0, requirement: 'Both repositories return 2', status: 'met', evidence: ['code.cjs returns 2 in both repositories'] }])
    expect(journal.acceptance?.checks.map(check => [check.name.split(':')[0], check.status, check.required])).toEqual([['front', 'passed', true], ['back', 'passed', true]])
    expect(inspectPipeline(context).completion).toMatchObject({ implementation: 'complete', validation: 'verified', archive: 'done', delivery: 'pending-host' })
  })

  it('asks the reviewer to resend acceptance evidence that does not certify every frozen requirement', async () => {
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      reviews++
      if (reviews === 1) return { ...result({ ...review, acceptance: { criteria: [], checks: [], findings: [] } }), sessionId: 'review-session' }
      expect(request.resumeSessionId).toBe('review-session')
      expect(request.prompt).toContain('Invalid acceptance report')
      return result(review)
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(2)
  })

  it('refuses reviewer approval while a frozen requirement is unresolved', async () => {
    const { registry } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      return result({ ...review, acceptance: { ...acceptance, criteria: [{ ...acceptance.criteria[0], status: 'pending' }] } })
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Unresolved requirement')
    expect(inspectPipeline(context).acceptance).toMatchObject({ valid: false, status: 'blocked', reasons: ['Unresolved requirement: Both repositories return 2'] })
    expect(inspectPipeline(context).phases.reviewer.status).toBe('running')
  })

  it('applies project review thresholds and reports them to the reviewer', async () => {
    config.review = { minScore: 95, aspects: { security: 91 } }
    let reviews = 0
    const { registry, calls } = fake(async request => {
      if (request.role === 'architect') return result(architecture)
      if (request.role === 'developer') { develop(); return result('Done') }
      return result(++reviews === 1 ? review : { ...review, score: 96, aspects: { ...review.aspects, security: 92 } })
    })
    const state = await runCoreWorkflow(opts(registry))
    expect(state.status, state.error).toBe('succeeded')
    expect(calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer', 'developer', 'reviewer'])
    expect(calls[2]!.prompt).toContain('`score` is at least 95')
    expect(calls[2]!.prompt).toContain('`security` ≥ 91')
    expect(JSON.parse(readFileSync(archivedChangeFile('confidence-score.json'), 'utf8'))).toMatchObject({ overall: 96 })
  })
})
