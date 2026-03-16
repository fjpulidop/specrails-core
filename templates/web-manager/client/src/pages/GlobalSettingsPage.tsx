import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Settings } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { useHub } from '../hooks/useHub'
import type { HubProject } from '../hooks/useHub'

interface HubSettings {
  port: number
}

function ProjectListItem({
  project,
  onRemove,
}: {
  project: HubProject
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-md border border-border">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{project.name}</p>
        <p className="text-[10px] text-muted-foreground truncate">{project.path}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive shrink-0"
        onClick={() => onRemove(project.id)}
      >
        Remove
      </Button>
    </div>
  )
}

export default function GlobalSettingsPage() {
  const { projects, removeProject } = useHub()
  const [hubSettings, setHubSettings] = useState<HubSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/hub/settings')
        if (res.ok) {
          const data = await res.json() as HubSettings
          setHubSettings(data)
        }
      } catch {
        // Hub may not be in settings-aware mode
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  async function handleRemoveProject(id: string) {
    try {
      await removeProject(id)
      toast.success('Project removed')
    } catch (err) {
      toast.error('Failed to remove project', { description: (err as Error).message })
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-32 bg-muted/30 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="w-4 h-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Hub Settings</h1>
      </div>

      {/* Projects section */}
      <Card>
        <CardHeader>
          <CardTitle>Registered Projects</CardTitle>
          <CardDescription>
            Projects managed by the hub. Remove projects to unregister them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4 text-center">
              <p className="text-xs text-muted-foreground">No projects registered yet</p>
            </div>
          ) : (
            projects.map((project) => (
              <ProjectListItem
                key={project.id}
                project={project}
                onRemove={handleRemoveProject}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Hub info */}
      <Card>
        <CardHeader>
          <CardTitle>Hub Information</CardTitle>
          <CardDescription>Runtime information about the hub server</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Port</span>
            <span className="font-mono">{hubSettings?.port ?? 4200}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Projects</span>
            <span className="font-mono">{projects.length}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Hub DB</span>
            <span className="font-mono text-muted-foreground">~/.specrails/hub.sqlite</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
