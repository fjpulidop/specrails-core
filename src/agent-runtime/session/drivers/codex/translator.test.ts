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
