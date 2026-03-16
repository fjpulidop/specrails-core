import { useChat } from '../hooks/useChat'
import { ChatHeader } from '../components/ChatHeader'
import { MessageList } from '../components/MessageList'
import { ChatInput } from '../components/ChatInput'
import { cn } from '../lib/utils'

export default function ConversationsPage() {
  const {
    conversations,
    activeTabIndex,
    setActiveTabIndex,
    createConversation,
    deleteConversation,
    sendMessage,
    abortStream,
    confirmCommand,
    dismissCommandProposal,
  } = useChat()

  const activeConversation = conversations[activeTabIndex] ?? null

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-base font-semibold">Conversations</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Chat with an AI assistant that has access to this project
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border/30 px-4">
        {conversations.map((conv, i) => (
          <div
            key={conv.id}
            className={cn(
              'group flex min-w-0 max-w-[140px] cursor-pointer items-center gap-1 px-3 py-2',
              'text-xs transition-colors',
              i === activeTabIndex
                ? 'border-b-2 border-dracula-purple text-foreground'
                : 'text-muted-foreground hover:text-foreground border-b-2 border-transparent'
            )}
            onClick={() => setActiveTabIndex(i)}
          >
            <span className="truncate">
              {conv.title ?? `Chat ${i + 1}`}
            </span>
            {conv.isStreaming && (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-dracula-purple" />
            )}
            <button
              type="button"
              className="ml-auto shrink-0 hidden group-hover:block text-muted-foreground hover:text-foreground text-xs"
              onClick={(e) => {
                e.stopPropagation()
                deleteConversation(conv.id)
              }}
              aria-label={`Delete ${conv.title ?? 'conversation'}`}
            >
              ×
            </button>
          </div>
        ))}

        {conversations.length < 3 && (
          <button
            type="button"
            onClick={() => createConversation()}
            className="px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            + New
          </button>
        )}
      </div>

      {/* Conversation view */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {activeConversation ? (
          <>
            <MessageList
              messages={activeConversation.messages}
              streamingText={activeConversation.streamingText}
              isStreaming={activeConversation.isStreaming}
              onConfirmCommand={confirmCommand}
              onDismissCommand={(cmd) => dismissCommandProposal(activeConversation.id, cmd)}
            />
            <ChatInput
              conversationId={activeConversation.id}
              model={activeConversation.model}
              hasMessages={activeConversation.messages.length > 0}
              isStreaming={activeConversation.isStreaming}
              onSend={sendMessage}
              onAbort={abortStream}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
            <p className="text-sm text-muted-foreground">No conversations yet</p>
            <button
              type="button"
              className="rounded-md bg-dracula-purple/20 px-3 py-1.5 text-xs text-dracula-purple hover:bg-dracula-purple/30 transition-colors"
              onClick={() => createConversation()}
            >
              Start a conversation
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
