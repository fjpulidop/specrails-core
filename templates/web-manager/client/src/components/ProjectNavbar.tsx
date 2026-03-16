import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BarChart3, MessageSquare, Settings } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { HubProject } from '../hooks/useHub'

interface ProjectNavbarProps {
  project: HubProject
}

export function ProjectNavbar({ project }: ProjectNavbarProps) {
  const navItems = [
    { to: '/', end: true, icon: LayoutDashboard, label: 'Home' },
    { to: '/analytics', end: false, icon: BarChart3, label: 'Analytics' },
    { to: '/conversations', end: false, icon: MessageSquare, label: 'Conversations' },
  ]

  return (
    <nav className="flex items-center justify-between h-9 px-3 border-b border-border bg-background/50">
      {/* Project name */}
      <span className="text-xs text-muted-foreground truncate max-w-[160px]">
        {project.path}
      </span>

      {/* Center nav */}
      <div className="flex items-center gap-0.5">
        {navItems.map(({ to, end, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
                isActive
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )
            }
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>

      {/* Settings */}
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
        <TooltipContent>Project Settings</TooltipContent>
      </Tooltip>
    </nav>
  )
}
