import { describe, it, expect } from 'vitest'
import { roleInstructions, rolePromptDefaults } from './prompts.js'
import type { AgentRole } from './executor-types.js'
import type { PipelineContext } from '../installer/runtime/pipeline-state.js'
const context = { artifactRoot: '/repo', repositories: [{ id: 'app', name: 'App', path: '/repo' }], specs: [{ title: 'A feature', description: 'Implement the requested feature', acceptanceCriteria: ['Works'], repositoryIds: ['app'] }] } as PipelineContext

describe('editable role definitions', () => {
  it.each<AgentRole>(['architect', 'developer', 'reviewer'])('replaces the %s task definition while preserving dynamic contracts', role => {
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
  it('preserves correction feedback with a custom definition', () => {
    const prompt = roleInstructions('developer', context, 'change', { definition: 'Custom developer', feedback: { review: { issues: ['Fix the failing behavior'] } } })
    expect(prompt).toContain('Custom developer')
    expect(prompt).toContain('Fix the failing behavior')
    expect(prompt).toContain('## Output contract')
  })
})
