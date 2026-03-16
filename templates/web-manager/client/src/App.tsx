import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { RootLayout } from './components/RootLayout'
import DashboardPage from './pages/DashboardPage'
import JobDetailPage from './pages/JobDetailPage'
import SettingsPage from './pages/SettingsPage'
import AnalyticsPage from './pages/AnalyticsPage'
import ConversationsPage from './pages/ConversationsPage'
import GlobalSettingsPage from './pages/GlobalSettingsPage'
import { ProjectLayout } from './components/ProjectLayout'
import { WelcomeScreen } from './components/WelcomeScreen'
import { TabBar } from './components/TabBar'
import { AddProjectDialog } from './components/AddProjectDialog'
import { SharedWebSocketProvider } from './hooks/useSharedWebSocket'
import { HubProvider, useHub } from './hooks/useHub'
import { WS_URL } from './lib/ws-url'

// ─── Hub mode detection ───────────────────────────────────────────────────────

function useHubMode(): boolean {
  const [isHub, setIsHub] = useState(false)

  useEffect(() => {
    async function detect() {
      try {
        const res = await fetch('/api/hub/state')
        setIsHub(res.ok)
      } catch {
        setIsHub(false)
      }
    }
    detect()
  }, [])

  return isHub
}

// ─── Hub app shell ────────────────────────────────────────────────────────────

function HubApp() {
  const { projects, activeProjectId, isLoading } = useHub()
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId)

  if (isLoading) {
    return (
      <div className="flex flex-col h-screen bg-background">
        <div className="h-11 border-b border-border bg-card/50 animate-pulse" />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background font-sans">
      {/* Hub top bar */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-border bg-card/50 backdrop-blur-sm flex-shrink-0">
        <span className="font-mono text-sm font-bold">
          <span className="text-dracula-purple">spec</span>
          <span className="text-dracula-pink">rails</span>
          <span className="text-muted-foreground text-xs font-normal ml-1">/ hub</span>
        </span>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `text-xs transition-colors ${isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`
          }
        >
          Settings
        </NavLink>
      </div>

      {/* Project tabs */}
      {projects.length > 0 && (
        <TabBar onAddProject={() => setAddDialogOpen(true)} />
      )}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/settings" element={<GlobalSettingsPage />} />
          {projects.length === 0 ? (
            <Route path="*" element={<WelcomeScreen onAddProject={() => setAddDialogOpen(true)} />} />
          ) : activeProject ? (
            <Route element={<ProjectLayout project={activeProject} />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/jobs/:id" element={<JobDetailPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/conversations" element={<ConversationsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          ) : (
            <Route path="*" element={
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground">Select a project</p>
              </div>
            } />
          )}
        </Routes>
      </div>

      <AddProjectDialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} />
    </div>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const isHub = useHubMode()

  return (
    <SharedWebSocketProvider url={WS_URL}>
      {isHub ? (
        <HubProvider>
          <HubApp />
        </HubProvider>
      ) : (
        <Routes>
          <Route element={<RootLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
    </SharedWebSocketProvider>
  )
}
