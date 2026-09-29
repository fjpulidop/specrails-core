import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import type { AgentRequest, AgentResult, RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import { OpenSpecTools } from '../../openspec.js'
const change = 'native-implementation'
const usage = { inputTokens: 20, outputTokens: 10, costUsd: 0.1 }

export function implementationFixture(approval = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'native implementation '))
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog)
  execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'])
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'implementation', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 7, title: 'Feature', description: 'Return two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }] })
  const role = { provider: 'fixture' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, limits: { maxAttempts: 2 }, approvalBeforeArchive: approval,
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("real check passed")'] }] }
  const requests: AgentRequest[] = []
  const registry = new ExecutorRegistry().register('fixture', { capabilities: () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }),
    async execute(request): Promise<AgentResult> {
      requests.push(request)
      const tools = new OpenSpecTools(request.openspec!)
      const capability = request.openspec!.change === change ? 'feature' : 'feature-' + request.openspec!.change.slice(-6)
      await tools.execute({ action: 'load_skill' })
      if (request.role !== 'architect') await tools.execute({ action: 'instructions', artifact: 'apply' })
      if (request.role === 'architect') {
        await tools.execute({ action: 'new' })
        const files = [
          ['proposal', 'proposal.md', '# Why\nReturn two.\n# What Changes\nUpdate the function.\n# Capabilities\n## New Capabilities\n- feature: Return the required value.\n# Impact\nOne function.'],
          ['design', 'design.md', '# Design\nUpdate code.cjs and verify the return value.'],
          ['specs', `specs/${capability}/spec.md`, '## ADDED Requirements\n### Requirement: Return the required value\nThe function SHALL return 2.\n#### Scenario: Calling the function\n- **WHEN** code.cjs is loaded\n- **THEN** it returns 2\n'],
          ['tasks', 'tasks.md', '- [ ] 1. Implement the return value and verify behavior\n'],
        ]
        for (const [artifact, file, content] of files) { await tools.execute({ action: 'instructions', artifact }); await tools.execute({ action: 'write_artifact', path: file, content }) }
        return { text: '{"confidence":"high"}', usage }
      }
      if (request.role === 'developer') {
        writeFileSync(path.join(request.openspec!.root, 'code.cjs'), 'module.exports = 2\n')
        const tasks = path.join(request.openspec!.root, 'openspec/changes', request.openspec!.change, 'tasks.md')
        writeFileSync(tasks, readFileSync(tasks, 'utf8').replaceAll('- [ ]', '- [x]'))
        return { text: 'Implemented and checked the required behavior.', usage }
      }
      const obligations = JSON.parse(request.prompt.split('Current frozen acceptance obligations (all remain required):\n')[1]!.split('\n')[0]!) as Array<{ specId: string; criterionIndex: number }>
      return { text: JSON.stringify({ approved: true, summary: 'Inspected actual code and verification evidence', issues: [], score: 90,
        aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
        acceptance: { criteria: obligations.map(item => ({ specId: item.specId, criterionIndex: item.criterionIndex, status: 'met', evidence: ['code.cjs returns 2 and host verification passed'] })), checks: [], findings: [] } }), usage }
    },
  })
  return { root, repository, context, config, registry, requests, dispose: () => rmSync(root, { recursive: true, force: true }) }
}
