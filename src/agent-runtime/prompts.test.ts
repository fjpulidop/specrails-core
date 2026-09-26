import { describe, it, expect } from 'vitest'
import { correctionInstructions, roleInstructions, rolePromptDefaults } from './prompts.js'
import type { BuiltinAgentRole } from './executor-types.js'
import type { PipelineContext } from '../pipeline/pipeline-state.js'
const context = { artifactRoot: '/repo', repositories: [{ id: 'app', name: 'App', path: '/repo' }], specs: [{ title: 'A feature', description: 'Implement the requested feature', acceptanceCriteria: ['Works'], repositoryIds: ['app'] }] } as PipelineContext

describe('editable role definitions', () => {
  it('focuses correction feedback without losing application failures or the complete evidence reference', () => {
    const feedback = { verification: { valid: false, commands: [{ repositoryId: 'app', command: 'node', args: ['test.cjs'], exitCode: 1,
      evidenceId: 'check-1', output: 'AssertionError: expected 2, actual 1\n    at solve (/repo/source.cjs:42:7)\n    at run (node:internal/modules/loader:10:3)\n    at node:internal/main/run_main_module:17:1' }] } }
    const legacy = correctionInstructions('developer', feedback)
    const focused = correctionInstructions('developer', feedback, { focusedEvidence: true })
    expect(legacy).toContain('node:internal/modules/loader')
    expect(focused).not.toContain('node:internal/')
    for (const value of ['expected 2, actual 1', '/repo/source.cjs:42:7', 'check-1', 'read_verification_evidence', 'same JSON summary', 'unchanged permissions and obligations']) expect(focused).toContain(value)
    expect(feedback.verification.commands[0].output).toContain('node:internal/modules/loader')
  })
  it.each<BuiltinAgentRole>(['architect', 'developer', 'reviewer'])('replaces the %s task definition while preserving dynamic contracts', role => {
    const defaults = rolePromptDefaults()
    expect(roleInstructions(role, context, 'change')).toContain(defaults[role])
    const prompt = roleInstructions(role, context, 'change', { definition: 'My custom definition', verification: [{ repositoryId: 'app', command: 'npm', args: ['test'] }], criteria: [{ specId: 'ticket', criterionIndex: 0, requirement: 'Works' }] })
    expect(prompt).toContain('My custom definition')
    expect(prompt).not.toContain(defaults[role])
    expect(prompt).toContain('## Output contract')
    expect(prompt).toContain('## Boundaries')
    expect(prompt).toContain('official OpenSpec')
    expect(prompt).toContain('Implement the requested feature')
    if (role === 'reviewer') expect(prompt).toContain('spec `ticket`, criterion 0: Works')
    else expect(prompt).toContain('npm test')
  })
  it('the fixer stance is a fourth editable definition on the developer role: own task text, developer contract and verification tail', () => {
    const defaults = rolePromptDefaults()
    expect(defaults.fixer).toMatch(/^## Your task: correction/)
    expect(defaults.fixer).toContain('FIXER')
    const feedback = { verification: { valid: false, reason: 'npm test failed', unverifiedRepositories: [], commands: [] } }
    const stock = roleInstructions('developer', context, 'change', { stance: 'fixer', feedback })
    expect(stock).toContain(defaults.fixer)
    expect(stock).not.toContain(defaults.developer)
    expect(stock).toContain('## Output contract')
    expect(stock).toContain('npm test failed')
    expect(roleInstructions('developer', context, 'change', { stance: 'fixer', feedback, verification: [{ repositoryId: 'app', command: 'npm', args: ['test'] }] })).toContain('`npm test`')
    const custom = roleInstructions('developer', context, 'change', { stance: 'fixer', definition: 'My fixer stance', feedback })
    expect(custom).toContain('My fixer stance')
    expect(custom).not.toContain(defaults.fixer)
    expect(custom).toContain('## Output contract')
    // Without the stance the developer definition is untouched.
    expect(roleInstructions('developer', context, 'change', { feedback })).toContain('returning for a correction pass')
  })
  it('renders the re-review section for a reviewer pass after corrections, with a machine-readable change list', () => {
    const reReview = { changes: [{ repositoryId: 'app', path: 'src/game.js', status: 'changed' as const }], previouslyMet: [{ specId: '7', criterionIndex: 0 }] }
    const prompt = roleInstructions('reviewer', context, 'change', { reReview, feedback: { review: { issues: ['src/game.js: guard the overlay'] } } })
    expect(prompt).toContain('## Re-review after corrections')
    expect(prompt).toContain('`app`: src/game.js (changed)')
    expect(prompt).toContain('7#0')
    expect(prompt).toContain('Re-review changes (JSON): [{"repositoryId":"app","path":"src/game.js","status":"changed"}]')
    expect(roleInstructions('reviewer', context, 'change')).not.toContain('## Re-review after corrections')
  })
  it('preserves correction feedback with a custom definition', () => {
    const prompt = roleInstructions('developer', context, 'change', { definition: 'Custom developer', feedback: { review: { issues: ['Fix the failing behavior'] } } })
    expect(prompt).toContain('Custom developer')
    expect(prompt).toContain('Fix the failing behavior')
    expect(prompt).toContain('## Output contract')
  })
})
