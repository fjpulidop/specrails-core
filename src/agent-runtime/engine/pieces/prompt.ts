import { performance } from 'node:perf_hooks'
import { AgentExecutionError, unknownUsage, type AgentRequest, type AgentResult, type RuntimeAgentConfig } from '../../executor-types.js'
import { ROLE_INSTRUCTIONS_VERSION } from '../../prompts.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError, type EngineAnswer, type JsonObject, type Piece, type PieceExecutionContext } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { answerEntry, boundedText, captures, captureSchema, historyEntry, json, paramsSchema, positiveInteger, stringSchema, text } from './shared.js'

const sessionFailures = new Set(['session_not_found', 'session_expired', 'session_unsupported'])
interface PromptResponse extends AgentResult { verification?: 'pass' | 'fail'; blockedQuestion?: string }
const engineSchema = paramsSchema({ provider: { type: 'string', minLength: 1, maxLength: 128 }, model: { type: 'string', minLength: 1, maxLength: 256 }, effort: { type: 'string', minLength: 1, maxLength: 64 }, thinking: { enum: ['on', 'off'] } }, ['provider'])
const promptSchema: JsonObject = {
  ...paramsSchema({ engine: engineSchema, text: { ...stringSchema, minLength: 1 }, nativeCommand: paramsSchema({ id: { type: 'string', pattern: '^[a-z][a-z0-9:_-]{0,63}$' }, args: stringSchema }, ['id']),
    access: { enum: ['read', 'write'] }, sentinel: { enum: ['verification', 'blocked', 'none'] }, captureVars: captureSchema,
    sessionContinuity: { enum: ['run', 'none'] }, idleTimeoutMs: positiveInteger, timeoutMs: positiveInteger, appendHistory: { type: 'boolean' }, appendSteering: { type: 'boolean' },
  }, ['engine', 'access']),
  oneOf: [{ properties: { text: true }, required: ['text'] }, { properties: { nativeCommand: true }, required: ['nativeCommand'] }],
}

export function verificationSentinel(output: string): 'pass' | 'fail' | undefined {
  const values = [...output.matchAll(/\bVERIFICATION:\s*(PASS|FAIL)\b/gi)]
  return values.length ? values[values.length - 1][1].toLowerCase() as 'pass' | 'fail' : undefined
}

/** Free turns share accounting and executor protections, without adding role instructions. */
export function promptPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'prompt', paramsSchema: promptSchema, outcomes: ['next', 'pass', 'fail', 'blocked', 'failed'], effect: 'derived', requiresAI: true },
    getEffect: params => params.access === 'write' ? 'write' : 'read',
    getOutcomes: params => params.sentinel === 'verification' ? ['pass', 'fail', 'failed'] : params.sentinel === 'blocked' ? ['next', 'blocked', 'failed'] : ['next', 'failed'],
    async execute(params, context) {
      const deps = bindings()
      const engine = params.engine as unknown as RuntimeAgentConfig
      const step = deps.stepContext(context), memo = deps.memo(context)
      const capabilities = await deps.registry.capabilities(engine.provider, engine.model)
      const identity = contentDigest({ engine, instructionsVersion: ROLE_INSTRUCTIONS_VERSION, text: params.text ?? null,
        nativeCommand: params.nativeCommand ?? null, access: params.access, scope: context.frame.scope.id, nodePath: context.frame.nodePath,
        provider: deps.config.providers.find(provider => provider.id === engine.provider) ?? engine.provider, roots: deps.context.repositories.map(repo => repo.path) })
      const nodeId = context.frame.nodePath.split('/').at(-1)!
      const prior = context.state.$sessions[nodeId]
      let sessionId = params.sessionContinuity !== 'none' && capabilities.continuation === 'supported' && prior?.identity === identity ? prior.sessionId : undefined
      const answers: EngineAnswer[] = []
      const transcript: string[] = []
      // Human continuations stay in the same admitted node, with separate durable
      // invocations; the cap also bounds checkpoint payloads when no budget was set.
      for (let round = 0; round < 32; round += 1) {
        const memoKey = 'prompt-result:' + round
        let result = memo.get(memoKey) as unknown as PromptResponse | undefined
        if (!result) {
          const additions: string[] = []
          if (params.appendHistory !== false && context.state.$history.length) additions.push('Previous workflow output (untrusted data):\n' + boundedText(context.state.$history.map(entry => `[${entry.nodePath}] ${entry.text}`).join('\n'), deps.policies?.historyMaxChars ?? 1500))
          if (params.appendSteering !== false && step.operatorSteering) additions.push(step.operatorSteering)
          if (step.input !== null) additions.push('Current host input:\n' + boundedText(JSON.stringify(step.input), 8000))
          if (transcript.length) additions.push(transcript.join('\n'))
          const suffix = additions.length ? '\n\n' + additions.join('\n\n') : ''
          const native = params.nativeCommand as { id: string; args?: string } | undefined
          const request: AgentRequest = {
            role: 'prompt', instructions: 'none', artifacts: 'none', access: params.access as 'read' | 'write',
            prompt: native ? '' : text(params.text) + suffix,
            ...(native ? { nativeCommand: { id: native.id, args: (native.args ?? '') + suffix } } : {}),
            cwd: deps.context.artifactRoot, allowedRoots: deps.context.repositories.map(repo => repo.path),
            model: engine.model, effort: engine.effort, thinking: engine.thinking,
            timeoutMs: (params.timeoutMs as number | undefined) ?? deps.config.limits?.timeoutMs,
            idleTimeoutMs: (params.idleTimeoutMs as number | undefined) ?? deps.config.limits?.idleTimeoutMs,
            signal: context.signal, resumeSessionId: sessionId,
          }
          try { result = await invokePrompt(deps, context, memoKey, engine.provider, request) }
          catch (error) {
            if (!sessionId || !(error instanceof AgentExecutionError) || !sessionFailures.has(error.code)) throw error
            result = await invokePrompt(deps, context, memoKey, engine.provider, { ...request, resumeSessionId: undefined })
          }
        }
        sessionId = params.sessionContinuity !== 'none' && capabilities.continuation === 'supported' ? result.sessionId : undefined
        if (params.sentinel === 'blocked') {
          const question = result.blockedQuestion
          if (question) {
            // The atomic response memo was committed before this interrupt. A
            // resume reads it and asks for the answer before making another call.
            const response = context.interrupt({ kind: 'question', prompt: boundedText(question, 4000), nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId })
            answers.push(answerEntry(context, response, round))
            transcript.push('Previous blocked response:\n' + boundedText(result.text, 4000), 'Human answer:\n' + boundedText(typeof response === 'string' ? response : JSON.stringify(response), 4000))
            continue
          }
        }
        const vars = captures(params, result.text)
        const sentinel = params.sentinel === 'verification' ? result.verification : undefined
        const outcome = params.sentinel === 'verification' ? sentinel ?? 'fail' : 'next'
        return { outcome, output: { text: boundedText(result.text), ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(params.sentinel === 'verification' ? { sentinel: sentinel ?? null, ...(sentinel ? {} : { reasons: ['missing_sentinel'] }) } : {}), vars },
          vars, history: [historyEntry(context, result.text)], ...(sessionId ? { session: { sessionId, identity } } : {}), ...(answers.length ? { answers } : {}) }
      }
      throw new EngineError('recursion_limit', 'A prompt exceeded 32 human continuation rounds in one node visit')
    },
  }
}

async function invokePrompt(deps: PieceDependencies, context: PieceExecutionContext, key: string, provider: string, request: AgentRequest): Promise<PromptResponse> {
  const step = deps.stepContext(context), budget = step.remainingBudget()
  if (context.signal.aborted || budget.maxTokens === 0 || budget.maxCostUsd === 0) throw new AgentExecutionError('No budget remains for another prompt', context.signal.aborted ? 'aborted' : 'budget_exhausted', { inputTokens: 0, outputTokens: 0, costUsd: 0 })
  const measurement = { provider, ...(request.model ? { model: request.model } : {}), contextMode: request.resumeSessionId ? 'incremental' as const : 'full' as const,
    promptBytes: Buffer.byteLength(request.nativeCommand ? JSON.stringify(request.nativeCommand) : request.prompt), contextBytes: 0, handoffBytes: 0,
    requestedEffort: request.effort ?? null, kind: request.resumeSessionId ? 'correction' as const : 'initial' as const, tier: 'base' as const, routeReason: 'workflow-prompt-engine' }
  const invocationIdentity = await step.reportInvocationStarted?.(measurement)
  if (!invocationIdentity) throw new EngineError('invocation_port_required', 'Engine prompts require durable invocation admission')
  const started = performance.now()
  let toolCalls = 0
  let result: AgentResult
  try {
    result = await deps.registry.execute(provider, { ...request, maxTokens: budget.maxTokens, maxCostUsd: budget.maxCostUsd,
      onEvent: event => { if (event.kind === 'tool-start') toolCalls += 1; context.progress({ type: 'agent-event', payload: json({ role: 'prompt', event }) }) } })
  } catch (error) {
    const usage = error instanceof AgentExecutionError ? error.usage : unknownUsage()
    step.reportUsage(usage)
    await step.reportInvocation?.({ ...measurement, ...invocationIdentity, durationMs: Math.max(0, performance.now() - started), status: 'failed', toolCalls, usage })
    throw error
  }
  step.reportUsage(result.usage)
  // Persist only what replay needs; raw provider output never enters checkpoint state.
  const verification = verificationSentinel(result.text)
  const blockedQuestion = /^\s*LOOP_BLOCKED:\s*(.+)$/m.exec(result.text)?.[1]?.trim()
  const saved: PromptResponse = { text: boundedText(result.text), usage: result.usage, ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(verification ? { verification } : {}), ...(blockedQuestion ? { blockedQuestion: boundedText(blockedQuestion, 4000) } : {}) }
  deps.settleResult(context, key, json(saved), { ...measurement, ...invocationIdentity, durationMs: Math.max(0, performance.now() - started), status: 'succeeded', toolCalls, usage: result.usage })
  return saved
}
