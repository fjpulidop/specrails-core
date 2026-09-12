import { Annotation } from '@langchain/langgraph'
import type { VerificationCommand } from '../../installer/runtime/pipeline-state.js'

export type DesignConfidence = 'high' | 'medium' | 'low'
export interface ArchitectureRecord {
  change: string
  tasks: number
  specs: string[]
  confidence: DesignConfidence
  /** The single blocking question the architect could not answer from the code. */
  question?: string
  /** True when a low-confidence design proceeded on stated assumptions instead of asking. */
  assumed?: boolean
}
export interface DeveloperRecord {
  summary: string
  provider: string
  sessionId?: string
  files: string[]
  tests: string[]
  verification?: string
  incomplete: Array<{ task: string; reason: string }>
  /** False when the provider returned prose instead of the structured summary. */
  structured: boolean
}
export interface VerificationRecord {
  valid: boolean
  reason?: string
  receiptId?: string
  incompleteTasks?: string[]
  unverifiedRepositories: string[]
  commands: Array<{ repositoryId: string; command: string; args: string[]; exitCode: number | null; output: string }>
}
export interface ReviewRecord {
  approved: boolean
  summary: string
  issues: string[]
  score: number
  aspects: Record<string, number>
  candidateHash?: string
}
export interface ArchiveRecord { archivePath: string; deliveryOwner: string }

const replace = <T>() => ({ reducer: (_previous: T, next: T): T => next })

/**
 * The Core implementation graph state. Every field is plain JSON so LangGraph
 * checkpoints, the host ledger and the CLI status share one representation.
 * Channel names never collide with node names (LangGraph forbids it).
 */
export const CoreState = Annotation.Root({
  /** The frozen verification plan: configured commands plus the architect's proposals. */
  plan: Annotation<VerificationCommand[]>({ ...replace<VerificationCommand[]>(), default: () => [] }),
  unverifiedRepositories: Annotation<string[]>({ ...replace<string[]>(), default: () => [] }),
  architecture: Annotation<ArchitectureRecord | null>({ ...replace<ArchitectureRecord | null>(), default: () => null }),
  development: Annotation<DeveloperRecord | null>({ ...replace<DeveloperRecord | null>(), default: () => null }),
  verifyResult: Annotation<VerificationRecord | null>({ ...replace<VerificationRecord | null>(), default: () => null }),
  review: Annotation<ReviewRecord | null>({ ...replace<ReviewRecord | null>(), default: () => null }),
  /** Answers the requester gave to architect questions, oldest first. */
  answers: Annotation<string[]>({ reducer: (previous: string[], next: string[]): string[] => [...previous, ...next], default: () => [] }),
  /** Autonomous investigation passes the architect already spent on a low-confidence design. */
  deepenPasses: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  archived: Annotation<ArchiveRecord | null>({ ...replace<ArchiveRecord | null>(), default: () => null }),
})
export type CoreStateType = typeof CoreState.State
export type CoreStateUpdate = typeof CoreState.Update
export type CoreNodeId = 'architect' | 'developer' | 'verify' | 'reviewer' | 'archive'
export const CORE_NODE_ORDER: readonly CoreNodeId[] = ['architect', 'developer', 'verify', 'reviewer', 'archive']
