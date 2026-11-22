import { describe, expect, it } from 'vitest'
import type { JsonValue } from './contracts.js'
import { answerText, boundedOptions, structuredQuestion } from './question-options.js'

describe('structured questions (capability questionOptions)', () => {
  it('bounds choices, derives missing ids from labels and needs at least two', () => {
    expect(boundedOptions([{ label: 'Only one' }])).toEqual([])
    expect(boundedOptions([{ id: 'Bad Id!', label: 'Keep the non-goal' }, { label: 'Keep the non-goal' }, 'Drop it', { meaning: 'no label' }]))
      .toEqual([{ id: 'keep-the-non-goal', label: 'Keep the non-goal', meaning: '' }, { id: 'keep-the-non-goal-2', label: 'Keep the non-goal', meaning: '' }, { id: 'drop-it', label: 'Drop it', meaning: '' }])
    expect(boundedOptions(Array.from({ length: 9 }, (_, index) => ({ id: 'o' + index, label: 'L' + index })))).toHaveLength(6)
  })

  it('keeps a plain question unchanged and lists the choices in the self-contained prompt', () => {
    expect(structuredQuestion({ text: 'Which?' })).toEqual({ prompt: 'Which?' })
    const asked = structuredQuestion({ text: 'Which colour?', asker: 'architect', why: 'The ticket names two.', options: [{ id: 'red', label: 'Red', meaning: 'As the mock.' }, { id: 'blue', label: 'Blue' }], recommended: 'Red', endsRun: ['blue', 'ghost'], detail: 'npm i -g x' })
    expect(asked).toEqual({ prompt: 'Which colour?\n\nThe ticket names two.\n\nOptions:\n- Red: As the mock. (recommended)\n- Blue', text: 'Which colour?', asker: 'architect', why: 'The ticket names two.',
      options: [{ id: 'red', label: 'Red', meaning: 'As the mock.' }, { id: 'blue', label: 'Blue', meaning: '' }], recommended: 'red', endsRun: ['blue'], detail: 'npm i -g x' })
  })

  it('asks the reason when the planner left the question empty (bench5 codex), never an empty card', () => {
    const asked = structuredQuestion({ text: '  ', asker: 'architect', why: 'The export checkout is not in this run; include it or stop here?' })
    expect(asked).toMatchObject({ text: 'The export checkout is not in this run; include it or stop here?', asker: 'architect' })
    expect(asked).not.toHaveProperty('why')
    expect(asked.prompt).toBe('The export checkout is not in this run; include it or stop here?')
    expect(structuredQuestion({ text: 'Q?', why: 'Because.' })).toMatchObject({ text: 'Q?', why: 'Because.' })
  })

  it('spells out the chosen option for the asker and keeps extra words', () => {
    const request: JsonValue = { options: [{ id: 'red', label: 'Red', meaning: 'As the mock.' }, { id: 'blue', label: 'Blue' }] }
    expect(answerText({ answer: 'Red', optionId: 'red' }, request)).toBe('The person chose "Red" (As the mock.).')
    expect(answerText({ answer: 'but darker', optionId: 'red' }, request)).toBe('The person chose "Red" (As the mock.).\nTheir words: but darker')
    expect(answerText({ answer: 'Purple' }, request)).toBe('Purple')
    expect(answerText('plain', request)).toBe('plain')
  })
})
