import { Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from './ui/tooltip'
import { Navbar } from './Navbar'
import { StatusBar } from './StatusBar'
import { ChatPanel } from './ChatPanel'
import { usePipeline } from '../hooks/usePipeline'
import { useChat } from '../hooks/useChat'

export function RootLayout() {
  const { connectionStatus } = usePipeline()
  const chat = useChat()

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
        <Navbar />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
          <ChatPanel chat={chat} />
        </div>
        <StatusBar connectionStatus={connectionStatus} />
      </div>
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          classNames: {
            toast: 'glass-card border border-border/30 text-foreground text-xs',
            description: 'text-muted-foreground',
          },
        }}
      />
    </TooltipProvider>
  )
}
