import type { PieceExecutionContext } from '../contracts.js'

/** Project notes are advisory: failure must never replay an already billed provider response. */
export async function advisoryMemory<T>(context: PieceExecutionContext, operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation() }
  catch {
    try { context.progress({ type: 'span', payload: { name: 'project-memory', status: 'unavailable', nodePath: context.frame.nodePath } }) } catch { /* Diagnostics cannot fail the node. */ }
    return undefined
  }
}
