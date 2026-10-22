import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineContext } from '../../pipeline/pipeline-state.js'
import {
  CLARIFICATION_LIMIT, blockingClarifications, clarificationQuestion, designAssumptions, designSection, NON_GOALS, ASSUMPTIONS,
  parseClarifications, readClarificationsRecord, validateDesignSections, writeClarificationsRecord, type Clarification,
} from './clarifications.js'

const high: Clarification = { question: 'Should archived projects appear in search?', impact: 'high', default: null }
const low: Clarification = { question: 'Page size?', impact: 'low', default: '25' }

describe('parseClarifications', () => {
  it('treats an absent or null list as no clarifications', () => {
    expect(parseClarifications(undefined)).toEqual([])
    expect(parseClarifications(null)).toEqual([])
  })

  it('trims text, keeps a default and reads a missing or blank default as no safe default', () => {
    expect(parseClarifications([
      { question: '  Page size? ', impact: 'low', default: ' 25 ' },
      { question: 'Scope?', impact: 'high' },
      { question: 'Order?', impact: 'medium', default: '   ' },
    ])).toEqual([
      { question: 'Page size?', impact: 'low', default: '25' },
      { question: 'Scope?', impact: 'high', default: null },
      { question: 'Order?', impact: 'medium', default: null },
    ])
  })

  it.each([
    ['a non-array', { question: 'x' }, 'expected an array'],
    ['an unknown impact', [{ question: 'x', impact: 'critical', default: null }], 'impact must be one of'],
    ['an empty question', [{ question: ' ', impact: 'low', default: null }], 'needs a question'],
    ['a non-string default', [{ question: 'x', impact: 'low', default: 3 }], 'default must be a string or null'],
    ['too many entries', Array.from({ length: CLARIFICATION_LIMIT + 1 }, () => ({ question: 'x', impact: 'low', default: 'y' })), `at most ${CLARIFICATION_LIMIT}`],
  ])('rejects %s with a repairable error', (_name, value, detail) => {
    expect(() => parseClarifications(value)).toThrow(/^Invalid architect clarifications: /)
    expect(() => parseClarifications(value)).toThrow(detail)
  })
})

describe('blockingClarifications', () => {
  it('blocks only high-impact questions without a safe default under ask-on-high', () => {
    const highWithDefault: Clarification = { ...high, default: 'No' }
    expect(blockingClarifications([high, low, highWithDefault])).toEqual([high])
    expect(blockingClarifications([high, low], 'ask-on-high')).toEqual([high])
  })

  it('never blocks under always-proceed', () => {
    expect(blockingClarifications([high], 'always-proceed')).toEqual([])
  })

  it('asks a single question verbatim and numbers several', () => {
    expect(clarificationQuestion([high])).toBe(high.question)
    expect(clarificationQuestion([high], 'Which module owns it?')).toBe('Before planning, the architect needs answers to:\n1. Should archived projects appear in search?\n2. Which module owns it?')
    expect(clarificationQuestion([high], high.question)).toBe(high.question)
  })
})

describe('designSection', () => {
  it('reads a dedicated heading', () => {
    expect(designSection('# Design\n## Non-Goals\n- No migration.\n## Decisions\n- x', NON_GOALS)).toEqual(['- No migration.'])
  })

  it("reads OpenSpec's bold label inside Goals / Non-Goals and ignores template comments", () => {
    const template = '## Goals / Non-Goals\n\n**Goals:**\n- Ship search.\n\n**Non-Goals:**\n<!-- What is explicitly out of scope -->\n\n## Decisions\n'
    expect(designSection(template, NON_GOALS)).toEqual([])
    expect(designSection(template.replace('<!-- What is explicitly out of scope -->', '- Ranking changes.'), NON_GOALS)).toEqual(['- Ranking changes.'])
  })

  it('accepts inline label content and the singular or unhyphenated spelling', () => {
    expect(designSection('**Non-goals:** anything about billing', NON_GOALS)).toEqual(['anything about billing'])
    expect(designSection('### Non Goals\nNone of the admin pages.', NON_GOALS)).toEqual(['None of the admin pages.'])
  })

  it('reports an absent section as undefined and an empty one as no lines', () => {
    expect(designSection('# Design\n## Decisions\n- x', NON_GOALS)).toBeUndefined()
    expect(designSection('## Non-Goals\n\n-\n## Next', NON_GOALS)).toEqual([])
    expect(designSection('## Assumptions\n- Page size is 25.\n', ASSUMPTIONS)).toEqual(['- Page size is 25.'])
  })
})

describe('design validation and the host record', () => {
  let root: string
  let context: PipelineContext
  const change = 'clarify-change'
  const design = (text: string): void => {
    const directory = path.join(root, 'openspec', 'changes', change)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'design.md'), text)
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clarifications-'))
    context = { artifactRoot: root, backlogRoot: root, runId: 'run-1' } as PipelineContext
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('leaves a missing design.md to the design gate', () => {
    expect(() => validateDesignSections(context, change, { clarifications: [low] })).not.toThrow()
  })

  it('requires a non-empty Non-Goals section', () => {
    design('# Design\n## Decisions\n- x\n')
    expect(() => validateDesignSections(context, change, { clarifications: [] })).toThrow(/^Invalid design\.md: .*Non-Goals/)
    design('# Design\n## Non-Goals\n- No migration.\n')
    expect(() => validateDesignSections(context, change, { clarifications: [] })).not.toThrow()
  })

  it('requires Assumptions only when clarifications were listed', () => {
    design('# Design\n## Non-Goals\n- No migration.\n')
    expect(() => validateDesignSections(context, change, { clarifications: [low] })).toThrow(/Assumptions/)
    design('# Design\n## Non-Goals\n- No migration.\n## Assumptions\n- Page size? Assumed 25.\n')
    expect(() => validateDesignSections(context, change, { clarifications: [low] })).not.toThrow()
    expect(designAssumptions(context, change)).toEqual(['- Page size? Assumed 25.'])
  })

  it('round-trips the record and reads an absent or foreign record as null', () => {
    expect(readClarificationsRecord(context)).toBeNull()
    const record = writeClarificationsRecord(context, { change, policy: 'ask-on-high', status: 'awaiting-answers', clarifications: [high, low], blocking: [high], answers: [] })
    expect(readClarificationsRecord(context)).toEqual(record)
    expect(record).toMatchObject({ schemaVersion: 1, assumptions: [] })
    writeFileSync(path.join(root, '.specrails', 'pipeline', 'run-1', 'clarifications.json'), '{"schemaVersion":99}')
    expect(readClarificationsRecord(context)).toBeNull()
  })
})

describe('always-proceed without artifacts', () => {
  it('asks a reply that stopped on a high question to plan instead', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clarifications-'))
    try {
      const context = { artifactRoot: root, backlogRoot: root, runId: 'run-1' } as PipelineContext
      expect(() => validateDesignSections(context, 'c', { clarifications: [high], policy: 'always-proceed' })).toThrow(/^Invalid architect reply: .*always-proceed/)
      expect(() => validateDesignSections(context, 'c', { clarifications: [high], policy: 'ask-on-high' })).not.toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
