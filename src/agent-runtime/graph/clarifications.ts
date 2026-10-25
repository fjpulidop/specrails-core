import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { child, write } from './artifacts.js'

/**
 * The architect's clarifications: the short list of ambiguities it found
 * before planning, each with its impact and the default it would choose.
 * A high-impact question without a safe default pauses the run (policy
 * `ask-on-high`); everything else proceeds and is written down in design.md
 * under Assumptions. Core also enforces a non-empty Non-Goals section.
 */
export const CLARIFICATIONS_SCHEMA_VERSION = 1
export const CLARIFICATION_LIMIT = 5
export const CLARIFICATION_IMPACTS = ['high', 'medium', 'low'] as const
export const CLARIFICATION_POLICIES = ['ask-on-high', 'always-proceed'] as const
export type ClarificationImpact = typeof CLARIFICATION_IMPACTS[number]
export type ClarificationPolicy = typeof CLARIFICATION_POLICIES[number]
export const DEFAULT_CLARIFICATION_POLICY: ClarificationPolicy = 'ask-on-high'
const TEXT_LIMIT = 2000

export interface Clarification {
  question: string
  impact: ClarificationImpact
  /** The answer the architect would assume; null when no safe default exists. */
  default: string | null
}

/** The optional `clarifications` property of ARCHITECT_OUTPUT_SCHEMA. */
export const CLARIFICATIONS_SCHEMA: Record<string, unknown> = {
  type: 'array', maxItems: CLARIFICATION_LIMIT,
  description: 'Ambiguities found before planning; empty or omitted when the ticket is clear.',
  items: { type: 'object', additionalProperties: false, required: ['question', 'impact', 'default'], properties: {
    question: { type: 'string', minLength: 1, maxLength: TEXT_LIMIT },
    impact: { type: 'string', enum: [...CLARIFICATION_IMPACTS] },
    default: { type: ['string', 'null'], maxLength: TEXT_LIMIT, description: 'The answer you would assume, or null when no safe default exists.' },
  } },
}

/** Throws a repairable `Invalid architect clarifications` error for a malformed list. */
export function parseClarifications(value: unknown): Clarification[] {
  if (value === undefined || value === null) return []
  const fail = (detail: string): never => { throw new Error('Invalid architect clarifications: ' + detail) }
  if (!Array.isArray(value)) fail('expected an array')
  const list = value as unknown[]
  if (list.length > CLARIFICATION_LIMIT) fail(`at most ${CLARIFICATION_LIMIT} entries`)
  return list.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(`entry ${index} must be an object`)
    const entry = item as Record<string, unknown>
    if (typeof entry.question !== 'string' || !entry.question.trim()) return fail(`entry ${index} needs a question`)
    if (!CLARIFICATION_IMPACTS.includes(entry.impact as ClarificationImpact)) return fail(`entry ${index} impact must be one of ${CLARIFICATION_IMPACTS.join(', ')}`)
    if (entry.default !== undefined && entry.default !== null && typeof entry.default !== 'string') return fail(`entry ${index} default must be a string or null`)
    const fallback = typeof entry.default === 'string' && entry.default.trim() ? entry.default.trim().slice(0, TEXT_LIMIT) : null
    return { question: entry.question.trim().slice(0, TEXT_LIMIT), impact: entry.impact as ClarificationImpact, default: fallback }
  })
}

/** The clarifications that pause the run under the policy: high impact without a safe default. */
export function blockingClarifications(clarifications: readonly Clarification[], policy: ClarificationPolicy = DEFAULT_CLARIFICATION_POLICY): Clarification[] {
  return policy === 'ask-on-high' ? clarifications.filter(item => item.impact === 'high' && item.default === null) : []
}

/** True when a raw architect reply carries a high-impact clarification without a default: it may stop before authoring artifacts. */
export function asksBeforePlanning(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => !!item && typeof item === 'object' && (item as Record<string, unknown>).impact === 'high'
    && !((item as Record<string, unknown>).default as string | null | undefined)?.toString().trim())
}

/** The single question the paused run carries (`pendingQuestion.question`). */
export function clarificationQuestion(blocking: readonly Clarification[], lowConfidenceQuestion?: string): string {
  const questions = [...blocking.map(item => item.question), ...(lowConfidenceQuestion && !blocking.some(item => item.question === lowConfidenceQuestion) ? [lowConfidenceQuestion] : [])]
  if (questions.length === 1) return questions[0]!
  return ['Before planning, the architect needs answers to:', ...questions.map((question, index) => `${index + 1}. ${question}`)].join('\n')
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
/** A bold or underscored label on its own line, such as OpenSpec's `**Non-Goals:**`. */
const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)\s*([^*_]+?)\s*:?\s*(?:\*\*|__)\s*:?\s*(.*)$/
function meaningful(line: string): boolean {
  return line.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(?:[-*+]|\d+\.)\s*$/, '').trim().length > 0
}
/**
 * The content lines of a design.md section, or undefined when the section is
 * absent. A section is a heading that contains the name (`## Non-Goals`,
 * `## Goals / Non-Goals` without labels) or a bold label (`**Non-Goals:**`),
 * which takes precedence; it ends at the next heading or label. HTML comments
 * (template placeholders) and empty bullets do not count as content.
 */
export function designSection(markdown: string, name: RegExp): string[] | undefined {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const collect = (start: number, inline: string, stopAtLabels: boolean): string[] => {
    const content = inline.trim() ? [inline.trim()] : []
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index]!
      if (HEADING.test(line) || (stopAtLabels && LABEL.test(line) && !LABEL.exec(line)![2]!.trim() && !/^\s*[-*+]\s/.test(line))) break
      if (meaningful(line)) content.push(line.trim())
    }
    return content
  }
  const label = lines.findIndex(line => { const match = LABEL.exec(line); return !!match && name.test(match[1]!) && !HEADING.test(line) })
  if (label >= 0) return collect(label, LABEL.exec(lines[label]!)![2]!, true)
  const heading = lines.findIndex(line => { const match = HEADING.exec(line); return !!match && name.test(match[1]!) })
  if (heading >= 0) return collect(heading, '', false)
  return undefined
}
export const NON_GOALS = /\bnon[\s-]?goals?\b/i
export const ASSUMPTIONS = /\bassumptions?\b/i

/**
 * Validates the active change's design.md once the architect proceeds:
 * a non-empty Non-Goals section always, and a non-empty Assumptions section
 * when it reported clarifications. Missing design.md is left to the design
 * gate. Throws a repairable `Invalid design.md` error.
 */
export function validateDesignSections(context: PipelineContext, change: string, options: { clarifications: readonly Clarification[]; policy?: ClarificationPolicy }): void {
  const file = child(context.artifactRoot, 'openspec/changes/' + change + '/design.md')
  if (!existsSync(file)) {
    // Under always-proceed a reply that stopped on a question has nothing to proceed with.
    if (options.policy === 'always-proceed' && options.clarifications.some(item => item.impact === 'high' && item.default === null)) throw new Error('Invalid architect reply: the clarification policy is always-proceed, so plan on your best default for every clarification, author the artifacts and record the defaults under `## Assumptions` in design.md.')
    return
  }
  const design = readFileSync(file, 'utf8')
  const missing: string[] = []
  if (!designSection(design, NON_GOALS)?.length) missing.push('a `## Non-Goals` section with at least one line naming what this change deliberately does not do')
  if (options.clarifications.length && !designSection(design, ASSUMPTIONS)?.length) missing.push('a `## Assumptions` section with one line per clarification you proceeded on (question and the answer you assumed)')
  if (missing.length) throw new Error(`Invalid design.md: it needs ${missing.join(' and ')}. Update design.md through the workflow's write_artifact action, then resend the same JSON reply.`)
}

export interface ClarificationsRecord {
  schemaVersion: typeof CLARIFICATIONS_SCHEMA_VERSION
  change: string
  policy: ClarificationPolicy
  /** `awaiting-answers`: the run paused on `blocking`; `proceeded`: the architect planned on its defaults and the answers. */
  status: 'awaiting-answers' | 'proceeded'
  recordedAt: string
  clarifications: Clarification[]
  /** The high-impact questions without a safe default the run paused on (empty once it proceeds). */
  blocking: Clarification[]
  /** Answers the requester gave so far, oldest first; authoritative for the design. */
  answers: string[]
  /** The Assumptions lines design.md records once the architect proceeds (empty when none). */
  assumptions: string[]
}
export const CLARIFICATIONS_FILE = 'clarifications.json'
export function clarificationsPath(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): string {
  return path.join(pipelineStateDirectory(context as PipelineContext), CLARIFICATIONS_FILE)
}
export function writeClarificationsRecord(context: PipelineContext, entry: Omit<ClarificationsRecord, 'schemaVersion' | 'recordedAt' | 'assumptions'> & { assumptions?: string[] }): ClarificationsRecord {
  const record: ClarificationsRecord = { schemaVersion: CLARIFICATIONS_SCHEMA_VERSION, change: entry.change, policy: entry.policy, status: entry.status, recordedAt: new Date().toISOString(), clarifications: entry.clarifications, blocking: entry.blocking, answers: entry.answers, assumptions: entry.assumptions ?? [] }
  write(clarificationsPath(context), JSON.stringify(record, null, 2) + '\n')
  return record
}
/** The Assumptions lines of the active change's design.md, for the host record. */
export function designAssumptions(context: PipelineContext, change: string): string[] {
  try {
    const file = child(context.artifactRoot, 'openspec/changes/' + change + '/design.md')
    return existsSync(file) ? (designSection(readFileSync(file, 'utf8'), ASSUMPTIONS) ?? []).slice(0, 50).map(line => line.slice(0, TEXT_LIMIT)) : []
  } catch { return [] }
}
/** The latest clarifications record of a run, or null when the architect has not recorded one (or it is unreadable). */
export function readClarificationsRecord(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): ClarificationsRecord | null {
  try {
    const file = clarificationsPath(context)
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as ClarificationsRecord
    return value && typeof value === 'object' && value.schemaVersion === CLARIFICATIONS_SCHEMA_VERSION ? value : null
  } catch { return null }
}
