export const DRACULA = {
  purple:  'hsl(265 89% 78%)',
  cyan:    'hsl(191 97% 77%)',
  green:   'hsl(135 94% 65%)',
  pink:    'hsl(326 100% 74%)',
  orange:  'hsl(31 100% 71%)',
  red:     'hsl(0 100% 67%)',
  yellow:  'hsl(65 92% 76%)',
  comment: 'hsl(225 27% 51%)',
}

export const STATUS_COLORS: Record<string, string> = {
  completed: DRACULA.purple,
  failed:    DRACULA.pink,
  canceled:  DRACULA.orange,
  running:   DRACULA.cyan,
  queued:    DRACULA.comment,
}

export const CHART_PALETTE = [
  DRACULA.purple,
  DRACULA.cyan,
  DRACULA.green,
  DRACULA.pink,
  DRACULA.orange,
]
