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
        success: 'border-transparent bg-dracula-green/20 text-dracula-green border-dracula-green/30',
        warning: 'border-transparent bg-dracula-orange/20 text-dracula-orange border-dracula-orange/30',
        running: 'border-transparent bg-dracula-cyan/20 text-dracula-cyan border-dracula-cyan/30',
        queued: 'border-transparent bg-dracula-purple/20 text-dracula-purple border-dracula-purple/30',
        failed: 'border-transparent bg-dracula-red/20 text-dracula-red border-dracula-red/30',
        canceled: 'border-transparent bg-dracula-orange/20 text-dracula-orange border-dracula-orange/30',
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
