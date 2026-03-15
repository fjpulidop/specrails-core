import { spawn, execSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { getConversation, addMessage, updateConversation } from './db'

const SYSTEM_PROMPT =
  'You are a project assistant with full access to this repository via Claude Code. ' +
  'You can help answer questions about the codebase, explain SpecRails concepts, and suggest commands to run. ' +
  'When you want to suggest a SpecRails command for the user to execute, wrap it in a command block like this: ' +
  ':::command\n/sr:implement #42\n::: ' +
  'The user will be prompted to confirm before the command runs.'

function claudeOnPath(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function extractTextFromEvent(event: Record<string, unknown>): string | null {
  const type = event.type as string
  if (type === 'assistant') {
    const content = event.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const texts = (content?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
    return texts.join('') || null
  }
  return null
}

function extractCommandProposals(text: string): string[] {
  const regex = /:::command\s*\n([\s\S]*?):::/g
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1].trim())
  }
  return results
}

// ─── ChatManager ──────────────────────────────────────────────────────────────

export class ChatManager {
  private _broadcast: (msg: WsMessage) => void
  private _db: DbInstance
  private _activeProcesses: Map<string, ChildProcess>
  private _buffers: Map<string, string>
  private _emittedProposals: Map<string, Set<string>>
  private _abortingConversations: Set<string>

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance) {
    this._broadcast = broadcast
    this._db = db
    this._activeProcesses = new Map()
    this._buffers = new Map()
    this._emittedProposals = new Map()
    this._abortingConversations = new Set()
  }

  isActive(conversationId: string): boolean {
    return this._activeProcesses.has(conversationId)
  }

  async sendMessage(conversationId: string, userText: string): Promise<void> {
    if (this._activeProcesses.has(conversationId)) {
      console.warn(`[ChatManager] conversation ${conversationId} already has an active stream`)
      return
    }

    if (!claudeOnPath()) {
      this._broadcast({
        type: 'chat_error',
        conversationId,
        error: 'CLAUDE_NOT_FOUND',
        timestamp: new Date().toISOString(),
      })
      return
    }

    const conversation = getConversation(this._db, conversationId)
    if (!conversation) {
      console.warn(`[ChatManager] conversation ${conversationId} not found`)
      return
    }

    // Check if this is turn 1 (session_id was null before this message)
    const isFirstTurn = conversation.session_id === null

    // Persist user message
    addMessage(this._db, { conversation_id: conversationId, role: 'user', content: userText })

    // Build spawn args
    const args: string[] = [
      '--model', conversation.model,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt', SYSTEM_PROMPT,
      '-p', userText,
    ]

    if (conversation.session_id) {
      args.push('--resume', conversation.session_id)
    }

    const child = spawn('claude', args, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this._activeProcesses.set(conversationId, child)
    this._buffers.set(conversationId, '')
    this._emittedProposals.set(conversationId, new Set())

    let capturedSessionId: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* skip non-JSON */ }
      if (!parsed) return

      const eventType = parsed.type as string

      if (eventType === 'result') {
        const sid = parsed.session_id as string | undefined
        if (sid) capturedSessionId = sid
      }

      const newText = extractTextFromEvent(parsed)
      if (newText) {
        const prev = this._buffers.get(conversationId) ?? ''
        const updated = prev + newText
        this._buffers.set(conversationId, updated)

        this._broadcast({
          type: 'chat_stream',
          conversationId,
          delta: newText,
          timestamp: new Date().toISOString(),
        })

        // Check for new command proposals
        const proposals = extractCommandProposals(updated)
        const emitted = this._emittedProposals.get(conversationId)
        if (emitted) {
          for (const proposal of proposals) {
            if (!emitted.has(proposal)) {
              emitted.add(proposal)
              this._broadcast({
                type: 'chat_command_proposal',
                conversationId,
                command: proposal,
                timestamp: new Date().toISOString(),
              })
            }
          }
        }
      }
    })

    return new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const fullText = this._buffers.get(conversationId) ?? ''
        const wasAborting = this._abortingConversations.has(conversationId)

        // Clean up tracking state
        this._activeProcesses.delete(conversationId)
        this._buffers.delete(conversationId)
        this._emittedProposals.delete(conversationId)
        this._abortingConversations.delete(conversationId)

        if (wasAborting) {
          // abort already emitted chat_error
          resolve()
          return
        }

        if (code === 0) {
          // Persist assistant message
          if (fullText) {
            addMessage(this._db, { conversation_id: conversationId, role: 'assistant', content: fullText })
          }

          // Update session_id
          if (capturedSessionId) {
            updateConversation(this._db, conversationId, { session_id: capturedSessionId })
          }

          this._broadcast({
            type: 'chat_done',
            conversationId,
            fullText,
            timestamp: new Date().toISOString(),
          })

          // Auto-title on first turn
          if (isFirstTurn && fullText) {
            this._autoTitle(conversationId, userText, fullText)
          }
        } else {
          this._broadcast({
            type: 'chat_error',
            conversationId,
            error: `Process exited with code ${code ?? 'unknown'}`,
            timestamp: new Date().toISOString(),
          })
        }

        resolve()
      })
    })
  }

  abort(conversationId: string): void {
    const child = this._activeProcesses.get(conversationId)
    if (!child || !child.pid) return

    this._abortingConversations.add(conversationId)
    treeKill(child.pid, 'SIGTERM')

    this._broadcast({
      type: 'chat_error',
      conversationId,
      error: 'aborted',
      timestamp: new Date().toISOString(),
    })
  }

  private _autoTitle(conversationId: string, firstUserMsg: string, firstResponse: string): void {
    try {
      const titlePrompt =
        `Generate a 4-6 word title for this conversation. Output ONLY the title text, no quotes or punctuation.\n\n` +
        `User: ${firstUserMsg.slice(0, 200)}\nAssistant: ${firstResponse.slice(0, 300)}`

      const child = spawn('claude', [
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '-p', titlePrompt,
      ], {
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let titleText = ''
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

      reader.on('line', (line) => {
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(line) } catch { return }
        if (!parsed) return

        // Take only the first assistant event's text
        if (!titleText) {
          const text = extractTextFromEvent(parsed)
          if (text) titleText = text.trim()
        }
      })

      child.on('close', (code) => {
        if (code === 0 && titleText) {
          updateConversation(this._db, conversationId, { title: titleText })
          this._broadcast({
            type: 'chat_title_update',
            conversationId,
            title: titleText,
            timestamp: new Date().toISOString(),
          })
        }
      })
    } catch {
      // auto-title is fire-and-forget; failure is silent
    }
  }
}
