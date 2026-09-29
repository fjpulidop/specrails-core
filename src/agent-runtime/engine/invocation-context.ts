import { randomUUID } from 'node:crypto'
import type { PendingProviderInvocation, ProviderInvocation } from '../efficiency-types.js'
import type { WorkflowState, WorkflowStepContext } from '../workflow-types.js'
import { EngineError, type JsonValue, type PieceExecutionContext, type WorkflowBudget } from './contracts.js'
import type { RunLedger } from './checkpoint/ledger.js'
import type { WorkflowDefinition, DefinitionNode } from './definition-types.js'
import { remainingBudget } from './budget.js'
import { projectDurableEvent, traceIdFor } from './events.js'
import { contentDigest } from './canonical-json.js'
import { ControlInbox, renderOperatorSteering } from './steering/inbox.js'

/** Resolve declared paths without interpreting LangGraph's opaque namespaces. */
export function definitionNodeAt(definition: WorkflowDefinition, nodePath: string): DefinitionNode | undefined {
  let nodes = definition.nodes, node: DefinitionNode | undefined
  for (const segment of nodePath.split('/')) {
    node = nodes[segment]
    if (!node) return undefined
    const reference = node.kind === 'component' ? node.params.ref : node.kind === 'map' ? node.params.body : undefined
    nodes = typeof reference === 'string' ? definition.components?.[reference]?.nodes ?? {} : {}
  }
  return node
}

export function roleAt(definition: WorkflowDefinition, nodePath: string): string {
  const node = definitionNodeAt(definition, nodePath)
  if (node?.kind === 'role-turn' || node?.kind === 'decider') return String(node.params.roleId)
  return node?.kind === 'prompt' ? 'prompt' : nodePath.split('/').at(-1)!
}

export function ledgerBudget(ledger: RunLedger): WorkflowBudget {
  const row = ledger.db.get('budget', { run_id: ledger.runId })!
  return { ...(row.max_cost_usd === null ? {} : { maxCostUsd: Number(row.max_cost_usd) }),
    ...(row.max_tokens === null ? {} : { maxTokens: Number(row.max_tokens) }),
    ...(row.max_duration_ms === null ? {} : { maxDurationMs: Number(row.max_duration_ms) }) }
}

export function ledgerWorkflowState(ledger: RunLedger, definition: WorkflowDefinition, scopeId = 'root'): WorkflowState {
  const row = ledger.run(), snapshot = ledger.scopeSnapshot(scopeId), usage = snapshot.usage
  const attempts = new Map(ledger.db.sqlite.prepare("SELECT a.*,v.effect FROM attempts a JOIN visits v ON a.visit_id=v.visit_id WHERE a.run_id=? AND (?='*' OR a.scope_id=?)").all(ledger.runId, scopeId, scopeId).map(item => [String(item.attempt_id), item]))
  const invocations = new Map<string, Array<Record<string, unknown>>>()
  for (const item of ledger.db.sqlite.prepare('SELECT * FROM invocations WHERE run_id=? ORDER BY started_at,ordinal').all(ledger.runId)) {
    const key = String(item.attempt_id), entries = invocations.get(key) ?? []
    entries.push(item); invocations.set(key, entries)
  }
  const history: WorkflowState['history'] = snapshot.attempts.map(attempt => {
    const details = attempts.get(attempt.frame.attemptId)!, rows = invocations.get(attempt.frame.attemptId) ?? []
    const completed = rows.filter(item => item.result_json).map(item => JSON.parse(String(item.result_json)) as ProviderInvocation)
    const sum = (key: 'costUsd' | 'inputTokens' | 'outputTokens') => rows.some(item => !item.result_json) || completed.some(item => item.usage[key] == null) ? null : completed.reduce((total, item) => total + (item.usage[key] ?? 0), 0)
    return { id: attempt.frame.attemptId, stepId: roleAt(definition, attempt.frame.nodePath), attempt: attempt.frame.attempt, visit: attempt.frame.visit,
      status: attempt.status as WorkflowState['history'][number]['status'], startedAt: String(details.started_at),
      ...(details.ended_at ? { completedAt: String(details.ended_at) } : {}),
      ...(attempt.result?.output === undefined ? {} : { output: attempt.result.output }),
      ...(attempt.error ? { error: attempt.error.message } : {}),
      ...(rows.length ? { usage: { costUsd: sum('costUsd'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') } } : {}),
      invocations: completed, pendingInvocations: rows.filter(item => !item.result_json).map(item => ({
        invocationId: String(item.invocation_id), ordinal: Number(item.ordinal), provider: String(item.provider), ...(item.model ? { model: String(item.model) } : {}),
      })),
    }
  })
  const steps: WorkflowState['steps'] = {}
  for (const attempt of snapshot.attempts) {
    const details = attempts.get(attempt.frame.attemptId)!
    steps[attempt.frame.nodePath] = { id: attempt.frame.nodePath, status: attempt.status as WorkflowState['steps'][string]['status'],
      effect: details.effect as 'read' | 'write', visits: attempt.frame.visit, attempt: attempt.frame.attempt, attemptId: attempt.frame.attemptId,
      startedAt: String(details.started_at), ...(details.ended_at ? { completedAt: String(details.ended_at) } : {}),
      ...(attempt.result?.output === undefined ? {} : { output: attempt.result.output }),
      ...(attempt.result?.childUpdate ? { update: attempt.result.childUpdate } : {}), ...(attempt.error ? { error: attempt.error.message } : {}) }
  }
  const interruptions = ledger.db.sqlite.prepare("SELECT * FROM interrupts WHERE run_id=? AND (?='*' OR scope_id=?) ORDER BY requested_at DESC,interrupt_id DESC").all(ledger.runId, scopeId, scopeId)
  const pending = interruptions.find(item => !item.answered_at) ?? interruptions[0]
  const request = pending ? JSON.parse(String(pending.payload_json)) as { kind: string; prompt: string } : undefined
  const answer = pending?.answer_json ? JSON.parse(String(pending.answer_json)) as { answer?: string; approved?: boolean } : undefined
  const events = ledger.events().filter(event => scopeId === '*' || !event.scopeId || event.scopeId === scopeId).flatMap(event => {
    const projected = projectDurableEvent(event)
    return projected.type === 'workflow-event' ? [projected.event as unknown as WorkflowState['events'][number]] : []
  })
  return { schemaVersion: 2, runId: ledger.runId, traceId: traceIdFor(ledger.runId), workflowId: definition.id,
    workflowVersion: definition.version, workflowFingerprint: definition.version, inputFingerprint: contentDigest(JSON.parse(String(row.request_json))),
    status: String(row.status) as WorkflowState['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    nextStep: pending && !pending.answered_at ? String(pending.node_path) : [...snapshot.attempts].reverse().find(attempt => ['running', 'interrupted', 'failed'].includes(attempt.status))?.frame.nodePath ?? null,
    nextAttempt: history.length + 1, transitions: snapshot.transitions, executionCount: history.length, steps, history, events, budget: ledgerBudget(ledger),
    ...(pending && request?.kind === 'question' ? { pendingQuestion: { stepId: String(pending.node_path), requestedAt: String(pending.requested_at), question: request.prompt,
      ...(pending.answered_at ? { answeredAt: String(pending.answered_at), answer: typeof answer === 'string' ? answer : answer?.answer } : {}) } } : {}),
    ...(pending && ['approval', 'gate'].includes(request?.kind ?? '') ? { pendingApproval: { stepId: String(pending.node_path), requestedAt: String(pending.requested_at), reason: request!.prompt,
      ...(pending.answered_at ? { grantedAt: String(pending.answered_at) } : {}) } } : {}),
    usage: { costUsd: usage.costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, knownCostUsd: usage.knownCostUsd,
      knownTokens: usage.knownInputTokens + usage.knownOutputTokens, durationMs: ledger.activeDurationMs() },
  }
}

/** Adapter to the existing efficient role invoker; SQLite remains the sole journal. */
export function invocationStepContext(ledger: RunLedger, definition: WorkflowDefinition, context: PieceExecutionContext, input: JsonValue = null): WorkflowStepContext {
  const budget = ledgerBudget(ledger)
  const messages = new ControlInbox(ledger.db, ledger.runId).assigned(context.frame)
  const pendingRow = ledger.db.sqlite.prepare('SELECT payload_json FROM interrupts WHERE run_id=? AND attempt_id=? ORDER BY requested_at DESC,interrupt_id DESC LIMIT 1').get(ledger.runId, context.frame.attemptId)
  const pending = pendingRow ? JSON.parse(String(pendingRow.payload_json)) as { kind: string; prompt: string } : undefined
  let offered: WorkflowBudget | undefined
  const headroom = (): WorkflowBudget => {
    const live = ledger.db.sqlite.prepare('SELECT COUNT(*) count,COALESCE(SUM(max_tokens),0) tokens,COALESCE(SUM(max_cost_usd),0) cost FROM reservations WHERE run_id=?').get(ledger.runId)!
    const remaining = remainingBudget(ledger.usage(), budget, ledger.activeDurationMs(), { costUsd: Number(live.cost), tokens: Number(live.tokens) })
    // Each concurrent caller receives a bounded share of unreserved capacity.
    // Actual usage returns the unused share immediately at invocation settlement.
    const parallelism = Math.min(definition.policies?.concurrency ?? 1, context.frame.scope.limits?.[0]?.concurrency ?? definition.policies?.concurrency ?? 1)
    const slots = Math.max(1, parallelism - Number(live.count))
    offered = { ...remaining,
      ...(remaining.maxTokens === undefined ? {} : { maxTokens: Math.floor(remaining.maxTokens / slots) }),
      ...(remaining.maxCostUsd === undefined ? {} : { maxCostUsd: remaining.maxCostUsd / slots }),
    }
    return offered
  }
  return {
    runId: ledger.runId, stepId: context.frame.nodePath, attemptId: context.frame.attemptId, attempt: context.frame.attempt,
    input, ...(messages.length ? { operatorSteering: renderOperatorSteering(messages) } : {}),
    ...(pending?.kind === 'question' ? { pending: { kind: 'question' as const, question: pending.prompt } } : pending && ['approval', 'gate'].includes(pending.kind) ? { pending: { kind: 'approval' as const, reason: pending.prompt } } : {}),
    signal: context.signal, checkpoint: ledgerWorkflowState(ledger, definition, context.frame.scope.id), remainingBudget: headroom,
    interrupt: request => context.interrupt({ kind: request.kind, prompt: request.kind === 'approval' ? request.reason : request.question,
      nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId }) as never,
    // The existing invoker calls this immediately before its finally settlement.
    // Never charge twice: ProviderInvocation is the durable source of usage.
    reportUsage: () => {},
    reportInvocationStarted: async (measurement: Omit<PendingProviderInvocation, 'invocationId' | 'ordinal'>) => {
      const invocationId = randomUUID(), limits = offered ?? headroom()
      if (limits.maxTokens === 0 || limits.maxCostUsd === 0) throw new EngineError('budget_exhausted', 'No unreserved budget remains for a provider invocation')
      const ordinal = ledger.startInvocation(context.frame, { ...measurement, invocationId, role: roleAt(definition, context.frame.nodePath) }, limits)
      offered = undefined
      return { invocationId, ordinal }
    },
    reportInvocation: async invocation => {
      if (!invocation.invocationId) throw new EngineError('invocation_mismatch', 'Provider settlement requires its durable invocation ID')
      ledger.settleInvocation(context.frame, { ...invocation, invocationId: invocation.invocationId })
    },
    reportEfficiencyActivity: async (kind, payload) => context.progress({ type: 'runtime-efficiency-event', payload: { kind, ...payload } }),
  }
}
