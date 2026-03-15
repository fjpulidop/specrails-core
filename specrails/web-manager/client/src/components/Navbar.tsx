import { NavLink } from 'react-router-dom'
import { Settings, BookOpen, LayoutDashboard, BarChart3 } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function Navbar() {
  return (
    <nav className="relative z-50 h-11 flex items-center justify-between px-4 border-b border-border bg-card/50 backdrop-blur-sm">
      {/* Wordmark */}
      <NavLink
        to="/"
        className="flex items-center gap-2 text-foreground hover:text-foreground/80 transition-colors"
      >
        <span className="font-mono text-sm font-bold"><span className="text-dracula-purple">spec</span><span className="text-dracula-pink">rails</span></span>
        <span className="text-muted-foreground text-xs font-normal">/ manager</span>
      </NavLink>

      {/* Center nav links */}
      <div className="flex items-center gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
              isActive
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )
          }
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>Home</span>
        </NavLink>
        <NavLink
          to="/analytics"
          className={({ isActive }) =>
            cn(
              'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
              isActive
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )
          }
        >
          <BarChart3 className="w-3.5 h-3.5" />
          <span>Analytics</span>
        </NavLink>
      </div>

      {/* Right-side actions */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://specrails.dev/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Docs</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn(
                  'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'text-foreground bg-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
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
  )
}
