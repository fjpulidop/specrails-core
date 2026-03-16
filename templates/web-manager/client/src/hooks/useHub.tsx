import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
  type ReactNode,
} from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'
import { setApiContext } from '../lib/api'

export interface HubProject {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  added_at: string
  last_seen_at: string
}

interface HubContextValue {
  projects: HubProject[]
  activeProjectId: string | null
  setActiveProjectId: (id: string | null) => void
  addProject: (path: string, name?: string) => Promise<HubProject | null>
  removeProject: (id: string) => Promise<void>
  isLoading: boolean
}

const HubContext = createContext<HubContextValue | null>(null)

export function HubProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<HubProject[]>([])
  const [activeProjectId, setActiveProjectIdRaw] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  function setActiveProjectId(id: string | null): void {
    setApiContext(true, id)
    setActiveProjectIdRaw(id)
  }
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Load projects from REST on mount
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/hub/projects')
        if (!res.ok) return
        const data = await res.json() as { projects: HubProject[] }
        setProjects(data.projects)
        // Default to first project if none selected
        if (data.projects.length > 0) {
          setActiveProjectIdRaw((prev) => {
            const next = prev ?? data.projects[0].id
            setApiContext(true, next)
            return next
          })
        }
      } catch {
        // Hub may not be running in hub mode — treat as empty
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  // Handle hub-level WebSocket messages
  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (typeof msg.type !== 'string') return

    if (msg.type === 'hub.projects') {
      const incoming = msg.projects as HubProject[]
      setProjects(incoming)
      setActiveProjectIdRaw((prev) => {
        const next = (prev && incoming.find((p) => p.id === prev)) ? prev : (incoming.length > 0 ? incoming[0].id : null)
        setApiContext(true, next)
        return next
      })
      setIsLoading(false)
    } else if (msg.type === 'hub.project_added') {
      const project = msg.project as HubProject
      setProjects((prev) => {
        if (prev.find((p) => p.id === project.id)) return prev
        return [...prev, project]
      })
      // Activate the newly added project
      setActiveProjectId(project.id)
    } else if (msg.type === 'hub.project_removed') {
      const projectId = msg.projectId as string
      setProjects((prev) => prev.filter((p) => p.id !== projectId))
      setActiveProjectIdRaw((prev) => {
        if (prev !== projectId) return prev
        setApiContext(true, null)
        return null
      })
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('hub', handleMessage)
    return () => unregisterHandler('hub')
  }, [handleMessage, registerHandler, unregisterHandler])

  const addProject = useCallback(async (projectPath: string, name?: string): Promise<HubProject | null> => {
    try {
      const body: Record<string, string> = { path: projectPath }
      if (name) body.name = name

      const res = await fetch('/api/hub/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as { project: HubProject }
      return data.project
    } catch (err) {
      console.error('[useHub] addProject error:', err)
      throw err
    }
  }, [])

  const removeProject = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/hub/projects/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
    } catch (err) {
      console.error('[useHub] removeProject error:', err)
      throw err
    }
  }, [])

  return (
    <HubContext.Provider value={{
      projects,
      activeProjectId,
      setActiveProjectId,
      addProject,
      removeProject,
      isLoading,
    }}>
      {children}
    </HubContext.Provider>
  )
}

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext)
  if (!ctx) throw new Error('useHub must be used within HubProvider')
  return ctx
}
