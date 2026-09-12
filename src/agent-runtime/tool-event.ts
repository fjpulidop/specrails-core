import type { AgentEvent } from './executor-types.js'
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function shorten(value: unknown, limit = 160): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > limit ? single.slice(0, limit - 1) + '…' : single
}
/** Short, human-readable tool activity for host logs; never a transcript. */
export function toolEvent(tool: string, input: unknown): AgentEvent {
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = {} } }
  const args = object(input)
  const detail = shorten(args.file_path ?? args.path ?? (Array.isArray(args.paths) ? args.paths[0] : undefined) ?? args.command ?? args.pattern ?? args.query ?? args.notebook_path ?? args.url ?? (typeof args.action === 'string' ? [args.action, args.artifact].filter(Boolean).join(' ') : undefined))
  const targetPaths = [args.file_path, args.path, args.notebook_path, ...(Array.isArray(args.paths) ? args.paths : [])].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const cwd = args.workdir ?? args.cwd
  return { kind: 'tool-start', tool, ...(detail ? { detail } : {}), ...(targetPaths.length ? { targetPaths } : {}), ...(typeof cwd === 'string' ? { cwd } : {}) }
}
