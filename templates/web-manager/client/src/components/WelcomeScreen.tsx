import { FolderOpen, Terminal } from 'lucide-react'
import { Button } from './ui/button'

interface WelcomeScreenProps {
  onAddProject: () => void
}

export function WelcomeScreen({ onAddProject }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-6 px-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
        <Terminal className="w-7 h-7 text-muted-foreground" />
      </div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold">
          Welcome to <span className="text-dracula-purple">spec</span><span className="text-dracula-pink">rails</span> hub
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          The hub manages multiple projects from a single interface. Add your first project to get started.
        </p>
      </div>

      <Button onClick={onAddProject} size="sm" className="gap-2">
        <FolderOpen className="w-3.5 h-3.5" />
        Add your first project
      </Button>

      <div className="text-[10px] text-muted-foreground space-y-1">
        <p>Or register a project from the terminal:</p>
        <code className="font-mono bg-muted/50 px-2 py-0.5 rounded text-xs">
          srm hub add /path/to/project
        </code>
      </div>
    </div>
  )
}
