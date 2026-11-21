import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue, PieceExecutionContext } from '../contracts.js'
import { artifactContractPiece, declaredNonGoals, protectsExistingCode, humanCheckText, taskCheckboxes, tasksContradictingNonGoals, tasksEditingFrozenArtifacts, tasksNeedingManualCheck } from './artifact-contract.js'
import type { PieceDependencies } from './ports.js'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'artifact-contract-')); roots.push(root)
  const directory = path.join(root, 'openspec/changes/feature')
  mkdirSync(path.join(directory, 'specs/example'), { recursive: true })
  for (const [name, content] of Object.entries({ 'proposal.md': 'Requirements', 'design.md': 'Approved design', 'tasks.md': '- [ ] 1. Implement requirement\n', 'specs/example/spec.md': 'Frozen acceptance criteria' })) writeFileSync(path.join(directory, name), content)
  const scopes = new Map<string, Map<string, JsonValue>>()
  const deps = { context: { artifactRoot: root }, artifactContracts: (context: PieceExecutionContext) => {
    const scope = context.frame.scope.id
    if (!scopes.has(scope)) scopes.set(scope, new Map())
    return { get: (key: string) => scopes.get(scope)!.get(key), set: (key: string, value: JsonValue) => { scopes.get(scope)!.set(key, value) } }
  } } as unknown as PieceDependencies
  const piece = artifactContractPiece(() => deps)
  const run = (action: 'freeze' | 'check', completed = false, scope = 'root') => piece.execute({ change: 'feature', contractId: 'plan', action, requireCompletedTasks: completed }, { frame: { scope: { id: scope } } } as PieceExecutionContext)
  return { run, directory }
}
it('freezes real artifacts and permits only task checkbox completion', async () => {
  const f = fixture()
  expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
  expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { incomplete: 1 } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n')
  expect(await f.run('check', true)).toMatchObject({ outcome: 'pass', output: { incomplete: 0 } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Weaken requirement\n')
  expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed' } })
})
it('rejects modified design, removed artifacts and cross-scope contracts', async () => {
  const f = fixture()
  await f.run('freeze')
  expect(await f.run('check', false, 'other')).toMatchObject({ outcome: 'fail', output: { reason: 'contract_missing' } })
  writeFileSync(path.join(f.directory, 'design.md'), 'Changed design')
  expect(await f.run('check')).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed' } })
  rmSync(path.join(f.directory, 'proposal.md'))
  expect(await f.run('check')).toMatchObject({ outcome: 'fail', output: { reason: 'required_artifacts_missing' } })
})
it('rejects empty tasks and symlinked specs without reading outside the artifact root', async () => {
  const f = fixture()
  writeFileSync(path.join(f.directory, 'tasks.md'), 'No actionable tasks')
  expect(await f.run('freeze')).toMatchObject({ outcome: 'fail', output: { reason: 'tasks_missing' } })
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] Work\n')
  symlinkSync(path.join(f.directory, 'design.md'), path.join(f.directory, 'specs/leak.md'))
  await expect(f.run('freeze')).rejects.toThrow('symlinks')
  expect(readFileSync(path.join(f.directory, 'design.md'), 'utf8')).toBe('Approved design')
})

describe('tasks that edit frozen artifacts', () => {
  // Two tasks of a real plan (deckdex-mtg) the implementer could never complete.
  const field = [
    '1.1 Modify `openspec/changes/feature/design.md` Runtime evidence with the unmodified fresh backend image\'s identity.',
    '2.1 If task 1.1 confirms the incompatibility, modify only the SQLAlchemy line in `requirements.txt` to `sqlalchemy>=2.0,<2.1` and update `openspec/changes/feature/design.md` Runtime evidence with the corrected results.',
  ]
  it('names tasks whose object is proposal.md, design.md or a delta spec, or that record evidence there', () => {
    const edits = [...field, '3. Record the container results in design.md', '4. Update proposal.md with the final scope', '5. Edit openspec/changes/feature/specs/example/spec.md to add a scenario']
    expect(tasksEditingFrozenArtifacts(edits.map(text => ({ text })), 'feature')).toEqual(edits)
  })
  it('accepts tasks that only cite them, and other changes or repository files', () => {
    const fine = ['1. Add the endpoint described in design.md', '2. Implement the requirement per `openspec/changes/feature/specs/example/spec.md`', '3. Update docs/design.md for users',
      '4. Update `openspec/changes/other/design.md`', '5. Modify requirements.txt and run the tests']
    expect(tasksEditingFrozenArtifacts(fine.map(text => ({ text })), 'feature')).toEqual([])
  })
  it('accepts a task that forbids editing them (a real repaired plan, deckdex-mtg)', () => {
    const repaired = ['1.1 Modify only the SQLAlchemy declaration in `requirements.txt` to exactly `sqlalchemy>=2.0,<2.1`, once the baseline fresh-image diagnostic described in design.md confirms selection of the absent psycopg driver. Do not modify proposal.md, design.md or delta specs during implementation; only task completion markers may change in this checklist.',
      "2. Never update design.md; don't edit proposal.md", '3. Fix the parser without changing `openspec/changes/feature/specs/example/spec.md`']
    expect(tasksEditingFrozenArtifacts(repaired.map(text => ({ text })), 'feature')).toEqual([])
    // A negation elsewhere in the task does not hide a real edit.
    expect(tasksEditingFrozenArtifacts([{ text: 'Do not touch tests. Update design.md with the results' }], 'feature')).toHaveLength(1)
  })
  it('refuses to freeze such a plan and tells the planner why', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'tasks.md'), field.map(text => `- [ ] ${text}`).join('\n') + '\n- [ ] 3. Implement requirement\n')
    const result = await f.run('freeze')
    expect(result).toMatchObject({ outcome: 'fail', output: { reason: 'tasks_edit_frozen_artifacts', tasks: field } })
    expect(result.history?.[0].text).toContain('Rewrite each as work on repository files')
    // A check of an already frozen contract is unaffected (only freeze judges the plan).
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] 1. Implement requirement\n')
    expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
  })
})

describe('human checks ([human] tasks)', () => {
  // The task of a real plan (tetrisex #14) the implementer could not do without a browser.
  const incident = '4.1 README: document the cinematic moment and add a visual-review note written from a manual check of the running game (desktop and narrow viewport, nearly full board, ghost on).'
  it('reads the tag after the task number and strips it for the human check text', () => {
    expect(taskCheckboxes('- [ ] 4.1 [human] Check the title on a real phone\n- [x] 4.2 Add the title\n- [ ] [HUMAN] Judge the glow')).toEqual([
      { done: false, text: '4.1 [human] Check the title on a real phone', human: true },
      { done: true, text: '4.2 Add the title', human: false },
      { done: false, text: '[HUMAN] Judge the glow', human: true },
    ])
    expect(humanCheckText('4.1 [human] Check the title on a real phone')).toBe('4.1 Check the title on a real phone')
  })
  it('names untagged tasks that ask for a manual or visual check', () => {
    const manual = [incident, '2. Visually verify the layout in a browser', '3. Test the flow manually on desktop', '4. Check the colours by hand', '5. Manually test the narrow viewport']
    expect(tasksNeedingManualCheck(manual.map(text => ({ text })))).toEqual(manual)
  })
  it('accepts checks the run performs itself, tagged checks and negated mentions', () => {
    const fine = ['1. Add tests/cinematic.test.js for the curve', '2. Visually verify the title with a $SPECRAILS_BROWSE screenshot at 390x844 and read it',
      '3. Document that no manual check is needed', '4. Update the user manual page', '5. [human] Judge the glow on a real phone']
    expect(tasksNeedingManualCheck(fine.map(text => ({ text, human: text.includes('[human]') })))).toEqual([])
  })
  it('refuses to freeze an untagged manual check and tells the planner both ways out', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'tasks.md'), `- [ ] 1. Implement requirement\n- [ ] ${incident}\n`)
    const result = await f.run('freeze')
    expect(result).toMatchObject({ outcome: 'fail', output: { reason: 'tasks_need_manual_check', tasks: [incident] } })
    expect(result.history?.[0].text).toContain('$SPECRAILS_BROWSE')
    expect(result.history?.[0].text).toContain('[human]')
  })
  it('never requires a [human] task, reports it, and lets the tag be added after the freeze', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] 1. Implement requirement\n- [ ] 2. Write the README section\n')
    expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n- [ ] 2. Write the README section\n')
    expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { incomplete: 1, incompleteTasks: ['2. Write the README section'], humanChecks: [] } })
    // The unblock turn turns the remaining check into a human check: same approved text, tag added.
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n- [ ] 2. [human] Write the README section\n')
    expect(await f.run('check', true)).toMatchObject({ outcome: 'pass', output: { incomplete: 0, incompleteTasks: [], humanChecks: ['2. Write the README section'] } })
    // The tag never hides a rewritten description.
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n- [ ] 2. [human] Skip the README\n')
    expect(await f.run('check', true)).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed' } })
  })
})
it('names the approved artifact that changed and tells the implementer to restore it', async () => {
  const f = fixture()
  await f.run('freeze')
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement (stays unticked by design)\n')
  const result = await f.run('check', true)
  expect(result).toMatchObject({ outcome: 'fail', output: { reason: 'artifacts_changed', changed: ['tasks.md'] } })
  const note = JSON.stringify((result as { history?: unknown }).history)
  expect(note).toContain('tasks.md')
  expect(note).toContain('Only task checkboxes may change')
  writeFileSync(path.join(f.directory, 'tasks.md'), '- [x] 1. Implement requirement\n')
  expect(await f.run('check', true)).toMatchObject({ outcome: 'pass' })
})

describe('tasks that contradict a declared non-goal', () => {
  const design = ['# Design', '', '## Goals', '- Keyboard controls for the orbit camera', '', '## Non-Goals', '', '- Mobile touch controls: keyboard and mouse only.', '- Multiplayer', '- WebGL2-only shaders (keep WebGL1)', '- Sound', '', '## Blast radius', '- src/game.js'].join('\n')
  it('reads the bullets of Non-Goals and Out of scope sections only', () => {
    expect(declaredNonGoals(design)).toEqual(['Mobile touch controls: keyboard and mouse only.', 'Multiplayer', 'WebGL2-only shaders (keep WebGL1)', 'Sound'])
    expect(declaredNonGoals('## Out of scope\n1. Payments\n### Detail\n- Still out of scope\n## Next\n- not a goal')).toEqual(['Payments', 'Still out of scope'])
    expect(declaredNonGoals('## Goals\n- Everything')).toEqual([])
  })
  it('names a task that requires a non-goal (the WebGL plan), and not one that excludes or merely cites it', () => {
    const tasks = [
      { text: '3.2 Add touch handlers in src/input.js so mobile players can orbit the camera with touch controls' },
      { text: '4.1 Add multiplayer lobby sync over WebSocket' },
      { text: '1.1 Add keyboard controls in src/input.js' },
      { text: '2.1 Keep input keyboard-only, without touch controls on mobile' },
      { text: "2.2 Don't add multiplayer hooks" },
      { text: '2.3 Document in README that mobile touch controls are a non-goal' },
      { text: '5.1 Play a sound when the score changes' },
      { text: '5.2 [human] Check touch controls on a real phone', human: true },
    ]
    expect(tasksContradictingNonGoals(tasks, declaredNonGoals(design))).toEqual([
      { task: tasks[0].text, nonGoal: 'Mobile touch controls: keyboard and mouse only.' },
      { task: tasks[1].text, nonGoal: 'Multiplayer' },
      { task: tasks[6].text, nonGoal: 'Sound' },
    ])
  })
  it('does not flag a task that keeps what a "does not change X" non-goal protects', () => {
    // wasm-rs: "done when … `mix` and its test are unchanged" was refused against "Does not change `mix`, its signature, or its tests."
    const nonGoals = ['Does not change `mix`, its signature, or its tests.']
    const keeps = '1.1 In `src/lib.rs`, add directly after `mix` a `#[no_mangle] pub extern "C" fn lighten(c: u8, amount: u8) -> u8`; done when the file contains this exported signature and `mix` and its test are unchanged.'
    expect(tasksContradictingNonGoals([{ text: keeps }], nonGoals)).toEqual([])
    const changes = '1.2 Rewrite the mix signature and its test to take u16 channels'
    expect(tasksContradictingNonGoals([{ text: changes }], nonGoals)).toEqual([{ task: changes, nonGoal: nonGoals[0] }])
  })
  it('flags a task against a non-goal that protects existing code only when the task alters it (speed benchmark plans)', () => {
    // Every discount plan of the speed benchmark was refused once (one extra architect turn, ~20 % of the run)
    // although its tasks only named `total` as an anchor or a style to follow.
    const protects = ['No change to `total(items)`, `formatPrice`, `createOrder`, or any other export.',
      '`src/cart.js` `total(items)` has placeholder JSDoc (`@param {*} items`, `@returns {*}`) and no input validation. Not changed here.',
      'Changing `total(items)` or its tests']
    const names = [
      '1.1 In `src/cart.js`, add `export function applyDiscount(totalCents, percent)` with a JSDoc block directly above it, in the same style as `total`. The body runs the guards first.',
      '1.3 In `README.md`, add `- `applyDiscount(totalCents, percent)` (src/cart.js)` to the `## API` list, after the `total(items)` entry, in the same format as the other entries.',
      '1.1 Export `applyDiscount(totalCents, percent)` from `src/cart.js` with a JSDoc block. Validate `totalCents` first, then compute from the total.',
    ]
    expect(tasksContradictingNonGoals(names.map(text => ({ text })), protects)).toEqual([])
    const alters = ['2.1 Update `total(items)` in `src/cart.js` to apply the discount', '2.2 Refactor `total` in `src/cart.js` to validate its items']
    expect(tasksContradictingNonGoals(alters.map(text => ({ text })), protects).map(item => item.task)).toEqual(alters)
  })
  it('tells a non-goal that protects existing code from one that excludes a feature', () => {
    for (const goal of ['No change to `total(items)`', 'Does not change `mix`, its signature, or its tests.', 'Changing the public API', '`total` stays the same', 'Existing exports remain unchanged', 'Not modified: `src/format.js`'])
      expect(protectsExistingCode(goal), goal).toBe(true)
    for (const goal of ['Mobile touch controls: keyboard and mouse only.', 'Multiplayer', 'No touch controls', 'No sound', 'Payments', 'WebGL2-only shaders (keep WebGL1)'])
      expect(protectsExistingCode(goal), goal).toBe(false)
  })
  it('ignores short single-word non-goals and long explanatory ones', () => {
    expect(tasksContradictingNonGoals([{ text: 'Add an API route' }], ['API'])).toEqual([])
    expect(tasksContradictingNonGoals([{ text: 'Refactor the renderer cache store layer module' }], ['Refactor renderer cache store layer module internals beyond'])).toEqual([])
  })
  it('refuses to freeze such a plan once, telling the architect how to resolve it, then freezes a plan it keeps', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'design.md'), design)
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] 1.1 Add keyboard controls\n- [ ] 3.2 Add mobile touch controls to the orbit camera\n')
    const first = await f.run('freeze')
    expect(first).toMatchObject({ outcome: 'fail', output: { reason: 'tasks_contradict_non_goals', tasks: ['3.2 Add mobile touch controls to the orbit camera'], nonGoals: ['Mobile touch controls: keyboard and mouse only.'] } })
    expect(first.history?.[0].text).toContain('return confidence low with one question for the person')
    // The architect reviewed it and kept the plan: the overlap was only apparent, so the plan freezes.
    expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
  })
  it('freezes a consistent plan on the first attempt', async () => {
    const f = fixture()
    writeFileSync(path.join(f.directory, 'design.md'), design)
    writeFileSync(path.join(f.directory, 'tasks.md'), '- [ ] 1.1 Add keyboard controls in src/input.js\n')
    expect(await f.run('freeze')).toMatchObject({ outcome: 'pass' })
  })
})
