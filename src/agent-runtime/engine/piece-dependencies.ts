import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fingerprintCandidate, persistCheckEvidence, readCandidateScope, pipelineStateDirectory,
  type CandidateScope, type PipelineContext, type VerificationEvidencePort, type VerificationReceipt } from '../../pipeline/pipeline-state.js'
import { resolveRoleDescriptor } from '../config.js'
import type { RuntimeConfig } from '../executor-types.js'
import type { ExecutorRegistry } from '../executors.js'
import { prepareOpenSpec, roleOpenSpecContext, type OpenSpecRoleContext } from '../openspec.js'
import type { ProviderInvocation } from '../efficiency-types.js'
import type { RoleExecutionState, RoleStatePort } from '../role-state.js'
import { contentDigest } from './canonical-json.js'
import { EngineError, type AttemptFrame, type CandidateState, type EngineEffect, type JsonValue, type PieceExecutionContext, type PieceResult } from './contracts.js'
import type { RunLedger } from './checkpoint/ledger.js'
import type { WorkflowDefinition } from './definition-types.js'
import { definitionNodeAt, invocationStepContext, roleAt } from './invocation-context.js'
import type { PieceDependencies, PieceStatePort } from './pieces/ports.js'

import type { ProjectMemory, SqliteProjectStore } from './store/sqlite-store.js'
import { deriveImplementationBinding, type ImplementationBinding } from './pieces/implementation-binding.js'

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

/** Adapters are bound to one frozen project, definition and execution lease. */
export class RunPieceDependencies implements PieceDependencies {
  readonly policies: PieceDependencies['policies']
  constructor(readonly context: PipelineContext, readonly config: RuntimeConfig, readonly registry: ExecutorRegistry,
    private readonly definition: WorkflowDefinition, private readonly ledger: RunLedger, private readonly directory: string,
    private readonly change?: string, private readonly projectMemory?: SqliteProjectStore) { this.policies = definition.policies }

  memory(context: PieceExecutionContext): ProjectMemory {
    if (!this.projectMemory) throw new EngineError('memory_unavailable', 'Project memory is not bound to this execution')
    const kind = this.ledger.db.get('visits', { visit_id: context.frame.visitId })?.kind
    const prefixes = kind === 'verify' ? [['verification', 'known-commands']] : kind === 'role-turn' ? [['roles', roleAt(this.definition, context.frame.nodePath), 'sessions'], ['review', 'notes']] : []
    return this.projectMemory.forAccess(prefixes.length ? 'write' : 'none', { namespacePrefixes: prefixes })
  }

  private implementationBindings(): ImplementationBinding[] {
    return this.ledger.db.sqlite.prepare("SELECT value_json FROM piece_state WHERE run_id=? AND key='binding:implementation'").all(this.ledger.runId)
      .map(row => JSON.parse(String(row.value_json)) as ImplementationBinding)
      .filter(binding => binding.parentRunId === this.context.runId)
  }

  bindImplementation(context: PieceExecutionContext, change: string): ImplementationBinding {
    const binding = deriveImplementationBinding(this.context, context, change)
    const previous = this.ledger.readPieceState(context.frame, 'binding:implementation')
    if (previous !== undefined && contentDigest(previous) !== contentDigest(binding)) throw new EngineError('scope_mismatch', 'Implementation binding changed within a frozen run')
    if (previous === undefined) this.ledger.writePieceState(context.frame, 'binding:implementation', json(binding))
    return binding
  }

  private candidateScope(): CandidateScope {
    const row = this.ledger.run()
    const inherited = row.fork_of && row.candidate_json ? (JSON.parse(String(row.candidate_json)) as CandidateState).scope : undefined
    const base: CandidateScope = this.definition.journal === 'implementation' && existsSync(path.join(pipelineStateDirectory(this.context), 'state.json'))
      ? readCandidateScope(this.context)
      : inherited ? this.inheritedCandidateScope(inherited)
        : { context: this.context, scopeHash: contentDigest(this.context), artifactExclusions: this.change ? ['openspec/changes/' + this.change] : [] }
    const bindings = this.implementationBindings(), repositoryExclusions: Record<string, string[]> = Object.fromEntries(Object.entries(base.repositoryExclusions ?? {}).map(([id, paths]) => [id, [...paths]]))
    for (const binding of bindings) {
      const exclusions = existsSync(path.join(binding.directory, 'state.json')) ? readCandidateScope(binding.context).artifactExclusions : ['openspec/changes/' + binding.change]
      const repository = this.context.repositories.find(item => item.id === binding.context.artifactRepositoryId)!
      const prefix = path.relative(repository.path, binding.context.artifactRoot).split(path.sep).join('/')
      const paths = exclusions.map(relative => prefix ? prefix + '/' + relative : relative)
      repositoryExclusions[repository.id] = [...new Set([...(repositoryExclusions[repository.id] ?? []), ...paths])]
    }
    return { ...base, runtimeExclusions: [...new Set([...(base.runtimeExclusions ?? []), pipelineStateDirectory(this.context), ...bindings.map(binding => binding.directory), ...(this.projectMemory ? ['', '-wal', '-shm'].map(suffix => this.projectMemory!.filename + suffix) : [])])], repositoryExclusions }
  }

  private inheritedCandidateScope(value: NonNullable<CandidateState['scope']>): CandidateScope {
    const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string')
    if (typeof value.scopeHash !== 'string' || !strings(value.artifactExclusions) || !strings(value.runtimeExclusions)
      || !value.repositoryExclusions || typeof value.repositoryExclusions !== 'object' || Array.isArray(value.repositoryExclusions)
      || !Object.values(value.repositoryExclusions).every(strings)) throw new EngineError('storage_corrupt', 'Inherited candidate scope is malformed')
    return { context: this.context, scopeHash: value.scopeHash, artifactExclusions: value.artifactExclusions,
      runtimeExclusions: value.runtimeExclusions, repositoryExclusions: value.repositoryExclusions as Record<string, string[]> }
  }

  private candidate(transition: number, revision: number): CandidateState {
    const scope = this.candidateScope()
    return { hash: fingerprintCandidate(scope), atTransition: transition, revision,
      scope: { scopeHash: scope.scopeHash, artifactExclusions: [...scope.artifactExclusions],
        runtimeExclusions: [...(scope.runtimeExclusions ?? [])],
        repositoryExclusions: Object.fromEntries(Object.entries(scope.repositoryExclusions ?? {}).map(([id, paths]) => [id, [...paths]])) } }
  }

  implementationExclusions(_context: PieceExecutionContext) {
    const scope = this.candidateScope()
    return { runtimeExclusions: [pipelineStateDirectory(this.context), ...(scope.runtimeExclusions ?? [])], repositoryExclusions: scope.repositoryExclusions ?? {} }
  }

  fingerprint(): string { return fingerprintCandidate(this.candidateScope()) }

  initializeCandidate(): void {
    if (this.ledger.run().candidate_json) return
    const candidate = this.candidate(0, 1)
    this.ledger.db.transaction('candidate-initialized', () => {
      this.ledger.lease.assert(this.ledger.token)
      this.ledger.db.put('runs', { ...this.ledger.run(), candidate_json: JSON.stringify(candidate), candidate_revision: candidate.revision })
    })
  }

  executionSnapshot(context: PieceExecutionContext) {
    const snapshot = this.ledger.scopeSnapshot(context.frame.scope.id), hash = this.fingerprint()
    const candidate = snapshot.candidate?.hash === hash ? snapshot.candidate : this.candidate(context.frame.transition, Number(this.ledger.run().candidate_revision) + 1)
    return { candidate, verified: snapshot.verified?.candidateHash === hash ? snapshot.verified : null }
  }

  /** Only the execution owner proposes protected candidate/receipt channels. */
  finalize(frame: AttemptFrame, result: PieceResult, effect: EngineEffect): PieceResult {
    const hash = this.fingerprint(), snapshot = this.ledger.scopeSnapshot(frame.scope.id)
    const candidate = effect === 'write' ? this.candidate(frame.transition, Number(this.ledger.run().candidate_revision) + 1)
      : snapshot.candidate ?? this.candidate(frame.transition, 1)
    const binding = this.implementationBindings().find(value => (frame.scope.id === value.scopeId || frame.scope.id.startsWith(value.scopeId + '/')) && (frame.nodePath === value.nodePath || frame.nodePath.startsWith(value.nodePath + '/')))
    const scoped = binding && binding.context.runId !== this.context.runId
    if (scoped && result.receipt) result = { ...result, receipt: { ...result.receipt, candidateHash: hash, scope: 'scoped' }, verified: null }
    const receipt = result.receipt
    const node = definitionNodeAt(this.definition, frame.nodePath)
    const kind = node?.kind ?? this.ledger.db.get('visits', { visit_id: frame.visitId })?.kind
    const evidence = receipt?.evidence as { commands?: unknown[]; unverifiedRepositories?: unknown[] } | undefined
    const certifies = result.verified !== null && ['verify', 'implementation'].includes(String(kind)) && receipt?.valid && receipt.scope === 'full' && !!evidence?.commands?.length && !evidence.unverifiedRepositories?.length
    if (receipt?.valid && receipt.candidateHash !== hash) return { ...result, outcome: 'fail',
      ...(effect === 'write' ? { candidate } : {}), verified: null,
      receipt: { ...receipt, valid: false, evidence: json({ ...(receipt.evidence as Record<string, unknown>), valid: false, reason: 'Candidate changed before terminal commit' }) },
      output: { receiptId: receipt.id, valid: false, reason: 'Candidate changed before terminal commit' },
    }
    return { ...result, ...(effect === 'write' ? { candidate } : {}),
      ...(certifies ? { verified: { receiptId: receipt.id, candidateHash: hash, atTransition: frame.transition, revision: candidate.revision } }
        : effect === 'write' || snapshot.verified?.candidateHash !== hash ? { verified: null } : {}),
    }
  }

  memo(context: PieceExecutionContext): PieceStatePort {
    const keyOf = (key: string) => 'memo:' + context.frame.visitId + ':' + key
    return { get: key => this.ledger.readPieceState(context.frame, keyOf(key)), set: (key, value) => this.ledger.writePieceState(context.frame, keyOf(key), value) }
  }

  roleState(context: PieceExecutionContext): RoleStatePort {
    return {
      read: () => {
        const value = this.ledger.readScopedPieceState(context.frame, context.frame.scope.nodePathPrefix, 'session:roles')
        if (value === undefined) return { sessions: {}, routes: {} }
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.sessions || !value.routes) throw new EngineError('storage_corrupt', 'Scoped role state is malformed')
        return structuredClone(value) as unknown as RoleExecutionState
      },
      write: value => this.ledger.writeScopedPieceState(context.frame, context.frame.scope.nodePathPrefix, 'session:roles', json(value)),
    }
  }

  stepContext(context: PieceExecutionContext) { return invocationStepContext(this.ledger, this.definition, context) }

  settleResult(context: PieceExecutionContext, key: string, value: JsonValue, invocation: ProviderInvocation): void {
    if (!invocation.invocationId) throw new EngineError('invocation_mismatch', 'A response memo requires its durable invocation ID')
    this.ledger.settleInvocation(context.frame, { ...invocation, invocationId: invocation.invocationId }, { key: 'memo:' + context.frame.visitId + ':' + key, value })
  }

  artifactDirectory(context: PieceExecutionContext): string {
    const target = path.join(this.directory, 'artifacts', contentDigest({ scope: context.frame.scope.id, node: context.frame.nodePath }))
    mkdirSync(target, { recursive: true, mode: 0o700 })
    return target
  }

  openspec(context: PieceExecutionContext): Record<string, OpenSpecRoleContext> {
    const roles = this.definition.roles.map(role => resolveRoleDescriptor(this.config, role)).filter(role => role.openspecSkill)
    if (!roles.length) return {}
    if (!this.change) throw new EngineError('invalid_arguments', 'OpenSpec roles require a frozen change name')
    const directory = this.artifactDirectory(context), prepared = prepareOpenSpec(this.context.artifactRoot, this.change, directory)
    return Object.fromEntries(roles.map(role => {
      const provider = this.config.providers.find(item => item.id === role.provider)
      return [role.id, roleOpenSpecContext(prepared, this.context.artifactRoot, this.change!, directory, role, provider?.kind === 'cli' ? provider.cli : 'claude')]
    }))
  }

  verification(context: PieceExecutionContext): VerificationEvidencePort {
    const candidateHash = this.fingerprint(), scope = this.candidateScope()
    const row = this.ledger.db.sqlite.prepare("SELECT receipt_json FROM receipts WHERE run_id=? AND valid=1 AND candidate_hash=? ORDER BY created_at DESC LIMIT 1").get(this.ledger.runId, candidateHash)
    const previous = row ? (JSON.parse(String(row.receipt_json)) as { evidence: VerificationReceipt }).evidence : undefined
    return {
      candidateHash, scopeHash: scope.scopeHash, ...(previous ? { previous } : {}),
      isCurrent: () => { this.ledger.lease.assert(this.ledger.token); return this.fingerprint() === candidateHash },
      persistCheck: (result, planHash, candidate) => {
        this.ledger.lease.assert(this.ledger.token)
        // Retain the existing bounded evidence format and paginated CLI reader.
        // These are diagnostic artifacts; only the SQLite terminal transaction
        // can certify this candidate and advance the workflow.
        persistCheckEvidence(this.context, result, planHash, candidate)
        this.ledger.writePieceState(context.frame, 'evidence:check:' + result.evidenceId, json({ ...result, planHash, candidateHash: candidate }))
      },
      commitReceipt: receipt => {
        this.ledger.lease.assert(this.ledger.token)
        const result = this.fingerprint() === candidateHash ? receipt : { ...receipt, valid: false, reason: 'Candidate changed during verification' }
        this.ledger.writePieceState(context.frame, 'evidence:receipt:' + receipt.id, json(result))
        return result
      },
    }
  }
}
