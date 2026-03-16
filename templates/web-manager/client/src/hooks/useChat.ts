import { useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'
import type { ChatConversationSummary, ChatMessage } from '../types'
import { getApiBase } from '../lib/api'

const PANEL_OPEN_KEY = 'specrails.chatPanelOpen'

export interface ChatConversation {
  id: string
  title: string | null
  model: string
  messages: ChatMessage[]
  isStreaming: boolean
  streamingText: string
  commandProposals: string[]
}

export interface UseChatReturn {
  conversations: ChatConversation[]
  activeTabIndex: number
  isPanelOpen: boolean
  setActiveTabIndex: (i: number) => void
  togglePanel: () => void
  createConversation: (model?: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  sendMessage: (conversationId: string, text: string) => Promise<void>
  abortStream: (conversationId: string) => Promise<void>
  confirmCommand: (command: string) => Promise<void>
  dismissCommandProposal: (conversationId: string, command: string) => void
}

export function useChat(): UseChatReturn {
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [isPanelOpen, setIsPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === 'true'
    } catch {
      return false
    }
  })

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Load existing conversations on mount
  useEffect(() => {
    async function load() {
      try {
        const base = getApiBase()
        const res = await fetch(`${base}/chat/conversations`)
        if (!res.ok) return
        const data = await res.json() as { conversations: ChatConversationSummary[] }
        const convos = data.conversations.slice(0, 3)

        const withMessages: ChatConversation[] = await Promise.all(
          convos.map(async (c) => {
            try {
              const msgRes = await fetch(`${getApiBase()}/chat/conversations/${c.id}/messages`)
              const msgData = msgRes.ok ? await msgRes.json() as { messages: ChatMessage[] } : { messages: [] }
              return {
                id: c.id,
                title: c.title,
                model: c.model,
                messages: msgData.messages,
                isStreaming: false,
                streamingText: '',
                commandProposals: [],
              }
            } catch {
              return {
                id: c.id,
                title: c.title,
                model: c.model,
                messages: [],
                isStreaming: false,
                streamingText: '',
                commandProposals: [],
              }
            }
          })
        )
        setConversations(withMessages)
      } catch {
        // ignore fetch errors on mount
      }
    }
    load()
  }, [])

  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (typeof msg.type !== 'string') return

    // In hub mode, filter messages to the active project only
    const apiBase = getApiBase()
    const activeProjectId = apiBase.startsWith('/api/projects/')
      ? apiBase.split('/api/projects/')[1]
      : null

    if (activeProjectId && msg.projectId && msg.projectId !== activeProjectId) {
      return
    }

    if (msg.type === 'chat_stream') {
      const conversationId = msg.conversationId as string
      const delta = msg.delta as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, isStreaming: true, streamingText: c.streamingText + delta }
            : c
        )
      )
    } else if (msg.type === 'chat_done') {
      const conversationId = msg.conversationId as string
      const fullText = msg.fullText as string
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== conversationId) return c
          const finalMessage: ChatMessage = {
            id: Date.now(),
            conversation_id: conversationId,
            role: 'assistant',
            content: fullText,
            created_at: new Date().toISOString(),
          }
          return {
            ...c,
            isStreaming: false,
            streamingText: '',
            messages: [...c.messages, finalMessage],
          }
        })
      )
    } else if (msg.type === 'chat_error') {
      const conversationId = msg.conversationId as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, isStreaming: false, streamingText: '' }
            : c
        )
      )
    } else if (msg.type === 'chat_command_proposal') {
      const conversationId = msg.conversationId as string
      const command = msg.command as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId && !c.commandProposals.includes(command)
            ? { ...c, commandProposals: [...c.commandProposals, command] }
            : c
        )
      )
    } else if (msg.type === 'chat_title_update') {
      const conversationId = msg.conversationId as string
      const title = msg.title as string
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title } : c))
      )
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('chat', handleMessage)
    return () => unregisterHandler('chat')
  }, [handleMessage, registerHandler, unregisterHandler])

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => {
      const next = !prev
      try { localStorage.setItem(PANEL_OPEN_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const createConversation = useCallback(async (model = 'claude-sonnet-4-5') => {
    try {
      const res = await fetch(`${getApiBase()}/chat/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) return
      const data = await res.json() as { conversation: ChatConversationSummary }
      const newConvo: ChatConversation = {
        id: data.conversation.id,
        title: data.conversation.title,
        model: data.conversation.model,
        messages: [],
        isStreaming: false,
        streamingText: '',
        commandProposals: [],
      }
      setConversations((prev) => {
        const next = [...prev, newConvo].slice(0, 3)
        // Switch to the newly created tab using the current (pre-add) length
        setActiveTabIndex(Math.min(prev.length, 2))
        return next
      })
    } catch {
      // ignore
    }
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`${getApiBase()}/chat/conversations/${id}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id)
      return next
    })
    setActiveTabIndex((prev) => Math.max(0, prev - 1))
  }, [])

  const sendMessage = useCallback(async (conversationId: string, text: string) => {
    // Optimistically add user message to local state
    const optimisticMsg: ChatMessage = {
      id: Date.now(),
      conversation_id: conversationId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, optimisticMsg], isStreaming: true }
          : c
      )
    )

    try {
      await fetch(`${getApiBase()}/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    } catch {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, isStreaming: false } : c))
      )
    }
  }, [])

  const abortStream = useCallback(async (conversationId: string) => {
    try {
      await fetch(`${getApiBase()}/chat/conversations/${conversationId}/messages/stream`, {
        method: 'DELETE',
      })
    } catch { /* ignore */ }
  }, [])

  const confirmCommand = useCallback(async (command: string) => {
    try {
      await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
    } catch { /* ignore */ }
  }, [])

  const dismissCommandProposal = useCallback((conversationId: string, command: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, commandProposals: c.commandProposals.filter((p) => p !== command) }
          : c
      )
    )
  }, [])

  return {
    conversations,
    activeTabIndex,
    isPanelOpen,
    setActiveTabIndex,
    togglePanel,
    createConversation,
    deleteConversation,
    sendMessage,
    abortStream,
    confirmCommand,
    dismissCommandProposal,
  }
}
