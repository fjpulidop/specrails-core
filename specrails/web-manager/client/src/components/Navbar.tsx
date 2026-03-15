import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Settings, BookOpen, Github, ExternalLink, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function Navbar() {
  const [docsOpen, setDocsOpen] = useState(false)

  return (
    <>
      <nav className="h-11 flex items-center justify-between px-4 border-b border-border/30 bg-background/80 backdrop-blur-sm">
        {/* Wordmark */}
        <NavLink
          to="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <span className="font-mono text-sm font-bold">
            <span className="text-dracula-purple">spec</span>
            <span className="text-dracula-pink">rails</span>
          </span>
          <span className="text-muted-foreground text-[11px] font-normal">/ manager</span>
        </NavLink>

        {/* Right-side actions */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setDocsOpen(true)}
                className="h-7 px-2 flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors cursor-pointer"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>Docs</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Open specrails documentation</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href="https://github.com/fjpulidop/specrails"
                target="_blank"
                rel="noopener noreferrer"
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors"
              >
                <Github className="w-3.5 h-3.5" />
              </a>
            </TooltipTrigger>
            <TooltipContent>GitHub</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  cn(
                    'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                    isActive
                      ? 'text-primary bg-dracula-current/50'
                      : 'text-muted-foreground hover:text-foreground hover:bg-dracula-current/50'
                  )
                }
              >
                <Settings className="w-3.5 h-3.5" />
              </NavLink>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </nav>

      {/* Docs slide-over panel */}
      {docsOpen && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setDocsOpen(false)}
          />

          {/* Panel */}
          <div className="relative w-full m-3 rounded-xl glass-card border border-border/30 flex flex-col animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/30">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-dracula-purple" />
                <span className="text-sm font-medium">Documentation</span>
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href="https://specrails.dev/docs"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>Open in new tab</TooltipContent>
                </Tooltip>
                <button
                  onClick={() => setDocsOpen(false)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-dracula-current/50 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Iframe */}
            <iframe
              src="https://specrails.dev/docs"
              className="flex-1 w-full border-0 bg-background"
              title="specrails documentation"
            />
          </div>
        </div>
      )}
    </>
  )
}
