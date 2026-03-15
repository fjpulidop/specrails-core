import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing chat-manager
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import treeKill from 'tree-kill'
import { ChatManager } from './chat-manager'
import { initDb, createConversation, getConversation } from './db'
import type { DbInstance } from './db'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 42000
  child.kill = vi.fn()
  return child
}

function pushLine(child: any, line: string) {
  child.stdout.push(line + '\n')
}

function finishProcess(child: any, code: number): Promise<void> {
  // Push EOF on stdout, then wait for readline to drain before emitting close.
  // readline processes data asynchronously; setImmediate ensures all buffered
  // line events have fired before the close handler runs.
  return new Promise((resolve) => {
    child.stdout.push(null)
    setImmediate(() => {
      child.emit('close', code)
      resolve()
    })
  })
}

function assistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })
}

function resultEvent(sessionId: string): string {
  return JSON.stringify({ type: 'result', session_id: sessionId })
}

function getBroadcastedByType(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type)
}

const TEST_CONV_ID = 'conv-test-001'

describe('ChatManager', () => {
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let cm: ChatManager

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
    db = initDb(':memory:')
    broadcast = vi.fn()
    cm = new ChatManager(broadcast, db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setupConversation(model = 'claude-sonnet-4-5'): string {
    createConversation(db, { id: TEST_CONV_ID, model })
    return TEST_CONV_ID
  }

  // ─── Test 1: sendMessage persists user message and triggers chat_stream + chat_done ─

  it('sendMessage persists user message and triggers chat_stream + chat_done broadcasts', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'Hello world')

    pushLine(child, assistantEvent('Hello '))
    pushLine(child, assistantEvent('back!'))
    pushLine(child, resultEvent('sess-abc'))
    await finishProcess(child, 0)

    await sendPromise

    const streamMsgs = getBroadcastedByType(broadcast, 'chat_stream')
    expect(streamMsgs.length).toBeGreaterThan(0)
    expect(streamMsgs[0].conversationId).toBe(convId)
    expect(streamMsgs[0].delta).toBeTruthy()

    const doneMsgs = getBroadcastedByType(broadcast, 'chat_done')
    expect(doneMsgs).toHaveLength(1)
    expect(doneMsgs[0].conversationId).toBe(convId)
    expect(doneMsgs[0].fullText).toBe('Hello back!')
  })

  // ─── Test 2: abort triggers chat_error { error: 'aborted' } ───────────────

  it('abort triggers chat_error with aborted reason', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'Do something')

    expect(cm.isActive(convId)).toBe(true)
    cm.abort(convId)

    await finishProcess(child, 1)
    await sendPromise

    const errorMsgs = getBroadcastedByType(broadcast, 'chat_error')
    expect(errorMsgs.length).toBeGreaterThan(0)
    expect(errorMsgs[0].conversationId).toBe(convId)
    expect(errorMsgs[0].error).toBe('aborted')
    expect(vi.mocked(treeKill)).toHaveBeenCalledWith(child.pid, 'SIGTERM')
  })

  // ─── Test 3: :::command block triggers chat_command_proposal ──────────────

  it(':::command block in response triggers chat_command_proposal broadcast', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'What should I do?')

    const responseWithCommand = 'You should run:\n:::command\n/sr:implement #5\n:::\nThis will help.'
    pushLine(child, assistantEvent(responseWithCommand))
    pushLine(child, resultEvent('sess-xyz'))
    await finishProcess(child, 0)

    await sendPromise

    const proposalMsgs = getBroadcastedByType(broadcast, 'chat_command_proposal')
    expect(proposalMsgs).toHaveLength(1)
    expect(proposalMsgs[0].conversationId).toBe(convId)
    expect(proposalMsgs[0].command).toBe('/sr:implement #5')
  })

  // ─── Test 4: duplicate :::command blocks not emitted twice ────────────────

  it('duplicate :::command blocks in same response are not emitted twice', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'Suggest something')

    // Emit the same command twice across two chunks (buffer accumulates)
    pushLine(child, assistantEvent(':::command\n/sr:implement #1\n:::'))
    pushLine(child, assistantEvent(' and again :::command\n/sr:implement #1\n:::'))
    pushLine(child, resultEvent('sess-dup'))
    await finishProcess(child, 0)

    await sendPromise

    const proposalMsgs = getBroadcastedByType(broadcast, 'chat_command_proposal')
    expect(proposalMsgs).toHaveLength(1)
  })

  // ─── Test 5: session_id stored in DB after first turn ────────────────────

  it('session_id is stored in DB after first turn completes', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'Hello')

    pushLine(child, assistantEvent('Hi there'))
    pushLine(child, resultEvent('sess-stored'))
    await finishProcess(child, 0)

    await sendPromise

    const conv = getConversation(db, convId)
    expect(conv?.session_id).toBe('sess-stored')
  })

  // ─── Test 6: isActive returns true while running, false after close ───────

  it('isActive returns true while process is running and false after close', async () => {
    const convId = setupConversation()
    const child = createMockChildProcess()
    vi.mocked(mockSpawn).mockReturnValue(child as any)

    const sendPromise = cm.sendMessage(convId, 'Are you active?')
    expect(cm.isActive(convId)).toBe(true)

    pushLine(child, assistantEvent('Yes'))
    pushLine(child, resultEvent('sess-active'))
    await finishProcess(child, 0)

    await sendPromise
    expect(cm.isActive(convId)).toBe(false)
  })
})
