import type { PipelineContext, VerificationEvidencePort } from '../../../pipeline/pipeline-state.js'
import type { RuntimeConfig } from '../../executor-types.js'
import type { ExecutorRegistry } from '../../executors.js'
import type { ProviderInvocation } from '../../efficiency-types.js'
import type { OpenSpecRoleContext } from '../../openspec.js'
import type { RoleStatePort } from '../../role-state.js'
import type { WorkflowStepContext } from '../../workflow-types.js'
import type { CandidateState, JsonValue, PieceExecutionContext, VerifiedState } from '../contracts.js'
import type { ProjectMemory } from '../store/sqlite-store.js'
import type { ImplementationBinding } from './implementation-binding.js'

/** One physical attempt's durable notes; never a cache shared between providers or runs. */
export interface PieceStatePort {
  get(key: string): JsonValue | undefined
  set(key: string, value: JsonValue): void
}

export interface PieceDependencies {
  context: PipelineContext
  config: RuntimeConfig
  registry: ExecutorRegistry
  stepContext(context: PieceExecutionContext): WorkflowStepContext
  roleState(context: PieceExecutionContext): RoleStatePort
  memo(context: PieceExecutionContext): PieceStatePort
  /** Narrow project memory is restricted by the declared piece and namespace capability. */
  memory(context: PieceExecutionContext): ProjectMemory
  /** Provider settlement and the response needed for interrupt replay share one transaction. */
  settleResult(context: PieceExecutionContext, key: string, value: JsonValue, invocation: ProviderInvocation): void
  executionSnapshot(context: PieceExecutionContext): { candidate: CandidateState | null; verified: VerifiedState | null }
  verification(context: PieceExecutionContext): VerificationEvidencePort
  /** A scoped adapter directory for recoverable OpenSpec write sets, never state.json. */
  artifactDirectory(context: PieceExecutionContext): string
  /** Registers parent-owned scoped journals for candidate inspection, recovery and fork. */
  bindImplementation(context: PieceExecutionContext, change: string): ImplementationBinding
  /** Current union of declared implementation artifacts and journals, including the parent run. */
  implementationExclusions?(context: PieceExecutionContext): { runtimeExclusions: readonly string[]; repositoryExclusions: Readonly<Record<string, readonly string[]>> }
  openspec?(context: PieceExecutionContext): Record<string, OpenSpecRoleContext>
  policies?: { historyMaxChars?: number; noProgress?: number }
}
/** Evaluated only at execution; catalog listing and validation are effect-free. */
export type PieceDependencyProvider = () => PieceDependencies
