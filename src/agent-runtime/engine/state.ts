import { Annotation } from '@langchain/langgraph'
import { EphemeralValue } from '@langchain/langgraph/channels'
import { canonicalJson } from './canonical-json.js'
import { EngineError, type BranchState, type CandidateState, type CoreDefinitionState, type EngineAnswer, type EngineUsage, type ExecutionScope, type HistoryEntry, type JsonValue, type TerminalCommit, type VerifiedState } from './contracts.js'

export function emptyUsage(): EngineUsage {
  return { revision: 0, invocations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, knownCostUsd: 0, knownInputTokens: 0, knownOutputTokens: 0 }
}

function mergeKeys<T>(previous: Record<string, T>, update: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, previous, update)
}

export function mergeRevision<T extends { revision: number }>(previous: T, update: T): T {
  if (update.revision < previous.revision) return previous
  if (update.revision === previous.revision && canonicalJson(update) !== canonicalJson(previous)) throw new EngineError('state_revision_conflict', 'Two different values have the same durable revision')
  return update
}

type OrderedRecord = { id: string; transition: number; attempt: number; ordinal: number }
export function mergeOrdered<T extends OrderedRecord>(previous: T[], update: T[]): T[] {
  const entries = new Map(previous.map(value => [value.id, value]))
  for (const value of update) {
    const existing = entries.get(value.id)
    if (existing && canonicalJson(existing) !== canonicalJson(value)) throw new EngineError('state_record_conflict', `Record ${value.id} has conflicting content`)
    entries.set(value.id, value)
  }
  return [...entries.values()].sort((a, b) => a.transition - b.transition || a.attempt - b.attempt || a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function mergeHistory(previous: HistoryEntry[], update: HistoryEntry[], maxChars: number): HistoryEntry[] {
  const bounded = update.flatMap(entry => {
    if (JSON.stringify(entry).length <= maxChars - 2) return [entry]
    let low = 0
    let high = Math.min(entry.text.length, maxChars)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (JSON.stringify({ ...entry, text: entry.text.slice(0, middle), truncated: true }).length <= maxChars - 2) low = middle
      else high = middle - 1
    }
    const trimmed = { ...entry, text: entry.text.slice(0, low).replace(/[\uD800-\uDBFF]$/, ''), truncated: true }
    return JSON.stringify(trimmed).length <= maxChars - 2 ? [trimmed] : []
  })
  const entries = mergeOrdered(previous, bounded)
  let total = 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0)
  while (entries.length && total > maxChars) total -= JSON.stringify(entries.shift()!).length + (entries.length ? 1 : 0)
  return entries
}

function mergeBranches(previous: Record<string, BranchState>, update: Record<string, BranchState>): Record<string, BranchState> {
  const merged = mergeKeys(previous, {})
  for (const [id, branch] of Object.entries(update)) {
    const existing = merged[id]
    if (existing?.visitId !== branch.visitId && existing?.visitId && branch.visitId) {
      if ((branch.transition ?? 0) <= (existing.transition ?? 0)) continue
      merged[id] = { ...branch, done: branch.results.length }
      continue
    }
    if (existing && existing.total !== branch.total) throw new EngineError('state_record_conflict', `Branch count changed for ${id}`)
    const results = mergeOrdered(existing?.results ?? [], branch.results)
    merged[id] = { ...branch, results, done: results.length }
  }
  return merged
}

/** Private commit markers reach each task's saver writes and expire after a superstep. */
export function definitionStateSchema(historyMaxChars = 1500, scope: ExecutionScope | null = { id: 'root', nodePathPrefix: '' }) {
  return Annotation.Root({
    $outputs: Annotation<Record<string, JsonValue>>({ reducer: mergeKeys, default: () => ({}) }),
    $vars: Annotation<Record<string, JsonValue>>({ reducer: mergeKeys, default: () => ({}) }),
    $history: Annotation<HistoryEntry[]>({ reducer: (a, b) => mergeHistory(a, b, historyMaxChars), default: () => [] }),
    $sessions: Annotation<CoreDefinitionState['$sessions']>({ reducer: mergeKeys, default: () => ({}) }),
    $usage: Annotation<EngineUsage>({ reducer: mergeRevision, default: emptyUsage }),
    $attempts: Annotation<Record<string, number>>({ reducer: (a, b) => { const result = mergeKeys(a, {}); for (const [id, count] of Object.entries(b)) result[id] = Math.max(result[id] ?? 0, count); return result }, default: () => ({}) }),
    $consecutiveFailures: Annotation<CoreDefinitionState['$consecutiveFailures']>({ reducer: mergeRevision, default: () => ({ revision: 0, count: 0 }) }),
    $candidate: Annotation<CandidateState | null>({ reducer: (a, b) => b === null ? a : a === null ? b : mergeRevision(a, b), default: () => null }),
    // Only the exclusive writer emits this channel. Read branches never publish stale receipts.
    $verified: Annotation<VerifiedState | null>({ reducer: (a, b) => b === null ? null : a === null ? b : mergeRevision(a, b), default: () => null }),
    $answers: Annotation<EngineAnswer[]>({ reducer: mergeOrdered, default: () => [] }),
    $branches: Annotation<Record<string, BranchState>>({ reducer: mergeBranches, default: () => ({}) }),
    $maps: Annotation<CoreDefinitionState['$maps']>({ reducer: mergeKeys, default: () => ({}) }),
    $transitions: Annotation<number>({ reducer: Math.max, default: () => 0 }),
    $lastOutcome: Annotation<Record<string, string>>({ reducer: mergeKeys, default: () => ({}) }),
    $item: Annotation<CoreDefinitionState['$item']>({ reducer: (_a, b) => b, default: () => null }),
    $scope: Annotation<ExecutionScope>({ reducer: (a, b) => { if (!a.id) return b; if (canonicalJson(a) !== canonicalJson(b)) throw new EngineError('state_scope_conflict', 'Execution scope is immutable'); return a }, default: () => structuredClone(scope ?? { id: '', nodePathPrefix: '' }) }),
    $exit: Annotation<CoreDefinitionState['$exit']>({ reducer: (a, b) => b && (!a || b.transition >= a.transition) ? b : a, default: () => null }),
    $commit: new EphemeralValue<TerminalCommit>(false),
  })
}

export function initialDefinitionState(vars: Record<string, JsonValue> = {}, scope: ExecutionScope = { id: 'root', nodePathPrefix: '' }): CoreDefinitionState {
  return { $outputs: {}, $vars: structuredClone(vars), $history: [], $sessions: {}, $usage: emptyUsage(), $attempts: {},
    $consecutiveFailures: { revision: 0, count: 0 }, $candidate: null, $verified: null, $answers: [], $branches: {}, $maps: {},
    $transitions: 0, $lastOutcome: {}, $item: null, $scope: structuredClone(scope), $exit: null }
}
