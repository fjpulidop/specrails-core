import { Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from './ui/tooltip'
import { Navbar } from './Navbar'
import { StatusBar } from './StatusBar'
import { usePipeline } from '../hooks/usePipeline'

export function RootLayout() {
  const { connectionStatus } = usePipeline()

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
        <Navbar />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
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
