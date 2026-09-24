import { RE_REVIEW_MARKER } from '../prompts.js'
/**
 * The compact pipelines receive the same role prompt the graph builds for every
 * executor (`roleInstructions` + frozen obligations + repository map). They have
 * no `PipelineContext`, so the deterministic sections are extracted here instead
 * of changing the prompts or the graph.
 */
import type { FrozenCriterion } from '../prompts.js'

export interface ScopeRepository { id: string; name: string; path: string }
export interface PromptInputs {
  /** `## Frozen scope` section: change name, repositories and the requested work. */
  scope: string
  repositories: ScopeRepository[]
  /** `## Answers from the requester`, when the run resumed with an answer. */
  answers: string
  /** Host-configured verification commands paragraph shown to the architect. */
  configuredVerification: string
  criteria: FrozenCriterion[]
  /** `## Repository reference` map, bounded. */
  repositoryMap: string
  /** `## Developer summary` shown to the reviewer. */
  developerSummary: string
  /** Reviewer gate thresholds line, verbatim from the output contract. */
  reviewGate: string
  /** `## Verification result` / `## Previous review` feedback for correction passes. */
  feedback: string
  /** The role definition (`## Your task: …` up to the next section) — the host-editable stance text. */
  definition: string
  /** Re-review after a correction round: the files that changed since the previous verdict (empty ⇒ a full review). */
  reReviewChanges: Array<{ repositoryId: string; path: string; status: 'added' | 'changed' | 'deleted' }>
}
const STOP = /^(## |Planning policy:|Current frozen acceptance obligations)/

/** Text of one `## Heading` section up to the next heading (or terminator), without the heading line. */
function section(prompt: string, heading: string): string {
  const lines = prompt.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  if (start < 0) return ''
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (STOP.test(line)) break
    body.push(line)
  }
  return body.join('\n').trim()
}
export function bounded(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text
}
function parseReReviewChanges(prompt: string): PromptInputs['reReviewChanges'] {
  const line = prompt.split('\n').find(row => row.startsWith(RE_REVIEW_MARKER))
  if (!line) return []
  try {
    const parsed: unknown = JSON.parse(line.slice(RE_REVIEW_MARKER.length).trim())
    return Array.isArray(parsed) ? parsed.filter((item): item is PromptInputs['reReviewChanges'][number] => !!item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' && typeof (item as { repositoryId?: unknown }).repositoryId === 'string' && ['added', 'changed', 'deleted'].includes(String((item as { status?: unknown }).status))).slice(0, 200) : []
  } catch { return [] }
}
export function extractPromptInputs(prompt: string): PromptInputs {
  const scope = section(prompt, '## Frozen scope')
  const repositories: ScopeRepository[] = []
  for (const match of scope.matchAll(/^- `([^`]+)` \(([^)]*)\): `([^`]+)`$/gm)) repositories.push({ id: match[1]!, name: match[2]!, path: match[3]! })
  const obligations = /Current frozen acceptance obligations \(all remain required\):\n(\[[^\n]*\])/.exec(prompt)
  let criteria: FrozenCriterion[] = []
  try {
    const parsed: unknown = obligations ? JSON.parse(obligations[1]!) : []
    criteria = Array.isArray(parsed) ? parsed.filter((item): item is FrozenCriterion => !!item && typeof item === 'object' && typeof (item as FrozenCriterion).specId === 'string' && Number.isInteger((item as FrozenCriterion).criterionIndex) && typeof (item as FrozenCriterion).requirement === 'string') : []
  } catch { criteria = [] }
  const mapStart = prompt.indexOf('## Repository reference')
  const configured = /^(Verification commands already configured by the host[\s\S]*?|No verification commands are configured by the host for this run\.)\n\n/m.exec(prompt)
  const gate = /^- Scores are numbers from 0 to 100\..*$/m.exec(prompt)
  const feedback = ['## Verification result', '## Previous review'].map(heading => { const text = section(prompt, heading); return text ? heading + '\n' + text : '' }).filter(Boolean).join('\n\n')
  return {
    scope, repositories, answers: section(prompt, '## Answers from the requester'), configuredVerification: configured?.[1]?.trim() ?? '',
    criteria, repositoryMap: mapStart >= 0 ? prompt.slice(mapStart) : '', developerSummary: section(prompt, '## Developer summary'),
    reviewGate: gate?.[0] ?? '', feedback,
    definition: /^## Your task:[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(prompt)?.[1]?.trim() ?? '',
    reReviewChanges: parseReReviewChanges(prompt),
  }
}
