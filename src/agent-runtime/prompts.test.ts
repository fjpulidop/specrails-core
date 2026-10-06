import { describe, it, expect } from 'vitest'
import { correctionInstructions, roleInstructions, rolePromptDefaults } from './prompts.js'
import type { BuiltinAgentRole, RoleDescriptor } from './executor-types.js'
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
  it('prioritizes failed facts over successful suites within the shared correction feedback budget', () => {
    const passed = Array.from({ length: 20 }, () => ({ repositoryId: 'app', command: 'passed-suite', args: [], exitCode: 0, output: 'successful output '.repeat(2000) }))
    const failed = { repositoryId: 'app', command: 'failed-suite', args: [], cwd: '/repo/app', exitCode: 1, evidenceId: 'failed-check', output: 'source dump '.repeat(2000), failureSummary: ['AssertionError: missing guard', 'expected: !confirmPending', 'at /repo/guard.test.ts:52:10'] }
    const prompt = correctionInstructions('developer', { verification: { valid: false, commands: [...passed, failed] } })
    expect(prompt).toContain('expected: !confirmPending')
    expect(prompt).toContain('at /repo/guard.test.ts:52:10')
    expect(prompt.indexOf('`failed-suite`')).toBeLessThan(prompt.indexOf('`passed-suite`'))
    expect(prompt).toContain('failed-check')
    expect(prompt.length).toBeLessThan(30_000)
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
  it('every factory definition carries the blast-radius discipline and stays a single extractable section', () => {
    const defaults = rolePromptDefaults()
    // The compact pipelines and Desktop extract the stance up to the next `## ` heading (the developer tail adds
    // `## Durable implementation progress`): identity, focus and blast radius must all live before it.
    const stance = (role: keyof typeof defaults) => defaults[role].split('\n## ')[0]!
    for (const role of ['architect', 'developer', 'reviewer', 'fixer'] as const) {
      expect(stance(role).toLowerCase()).toContain('blast radius')
      expect(stance(role).split('T-shaped principal engineer')).toHaveLength(2)
      expect(stance(role)).toContain('Focus:')
    }
    expect(defaults.architect).toContain('`Blast radius` heading')
    expect(defaults.architect).toContain('hexagonal')
    expect(defaults.developer).toContain('Clean Code')
    expect(defaults.reviewer).toContain('SOLID')
    expect(defaults.architect).toContain('solve exactly the requested spec and nothing else')
    expect(defaults.developer).toContain('solve exactly the requested spec and nothing else')
    expect(defaults.fixer).toContain('Fix the cause, not the symptom')
    expect(defaults.developer).toContain('git diff --stat')
    expect(defaults.fixer).toContain('never grows the blast radius')
    expect(defaults.reviewer).toContain('issue to REVERT')
    expect(defaults.reviewer).toContain('asking to REVERT an edit this change introduced is always in scope')
    // A fresh correction pass keeps the identity and the correction framing.
    expect(roleInstructions('developer', context, 'change', { feedback: { review: { issues: ['x'] } } })).toContain('returning for a correction pass')
  })
  it('gives declared (custom) roles the shared boundaries that match their access, without the built-in output contracts', () => {
    const build = roleInstructions({ id: 'build', provider: 'claude', access: 'write', artifacts: 'tasks-checkboxes', prompt: 'Build the thing' } as unknown as RoleDescriptor, context, 'change')
    expect(build).toContain('## Your task: build')
    expect(build).toContain('Build the thing')
    expect(build).toContain('## Boundaries')
    expect(build).toContain('Never edit package-manager')
    expect(build).not.toContain('## Output contract')
    const assess = roleInstructions({ id: 'assess', provider: 'claude', access: 'read', artifacts: 'none', prompt: 'Assess it' } as unknown as RoleDescriptor, context, 'change')
    expect(assess).toContain('This role is read-only')
    expect(assess).not.toContain('Never edit package-manager')
    const plan = roleInstructions({ id: 'plan', provider: 'claude', access: 'read', artifacts: 'all', prompt: 'Plan it' } as unknown as RoleDescriptor, context, 'change')
    expect(plan).toContain('Author OpenSpec artifacts only through the supplied scoped workflow tools.')
    expect(plan).not.toContain('Return confidence and verification metadata in JSON')
  })
  it('states the host blocker contract for the fixer, the toolchain and bypass rules for the developer, and the host plan for custom write roles', () => {
    const verification = [{ repositoryId: 'app', command: 'npm', args: ['run', 'test:e2e'] }]
    // Desktop keeps a parity test against these exact sentences.
    const DEV_BYPASS = 'Never validate with a temporary configuration, alternate runner or local browser the host verification plan does not use, and never delete such a file to hide it: the host runs the plan as-is. When a required tool is missing, install it through the project\'s documented command or report it as a blocker.'
    const TOOLCHAIN_ALLOW = 'Installing a documented, idempotent toolchain artifact inside the admitted workspace (for example a Playwright browser with `npx playwright install <browser>`, or a Python virtualenv) is allowed and must be reported under verification; editing package-manager, registry, credential, CI or environment configuration remains forbidden.'
    const FIXER_BLOCKER = 'When the diagnosed cause is a host precondition or environment blocker (missing network, credentials, environment variable, toolchain, setup command or an out-of-scope repository), make no speculative edits, state in summary that the candidate was intentionally left unchanged, and return `blocker` as {"kind":"network|credential|environment-variable|toolchain|setup|environment|scope","command":"…","cwd":"…","evidence":"exact error","requiredAction":"one imperative sentence the host can act on"}.'
    const BLOCKER_BULLET = '- `blocker`: only when the cause lies outside the change; omit otherwise. The host ends the run with your `requiredAction` instead of starting another correction round.'
    const developer = roleInstructions('developer', context, 'change', { verification })
    expect(developer).toContain(DEV_BYPASS)
    expect(developer).toContain('report it under `incomplete` with the exact error. ' + TOOLCHAIN_ALLOW)
    expect(developer).toContain(BLOCKER_BULLET)
    expect(developer).toContain('"blocker":{"kind":"toolchain"')
    expect(developer).not.toContain(FIXER_BLOCKER)
    const fixer = roleInstructions('developer', context, 'change', { stance: 'fixer', verification, feedback: { verification: { valid: false, commands: [] } } })
    expect(fixer).toContain(FIXER_BLOCKER)
    expect(fixer).not.toContain('For an external or unrepairable scope blocker')
    expect(fixer).toContain(TOOLCHAIN_ALLOW)
    expect(fixer).toContain(BLOCKER_BULLET)
    expect(fixer).toContain('`npm run test:e2e`')
    // The default definitions carry the same sentences, so Desktop can extract them.
    const defaults = rolePromptDefaults()
    expect(defaults.developer).toContain(DEV_BYPASS)
    expect(defaults.fixer).toContain(FIXER_BLOCKER)
    // A custom write role sees the host plan block (and nothing of the builtin output contract).
    const build = roleInstructions({ id: 'build', provider: 'claude', access: 'write', artifacts: 'tasks-checkboxes', prompt: 'Build the thing' } as unknown as RoleDescriptor, context, 'change', { verification: [...verification, { repositoryId: 'app', command: 'cargo', args: ['test'], cwd: 'crates/core' }] })
    expect(build).toContain('Core owns these complete verification commands and will run them after your turn.')
    expect(build).toContain('- repository `app`: `npm run test:e2e`')
    expect(build).toContain('- repository `app` in `crates/core`: `cargo test`')
    expect(build).toContain(TOOLCHAIN_ALLOW)
    expect(build).not.toContain('## Output contract')
    expect(roleInstructions({ id: 'build', provider: 'claude', access: 'write', artifacts: 'none', prompt: 'Build' } as unknown as RoleDescriptor, context, 'change')).not.toContain('Core owns these complete verification commands')
    // A read-only custom role never gets the plan, even when the host has one.
    const assess = roleInstructions({ id: 'assess', provider: 'claude', access: 'read', artifacts: 'none', prompt: 'Assess it' } as unknown as RoleDescriptor, context, 'change', { verification })
    expect(assess).not.toContain('Core owns these complete verification commands')
    expect(assess).not.toContain('npm run test:e2e')
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
