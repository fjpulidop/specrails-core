import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
        warning: 'border-transparent bg-amber-500/20 text-amber-400 border-amber-500/30',
        running: 'border-transparent bg-blue-500/20 text-blue-400 border-blue-500/30',
        queued: 'border-transparent bg-slate-500/20 text-slate-400 border-slate-500/30',
        failed: 'border-transparent bg-red-500/20 text-red-400 border-red-500/30',
        canceled: 'border-transparent bg-slate-600/20 text-slate-500 border-slate-600/30',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
