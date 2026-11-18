import { describe, expect, it } from 'vitest'

import { CodexTranslator } from './translator.js'

// Shape of a codex-cli 0.160.1 `imageGeneration` ThreadItem (app-server v2 schema).
const imageItem = (overrides: Record<string, unknown> = {}) => ({
  type: 'imageGeneration',
  id: 'exec-img-1',
  status: 'completed',
  revisedPrompt: 'Planet Earth seen from space',
  result: 'iVBORw0KGgo'.repeat(10_000),
  savedPath: '/Users/me/.codex/generated_images/thread-1/exec-img-1.png',
  transparentBackground: false,
  failure: null,
  ...overrides,
})

function rootTurn(): CodexTranslator {
  const translator = new CodexTranslator()
  translator.setRoot('thread-1', 'gpt')
  translator.noteTurnRequested('in-1')
  translator.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  return translator
}

describe('CodexTranslator imageGeneration items', () => {
  it('reports a generated image by path with a tool activity, never the inline base64', () => {
    const translator = rootTurn()
    const started = translator.notification('item/started', { threadId: 'thread-1', item: imageItem({ status: 'inProgress', result: '', savedPath: null }) })
    const completed = translator.notification('item/completed', { threadId: 'thread-1', item: imageItem() })

    expect(started).toEqual([{ kind: 'turn.tool', toolUseId: 'exec-img-1', name: 'imageGeneration', phase: 'started', input: 'Planet Earth seen from space' }])
    expect(completed).toEqual([
      { kind: 'turn.tool', toolUseId: 'exec-img-1', name: 'imageGeneration', phase: 'completed', output: '/Users/me/.codex/generated_images/thread-1/exec-img-1.png' },
      { kind: 'turn.image', imageId: 'exec-img-1', path: '/Users/me/.codex/generated_images/thread-1/exec-img-1.png', mimeType: 'image/png', prompt: 'Planet Earth seen from space' },
    ])
    expect(JSON.stringify(completed)).not.toContain('iVBORw0KGgo')
    // A repeated completion is ignored.
    expect(translator.notification('item/completed', { threadId: 'thread-1', item: imageItem() })).toEqual([])
  })

  it('reports a failed generation as a failed tool call and no image', () => {
    const translator = rootTurn()
    const events = translator.notification('item/completed', { threadId: 'thread-1', item: imageItem({ status: 'failed', savedPath: null, failure: { message: 'blocked' } }) })
    expect(events).toEqual([
      { kind: 'turn.tool', toolUseId: 'exec-img-1', name: 'imageGeneration', phase: 'started', input: 'Planet Earth seen from space' },
      { kind: 'turn.tool', toolUseId: 'exec-img-1', name: 'imageGeneration', phase: 'completed', output: '{"message":"blocked"}', isError: true },
    ])
  })

  it('infers the MIME type from the saved file extension', () => {
    const translator = rootTurn()
    const events = translator.notification('item/completed', { threadId: 'thread-1', item: imageItem({ savedPath: '/tmp/x/photo.JPG' }) })
    expect(events.find((event) => event.kind === 'turn.image')).toMatchObject({ mimeType: 'image/jpeg' })
  })
})

describe('CodexTranslator context usage', () => {
  // `thread/tokenUsage/updated` as codex-cli 0.160.1 app-server emits it.
  const tokenUsage = (threadId: string, last: number, total: number, window: number | null = 258_400) => ({
    threadId,
    turnId: 'turn-1',
    tokenUsage: {
      total: { totalTokens: total, inputTokens: total - 100, cachedInputTokens: 13_184, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
      last: { totalTokens: last, inputTokens: last - 69, cachedInputTokens: 13_184, cacheWriteInputTokens: 0, outputTokens: 69, reasoningOutputTokens: 0 },
      ...(window === null ? {} : { modelContextWindow: window }),
    },
  })
  const complete = (translator: CodexTranslator, turnId = 'turn-1') => translator.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, items: [], status: 'completed', error: null } })
    .find((event) => event.kind === 'turn.completed') as Extract<ReturnType<CodexTranslator['notification']>[number], { kind: 'turn.completed' }>

  it('maps the last request total and the model window, not the cumulative total', () => {
    const translator = rootTurn()
    translator.notification('thread/tokenUsage/updated', tokenUsage('thread-1', 16_025, 16_025))
    translator.notification('thread/tokenUsage/updated', tokenUsage('thread-1', 21_300, 37_325))
    const done = complete(translator)
    expect(done.context).toEqual({ usedTokens: 21_300, windowTokens: 258_400, model: 'gpt' })
    expect(done.usage.totalTokens).toBe(37_325)
  })

  it('ignores child threads and omits the context for a turn without token usage', () => {
    const translator = rootTurn()
    translator.notification('item/completed', { threadId: 'thread-1', item: { type: 'subAgentActivity', id: 'sa-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/worker' } })
    translator.notification('thread/tokenUsage/updated', tokenUsage('child-1', 90_000, 90_000))
    expect(complete(translator).context).toBeUndefined()

    translator.noteTurnRequested('in-2')
    translator.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } })
    translator.notification('thread/tokenUsage/updated', tokenUsage('thread-1', 5_000, 50_000, null))
    expect(complete(translator, 'turn-2').context).toEqual({ usedTokens: 5_000, windowTokens: null, model: 'gpt' })
  })
})

describe('CodexTranslator usage limits', () => {
  it('reports account/rateLimits/updated as a typed rate-limit event without a thread', () => {
    const translator = new CodexTranslator()
    const events = translator.notification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 1791386108 }, rateLimitReachedType: null } })
    expect(events).toEqual([{ kind: 'rate-limit', rateLimit: expect.objectContaining({ status: 'allowed', rateLimitType: 'codex:primary', utilization: 0.85 }) }])
    expect(translator.notification('account/rateLimits/updated', { rateLimits: {} })).toEqual([])
  })
})
